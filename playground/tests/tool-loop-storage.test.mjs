import test from "node:test";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { canRestore, directory, readText, resetWorkspace, restoreWorkspace, writeText } from "../src/lib/tool-loop-storage.ts";

async function fixture(t) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-storage-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const memoryText = '{\n  "index" : "notes/source.txt: words 0–19"\n}\n';
const stoppedRun = { id: "original-run", status: "stopped", steps: [], readBuffer: { content: "old excerpt" } };
async function seed(root, workspace = "demo", run = stoppedRun) {
  const dir = path.join(root, workspace);
  await directory(path.join(dir, "sandbox/notes"));
  await writeText(path.join(dir, "sandbox/notes/source.txt"), "original text");
  await writeText(path.join(dir, "memory.json"), memoryText);
  if (run !== null) await writeText(path.join(dir, "run.json"), JSON.stringify(run));
  return dir;
}

async function assertMissing(file) { await assert.rejects(readFile(file), { code: "ENOENT" }); }

test("reset files preserves exact memory, clears run and sandbox, and restores the complete backup", async t => {
  const root = await fixture(t);
  const dir = await seed(root);
  await seed(root, "other", { ...stoppedRun, id: "other-run" });
  assert.equal(await canRestore(root, "demo"), false);
  await resetWorkspace(root, "demo", "files", "original-run");
  assert.deepEqual(await readdir(path.join(dir, "sandbox")), []);
  assert.equal(await readFile(path.join(dir, "memory.json"), "utf8"), memoryText);
  await assertMissing(path.join(dir, "run.json"));
  assert.equal(await canRestore(root, "demo"), true);
  const reference = JSON.parse(await readFile(path.join(dir, "reset.json"), "utf8"));
  assert.equal(reference.workspace, "demo");
  assert.equal(await readFile(path.join(root, ".resets", reference.backup, "sandbox/notes/source.txt"), "utf8"), "original text");
  await writeText(path.join(dir, "sandbox/new.txt"), "after reset");
  await restoreWorkspace(root, "demo", null);
  assert.equal(await readFile(path.join(dir, "sandbox/notes/source.txt"), "utf8"), "original text");
  assert.equal(await readFile(path.join(dir, "memory.json"), "utf8"), memoryText);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "run.json"), "utf8")), stoppedRun);
  await assertMissing(path.join(dir, "sandbox/new.txt"));
  assert.equal(await canRestore(root, "demo"), false);
  const archives = await readdir(path.join(root, ".resets"));
  assert.equal(archives.length, 1, "changes after reset are preserved in an archive");
  assert.equal(await readFile(path.join(root, ".resets", archives[0], "sandbox/new.txt"), "utf8"), "after reset");
  assert.equal(await readFile(path.join(root, "other/sandbox/notes/source.txt"), "utf8"), "original text");
  assert.equal(JSON.parse(await readFile(path.join(root, "other/run.json"), "utf8")).id, "other-run");
});

test("reset all clears memory; a fresh workspace can reset and restore with null run ID", async t => {
  const root = await fixture(t);
  const dir = await seed(root);
  await resetWorkspace(root, "demo", "all", "original-run");
  await assertMissing(path.join(dir, "memory.json"));
  await assertMissing(path.join(dir, "run.json"));
  await restoreWorkspace(root, "demo", null);
  assert.equal(await readFile(path.join(dir, "memory.json"), "utf8"), memoryText);
  await resetWorkspace(root, "fresh", "files", null);
  assert.equal(await canRestore(root, "fresh"), true);
  await restoreWorkspace(root, "fresh", null);
  assert.deepEqual(await readdir(path.join(root, "fresh/sandbox")), []);
});

test("reset and restore refuse running or stale runs without changing user data", async t => {
  const root = await fixture(t);
  const dir = await seed(root, "demo", { ...stoppedRun, status: "running" });
  await assert.rejects(resetWorkspace(root, "demo", "files", "original-run"), /Stop the current run/);
  await writeText(path.join(dir, "run.json"), JSON.stringify(stoppedRun));
  await assert.rejects(resetWorkspace(root, "demo", "files", "stale"), /stale/);
  assert.equal(await readFile(path.join(dir, "sandbox/notes/source.txt"), "utf8"), "original text");
  await resetWorkspace(root, "demo", "all", "original-run");
  await assert.rejects(restoreWorkspace(root, "demo", "original-run"), /stale/);
  await assert.rejects(restoreWorkspace(root, "demo", undefined), /stale/);
  await writeText(path.join(dir, "run.json"), JSON.stringify({ ...stoppedRun, id: "new-run", status: "running" }));
  await assert.rejects(restoreWorkspace(root, "demo", "new-run"), /Stop the current run/);
  assert.equal(await canRestore(root, "demo"), true);
  await writeText(path.join(dir, "run.json"), JSON.stringify({ ...stoppedRun, id: "new-run" }));
  await restoreWorkspace(root, "demo", "new-run");
  assert.equal(await readFile(path.join(dir, "sandbox/notes/source.txt"), "utf8"), "original text");
});

test("invalid workspace names and reset scopes cannot target another directory", async t => {
  const root = await fixture(t);
  await seed(root);
  for (const workspace of ["../demo", ".resets", "demo/../other", "constructor", "/outside"]) {
    await assert.rejects(resetWorkspace(root, workspace, "all", null), /Workspace/);
    await assert.rejects(restoreWorkspace(root, workspace, null), /Workspace/);
    await assert.rejects(canRestore(root, workspace), /Workspace/);
  }
  await assert.rejects(resetWorkspace(root, "demo", "everything", "original-run"), /scope/);
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes/source.txt"), "utf8"), "original text");
});

test("backup references are bound to the workspace and reject path injection", async t => {
  const root = await fixture(t);
  const dir = await seed(root);
  await resetWorkspace(root, "demo", "all", "original-run");
  const reference = JSON.parse(await readFile(path.join(dir, "reset.json"), "utf8"));
  for (const value of [
    { ...reference, backup: "../other" },
    { ...reference, backup: "/tmp" },
    { ...reference, workspace: "other" },
    { ...reference, backup: reference.backup.replace("demo--", "other--") },
    { ...reference, version: 2 },
  ]) {
    await writeText(path.join(dir, "reset.json"), JSON.stringify(value));
    await assert.rejects(canRestore(root, "demo"), /reset reference/);
    await assert.rejects(restoreWorkspace(root, "demo", null), /reset reference/);
  }
  await writeText(path.join(dir, "reset.json"), JSON.stringify(reference));
  const backup = path.join(root, ".resets", reference.backup);
  await rename(backup, `${backup}-moved`);
  assert.equal(await canRestore(root, "demo"), false);
  await assert.rejects(restoreWorkspace(root, "demo", null), /No reset/);
  assert.deepEqual(await readdir(path.join(dir, "sandbox")), []);
});

test("reset refuses symlinked roots, workspaces, archive directories, and sandbox contents", async t => {
  const root = await fixture(t);
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "untouched");
  await symlink(outside, path.join(root, "linked-root"));
  await assert.rejects(resetWorkspace(path.join(root, "linked-root"), "demo", "all", null), /Not a real directory/);
  await symlink(outside, path.join(root, "linked-workspace"));
  await assert.rejects(resetWorkspace(root, "linked-workspace", "all", null), /Not a real directory/);
  const dir = await seed(root);
  await symlink(outside, path.join(dir, "sandbox/linked"));
  await assert.rejects(resetWorkspace(root, "demo", "all", "original-run"), /Symlinks/);
  await rm(path.join(dir, "sandbox/linked"));
  await symlink(outside, path.join(root, ".resets"));
  await assert.rejects(resetWorkspace(root, "demo", "all", "original-run"), /Not a real directory/);
  assert.equal(await readFile(path.join(outside, "secret.txt"), "utf8"), "untouched");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
});

test("restore rejects a symlinked backup and never revives an archived running run", async t => {
  const root = await fixture(t);
  const dir = await seed(root);
  await resetWorkspace(root, "demo", "all", "original-run");
  const reference = JSON.parse(await readFile(path.join(dir, "reset.json"), "utf8"));
  const backup = path.join(root, ".resets", reference.backup);
  await writeText(path.join(backup, "run.json"), JSON.stringify({ ...stoppedRun, status: "running" }));
  assert.equal(await canRestore(root, "demo"), false);
  await assert.rejects(restoreWorkspace(root, "demo", null), /running run/);
  await rename(backup, `${backup}-moved`);
  await symlink(`${backup}-moved`, backup);
  await assert.rejects(canRestore(root, "demo"), /Not a real directory/);
  await assert.rejects(restoreWorkspace(root, "demo", null), /Not a real directory/);
  assert.deepEqual(await readdir(path.join(dir, "sandbox")), []);
});

test("storage reads reject hard links, symlinks, and files over the byte limit", async t => {
  const root = await fixture(t);
  await writeText(path.join(root, "original.txt"), "hello");
  await link(path.join(root, "original.txt"), path.join(root, "hardlink.txt"));
  await assert.rejects(readText(path.join(root, "hardlink.txt")), /Invalid or oversized/);
  await symlink(path.join(root, "original.txt"), path.join(root, "symlink.txt"));
  await assert.rejects(readText(path.join(root, "symlink.txt")));
  await writeText(path.join(root, "oversized.txt"), "一".repeat(11000));
  await assert.rejects(readText(path.join(root, "oversized.txt")), /Invalid or oversized/);
  assert.equal(await readText(path.join(root, "missing.txt")), null);
  const dir = await seed(root);
  await link(path.join(root, "original.txt"), path.join(dir, "sandbox/hardlink.txt"));
  await assert.rejects(resetWorkspace(root, "demo", "all", "original-run"), /unlinked files/);
});


test("reset and restore roll back failed workspace swaps without losing files", async t => {
  const root = await fixture(t);
  const dir = await seed(root);
  const originalRename = fs.rename;
  const failPromotion = async (operation, fromMatches) => {
    fs.rename = async (from, to) => {
      if (to === dir && fromMatches(from)) throw new Error("injected promotion failure");
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    try { await assert.rejects(operation(), /injected promotion failure/); }
    finally { fs.rename = originalRename; syncBuiltinESMExports(); }
  };
  await failPromotion(() => resetWorkspace(root, "demo", "all", "original-run"), from => path.basename(from).startsWith(".pending-"));
  assert.equal(await readFile(path.join(dir, "sandbox/notes/source.txt"), "utf8"), "original text");
  assert.equal(await readFile(path.join(dir, "memory.json"), "utf8"), memoryText);
  assert.equal(await canRestore(root, "demo"), false);
  await resetWorkspace(root, "demo", "all", "original-run");
  const reference = JSON.parse(await readFile(path.join(dir, "reset.json"), "utf8"));
  const backup = path.join(root, ".resets", reference.backup);
  await writeText(path.join(dir, "sandbox/new.txt"), "current file");
  await failPromotion(() => restoreWorkspace(root, "demo", null), from => from === backup);
  assert.equal(await readFile(path.join(dir, "sandbox/new.txt"), "utf8"), "current file");
  assert.equal(await readFile(path.join(backup, "sandbox/notes/source.txt"), "utf8"), "original text");
  assert.equal(await canRestore(root, "demo"), true);
});
