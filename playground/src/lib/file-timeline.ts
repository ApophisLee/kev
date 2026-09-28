import type { Decision, FileView, Run, Step } from "./tool-loop.ts";

export type { FileView } from "./tool-loop.ts";
export type FileTimelineStage = {
  stage: string; title: string; choice: string; value: string;
  probability: number | null; confidence: number; latencyMs: number; startMs: number;
};
export type FileTimelineFrame = {
  id: string; step: number; path: string; tool: string; ok: boolean; message: string;
  startMs: number; durationMs: number; stages: FileTimelineStage[];
  before?: FileView | null; after?: FileView;
  change: { start: number; end: number; insertedChars: number } | null;
};

type KnownView = { view: FileView; version?: string };
const FILE_TOOLS = new Set(["create_file", "append_file", "replace_file_range", "write_python", "write_file"]);
const TITLES: Record<string, string> = {
  tool: "Tool", arguments: "Arguments", python_file: "Target file", python_function: "Python function",
  python_string: "String value", write_target: "Target file", write_range: "Visible range",
  write_range_group: "Range focus",
  write_mode: "Input mode", write_fragment: "Text fragment", write_character_group: "Character group", write_character: "Character",
  memory_target: "Memory entry", legacy: "Recorded choice",
};
const milliseconds = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
const copyView = (view: FileView): FileView => ({ start: view.start, end: view.end, totalChars: view.totalChars, text: view.text });

function bounded(view: FileView, limit: number, preferredStart = view.start): FileView {
  const chars = Array.from(view.text);
  const offset = Math.min(Math.max(0, preferredStart - view.start), Math.max(0, chars.length - limit));
  const text = chars.slice(offset, offset + limit).join("");
  const start = view.start + offset;
  return { start, end: start + Array.from(text).length, totalChars: view.totalChars, text };
}

function decisionValue(step: Step, stage: string, choice: string): string {
  const action = step.action;
  if (stage === "tool") return action.tool;
  if (stage === "write_mode") return choice;
  if ((stage === "write_target" || stage === "python_file") && "path" in action) return action.path;
  if (stage === "write_range" && choice === "focus_range") return "Choose a smaller range";
  if (stage === "write_range" && action.tool === "replace_file_range") return action.start === action.end ? `Insert at ${action.start}` : `[${action.start}, ${action.end})`;
  if ((stage === "write_fragment" || stage === "write_character") && "content" in action) return JSON.stringify(action.content);
  if (stage === "python_function" && action.tool === "write_python") return action.function;
  if (stage === "python_string" && action.tool === "write_python") return JSON.stringify(action.value);
  if ((stage === "arguments" || stage === "legacy") && "path" in action) {
    return "content" in action ? `${action.path}: ${JSON.stringify(action.content)}` : action.path;
  }
  return choice;
}

function stagesFor(step: Step, startMs: number): FileTimelineStage[] {
  const recorded: Array<Decision | (Omit<Decision, "stage"> & { stage: "legacy" })> = step.decisions?.length
    ? step.decisions
    : [{ stage: "legacy", choice: step.choice, probabilities: step.probabilities, confidence: step.confidence, latency_ms: step.latency_ms }];
  let elapsed = startMs;
  return recorded.map(decision => {
    const probability = decision.probabilities?.[decision.choice];
    const latencyMs = milliseconds(decision.latency_ms);
    const stage: FileTimelineStage = {
      stage: decision.stage, title: decision.stage === "arguments" && step.action.tool === "create_file" ? "Target file" : TITLES[decision.stage] ?? decision.stage,
      choice: decision.choice, value: decisionValue(step, decision.stage, decision.choice),
      probability: typeof probability === "number" && Number.isFinite(probability) && probability >= 0 && probability <= 1 ? probability : null,
      confidence: decision.confidence, latencyMs, startMs: elapsed,
    };
    elapsed += latencyMs;
    return stage;
  });
}

function recordedChange(step: Step): FileTimelineFrame["change"] {
  if (step.result.fileEdit) {
    const { start, end, insertedChars } = step.result.fileEdit;
    return { start, end, insertedChars };
  }
  if (step.result.fileChange) {
    const { start, end, insertedChars } = step.result.fileChange;
    return { start, end, insertedChars };
  }
  const action = step.action;
  if (action.tool === "create_file") return { start: 0, end: 0, insertedChars: 0 };
  if (action.tool === "append_file") return { start: action.offset, end: action.offset, insertedChars: Array.from(action.content).length };
  if (action.tool === "replace_file_range") return { start: action.start, end: action.end, insertedChars: Array.from(action.content).length };
  return null;
}

// Only patch a previously observed window when the entire edit is within it.
// An unrelated initialFiles entry is not evidence of the file's pre-run contents.
function previousEdit(step: Step, previous: KnownView | undefined): { before: FileView; after: FileView } | null {
  const action = step.action;
  if (!previous || (action.tool !== "append_file" && action.tool !== "replace_file_range")) return null;
  if (!previous.version || previous.version !== action.version) return null;
  const before = previous.view;
  const start = action.tool === "append_file" ? action.offset : action.start;
  const end = action.tool === "append_file" ? action.offset : action.end;
  if (start < before.start || end > before.end || (action.tool === "append_file" && end !== before.totalChars)) return null;
  const chars = Array.from(before.text);
  const inserted = Array.from(action.content);
  const text = [...chars.slice(0, start - before.start), ...inserted, ...chars.slice(end - before.start)].join("");
  const delta = inserted.length - (end - start);
  return { before, after: { start: before.start, end: before.end + delta, totalChars: before.totalChars + delta, text } };
}

/** File writes and their recorded decisions, timed by cumulative model latency. */
export function buildFileTimeline(run: Run | null): FileTimelineFrame[] {
  if (!run) return [];
  const frames: FileTimelineFrame[] = [];
  const known = new Map<string, KnownView>();
  const limit = Number.isInteger(run.program.readLimit) && Number(run.program.readLimit) > 0 ? Number(run.program.readLimit) : 400;
  let elapsed = 0;
  for (const step of run.steps) {
    const startMs = elapsed, durationMs = milliseconds(step.latency_ms);
    elapsed += durationMs;
    const action = step.action;
    if (!FILE_TOOLS.has(action.tool) || !("path" in action)) {
      if (step.result.ok && action.tool === "read_file" && step.result.reading?.path === action.path) {
        known.set(action.path, { view: copyView(step.result.reading), version: step.result.reading.version });
      }
      continue;
    }
    const frame: FileTimelineFrame = {
      id: String(step.number), step: step.number, path: action.path, tool: action.tool,
      ok: step.result.ok, message: step.result.message, startMs, durationMs, stages: stagesFor(step, startMs), change: null,
    };
    frames.push(frame);
    if (!step.result.ok) {
      // A stale-write failure may mean an external writer changed the file.
      // Neither attempted content nor a formerly known view proves its state now.
      known.delete(action.path);
      continue;
    }
    frame.change = recordedChange(step);
    let after: FileView | undefined;
    const edit = step.result.fileEdit;
    if (edit) {
      frame.before = edit.before === null ? null : bounded(edit.before, limit);
      after = copyView(edit.after);
    } else if (action.tool === "create_file") {
      frame.before = null;
      after = { start: 0, end: 0, totalChars: 0, text: "" };
    } else if (action.tool === "write_file" || action.tool === "write_python") {
      const totalChars = Array.from(action.content).length;
      after = { start: 0, end: totalChars, totalChars, text: action.content };
    } else {
      const inferred = previousEdit(step, known.get(action.path));
      if (inferred) {
        frame.before = bounded(inferred.before, limit, frame.change?.start);
        after = inferred.after;
      }
      if (step.result.reading?.path === action.path) after = copyView(step.result.reading);
    }
    if (after) {
      const preferredStart = action.tool === "append_file" ? after.totalChars - limit : frame.change?.start;
      frame.after = bounded(after, limit, preferredStart);
      const reading = step.result.reading;
      known.set(action.path, { view: after, ...(reading?.path === action.path ? { version: reading.version } : {}) });
    } else known.delete(action.path);
  }
  return frames;
}
