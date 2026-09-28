import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

const length = text => Array.from(text).length;
const slice = (text, start, end) => Array.from(text).slice(start, end).join("");
const finish = { tool: "finish", description: "Finish this fixture." };

async function fixture(t, decisions) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-audit-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(url, "http://audit.test/v1/systemone");
    const request = JSON.parse(options.body);
    requests.push(request);
    const [question] = Object.keys(request.questions);
    assert.ok(decisions.length, `Unexpected model request: ${question}`);
    const decision = decisions.shift();
    const choice = typeof decision === "function" ? await decision(request, root) : decision;
    const criteria = request.questions[question].criteria;
    assert.ok(Object.hasOwn(criteria, choice), `Unavailable ${question} choice: ${choice}`);
    return Response.json({ answers: { [question]: {
      type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])),
    } }, latency_ms: 1 });
  };
  return { root, requests, loop: new ToolLoop(root, "http://audit.test", fetcher, undefined, async () => 100) };
}

function checkView(view, source, limit) {
  assert.ok(view, "successful edits must have a view");
  assert.deepEqual(Object.keys(view).sort(), ["end", "start", "text", "totalChars"]);
  assert.ok(Number.isInteger(view.start) && Number.isInteger(view.end));
  assert.ok(view.start >= 0 && view.end >= view.start && view.end <= length(source));
  assert.equal(view.totalChars, length(source));
  assert.equal(view.text, slice(source, view.start, view.end));
  assert.equal(length(view.text), view.end - view.start);
  assert.ok(length(view.text) <= limit, "audit window must obey readLimit");
}
function checkEdit(result, before, after, start, end, insertedChars, limit, matchesReading = true) {
  assert.equal(result.ok, true, result.message);
  const edit = result.fileEdit;
  assert.ok(edit, "successful file edit must include fileEdit audit metadata");
  assert.deepEqual(Object.keys(edit).sort(), ["after", "before", "end", "insertedChars", "start"]);
  assert.deepEqual({ start: edit.start, end: edit.end, insertedChars: edit.insertedChars }, { start, end, insertedChars });
  if (before === null) assert.equal(edit.before, null);
  else checkView(edit.before, before, limit);
  checkView(edit.after, after, limit);
  if (matchesReading) {
    const { start, end, totalChars, text } = result.reading;
    assert.deepEqual(edit.after, { start, end, totalChars, text });
  }
}
function checkModelAuditIsolation(requests) {
  for (const request of requests) {
    assert.equal(JSON.stringify(request.state).includes('"fileEdit"'), false, "UI audit must never enter model state");
    for (const step of request.state.recent_steps) {
      assert.deepEqual(Object.keys(step).sort(), ["choice", "message", "number", "ok", "tool"]);
    }
    if (request.state.reading) assert.ok(length(request.state.reading.text) <= request.state.reading_limit);
  }
}

function editingProgram(initialFiles = {}) {
  return {
    goal: "Edit a small Unicode file, preserving unrelated text and memory.", maxSteps: 20, readLimit: 80, writeLimit: 100,
    initialFiles,
    actions: {
      remember: { tool: "write_memory", description: "Keep a notebook entry.", key: "note", value: "Keep this notebook entry." },
      create: { tool: "create_file", description: "Create a new file.", paths: ["notes.txt"] },
      append: { tool: "append_file", description: "Append a fragment.", paths: ["notes.txt"], fragments: {
        first: "A😀".repeat(30) + "\n", second: "B🚀".repeat(25) + "\n",
      } },
      replace: { tool: "replace_file_range", description: "Replace a visible range.", paths: ["notes.txt"], fragments: { corrected: "修正🌏\n" } },
      read: { tool: "read_file", description: "Read a bounded page." }, finish,
    },
  };
}

test("Unicode create, chained appends and visible-range replacement retain bounded audit views after reload", async t => {
  const { root, loop, requests } = await fixture(t, [
    "write_memory", "remember", "create_file", "file_0",
    "append_file", "file_0", "fragment", "first",
    "append_file", "file_0", "fragment", "second",
    "replace_file_range", "line_1", "fragment", "corrected", "finish",
  ]);
  const program = editingProgram();
  let state = await loop.start("demo", program);
  for (let step = 0; step < 6; step++) state = await loop.step("demo", state.run.id, step);
  const first = program.actions.append.fragments.first;
  const second = program.actions.append.fragments.second;
  const combined = first + second;
  const beforeReplacement = state.run.steps[3].result.reading;
  const replaceStart = beforeReplacement.start;
  const replaceEnd = length(first);
  const corrected = slice(combined, 0, replaceStart) + "修正🌏\n" + slice(combined, replaceEnd);
  const steps = state.run.steps;
  checkEdit(steps[1].result, null, "", 0, 0, 0, 80);
  checkEdit(steps[2].result, "", first, 0, 0, length(first), 80);
  checkEdit(steps[3].result, first, combined, length(first), length(first), length(second), 80);
  checkEdit(steps[4].result, combined, corrected, replaceStart, replaceEnd, 4, 80);
  assert.ok(steps[3].result.fileEdit.after.start > 0, "second append must exercise a clipped audit window");
  assert.ok(steps[4].result.fileEdit.before.start <= replaceStart && steps[4].result.fileEdit.before.end >= replaceEnd);
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes.txt"), "utf8"), corrected);
  assert.deepEqual(state.memory, { note: "Keep this notebook entry." });
  const reload = await new ToolLoop(root).snapshot("demo");
  assert.deepEqual(reload.run.steps.map(step => step.result.fileEdit ?? null), steps.map(step => step.result.fileEdit ?? null));
  assert.deepEqual(reload.run.reading, steps[4].result.reading);
  const afterAppend = requests.filter(request => request.state.last_step?.tool === "append_file");
  assert.ok(afterAppend.length > 0);
  for (const request of afterAppend) {
    assert.deepEqual(request.state.persistent_memory, { note: "Keep this notebook entry." });
    assert.ok(request.state.reading, "normal bounded editor reading still reaches the next decision");
  }
  checkModelAuditIsolation(requests);
});

test("static and Python writes distinguish creation from overwriting fresh disk contents without exposing audit text", async t => {
  const freshDisk = "AUDIT_ONLY_OLD_SECRET " + "舊😀".repeat(75);
  const freshPython = "AUDIT_ONLY_PYTHON_SECRET " + "舊🌏".repeat(70);
  const newText = "new🚀".repeat(60);
  const greeting = "Hello 🌏";
  const { root, loop, requests } = await fixture(t, [
    "write_file", async (request, root) => {
      assert.ok(request.questions.arguments);
      await writeFile(path.join(root, "demo/sandbox/existing.txt"), freshDisk);
      return "rewrite";
    },
    "write_file", "new_file",
    "write_python", "file_0", "print", async (request, root) => {
      assert.ok(request.questions.python_string);
      await writeFile(path.join(root, "demo/sandbox/legacy.py"), freshPython);
      return "greeting";
    },
    "write_python", "file_1", "print", "greeting", "finish",
  ]);
  const program = {
    goal: "Exercise whole-file compatibility writes.", maxSteps: 10, readLimit: 80,
    initialFiles: { "existing.txt": "snapshot content that changes during selection", "legacy.py": "old Python file" },
    actions: {
      rewrite: { tool: "write_file", description: "Replace the old text.", path: "existing.txt", content: newText },
      new_file: { tool: "write_file", description: "Write a new text file.", path: "new.txt", content: "new 😀 file" },
      compose: { tool: "write_python", description: "Compose a Python statement.", paths: ["legacy.py", "fresh.py"], functions: ["print"], strings: { greeting } },
      finish,
    },
  };
  let state = await loop.start("demo", program);
  for (let step = 0; step < 5; step++) state = await loop.step("demo", state.run.id, step);
  const pythonContent = `print(${JSON.stringify(greeting)})\n`;
  checkEdit(state.run.steps[0].result, freshDisk, newText, 0, length(freshDisk), length(newText), 80, false);
  checkEdit(state.run.steps[1].result, null, "new 😀 file", 0, 0, length("new 😀 file"), 80, false);
  checkEdit(state.run.steps[2].result, freshPython, pythonContent, 0, length(freshPython), length(pythonContent), 80, false);
  checkEdit(state.run.steps[3].result, null, pythonContent, 0, 0, length(pythonContent), 80, false);
  assert.equal(state.run.reading, null, "audit metadata must not create a model reading for compatibility writes");
  assert.deepEqual(state.memory, {});
  assert.equal(await readFile(path.join(root, "demo/sandbox/existing.txt"), "utf8"), newText);
  assert.deepEqual((await new ToolLoop(root).snapshot("demo")).run.steps, state.run.steps);
  for (const request of requests) {
    assert.equal(request.state.reading, null);
    assert.equal(JSON.stringify(request.state).includes("AUDIT_ONLY_"), false, "unread overwritten text must stay in the UI audit only");
    assert.deepEqual(request.state.persistent_memory, {});
  }
  checkModelAuditIsolation(requests);
});

test("default audit window is capped at 400 Unicode characters", async t => {
  const before = "OLD_AUDIT_SENTINEL " + "😀".repeat(800);
  const after = "新🚀".repeat(350);
  const { loop, requests } = await fixture(t, ["write_file", "rewrite", "finish"]);
  let state = await loop.start("demo", {
    goal: "Replace the fixture text.", maxSteps: 3,
    initialFiles: { "notes.txt": before },
    actions: { rewrite: { tool: "write_file", description: "Write replacement text.", path: "notes.txt", content: after }, finish },
  });
  state = await loop.step("demo", state.run.id, 0);
  checkEdit(state.run.steps[0].result, before, after, 0, length(before), length(after), 400, false);
  assert.equal(length(state.run.steps[0].result.fileEdit.before.text), 400);
  assert.equal(length(state.run.steps[0].result.fileEdit.after.text), 400);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(JSON.stringify(requests.at(-1).state).includes("OLD_AUDIT_SENTINEL"), false);
  checkModelAuditIsolation(requests);
});

test("stale append and replacement failures have no fabricated file audit", async t => {
  for (const tool of ["append_file", "replace_file_range"]) {
    await t.test(tool, async t => {
      const original = "old😀".repeat(40);
      const external = "Externally changed 🌏 file";
      const mutate = async (request, root) => {
        assert.ok(request.questions.write_fragment);
        await writeFile(path.join(root, "demo/sandbox/notes.txt"), external);
        return tool === "append_file" ? "first" : "corrected";
      };
      const { root, loop, requests } = await fixture(t, [
        "read_file", tool === "append_file" ? "read_0_80" : "read_0_0", tool, tool === "append_file" ? "file_0" : "current_view", "fragment", mutate, "finish",
      ]);
      let state = await loop.start("demo", editingProgram({ "notes.txt": original }));
      state = await loop.step("demo", state.run.id, 0);
      state = await loop.step("demo", state.run.id, 1);
      const result = state.run.steps[1].result;
      assert.equal(result.ok, false);
      assert.match(result.message, /changed|stale/i);
      assert.equal(Object.hasOwn(result, "fileEdit"), false);
      assert.equal(Object.hasOwn(result, "reading"), false);
      assert.equal(state.run.reading, null);
      assert.equal(await readFile(path.join(root, "demo/sandbox/notes.txt"), "utf8"), external);
      assert.equal(Object.hasOwn((await new ToolLoop(root).snapshot("demo")).run.steps[1].result, "fileEdit"), false);
      state = await loop.step("demo", state.run.id, 2);
      assert.equal(requests.at(-1).state.reading, null);
      assert.deepEqual(requests.at(-1).state.persistent_memory, {});
      checkModelAuditIsolation(requests);
    });
  }
});

test("a file created externally after create selection stays untouched and has no success audit", async t => {
  const { root, loop } = await fixture(t, ["create_file", async (request, root) => {
    assert.ok(request.questions.arguments);
    await writeFile(path.join(root, "demo/sandbox/notes.txt"), "external owner 🌏");
    return "file_0";
  }]);
  let state = await loop.start("demo", editingProgram());
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.steps[0].result.ok, false);
  assert.equal(Object.hasOwn(state.run.steps[0].result, "fileEdit"), false);
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes.txt"), "utf8"), "external owner 🌏");
});
