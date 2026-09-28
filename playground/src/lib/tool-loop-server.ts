import { open, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { characters, completionChecks, DEFAULT_READ_LIMIT, DEFAULT_WRITE_LIMIT, EXCERPT_LIMIT, isLegacyCompletionNote, object, parseProgram, validateFilePaths, validateMemory, validateName } from "./tool-loop.ts";
import type { Action, Decision, ExecutedAction, FileSegmentAction, FileView, MemoryIndex, MemoryValue, Observation, PythonAction, Reading, Run, Snapshot, Step } from "./tool-loop.ts";
import type { JSONContent, SystemOneRequest, SystemOneResponse } from "./kev.ts";
import { canRestore, directory, readText, resetWorkspace, restoreWorkspace, writeText } from "./tool-loop-storage.ts";
import { buildPythonStatement, PYTHON_FUNCTIONS } from "./python-dictionary.ts";
import type { PythonFunction } from "./python-dictionary.ts";
import { buildFilePatch, editPreview, visibleRanges } from "./file-segments.ts";
import { validatePath } from "./tool-loop.ts";
import { createTokenCounter, prepareModelRequest } from "./model-input-budget.ts";
import type { TokenCounter } from "./model-input-budget.ts";
import { MODEL_ID } from "./model-config.ts";

const MAX_CONTENT = 32000;
const MAX_TOTAL = 96000;
const version = (text: string) => createHash("sha256").update(text).digest("hex");
const TOOL_DESCRIPTIONS: Record<Action["tool"], string> = {
  create_file: "Create a new empty file. Existing files are never overwritten.",
  append_file: "Continue writing at the end of the file shown in reading. Add a fragment or character; delete nothing.",
  replace_file_range: "Edit inside the visible source: select characters to replace, or select an insertion cursor to add text without deleting any. Then choose literal text.",
  write_file: "Create or update a sandbox file.",
  write_python: "Compose a Python statement by selecting a target file, a function, and a string separately.",
  write_memory: "Add or replace a memory value. Memory is returned in every future decision.",
  read_file: "Read a small window of a file. The text is returned for the next decision; memory is unchanged.",
  read_goal: "Read another page of the saved goal memory. File reading and working memory are preserved.",
  remember_excerpt: "Select a useful short excerpt from the current reading and save its source index in memory.",
  edit_memory: "Choose an existing memory entry, then replace it with a better excerpt from the current reading.",
  delete_memory: "Delete an irrelevant or outdated memory entry.",
  finish: "Finish the task when the goal is fulfilled and all required outputs are complete.",
  END: "Stop when the goal is fulfilled and all required outputs are complete.",
};
type Candidates = Record<string, ExecutedAction>;
const ARGUMENT_INSTRUCTIONS: Partial<Record<Action["tool"], string>> = {
  create_file: "Choose the missing target file to create empty. Select the path needed by the goal; source text is added in later edits.",
  write_file: "Choose a supplied file write that advances the goal. This replaces that file's contents with the selected text.",
  write_memory: "Choose a useful supplied note to add or replace at its memory key. This only updates memory, not the program or its output checks. Identical notes and notes with unmet prerequisites are unavailable.",
  read_file: "Choose a useful file page to inspect. The tool returns that limited page for your next decision; reading does not save anything to memory.",
  read_goal: "Choose which page of the saved goal to read next. This preserves file reading and working memory.",
  remember_excerpt: "Choose an important excerpt from the current reading to save with its source index. Excerpts already stored in memory are unavailable.",
  edit_memory: "Choose a visible excerpt that improves the selected memory entry. It replaces that entry; an identical value is unavailable.",
  delete_memory: "Choose the existing memory key to remove because its note is irrelevant or outdated. This does not change files or mark the task complete.",
};

function sameMemoryValue(a: MemoryValue | null | undefined, b: MemoryValue | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a === "string" || typeof b === "string") return false;
  return a.kind === b.kind && a.path === b.path && a.start === b.start && a.end === b.end && a.quote === b.quote;
}
function needsPassedChecks(action: ExecutedAction | Action): boolean {
  return action.tool === "write_memory" && (action.requiresChecks === true || isLegacyCompletionNote(action));
}
function allRequiredChecksPassed(state: Snapshot & { run: Run }): boolean {
  const checks = completionChecks(state.run.program, state);
  return checks.length > 0 && checks.every(check => check.met);
}
function shortNote(value: MemoryValue): JSONContent {
  if (typeof value !== "string") return { source: { path: value.path, start: value.start, end: value.end } };
  const chars = characters(value);
  return { text: chars.slice(0, 120).join(""), characters: chars.length, truncated: chars.length > 120 };
}
function candidatePreview(choice: string, action: ExecutedAction, memory: Snapshot["memory"]): JSONContent {
  switch (action.tool) {
    case "create_file": return { choice, path: action.path, effect: "Create an empty file" };
    case "append_file": return { choice, path: action.path, offset: action.offset, effect: "Append a selected fragment or character" };
    case "replace_file_range": return { choice, path: action.path, start: action.start, end: action.end, effect: action.start === action.end ? "Insert at this cursor; delete nothing" : "Replace these existing characters with selected text" };
    case "write_file": return { choice, path: action.path, characters: characters(action.content).length, effect: "Write supplied file contents" };
    case "write_memory": return { choice, key: action.key, effect: Object.hasOwn(memory, action.key) ? "Replace memory entry" : "Add memory entry", value: shortNote(action.value) };
    case "read_file": return { choice, path: action.path, start: action.offset, limit: action.limit };
    case "read_goal": return { choice, start: action.offset, limit: action.limit, effect: "Read a saved goal page" };
    case "remember_excerpt": return { choice, key: action.key, source: { path: action.value.path, start: action.value.start, end: action.value.end }, effect: "Save an index to the current page" };
    case "edit_memory": return { choice, key: action.key, effect: "Replace this entry with a different visible excerpt" };
    case "delete_memory": return { choice, key: action.key, value: shortNote(memory[action.key]), effect: "Remove this memory entry" };
    default: return { choice, effect: "Finish after the goal is fulfilled" };
  }
}
export class LoopError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

// Candidate excerpts come only from text the model has already received, never unseen file content.
function excerpts(reading: Reading | null | undefined): MemoryIndex[] {
  if (!reading) return [];
  const chars = characters(reading.text);
  const out: MemoryIndex[] = [];
  for (let offset = 0; offset < chars.length; offset += EXCERPT_LIMIT) {
    let start = offset, end = Math.min(offset + EXCERPT_LIMIT, chars.length);
    while (start < end && !chars[start].trim()) start++;
    while (end > start && !chars[end - 1].trim()) end--;
    if (end > start) out.push({ kind: "index", path: reading.path, start: reading.start + start, end: reading.start + end, quote: chars.slice(start, end).join("") });
  }
  return out;
}
function indexKey(index: MemoryIndex) { return `index_${version(index.path).slice(0, 10)}_${index.start}`; }
function readingWindow(file: string, text: string, start: number, limit: number): Reading {
  const chars = characters(text);
  start = Math.min(Math.max(0, start), chars.length);
  const end = Math.min(start + limit, chars.length);
  return { path: file, start, end, totalChars: chars.length, hasMore: end < chars.length, text: chars.slice(start, end).join(""), version: version(text) };
}
function auditView(reading: Reading): FileView {
  const { start, end, totalChars, text } = reading;
  return { start, end, totalChars, text };
}
function goalWindow(run: Pick<Run, "program">, start = 0): FileView {
  const chars = characters(run.program.goal);
  start = Math.min(Math.max(0, start), chars.length);
  const end = Math.min(start + (run.program.readLimit ?? DEFAULT_READ_LIMIT), chars.length);
  return { start, end, totalChars: chars.length, text: chars.slice(start, end).join("") };
}

function textChoice(text: string): string {
  const label = text === "\n" ? "newline" : text === " " ? "space" : text === "\t" ? "tab" : text === "" ? "remove selected text" : "literal source text";
  return `${JSON.stringify(text)} (${label})`;
}

// Keep every configured character, but avoid asking one question with 96 options.
function characterGroups(alphabet: string): Record<string, Record<string, string>> {
  const buckets = new Map<string, [string, string][]>();
  characters(alphabet).forEach((character, index) => {
    const category = /[0-9]/u.test(character) ? "digits" : /\s/u.test(character) ? "whitespace" :
      /[a-z]/u.test(character) ? "lowercase" : /[A-Z]/u.test(character) ? "uppercase" : "symbols";
    const entries = buckets.get(category) ?? [];
    entries.push([`char_${index}`, character]);
    buckets.set(category, entries);
  });
  return Object.fromEntries([...buckets].flatMap(([category, entries]) =>
    Array.from({ length: Math.ceil(entries.length / 8) }, (_, page) =>
      [`${category}_${page + 1}`, Object.fromEntries(entries.slice(page * 8, (page + 1) * 8))])));
}

// The latest attempt is essential context, independent of optional older history.
// Keep resolved choices and actual effects, without replaying old pages or UI audits.
function lastStepContext(step: Step | undefined): JSONContent {
  if (!step) return null;
  const action = step.action;
  const args: Record<string, JSONContent> = {};
  for (const key of ["path", "key", "offset", "limit", "start", "end", "function", "value"] as const) {
    if (key in action) args[key] = action[key as keyof typeof action] as JSONContent;
  }
  if ("content" in action) {
    if (action.tool === "append_file" || action.tool === "replace_file_range") args.content = action.content;
    else if (action.tool === "write_file") {
      args.content_characters = characters(action.content).length;
      args.content_omitted = "Use read_file to inspect the file in bounded pages.";
    }
  }
  const result = step.result;
  const fileChange = result.fileChange ?? (result.fileEdit && "path" in action ? {
    path: action.path, start: result.fileEdit.start, end: result.fileEdit.end,
    insertedChars: result.fileEdit.insertedChars, totalChars: result.fileEdit.after.totalChars,
  } : undefined);
  return {
    number: step.number, tool: action.tool, choice: step.choice, arguments: args,
    outcome: {
      ok: result.ok, message: result.message,
      ...(result.changed !== undefined ? { changed: result.changed } : {}),
      ...(fileChange ? { file_change: fileChange } : {}),
      ...(result.memoryChange ? { memory_change: result.memoryChange } : {}),
      ...(result.reading ? { reading: { path: result.reading.path, start: result.reading.start, end: result.reading.end, totalChars: result.reading.totalChars } } : {}),
      ...(result.goalReading ? { goal_page: { start: result.goalReading.start, end: result.goalReading.end, totalChars: result.goalReading.totalChars } } : {}),
    },
  };
}

export class ToolLoop {
  readonly root: string;
  readonly endpoint: string;
  private readonly fetcher: typeof fetch;
  private readonly apiKey?: string;
  private readonly tokenCounter: TokenCounter;
  constructor(root: string, endpoint = "http://127.0.0.1:8009", fetcher: typeof fetch = fetch, apiKey?: string, tokenCounter?: TokenCounter) {
    this.root = root; this.endpoint = endpoint; this.fetcher = fetcher; this.apiKey = apiKey; this.tokenCounter = tokenCounter ?? createTokenCounter(endpoint, fetcher, apiKey);
  }
  private async location(workspace: string) {
    validateName(workspace);
    const dir = path.resolve(this.root, workspace);
    await directory(path.join(dir, "sandbox"));
    return dir;
  }
  private async memory(dir: string): Promise<Record<string, MemoryValue>> {
    const value: unknown = JSON.parse(await readText(path.join(dir, "memory.json"), MAX_TOTAL) ?? "{}");
    validateMemory(value);
    return value;
  }
  async snapshot(workspace: string): Promise<Snapshot> {
    const dir = await this.location(workspace);
    const files: Snapshot["files"] = [];
    let total = 0;
    const walk = async (sub = "") => {
      const current = path.join(dir, "sandbox", sub);
      await directory(current);
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const relative = sub ? `${sub}/${entry.name}` : entry.name;
        validatePath(relative);
        if (entry.isSymbolicLink()) throw new Error("Symlinks are not allowed in the sandbox.");
        if (entry.isDirectory()) { await walk(relative); continue; }
        const content = await readText(path.join(current, entry.name));
        if (content === null) continue;
        total += Buffer.byteLength(content);
        if (files.length >= 32 || total > MAX_TOTAL) throw new Error("Sandbox exceeds 32 files or 96 KB.");
        files.push({ path: relative, content });
      }
    };
    await walk();
    const rawRun = await readText(path.join(dir, "run.json"), 8_000_000);
    const run: Run | null = rawRun ? JSON.parse(rawRun) : null;
    if (run?.reading) {
      const source = files.find(f => f.path === run.reading!.path);
      if (!source || version(source.content) !== run.reading.version) run.reading = null;
    }
    return { workspace, storagePath: dir, files: files.sort((a, b) => a.path.localeCompare(b.path)), memory: await this.memory(dir), run, resetAvailable: await canRestore(this.root, workspace) };
  }
  private async save(workspace: string, run: Run) {
    const dir = await this.location(workspace);
    await writeText(path.join(dir, "run.json"), JSON.stringify(run, null, 2) + "\n");
    return this.snapshot(workspace);
  }
  async start(workspace: string, value: unknown) {
    const program = parseProgram(value);
    const state = await this.snapshot(workspace);
    if (state.run?.status === "running") throw new LoopError("Stop the current run before starting another.", 409);
    const additions = Object.entries(program.initialFiles ?? {}).filter(([file]) => !state.files.some(f => f.path === file));
    validateFilePaths([...state.files.map(f => f.path), ...additions.map(([file]) => file)]);
    if (state.files.length + additions.length > 32 || additions.some(([, text]) => Buffer.byteLength(text) > MAX_CONTENT) ||
        [...state.files.map(f => f.content), ...additions.map(([, text]) => text)].reduce((sum, text) => sum + Buffer.byteLength(text), 0) > MAX_TOTAL) throw new LoopError("Initial files exceed the sandbox size limit.");
    for (const [file, content] of additions) await writeText(path.join(state.storagePath, "sandbox", file), content);
    return this.save(workspace, { id: randomUUID(), program, model: MODEL_ID, status: "running", steps: [], reading: null, goalReading: goalWindow({ program }) });
  }
  private async current(workspace: string, id: unknown) {
    const state = await this.snapshot(workspace);
    if (!state.run || state.run.id !== id) throw new LoopError("This run is stale. Reload the workspace.", 409);
    return state as Snapshot & { run: Run };
  }
  async stop(workspace: string, id: unknown) {
    const { run } = await this.current(workspace, id);
    if (run.status === "running") run.status = "stopped";
    return this.save(workspace, run);
  }
  async reset(workspace: string, scope: "files" | "all", id: unknown) {
    await resetWorkspace(this.root, workspace, scope, id);
    return this.snapshot(workspace);
  }
  async restore(workspace: string, id: unknown) {
    await restoreWorkspace(this.root, workspace, id);
    return this.snapshot(workspace);
  }

  private candidates(state: Snapshot & { run: Run }, tool: Action["tool"], target?: string): Candidates {
    const entries = Object.entries(state.run.program.actions).filter(([, action]) => action.tool === tool);
    const description = entries[0]?.[1].description ?? TOOL_DESCRIPTIONS[tool];
    if (tool === "write_python") return {};
    if (tool === "write_memory") return Object.fromEntries(entries.filter(([, action]) => action.tool === "write_memory" &&
      !sameMemoryValue(state.memory[action.key], action.value) && (!needsPassedChecks(action) || allRequiredChecksPassed(state)))) as Candidates;
    if (tool === "write_file" || tool === "END" || tool === "finish") return Object.fromEntries(entries) as Candidates;
    const result: Candidates = {};
    if (tool === "read_goal") {
      const page = state.run.goalReading ?? goalWindow(state.run);
      const limit = state.run.program.readLimit ?? DEFAULT_READ_LIMIT;
      const offsets = new Set([0]);
      if (page.end < page.totalChars) offsets.add(page.end);
      if (page.start > 0) offsets.add(Math.max(0, page.start - limit));
      for (const offset of offsets) result[`goal_${offset}`] = { tool, description: `Read goal characters [${offset}, ${Math.min(offset + limit, page.totalChars)}) of ${page.totalChars}.`, offset, limit };
    } else if (tool === "create_file" || tool === "append_file" || tool === "replace_file_range") {
      const config = entries[0][1] as FileSegmentAction;
      if (tool === "replace_file_range") {
        const reading = state.run.reading;
        if (!reading || !reading.text || !config.paths.includes(reading.path)) return result;
        for (const [key, range] of Object.entries(visibleRanges(reading))) {
          if (reading.end - reading.start > 16 && key !== "current_view" && !key.startsWith("line_")) continue;
          result[key] = {
          tool, description: `${description} Characters [${range.start}, ${range.end}).`, path: reading.path,
          ...range, content: "", version: reading.version,
          };
        }
      } else config.paths.forEach((file, i) => {
        const existing = state.files.find(f => f.path === file);
        if (tool === "create_file" && !existing && !state.files.some(f => f.path.startsWith(`${file}/`) || file.startsWith(`${f.path}/`))) result[`file_${i}`] = { tool, description, path: file };
        const reading = state.run.reading;
        if (tool === "append_file" && existing && reading?.path === file &&
            reading.version === version(existing.content) && reading.end === characters(existing.content).length) {
          result[`file_${i}`] = { tool, description, path: file, offset: reading.end, content: "", version: reading.version };
        }
      });
    } else if (tool === "read_file") {
      const limit = state.run.program.readLimit ?? DEFAULT_READ_LIMIT;
      state.files.forEach((file, i) => {
        const total = characters(file.content).length;
        const last = [...state.run.steps].reverse().find(s => s.result.reading?.path === file.path && s.result.reading.version === version(file.content))?.result.reading;
        const offsets = new Set([0]);
        if (total > limit) offsets.add(total - limit);
        if (last) {
          if (last.end < total) offsets.add(last.end);
          if (last.start > 0) offsets.add(Math.max(0, last.start - limit));
        }
        for (const offset of offsets) result[`read_${i}_${offset}`] = {
          tool, description: `${description} ${file.path}: characters ${offset}–${Math.min(offset + limit, total)} of ${total}${last?.end === offset ? " (next page)" : ""}.`,
          path: file.path, offset, limit,
        };
      });
    } else if (tool === "delete_memory") {
      for (const key of Object.keys(state.memory)) result[key] = { tool, description: `Forget memory entry ${key}.`, key };
    } else if (tool === "edit_memory" && target === undefined) {
      for (const key of Object.keys(state.memory)) {
        const choices = this.candidates(state, tool, key);
        const first = Object.values(choices)[0];
        if (first) result[key] = first;
      }
    } else {
      if (tool === "edit_memory" && (!target || !Object.hasOwn(state.memory, target))) return result;
      excerpts(state.run.reading).forEach((value, i) => {
        if (tool === "remember_excerpt" && Object.values(state.memory).some(saved => sameMemoryValue(saved, value))) return;
        if (tool === "edit_memory" && sameMemoryValue(state.memory[target!], value)) return;
        result[`excerpt_${i + 1}`] = { tool, description, key: target ?? indexKey(value), value };
      });
    }
    return result;
  }
  private async execute(state: Snapshot & { run: Run }, action: ExecutedAction): Promise<Observation> {
    const dir = state.storagePath;
    if (action.tool === "END" || action.tool === "finish") {
      const missing = completionChecks(state.run.program, state).filter(c => !c.met);
      return { ok: missing.length === 0, message: missing.length ? `Finish rejected: unmet checks ${missing.map(c => c.name).join(", ")}. Continue inspecting or editing the file; the task is incomplete.` : `Model selected ${action.tool}.` };
    }
    if (action.tool === "read_goal") {
      const goalReading = goalWindow(state.run, action.offset);
      state.run.goalReading = goalReading;
      return { ok: true, message: `Read goal memory [${goalReading.start}, ${goalReading.end}) of ${goalReading.totalChars} characters. File reading and working memory unchanged.`, goalReading };
    }
    if (action.tool === "read_file") {
      const text = await readText(path.join(dir, "sandbox", action.path));
      if (text === null) throw new Error(`File not found: ${action.path}`);
      const chars = characters(text), start = Math.min(action.offset, chars.length);
      const end = Math.min(start + Math.min(action.limit, state.run.program.readLimit ?? DEFAULT_READ_LIMIT), chars.length);
      const reading: Reading = { path: action.path, start, end, totalChars: chars.length, hasMore: end < chars.length, text: chars.slice(start, end).join(""), version: version(text) };
      state.run.reading = reading;
      return { ok: true, message: `Read ${action.path} [${start}, ${end}) of ${chars.length} characters. ${reading.hasMore ? "More text is available." : "End of file."} Memory unchanged.`, reading };
    }
    if (action.tool === "create_file" || action.tool === "append_file" || action.tool === "replace_file_range") {
      const file = path.join(dir, "sandbox", action.path);
      const limit = state.run.program.readLimit ?? DEFAULT_READ_LIMIT;
      if (action.tool === "create_file") {
        if (state.files.length >= 32) throw new Error("Sandbox file limit reached.");
        await directory(path.dirname(file));
        const handle = await open(file, "wx", 0o600);
        await handle.close();
        const reading = readingWindow(action.path, "", 0, limit);
        state.run.reading = reading;
        return { ok: true, message: `Created empty file ${action.path}. Choose a fragment to append next. Memory unchanged.`, reading,
          fileChange: { path: action.path, start: 0, end: 0, insertedChars: 0, totalChars: 0 },
          fileEdit: { before: null, after: auditView(reading), start: 0, end: 0, insertedChars: 0 } };
      }
      const source = await readText(file);
      if (source === null || version(source) !== action.version) throw new Error("The target file has changed. Inspect its current contents before editing again.");
      if (action.tool === "replace_file_range") {
        const reading = state.run.reading;
        if (!reading || reading.path !== action.path || reading.version !== action.version || action.start < reading.start || action.end > reading.end) throw new Error("Only a range in the current reading can be replaced. Read the target page first.");
      } else {
        const reading = state.run.reading;
        if (!reading || reading.path !== action.path || reading.version !== action.version || reading.end !== action.offset || action.offset !== characters(source).length) {
          throw new Error("Read the current end of this file before appending.");
        }
      }
      const start = action.tool === "append_file" ? action.offset : action.start;
      const end = action.tool === "append_file" ? action.offset : action.end;
      const patch = buildFilePatch(source, start, end, action.content, state.run.program.writeLimit ?? DEFAULT_WRITE_LIMIT);
      const others = state.files.filter(f => f.path !== action.path);
      if (Buffer.byteLength(patch.content) > MAX_CONTENT || others.reduce((sum, f) => sum + Buffer.byteLength(f.content), Buffer.byteLength(patch.content)) > MAX_TOTAL) throw new Error("Sandbox size limit reached.");
      await writeText(file, patch.content);
      const viewStart = action.tool === "append_file" ? Math.max(0, patch.totalChars - limit) : Math.max(0, Math.min(start, patch.totalChars - limit));
      const reading = readingWindow(action.path, patch.content, viewStart, limit);
      state.run.reading = reading;
      const fileChange = { path: action.path, start, end, insertedChars: patch.insertedChars, totalChars: patch.totalChars };
      const fileEdit = { before: auditView(readingWindow(action.path, source, Math.min(viewStart, start), limit)), after: auditView(reading), start, end, insertedChars: patch.insertedChars };
      return { ok: true, message: `${action.tool === "append_file" ? "Appended" : "Replaced range [" + start + ", " + end + ") with"} ${patch.insertedChars} characters in ${action.path}. File now has ${patch.totalChars} characters. The bounded editor view is returned for the next decision. Memory unchanged.`, reading, fileChange, fileEdit };
    }
    if (action.tool === "write_file" || action.tool === "write_python") {
      const others = state.files.filter(f => f.path !== action.path);
      if (others.length >= 32 || Buffer.byteLength(action.content) > MAX_CONTENT ||
          others.reduce((n, f) => n + Buffer.byteLength(f.content), Buffer.byteLength(action.content)) > MAX_TOTAL) throw new Error("Sandbox size limit reached.");
      const previous = await readText(path.join(dir, "sandbox", action.path));
      await writeText(path.join(dir, "sandbox", action.path), action.content);
      if (state.run.reading?.path === action.path) state.run.reading = null;
      const limit = state.run.program.readLimit ?? DEFAULT_READ_LIMIT;
      return { ok: true, message: `Wrote ${action.path} (${Buffer.byteLength(action.content)} bytes).`,
        fileEdit: { before: previous === null ? null : auditView(readingWindow(action.path, previous, 0, limit)), after: auditView(readingWindow(action.path, action.content, 0, limit)),
          start: 0, end: characters(previous ?? "").length, insertedChars: characters(action.content).length } };
    }
    // Re-read before applying a selected update so a concurrent/no-op write cannot
    // overwrite newer entries or be reported as fresh progress.
    const memory = await this.memory(dir);
    const before = memory[action.key] ?? null;
    if (needsPassedChecks(action)) {
      const fresh = await this.snapshot(state.workspace);
      if (!allRequiredChecksPassed({ ...fresh, run: state.run })) return { ok: false, changed: false, message: "Memory update rejected: required completion checks have not passed." };
    }
    if (action.tool === "delete_memory") {
      if (!Object.hasOwn(memory, action.key)) return { ok: true, changed: false, message: `Unchanged memory[${action.key}]: this entry is already absent.`, memoryChange: { key: action.key, before: null, after: null } };
      delete memory[action.key];
    } else {
      if (action.tool === "edit_memory" && !Object.hasOwn(memory, action.key)) throw new Error("Memory entry no longer exists.");
      if (sameMemoryValue(before, action.value)) return { ok: true, changed: false, message: `Unchanged memory[${action.key}]: the selected value is already stored.`, memoryChange: { key: action.key, before, after: before } };
      if (action.tool === "remember_excerpt") {
        const saved = Object.entries(memory).find(([, value]) => sameMemoryValue(value, action.value));
        if (saved) return { ok: true, changed: false, message: `Unchanged memory: this excerpt is already indexed in memory[${saved[0]}].`, memoryChange: { key: action.key, before, after: before } };
      }
      if (action.tool === "remember_excerpt" || action.tool === "edit_memory") {
        const reading = state.run.reading;
        const source = await readText(path.join(dir, "sandbox", action.value.path));
        if (!reading || source === null || version(source) !== reading.version ||
            action.value.start < reading.start || action.value.end > reading.end ||
            characters(reading.text).slice(action.value.start - reading.start, action.value.end - reading.start).join("") !== action.value.quote) {
          throw new Error("The source reading has changed. Read the file again before indexing it.");
        }
      }
      memory[action.key] = action.value;
    }
    validateMemory(memory);
    await writeText(path.join(dir, "memory.json"), JSON.stringify(memory, null, 2) + "\n");
    return { ok: true, changed: true, message: `${action.tool === "delete_memory" ? "Deleted" : before === null ? "Added" : "Updated"} memory[${action.key}].`, memoryChange: { key: action.key, before, after: memory[action.key] ?? null } };
  }
  private async decide(request: SystemOneRequest, question: string, stage: Decision["stage"]): Promise<Decision> {
    const prepared = await prepareModelRequest(request, this.tokenCounter);
    const response = await this.fetcher(`${this.endpoint.replace(/\/$/, "")}/v1/systemone`, {
      method: "POST", headers: { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify(prepared.request), signal: AbortSignal.timeout(120_000), cache: "no-store",
    });
    if (!response.ok) throw new Error(`Model API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    const result: SystemOneResponse = await response.json();
    if (result.model !== undefined && result.model !== MODEL_ID) throw new Error(`Expected ${MODEL_ID}, but the server returned ${result.model}.`);
    const answer = result.answers?.[question], asked = request.questions[question];
    if (asked.type !== "choice" || answer?.type !== "choice" || typeof answer.choice !== "string" ||
        !Object.hasOwn(asked.criteria, answer.choice) || !object(answer.probabilities) ||
        Object.keys(answer.probabilities).length !== Object.keys(asked.criteria).length ||
        Object.entries(answer.probabilities).some(([key, p]) => !Object.hasOwn(asked.criteria, key) || typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) ||
        !Number.isFinite(answer.confidence) || !Number.isFinite(result.latency_ms)) throw new Error(`Model returned an invalid ${stage} choice or distribution.`);
    const reported = result.usage?.input_tokens;
    if (reported !== undefined && (!Number.isSafeInteger(reported) || reported !== prepared.inputTokens)) throw new Error(`Model tokenizer mismatch: preflight counted ${prepared.inputTokens} input tokens but the server reported ${reported}. Verify that token counting and inference use the same Kev server.`);
    return { stage, choice: answer.choice, probabilities: answer.probabilities, confidence: answer.confidence, latency_ms: result.latency_ms,
      model: MODEL_ID, input_tokens: prepared.inputTokens, ...(reported !== undefined ? { reported_input_tokens: reported } : {}), ...(prepared.compacted ? { context_compacted: true } : {}) };
  }
  async step(workspace: string, id: unknown, expectedStep: unknown) {
    const state = await this.current(workspace, id), run = state.run;
    if (expectedStep !== run.steps.length) throw new LoopError("Step changed. Reload the workspace before continuing.", 409);
    if (run.status !== "running") return state;
    let phase = "tool selection";
    try {
      parseProgram(run.program); // Reject legacy whole-file-copy tools when continuing an old run.
      run.goalReading ??= goalWindow(run);
      const checks = completionChecks(run.program, state), missing = checks.filter(c => !c.met);
      const groups = new Map<Action["tool"], Candidates>();
      for (const action of Object.values(run.program.actions)) {
        if ((action.tool === "finish" || action.tool === "END") && missing.length) continue;
        const candidates = this.candidates(state, action.tool);
        if (action.tool === "write_python" || Object.keys(candidates).length) groups.set(action.tool, candidates);
      }
      if (characters(run.program.goal).length > (run.program.readLimit ?? DEFAULT_READ_LIMIT)) groups.set("read_goal", this.candidates(state, "read_goal"));
      if (!groups.size) throw new Error("No tools are currently available. Required checks are incomplete; revise the dictionary before starting another run.");
      const modelState = {
        goal_memory: run.goalReading,
        persistent_memory: state.memory,
        reading: run.reading ?? null,
        reading_limit: run.program.readLimit ?? DEFAULT_READ_LIMIT,
        writing_limit: run.program.writeLimit ?? DEFAULT_WRITE_LIMIT,
        completion_status: missing.length ? "INCOMPLETE" : "All checks passed",
        completion_checks: checks.map(c => `${c.met ? "DONE" : "NOT DONE"}: ${c.requirement}${"detail" in c && c.detail ? ` ${c.detail}` : ""}`),
        sandbox_files: state.files.map(f => ({ path: f.path, characters: characters(f.content).length })),
        last_step: lastStepContext(run.steps.at(-1)),
        recent_steps: run.steps.slice(-3, -1).map(s => ({ number: s.number, tool: s.action.tool, choice: s.choice, ok: s.result.ok, message: s.result.message })),
      };
      const toolCriteria = Object.fromEntries([...groups].map(([tool, candidates]) => {
        if (tool === "write_python") {
          const config = Object.values(run.program.actions).find((action): action is PythonAction => action.tool === "write_python")!;
          return [tool, { description: TOOL_DESCRIPTIONS[tool], argument_stages: ["target file", "function", "string value"], targets: config.paths, functions: config.functions }];
        }
        const entries = Object.entries(candidates);
        return [tool, { description: TOOL_DESCRIPTIONS[tool], available_choices: entries.length,
          previews: entries.slice(0, 3).map(([choice, action]) => candidatePreview(choice, action, state.memory)),
          ...(entries.length > 3 ? { preview_remaining: entries.length - 3 } : {}),
        }];
      }));
      const decisions: Decision[] = [];
      const selectedChoices: { stage: Decision["stage"]; choice: string; selected: JSONContent }[] = [];
      const ask = async (question: string, stage: Decision["stage"], instructions: string, criteria: Record<string, JSONContent>, extra: Record<string, JSONContent> = {}) => {
        const decision = await this.decide({ model: MODEL_ID, state: {
          ...modelState, ...extra,
          current_step: { number: run.steps.length + 1, stage, execution_status: "not_executed", decisions: [...selectedChoices] },
        }, questions: { [question]: { type: "choice", instructions: `Continue from last_step (your last executed action and its outcome) and current_step.decisions (your choices in this unfinished operation). Choices are not executed until all arguments are selected. ${instructions}`, criteria } } }, question, stage);
        decisions.push(decision);
        selectedChoices.push({ stage, choice: decision.choice, selected: criteria[decision.choice] });
        return decision;
      };
      const toolDecision = await ask("next_tool", "tool", "Choose one action that advances goal_memory. Continue from the visible source in reading and last_step. Read an existing file before editing it. Use append_file to continue at the file end; a syntax check can fail normally while a statement is still being written. Use replace_file_range to edit inside the visible source, either replacing characters or inserting at a cursor. Memory notes are not proof of completion. persistent_memory contains working notes. read_goal selects another goal page. finish becomes available when all checks pass.", toolCriteria);
      const selectedTool = toolDecision.choice as Action["tool"];
      let choice = selectedTool as string, action: ExecutedAction;
      let candidates = groups.get(selectedTool)!;
      if (selectedTool === "append_file" || selectedTool === "replace_file_range") {
        const config = Object.values(run.program.actions).find((a): a is Extract<FileSegmentAction, { tool: "append_file" | "replace_file_range" }> => a.tool === selectedTool)!;
        const extra: Record<string, JSONContent> = { selected_tool: selectedTool };
        const range = selectedTool === "replace_file_range";
        phase = range ? "write range selection" : "write target selection";
        const rangeOptions = Object.fromEntries(Object.entries(candidates).map(([key, candidate]) => [key, {
          ...("path" in candidate ? { path: candidate.path } : {}),
          ...("start" in candidate ? { start: candidate.start, end: candidate.end,
            delete: editPreview(run.reading!, candidate, "").removed,
            ...(candidate.end - candidate.start > 80 ? { delete_clipped: true } : {}) } : "offset" in candidate ? { offset: candidate.offset } : {}),
          ...(!range ? { effect: "Append; preserve all existing text" } : {}),
        }]));
        if (range && run.reading!.end - run.reading!.start > 16) {
          rangeOptions.focus_range = { effect: "Locate a smaller token or character range inside this reading before replacing it" };
        }
        let target = await ask(range ? "write_range" : "write_target", range ? "write_range" : "write_target",
          range ? "Where should text be edited? Select existing characters to replace, or an insertion cursor with start=end to add text without deleting anything. Select the smallest suitable range. All other text is preserved." : "Which visible file end should receive new text? All existing characters will be preserved.",
          rangeOptions, extra);
        if (target.choice === "focus_range") {
          let focus = { ...run.reading! };
          while (focus.end - focus.start > 16) {
            const width = Math.ceil((focus.end - focus.start) / 4);
            const parts = Object.fromEntries(Array.from({ length: Math.ceil((focus.end - focus.start) / width) }, (_, i) => {
              const start = focus.start + i * width, end = Math.min(start + width, focus.end);
              return [`part_${i + 1}`, { start, end }];
            }));
            phase = "range focus selection";
            const part = await ask("write_range_group", "write_range_group", "Which part contains the characters to correct? This only narrows the search; no text is changed yet. Continue narrowing until you can select an exact small range.",
              Object.fromEntries(Object.entries(parts).map(([key, part]) => [key, {
                ...part, text: characters(focus.text).slice(part.start - focus.start, Math.min(part.end - focus.start, part.start - focus.start + 40)).join(""),
                ...(part.end - part.start > 40 ? { clipped: true } : {}),
              }])), extra);
            const selected = parts[part.choice];
            focus = { ...focus, ...selected, text: characters(focus.text).slice(selected.start - focus.start, selected.end - focus.start).join("") };
          }
          candidates = Object.fromEntries(Object.entries(visibleRanges(focus)).map(([key, span]) => [key, {
            tool: "replace_file_range", description: TOOL_DESCRIPTIONS.replace_file_range,
            path: focus.path, ...span, content: "", version: focus.version,
          }]));
          target = await ask("write_range", "write_range", "Select characters to replace or a start=end cursor to insert without deleting anything. Text outside this range stays unchanged.",
            Object.fromEntries(Object.entries(visibleRanges(focus)).map(([key, span]) => [key, { ...span, delete: editPreview(focus, span, "").removed }])), extra);
        }
        const edit = candidates[target.choice] as Extract<ExecutedAction, { tool: "append_file" | "replace_file_range" }>;
        extra.selected_path = edit.path;
        const inserting = edit.tool === "replace_file_range" && edit.start === edit.end;
        extra.edit = { operation: inserting ? "insert" : range ? "replace" : "append", path: edit.path, start: edit.tool === "append_file" ? edit.offset : edit.start, end: edit.tool === "append_file" ? edit.offset : edit.end };
        if (edit.tool === "replace_file_range") extra.selected_range = { start: edit.start, end: edit.end };
        const modes: Record<string, JSONContent> = {};
        if (config.fragments) modes.fragment = { effect: "Choose one of these literal fragments", fragments: config.fragments };
        if (config.characters) modes.character = "Choose one Unicode character to type.";
        phase = "write input mode selection";
        const mode = await ask("write_mode", "write_mode", "Choose fragment input if its listed literals contain the text needed for this edit. Choose character input to type a character separately.", modes, extra);
        extra.selected_input_mode = mode.choice;
        let inputs = mode.choice === "fragment" ? config.fragments! : Object.fromEntries(characters(config.characters!).map((character, i) => [`char_${i}`, character]));
        if (mode.choice === "character" && Object.keys(inputs).length > 8) {
          phase = "character group selection";
          const groups = characterGroups(config.characters!);
          const group = await ask("write_character_group", "write_character_group", "Choose the character group containing the literal character to insert for this edit. The next decision selects one character from this group.",
            Object.fromEntries(Object.entries(groups).map(([key, members]) => [key, { characters: Object.values(members).join("") }])), extra);
          inputs = groups[group.choice];
          extra.selected_character_group = group.choice;
        }
        phase = `${mode.choice} selection`;
        const editRange = { start: edit.tool === "append_file" ? edit.offset : edit.start, end: edit.tool === "append_file" ? edit.offset : edit.end };
        const sharedPreview = editPreview(run.reading!, editRange, "");
        extra.edit_preview = {
          before: sharedPreview.before, removed: sharedPreview.removed,
          preview_start: sharedPreview.preview_start, preview_end: sharedPreview.preview_end,
          clipped_before: sharedPreview.clipped_before, clipped_after: sharedPreview.clipped_after,
          removed_clipped: sharedPreview.removed_clipped,
        };
        const options = Object.fromEntries(Object.entries(inputs).map(([key, text]) => {
          const preview = editPreview(run.reading!, editRange, text);
          return [key, {
            insert: text, effect: `${inserting ? "Insert at cursor" : range ? "Replace selected text with" : "Append"} ${textChoice(text)}`,
            preview: { after: preview.after, after_preview_end: preview.after_preview_end, after_clipped: preview.after_clipped },
          }];
        }));
        const content = await ask(mode.choice === "fragment" ? "write_fragment" : "write_character", mode.choice === "fragment" ? "write_fragment" : "write_character",
          `Task page: ${run.goalReading!.text}\n${inserting ? "Choose text to insert at the selected cursor. No existing characters are deleted." : range ? "Choose replacement text. The selected range is deleted, then insert is put in its place." : "Choose text to append after the existing source. Nothing already written is deleted."} edit_preview shows shared before/removed text; each option shows after text at the same preview_start. Choose an edit that advances the task, even if the source remains unfinished. Closing syntax alone does not fulfill the task. Fragment names label literal text, not additional operations.`, options, extra);
        action = { ...edit, content: inputs[content.choice] };
        choice = `${target.choice}/${mode.choice}/${content.choice}`;
      } else if (selectedTool === "write_python") {
        const config = Object.values(run.program.actions).find((a): a is PythonAction => a.tool === "write_python")!;
        const extra: Record<string, JSONContent> = { selected_tool: selectedTool };
        const files = Object.fromEntries(config.paths.map((file, i) => [`file_${i}`, file]));
        phase = "Python file selection";
        const file = await ask("python_file", "python_file", "Which file should receive the Python statement? Choose the path required by the goal.", files, extra);
        extra.selected_file = files[file.choice];
        phase = "Python function selection";
        const fn = await ask("python_function", "python_function", "Choose the function for a single Python function-call statement. Consider the requested behavior and any tutorial you have read.", Object.fromEntries(config.functions.map(name => [name, PYTHON_FUNCTIONS[name]])), extra);
        extra.selected_function = fn.choice;
        phase = "Python string selection";
        const literal = await ask("python_string", "python_string", "Choose the string value to pass to the selected function. The editor handles quoting, escaping, parentheses and line endings.", config.strings, extra);
        const value = config.strings[literal.choice];
        action = { tool: "write_python", description: config.description, path: files[file.choice], function: fn.choice as PythonFunction, value, content: buildPythonStatement(fn.choice as PythonFunction, value) };
        choice = `${file.choice}/${fn.choice}/${literal.choice}`;
      } else if (selectedTool !== "END" && selectedTool !== "finish") {
        const extra: Record<string, JSONContent> = { selected_tool: selectedTool };
        if (selectedTool === "edit_memory") {
          phase = "memory target selection";
          const target = await ask("memory_target", "memory_target", "Which existing memory entry should be revised using a different excerpt from the current reading? Only entries with a useful replacement are offered.", Object.fromEntries(Object.keys(candidates).map(key => [key, `Replace memory[${key}].`])), extra);
          candidates = this.candidates(state, selectedTool, target.choice);
          extra.selected_memory_key = target.choice;
        }
        phase = `argument selection for ${selectedTool}`;
        const argumentsDecision = await ask("arguments", "arguments", ARGUMENT_INSTRUCTIONS[selectedTool]!,
          Object.fromEntries(Object.entries(candidates).map(([key, action]) => [key, { ...action }])), extra);
        choice = argumentsDecision.choice;
        action = candidates[choice];
      } else action = candidates[choice];
      let observation: Observation;
      try { observation = await this.execute(state, action); }
      catch (error) { observation = { ok: false, message: (error as Error).message }; }
      const last = decisions.at(-1)!;
      run.steps.push({ number: run.steps.length + 1, choice, action, probabilities: last.probabilities, confidence: last.confidence,
        latency_ms: decisions.reduce((ms, d) => ms + d.latency_ms, 0), decisions, result: observation });
      if ((action.tool === "END" || action.tool === "finish") && observation.ok) run.status = "ended";
      else if (run.steps.length >= run.program.maxSteps) run.status = "limit";
    } catch (error) { run.status = "error"; run.error = `Decision failed during ${phase}: ${(error as Error).message}`; }
    return this.save(workspace, run);
  }
}

const globals = globalThis as typeof globalThis & { kevToolLocks?: Map<string, Promise<unknown>> };
const locks = globals.kevToolLocks ??= new Map();
export async function exclusive<T>(workspace: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(workspace) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(task);
  locks.set(workspace, pending);
  try { return await pending; } finally { if (locks.get(workspace) === pending) locks.delete(workspace); }
}
export function localRequest(request: Request) {
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const hostname = new URL(`http://${host}`).hostname, origin = request.headers.get("origin");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) || (origin && new URL(origin).host !== host) || request.headers.get("sec-fetch-site") === "cross-site") throw new LoopError("Tool playground is available only on the same local origin.", 403);
}
