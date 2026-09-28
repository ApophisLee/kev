import test from "node:test";
import assert from "node:assert/strict";
import { buildFileTimeline } from "../src/lib/file-timeline.ts";

const view = (text, start = 0, totalChars = start + Array.from(text).length) => ({ start, end: start + Array.from(text).length, totalChars, text });
const reading = (path, text, start = 0, totalChars = start + Array.from(text).length, version = "v1") => ({ path, ...view(text, start, totalChars), hasMore: start + Array.from(text).length < totalChars, version });
const decision = (stage, choice, latency_ms, probability = 0.8) => ({ stage, choice, latency_ms, probabilities: { [choice]: probability }, confidence: 0.9 });
const step = (number, action, result, decisions, latency_ms = decisions?.reduce((total, item) => total + item.latency_ms, 0) ?? 9) => ({
  number, action: { description: "Recorded action", ...action }, result: { ok: true, message: "Recorded result", ...result },
  decisions, latency_ms, choice: decisions?.at(-1)?.choice ?? "legacy_choice", probabilities: { legacy_choice: 0.6 }, confidence: 0.7,
});
const run = (steps, overrides = {}) => ({
  id: "timeline-test", status: "ended", program: { goal: "Inspect file decisions", maxSteps: 100, readLimit: 80, actions: { finish: { tool: "finish", description: "Done" } }, ...overrides }, steps,
});

test("file frames keep cross-file order and count non-file model latency between writes", () => {
  const state = run([
    step(1, { tool: "write_memory", key: "note", value: "Keep" }, {}, undefined, 10),
    step(2, { tool: "create_file", path: "a.txt" }, { fileEdit: { before: null, after: view(""), start: 0, end: 0, insertedChars: 0 } }, [decision("tool", "create_file", 2), decision("arguments", "file_0", 3)]),
    step(3, { tool: "read_file", path: "a.txt", offset: 0, limit: 80 }, { reading: reading("a.txt", "") }, undefined, 7),
    step(4, { tool: "append_file", path: "a.txt", offset: 0, content: "A", version: "v1" }, { fileEdit: { before: view(""), after: view("A"), start: 0, end: 0, insertedChars: 1 } }, [decision("tool", "append_file", 2), decision("write_target", "file_0", 4), decision("write_mode", "fragment", 3), decision("write_fragment", "letter", 6)]),
    step(5, { tool: "write_file", path: "b.txt", content: "B" }, {}, undefined, 6),
    step(6, { tool: "finish" }, {}, undefined, 4),
    step(7, { tool: "append_file", path: "a.txt", offset: 1, content: "bad", version: "v2" }, { ok: false, message: "Target changed" }, undefined, 8),
  ]);
  const frames = buildFileTimeline(state);
  assert.deepEqual(frames.map(frame => [frame.id, frame.step, frame.path, frame.startMs, frame.durationMs]), [
    ["2", 2, "a.txt", 10, 5], ["4", 4, "a.txt", 22, 15], ["5", 5, "b.txt", 37, 6], ["7", 7, "a.txt", 47, 8],
  ]);
  assert.deepEqual(frames[1].stages.map(stage => stage.startMs), [22, 24, 28, 31]);
  assert.equal(frames[3].ok, false);
  assert.equal(frames[3].message, "Target changed");
  assert.deepEqual(buildFileTimeline(null), []);
});

test("stage values decode target, mode, escaped newline, and probabilities from actual choices", () => {
  const recorded = step(1, { tool: "append_file", path: "unicode.txt", offset: 2, content: "\n", version: "v1" }, {
    fileEdit: { before: view("🧭x"), after: view("🧭x\n"), start: 2, end: 2, insertedChars: 1 },
  }, [decision("tool", "append_file", 5), decision("write_target", "file_3", 6), decision("write_mode", "character", 7), decision("write_character", "char_95", 8, 0.65)]);
  const [frame] = buildFileTimeline(run([recorded]));
  assert.deepEqual(frame.stages.map(stage => stage.value), ["append_file", "unicode.txt", "character", '"\\n"']);
  assert.equal(frame.stages[3].title, "Character");
  assert.equal(frame.stages[3].probability, 0.65);
  assert.equal(frame.stages[3].confidence, 0.9);
  assert.equal(frame.stages[3].latencyMs, 8);
  assert.deepEqual(frame.change, { start: 2, end: 2, insertedChars: 1 });
  assert.equal(frame.before.end, 2);
  assert.equal(frame.after.end, 3);
  assert.equal(frame.after.text, "🧭x\n");
});

test("recorded bounded before and after views preserve their absolute source offsets", () => {
  const before = view("old", 200, 1000), after = view("new🧭", 200, 1001);
  const state = run([step(1, { tool: "replace_file_range", path: "large.txt", start: 200, end: 203, content: "new🧭", version: "old" }, {
    fileEdit: { before, after, start: 200, end: 203, insertedChars: 4 },
  }, [decision("write_range", "current_view", 4), decision("write_fragment", "replacement", 5)])]);
  const [frame] = buildFileTimeline(state);
  assert.deepEqual(frame.before, before);
  assert.deepEqual(frame.after, after);
  assert.deepEqual(frame.stages.map(stage => stage.value), ["[200, 203)", '"new🧭"']);
  assert.deepEqual(frame.change, { start: 200, end: 203, insertedChars: 4 });
  frame.after.text = "Changed UI copy";
  assert.equal(state.steps[0].result.fileEdit.after.text, "new🧭");
});

test("legacy full writes show a bounded recorded result without inventing initial-file baselines", () => {
  const content = "🧭".repeat(200);
  const state = run([step(1, { tool: "write_file", path: "existing.txt", content }, {}, undefined, 12)], {
    initialFiles: { "existing.txt": "This is not proof of the pre-run content." },
  });
  state.steps[0].probabilities = { a_different_choice: 0.4 };
  const [frame] = buildFileTimeline(state);
  assert.equal(frame.before, undefined);
  assert.equal(frame.change, null);
  assert.deepEqual(frame.after, view("🧭".repeat(80), 0, 200));
  assert.equal(frame.stages.length, 1);
  assert.equal(frame.stages[0].stage, "legacy");
  assert.equal(frame.stages[0].choice, "legacy_choice");
  assert.equal(frame.stages[0].probability, null);
  assert.equal(frame.stages[0].latencyMs, 12);
});

test("legacy traces reconstruct only ranges proven by prior writes or observed readings", () => {
  const state = run([
    step(1, { tool: "create_file", path: "new.txt" }, { reading: reading("new.txt", "", 0, 0, "v0") }),
    step(2, { tool: "append_file", path: "new.txt", offset: 0, content: "🧭ab\n", version: "v0" }, { reading: reading("new.txt", "🧭ab\n", 0, 4, "v1") }),
    step(3, { tool: "replace_file_range", path: "new.txt", start: 1, end: 3, content: "界", version: "v1" }, {}),
    step(4, { tool: "read_file", path: "large.txt", offset: 100, limit: 80 }, { reading: reading("large.txt", "ab🧭cd", 100, 200, "observed") }),
    step(5, { tool: "replace_file_range", path: "large.txt", start: 102, end: 103, content: "Z", version: "observed" }, {}),
  ]);
  const frames = buildFileTimeline(state);
  assert.equal(frames[0].before, null);
  assert.deepEqual(frames[0].after, view(""));
  assert.deepEqual(frames[1].before, view(""));
  assert.deepEqual(frames[1].after, view("🧭ab\n"));
  assert.deepEqual(frames[2].before, view("🧭ab\n"));
  assert.deepEqual(frames[2].after, view("🧭界\n"));
  assert.deepEqual(frames[2].change, { start: 1, end: 3, insertedChars: 1 });
  assert.deepEqual(frames[3].before, view("ab🧭cd", 100, 200));
  assert.deepEqual(frames[3].after, view("abZcd", 100, 200));
});

test("legacy append observations do not fabricate missing or version-mismatched before views", () => {
  const state = run([
    step(1, { tool: "read_file", path: "old.txt", offset: 0, limit: 80 }, { reading: reading("old.txt", "OLD", 0, 3, "old-version") }),
    step(2, { tool: "append_file", path: "old.txt", offset: 3, content: "!", version: "new-version" }, { reading: reading("old.txt", "NEW!", 0, 4, "after-version") }),
    step(3, { tool: "append_file", path: "unknown.txt", offset: 500, content: "X", version: "unknown" }, { reading: reading("unknown.txt", "tailX", 496, 501, "after") }),
  ], { initialFiles: { "unknown.txt": "Not a valid baseline" } });
  const frames = buildFileTimeline(state);
  assert.equal(frames[0].before, undefined);
  assert.deepEqual(frames[0].after, view("NEW!"));
  assert.equal(frames[1].before, undefined);
  assert.deepEqual(frames[1].after, view("tailX", 496, 501));
});

test("a legacy static write without a version cannot establish the baseline of a later append", () => {
  const state = run([
    step(1, { tool: "write_file", path: "external.txt", content: "OLD" }, {}),
    step(2, { tool: "append_file", path: "external.txt", offset: 3, content: "!", version: "externally-modified" }, {
      reading: reading("external.txt", "NEW!", 0, 4, "after-append"),
    }),
  ]);
  const frames = buildFileTimeline(state);
  assert.deepEqual(frames[0].after, view("OLD"));
  assert.equal(frames[1].before, undefined);
  assert.deepEqual(frames[1].after, view("NEW!"));
});

test("failed edits remain in the timeline but never advance inferred contents or show attempted changes", () => {
  const state = run([
    step(1, { tool: "write_file", path: "file.txt", content: "old" }, {}),
    step(2, { tool: "append_file", path: "file.txt", offset: 3, content: "BAD", version: "stale" }, {
      ok: false, message: "Source changed", fileChange: { path: "file.txt", start: 3, end: 3, insertedChars: 3, totalChars: 6 },
      fileEdit: { before: view("old"), after: view("oldBAD"), start: 3, end: 3, insertedChars: 3 },
    }),
    step(3, { tool: "append_file", path: "file.txt", offset: 3, content: "!", version: "another" }, {}),
  ]);
  const frames = buildFileTimeline(state);
  assert.equal(frames.length, 3);
  assert.equal(frames[1].ok, false);
  assert.equal(frames[1].change, null);
  assert.equal(frames[1].before, undefined);
  assert.equal(frames[1].after, undefined);
  assert.equal(frames[2].before, undefined);
  assert.equal(frames[2].after, undefined);
  assert.deepEqual(frames[0].after, view("old"));
});

test("legacy Python decisions decode the chosen function and string without inventing reasoning", () => {
  const [frame] = buildFileTimeline(run([step(1, {
    tool: "write_python", path: "hello.py", function: "print", value: "a\nb", content: 'print("a\\nb")\n',
  }, {}, [decision("python_file", "file_0", 2), decision("python_function", "print", 3), decision("python_string", "multiline", 4)])]));
  assert.deepEqual(frame.stages.map(stage => stage.value), ["hello.py", "print", '"a\\nb"']);
  assert.equal(frame.before, undefined);
  assert.equal(frame.after.text, 'print("a\\nb")\n');
});
