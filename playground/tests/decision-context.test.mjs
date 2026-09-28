import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

const finish = { tool: "finish", description: "Finish the context fixture." };
const length = text => Array.from(text).length;
const slice = (text, start, end) => Array.from(text).slice(start, end).join("");
const coordinates = ({ path, start, end, totalChars }) => ({ path, start, end, totalChars });

async function fixture(t, plan) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "decision-context-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const pending = [...plan];
  const fetcher = async (url, options) => {
    assert.equal(url, "http://context.test/v1/systemone");
    const request = JSON.parse(options.body);
    const [question] = Object.keys(request.questions);
    assert.ok(pending.length, `Unexpected ${question} model request`);
    const next = pending.shift();
    const choice = typeof next === "function" ? await next(request, root) : next;
    const criteria = request.questions[question].criteria;
    assert.ok(Object.hasOwn(criteria, choice), `Unavailable ${question} choice: ${choice}`);
    calls.push({ request, choice });
    return Response.json({ answers: { [question]: {
      type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, Number(key === choice)])),
    } }, usage: { input_tokens: 100 }, latency_ms: 1 });
  };
  const makeLoop = () => new ToolLoop(root, "http://context.test", fetcher, undefined, async () => 100);
  return { root, calls, makeLoop, loop: makeLoop(), assertDone: () => assert.deepEqual(pending, []) };
}

async function advance(loop, state, count = 1) {
  for (let i = 0; i < count; i++) {
    state = await loop.step(state.workspace, state.run.id, state.run.steps.length);
    assert.notEqual(state.run.status, "error", state.run.error);
  }
  return state;
}

// Compare exact request criteria, including strings and structured values. This
// catches a prefix reconstructed from descriptions or from only the final choice.
function checkPrefixes(calls, groups, firstNumber = 1) {
  let cursor = 0;
  for (const [index, stages] of groups.entries()) {
    const prefix = [];
    for (const stage of stages) {
      const { request, choice } = calls[cursor++];
      assert.deepEqual(request.state.current_step, {
        number: firstNumber + index, stage, execution_status: "not_executed", decisions: prefix,
      });
      const [question] = Object.values(request.questions);
      prefix.push({ stage, choice, selected: question.criteria[choice] });
    }
  }
  assert.equal(cursor, calls.length);
}

function checkLast(call, step, args, details = {}) {
  assert.deepEqual(call.request.state.last_step, {
    number: step.number, tool: step.action.tool, choice: step.choice, arguments: args,
    outcome: { ok: step.result.ok, message: step.result.message, ...details },
  });
  assert.equal(Object.hasOwn(call.request.state.last_step.arguments, "description"), false);
  assert.equal(Object.hasOwn(call.request.state.last_step.arguments, "version"), false);
  assert.equal(JSON.stringify(call.request.state.last_step).includes('"fileEdit"'), false);
}

test("create, append and replace pass the exact selection prefix, resolved edit and latest outcome to the next decision", async t => {
  const fragment = "A😀".repeat(45) + "\nOLD_AUDIT_WINDOW";
  const replacement = "new🌏\n";
  const fixtureData = await fixture(t, [
    "create_file", "file_0", "append_file", "file_0", "fragment", "first",
    "replace_file_range", "current_view", "fragment", "corrected", "finish",
  ]);
  const { loop, root, calls } = fixtureData;
  let state = await loop.start("demo", {
    goal: "Create and revise notes.txt.", maxSteps: 10, readLimit: 80, writeLimit: 120,
    actions: {
      create: { tool: "create_file", description: "Create the target.", paths: ["notes.txt"] },
      append: { tool: "append_file", description: "Append a supplied fragment.", paths: ["notes.txt"], fragments: { first: fragment } },
      replace: { tool: "replace_file_range", description: "Revise visible text.", paths: ["notes.txt"], fragments: { corrected: replacement } },
      finish,
    },
  });
  state = await advance(loop, state, 4);
  const [created, appended, replaced] = state.run.steps;
  const visible = appended.result.reading;
  checkPrefixes(calls, [["tool", "arguments"], ["tool", "write_target", "write_mode", "write_fragment"],
    ["tool", "write_range", "write_mode", "write_fragment"], ["tool"]]);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.request.state.last_step, null);
    assert.deepEqual(call.request.state.recent_steps, []);
  }
  for (const call of calls.slice(2, 6)) checkLast(call, created, { path: "notes.txt" }, {
    file_change: created.result.fileChange, reading: coordinates(created.result.reading),
  });
  for (const call of calls.slice(6, 10)) checkLast(call, appended, { path: "notes.txt", offset: 0, content: fragment }, {
    file_change: appended.result.fileChange, reading: coordinates(visible),
  });
  checkLast(calls[10], replaced, { path: "notes.txt", start: visible.start, end: visible.end, content: replacement }, {
    file_change: replaced.result.fileChange, reading: coordinates(replaced.result.reading),
  });
  assert.deepEqual(appended.result.fileChange, { path: "notes.txt", start: 0, end: 0, insertedChars: length(fragment), totalChars: length(fragment) });
  assert.deepEqual(replaced.result.fileChange, { path: "notes.txt", start: visible.start, end: visible.end,
    insertedChars: length(replacement), totalChars: visible.start + length(replacement) });
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes.txt"), "utf8"), slice(fragment, 0, visible.start) + replacement);
  assert.equal(calls[10].request.state.reading.text, replaced.result.reading.text);
  assert.equal(JSON.stringify(calls[10].request.state).includes("OLD_AUDIT_WINDOW"), false, "historical append text and audit windows must not survive after a newer edit");
  for (const { request } of calls) assert.equal(JSON.stringify(request.state).includes('"fileEdit"'), false);
  fixtureData.assertDone();
});

test("memory context retains a stale no-op, indexed replacements and deletion before/after values", async t => {
  const racedMemory = '{ "note" : "Keep this value." }\n';
  const data = await fixture(t, [
    "write_memory", "note", "write_memory", async (request, root) => {
      assert.ok(request.questions.arguments.criteria.note, "the candidate was useful when this step began");
      assert.equal(request.state.persistent_memory.note, "An older draft.");
      await writeFile(path.join(root, "demo/memory.json"), racedMemory);
      return "note";
    }, "read_file", "read_0_0",
    "edit_memory", "note", "excerpt_1", "delete_memory", "note", "finish",
  ]);
  let state = await data.loop.start("demo", {
    goal: "Keep and then remove an indexed note.", maxSteps: 10, readLimit: 80,
    initialFiles: { "guide.txt": "Useful Unicode 🌏 fact.\n" },
    actions: {
      note: { tool: "write_memory", description: "Keep a working note.", key: "note", value: "Keep this value." },
      read: { tool: "read_file", description: "Read the source." },
      edit: { tool: "edit_memory", description: "Index the useful source." },
      remove: { tool: "delete_memory", description: "Forget the note." }, finish,
    },
  });
  state = await advance(data.loop, state);
  await writeFile(path.join(data.root, "demo/memory.json"), JSON.stringify({ note: "An older draft." }));
  state = await advance(data.loop, state);
  assert.equal(state.run.steps[1].result.ok, true);
  assert.equal(state.run.steps[1].result.changed, false);
  assert.match(state.run.steps[1].result.message, /Unchanged/);
  assert.equal(await readFile(path.join(data.root, "demo/memory.json"), "utf8"), racedMemory, "an already satisfied choice must not rewrite memory.json");
  state = await advance(data.loop, state, 4);
  const [added, repeated, read, edited, deleted] = state.run.steps;
  const index = edited.action.value;
  checkPrefixes(data.calls, [["tool", "arguments"], ["tool", "arguments"], ["tool", "arguments"],
    ["tool", "memory_target", "arguments"], ["tool", "arguments"], ["tool"]]);
  checkLast(data.calls[2], added, { key: "note", value: "Keep this value." }, {
    changed: true,
    memory_change: { key: "note", before: null, after: "Keep this value." },
  });
  checkLast(data.calls[4], repeated, { key: "note", value: "Keep this value." }, {
    changed: false,
    memory_change: { key: "note", before: "Keep this value.", after: "Keep this value." },
  });
  checkLast(data.calls[6], read, { path: "guide.txt", offset: 0, limit: 80 }, { reading: coordinates(read.result.reading) });
  checkLast(data.calls[9], edited, { key: "note", value: index }, {
    changed: true,
    memory_change: { key: "note", before: "Keep this value.", after: index },
  });
  checkLast(data.calls[11], deleted, { key: "note" }, { changed: true, memory_change: { key: "note", before: index, after: null } });
  assert.deepEqual(data.calls[9].request.state.persistent_memory, { note: index });
  assert.deepEqual(data.calls[11].request.state.persistent_memory, {});
  assert.deepEqual(data.calls[11].request.state.recent_steps, [read, edited].map(step => ({
    number: step.number, tool: step.action.tool, choice: step.choice, ok: step.result.ok, message: step.result.message,
  })), "only the two older attempts belong in optional history");
  assert.deepEqual(state.memory, {});
  data.assertDone();
});

test("a failed file action replaces the preceding success in last_step and survives reloading", async t => {
  const changed = "EXTERNAL_CURRENT_FILE 🌏";
  const data = await fixture(t, [
    "read_file", "read_0_0", "append_file", "file_0", "fragment",
    async (request, root) => {
      assert.ok(request.questions.write_fragment);
      await writeFile(path.join(root, "demo/sandbox/notes.txt"), changed);
      return "tail";
    }, "finish",
  ]);
  let state = await data.loop.start("demo", {
    goal: "Exercise a stale file selection.", maxSteps: 5, readLimit: 80,
    initialFiles: { "notes.txt": "STALE_READ_PAGE 😀" },
    actions: {
      read: { tool: "read_file", description: "Read the target." },
      append: { tool: "append_file", description: "Append a short literal.", paths: ["notes.txt"], fragments: { tail: "x🌏" } }, finish,
    },
  });
  state = await advance(data.loop, state, 2);
  const failed = state.run.steps[1];
  assert.equal(failed.result.ok, false);
  assert.match(failed.result.message, /changed/);
  state = await advance(data.makeLoop(), state);
  checkLast(data.calls[6], failed, { path: "notes.txt", offset: length("STALE_READ_PAGE 😀"), content: "x🌏" });
  assert.equal(data.calls[6].request.state.reading, null);
  assert.equal(JSON.stringify(data.calls[6].request.state).includes("STALE_READ_PAGE"), false);
  assert.equal(await readFile(path.join(data.root, "demo/sandbox/notes.txt"), "utf8"), changed);
  assert.equal(state.run.steps[1].result.fileEdit, undefined);
  checkPrefixes(data.calls, [["tool", "arguments"], ["tool", "write_target", "write_mode", "write_fragment"], ["tool"]]);
  data.assertDone();
});

test("whole-file writes summarize content while Python writes retain selected function and value", async t => {
  const content = "WHOLE_FILE_CONTENT_MUST_NOT_REPLAY " + "🌏".repeat(100);
  const value = "Hello \"🌏\"\n";
  const data = await fixture(t, ["write_file", "whole", "write_python", "file_0", "print", "greeting", "finish"]);
  let state = await data.loop.start("demo", {
    goal: "Exercise complete-write argument summaries.", maxSteps: 5, readLimit: 80,
    initialFiles: { "notes.txt": "AUDIT_BEFORE_SECRET" },
    actions: {
      whole: { tool: "write_file", description: "Replace the text.", path: "notes.txt", content },
      python: { tool: "write_python", description: "Compose one statement.", paths: ["greeting.py"], functions: ["print", "repr"], strings: { greeting: value } }, finish,
    },
  });
  state = await advance(data.loop, state, 3);
  const [written, python] = state.run.steps;
  for (const call of data.calls.slice(2, 6)) {
    checkLast(call, written, { path: "notes.txt", content_characters: length(content), content_omitted: "Use read_file to inspect the file in bounded pages." }, {
      file_change: { path: "notes.txt", start: 0, end: length("AUDIT_BEFORE_SECRET"), insertedChars: length(content), totalChars: length(content) },
    });
    assert.equal(JSON.stringify(call.request.state).includes("WHOLE_FILE_CONTENT_MUST_NOT_REPLAY"), false);
    assert.equal(JSON.stringify(call.request.state).includes("AUDIT_BEFORE_SECRET"), false);
  }
  checkLast(data.calls[6], python, { path: "greeting.py", function: "print", value }, {
    file_change: { path: "greeting.py", start: 0, end: 0, insertedChars: length(python.action.content), totalChars: length(python.action.content) },
  });
  assert.equal(Object.hasOwn(data.calls[6].request.state.last_step.arguments, "content"), false);
  assert.equal(JSON.stringify(data.calls[6].request.state).includes(JSON.stringify(python.action.content)), false);
  checkPrefixes(data.calls, [["tool", "arguments"], ["tool", "python_file", "python_function", "python_string"], ["tool"]]);
  data.assertDone();
});

test("previous file and goal pages are represented only by coordinates after moving to another page", async t => {
  const oldFilePage = "OLD_FILE_PAGE " + "x".repeat(65) + "🌏";
  const oldGoalPage = "OLD_GOAL_PAGE " + "g".repeat(65) + "🌏";
  assert.equal(length(oldFilePage), 80);
  assert.equal(length(oldGoalPage), 80);
  const data = await fixture(t, ["read_file", "read_0_0", "read_file", "read_0_80", "read_goal", "goal_80", "finish"]);
  let state = await data.loop.start("demo", {
    goal: oldGoalPage + "CURRENT_GOAL_PAGE: select finish.", maxSteps: 6, readLimit: 80,
    initialFiles: { "notes.txt": oldFilePage + "CURRENT_FILE_PAGE 🌏" },
    actions: { read: { tool: "read_file", description: "Read a bounded file page." }, finish },
  });
  state = await advance(data.loop, state, 4);
  const [first, second, goal] = state.run.steps;
  checkLast(data.calls[2], first, { path: "notes.txt", offset: 0, limit: 80 }, { reading: coordinates(first.result.reading) });
  checkLast(data.calls[4], second, { path: "notes.txt", offset: 80, limit: 80 }, { reading: coordinates(second.result.reading) });
  const { start, end, totalChars } = goal.result.goalReading;
  checkLast(data.calls[6], goal, { offset: 80, limit: 80 }, { goal_page: { start, end, totalChars } });
  for (const call of data.calls.slice(4)) {
    assert.equal(JSON.stringify(call.request.state).includes("OLD_FILE_PAGE"), false);
    assert.equal(call.request.state.reading.text, "CURRENT_FILE_PAGE 🌏");
  }
  assert.equal(JSON.stringify(data.calls[6].request.state).includes("OLD_GOAL_PAGE"), false);
  assert.equal(data.calls[6].request.state.goal_memory.text, "CURRENT_GOAL_PAGE: select finish.");
  checkPrefixes(data.calls, [["tool", "arguments"], ["tool", "arguments"], ["tool", "arguments"], ["tool"]]);
  data.assertDone();
});

test("a reloaded loop restores its last attempt and reset starts a fresh decision context", async t => {
  const data = await fixture(t, ["write_memory", "note", "read_file", "read_0_0", "finish", "finish"]);
  let state = await data.loop.start("demo", {
    goal: "Exercise persistent context.", maxSteps: 5, readLimit: 80,
    initialFiles: { "notes.txt": "OLD_RUN_READING" },
    actions: {
      note: { tool: "write_memory", description: "Keep a note.", key: "note", value: "OLD_RUN_MEMORY" },
      read: { tool: "read_file", description: "Read a file." }, finish,
    },
  });
  state = await advance(data.loop, state, 2);
  const read = state.run.steps[1];
  const resumed = data.makeLoop();
  state = await resumed.snapshot("demo");
  state = await advance(resumed, state);
  checkLast(data.calls[4], read, { path: "notes.txt", offset: 0, limit: 80 }, { reading: coordinates(read.result.reading) });
  assert.deepEqual(data.calls[4].request.state.persistent_memory, { note: "OLD_RUN_MEMORY" });
  assert.equal(data.calls[4].request.state.reading.text, "OLD_RUN_READING");
  checkPrefixes(data.calls.slice(0, 5), [["tool", "arguments"], ["tool", "arguments"], ["tool"]]);
  await resumed.reset("demo", "all", state.run.id);
  state = await resumed.start("demo", { goal: "Fresh run.", maxSteps: 2, actions: {
    create: { tool: "create_file", description: "Create a fresh target.", paths: ["fresh.txt"] }, finish,
  } });
  state = await advance(resumed, state);
  const fresh = data.calls[5].request.state;
  assert.equal(fresh.last_step, null);
  assert.equal(fresh.reading, null);
  assert.deepEqual(fresh.recent_steps, []);
  assert.deepEqual(fresh.persistent_memory, {});
  assert.deepEqual(fresh.sandbox_files, []);
  assert.equal(JSON.stringify(fresh).includes("OLD_RUN_"), false);
  checkPrefixes(data.calls.slice(5), [["tool"]]);
  data.assertDone();
});
