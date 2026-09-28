import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateName } from "./tool-loop.ts";

const MAX_CONTENT = 32000;
const MAX_MEMORY = 96000;
const MAX_RUN = 8_000_000;

// Reject symlinks in every managed path component, including an existing data root.
export async function directory(dir: string): Promise<void> {
  const parent = path.dirname(dir);
  if (parent !== dir) await directory(parent);
  try { await mkdir(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a real directory: ${dir}`);
}

export async function readText(file: string, limit = MAX_CONTENT): Promise<string | null> {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error(`Invalid or oversized file: ${path.basename(file)}`);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

export async function writeText(file: string, content: string): Promise<void> {
  await directory(path.dirname(file));
  // Atomic replacement prevents truncated memory/run files if the process is interrupted.
  const temp = path.join(path.dirname(file), `.pending-${randomUUID()}`);
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.close();
    await rename(temp, file);
  } finally { await handle.close(); await unlink(temp).catch(() => {}); }
}

function workspacePath(root: string, workspace: string): string {
  validateName(workspace);
  return path.join(path.resolve(root), workspace);
}

// Unlike directory(), this never creates a missing directory during a lookup.
async function existingDirectory(dir: string): Promise<boolean> {
  const parent = path.dirname(dir);
  if (parent !== dir && !await existingDirectory(parent)) return false;
  let stat;
  try { stat = await lstat(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Not a real directory: ${dir}`);
  return true;
}

// Renames do not follow file links, but a restored workspace must also be safe to use.
async function validateTree(dir: string): Promise<void> {
  if (!await existingDirectory(dir)) throw new Error("Workspace backup is missing.");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    const stat = await lstat(file);
    if (stat.isSymbolicLink()) throw new Error("Symlinks are not allowed in workspace storage.");
    if (stat.isDirectory()) await validateTree(file);
    else if (!stat.isFile() || stat.nlink !== 1) throw new Error("Only regular, unlinked files are allowed in workspace storage.");
  }
}

type StoredRun = { id: string; status: string } | null;
async function storedRun(dir: string): Promise<StoredRun> {
  const raw = await readText(path.join(dir, "run.json"), MAX_RUN);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value) ||
      !("id" in value) || typeof value.id !== "string" ||
      !("status" in value) || typeof value.status !== "string") {
    throw new Error("Invalid run.json.");
  }
  return { id: value.id, status: value.status };
}

async function guardCurrent(dir: string, expectedRunId: unknown): Promise<void> {
  const run = await storedRun(dir);
  if ((run?.id ?? null) !== expectedRunId) throw new Error("This run is stale. Reload the workspace before resetting or restoring.");
  if (run?.status === "running") throw new Error("Stop the current run before resetting or restoring the workspace.");
}

type ResetReference = { version: 1; workspace: string; backup: string };
function archiveName(workspace: string): string { return `${workspace}--${randomUUID()}`; }

async function backupPath(root: string, workspace: string, dir: string): Promise<string | null> {
  const raw = await readText(path.join(dir, "reset.json"), 4096);
  if (raw === null) return null;
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      !("version" in value) || value.version !== 1 ||
      !("workspace" in value) || value.workspace !== workspace ||
      !("backup" in value) || typeof value.backup !== "string" ||
      !new RegExp(`^${workspace}--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(value.backup)) {
    throw new Error("Invalid workspace reset reference.");
  }
  const backup = path.join(path.resolve(root), ".resets", value.backup);
  return await existingDirectory(backup) ? backup : null;
}

export async function canRestore(root: string, workspace: string): Promise<boolean> {
  const dir = workspacePath(root, workspace);
  if (!await existingDirectory(dir)) return false;
  const backup = await backupPath(root, workspace, dir);
  if (!backup) return false;
  await validateTree(backup);
  return (await storedRun(backup))?.status !== "running";
}

// Call under the tool loop's exclusive workspace lock. No user files are deleted.
export async function resetWorkspace(
  root: string, workspace: string, scope: "files" | "all", expectedRunId: unknown,
): Promise<void> {
  if (scope !== "files" && scope !== "all") throw new Error("Reset scope must be files or all.");
  const dir = workspacePath(root, workspace);
  await directory(path.join(dir, "sandbox"));
  await guardCurrent(dir, expectedRunId);
  await validateTree(dir);
  const memory = scope === "files" ? await readText(path.join(dir, "memory.json"), MAX_MEMORY) : null;
  const archives = path.join(path.resolve(root), ".resets");
  await directory(archives);
  const backup = archiveName(workspace);
  const staged = path.join(archives, `.pending-${randomUUID()}`);
  await directory(path.join(staged, "sandbox"));
  if (memory !== null) await writeText(path.join(staged, "memory.json"), memory);
  const reference: ResetReference = { version: 1, workspace, backup };
  await writeText(path.join(staged, "reset.json"), JSON.stringify(reference, null, 2) + "\n");
  const archived = path.join(archives, backup);
  await rename(dir, archived);
  try { await rename(staged, dir); }
  catch (error) {
    try { await rename(archived, dir); }
    catch (rollback) { throw new AggregateError([error, rollback], `Reset failed; the original workspace is preserved at ${archived}.`); }
    throw error;
  }
}

export async function restoreWorkspace(root: string, workspace: string, expectedRunId: unknown): Promise<void> {
  const dir = workspacePath(root, workspace);
  if (!await existingDirectory(dir)) throw new Error("No reset is available to restore.");
  await guardCurrent(dir, expectedRunId);
  const backup = await backupPath(root, workspace, dir);
  if (!backup) throw new Error("No reset is available to restore.");
  await validateTree(dir);
  await validateTree(backup);
  if ((await storedRun(backup))?.status === "running") throw new Error("Cannot restore a backup with a running run.");
  // Preserve changes made after resetting as a separate archive before restoring.
  const archived = path.join(path.resolve(root), ".resets", archiveName(workspace));
  await rename(dir, archived);
  try { await rename(backup, dir); }
  catch (error) {
    try { await rename(archived, dir); }
    catch (rollback) { throw new AggregateError([error, rollback], `Restore failed; the current workspace is preserved at ${archived}.`); }
    throw error;
  }
}
