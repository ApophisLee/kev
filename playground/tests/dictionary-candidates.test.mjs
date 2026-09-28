import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MODEL_ID } from "../src/lib/model-config.ts";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

const FINISH = { tool: "finish", description: "Finish when the required checks pass." };
const COMPLETE = "The requested Python program passes its output check.";
const SOURCE = "notes/source.txt";
const sourceIndex = (quote, start = 0) => ({ kind: "index", path: SOURCE, start, end: start + Array.from(quote).length, quote });
const note = (key, value, extra = {}) => ({ tool: "write_memory", description: `Keep a note in ${key}.`, key, value, ...extra });
const task = (actions, extra = {}) => ({
  goal: "Choose useful dictionary actions, inspect files, and maintain accurate memory.",
  maxSteps: 12, readLimit: 200,
  actions: { ...actions, finish: FINISH }, ...extra,
});
const readerTask = text => task({
  read: { tool: "read_file", description: "Read a source page." },
  remember: { tool: "remember_excerpt", description: "Save useful evidence." },
  revise: { tool: "edit_memory", description: "Revise an existing memory with evidence." },
  forget: { tool: "delete_memory", description: "Delete an obsolete memory." },
}, { initialFiles: { [SOURCE]: text } });
const matching = predicate => request => {
  const [question] = Object.keys(request.questions);
  const candidate = Object.entries(request.questions[question].criteria).find(([, value]) => predicate(value));
  assert.ok(candidate, `No matching choice in ${question}`);
  return candidate[0];
};
const readSource = matching(candidate => candidate.path === SOURCE && candidate.offset === 0);

async function fixture(t, choices) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-candidates-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(url, "http://candidates.test/v1/systemone");
    const request = JSON.parse(options.body);
    requests.push(request);
    const [question] = Object.keys(request.questions);
    assert.ok(choices.length, `Unexpected model request: ${question}`);
    const next = choices.shift();
    const choice = typeof next === "function" ? await next(request) : next;
    const criteria = request.questions[question].criteria;
    assert.ok(Object.hasOwn(criteria, choice), `Unavailable choice ${question}/${choice}`);
    return Response.json({ model: MODEL_ID, answers: { [question]: {
      type: "choice", choice, confidence: 0.8,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])),
    } }, usage: { input_tokens: 100, output_tokens: 0 }, latency_ms: 1 });
  };
  const loop = new ToolLoop(root, "http://candidates.test", fetcher, undefined, async () => 100);
  const memoryPath = path.join(root, "demo/memory.json");
  const start = async (program, memory = {}) => {
    await loop.start("demo", program);
    await writeFile(memoryPath, JSON.stringify(memory));
    return loop.snapshot("demo");
  };
  return { root, loop, requests, memoryPath, start };
}

test("legacy completion notes and requiresChecks notes require nonempty, fully passing checks", async t => {
  for (const [name, checks, initialFiles, ready] of [
    ["absent checks", undefined, {}, false],
    ["empty checks", {}, {}, false],
    ["unmet check", { result: { file: "done.txt", equals: "ready" } }, {}, false],
    ["partly met checks", { result: { file: "done.txt", equals: "ready" }, other: { file: "other.txt", equals: "ready" } }, { "done.txt": "ready" }, false],
    ["all checks pass", { result: { file: "done.txt", equals: "ready" } }, { "done.txt": "ready" }, true],
  ]) {
    await t.test(name, async t => {
      const { loop, start, requests } = await fixture(t, ["write_memory", request => {
        const criteria = request.questions.arguments.criteria;
        assert.equal(Object.hasOwn(criteria, "legacy_complete"), ready);
        assert.equal(Object.hasOwn(criteria, "guarded_note"), ready);
        assert.ok(Object.hasOwn(criteria, "custom_note"), "Generic notes must not be treated as completion assertions by wording alone");
        return ready ? "guarded_note" : "custom_note";
      }]);
      let state = await start(task({
        legacy_complete: note("task_status", COMPLETE),
        guarded_note: note("verified", "The check was verified.", { requiresChecks: true }),
        custom_note: note("custom_status", COMPLETE),
      }, { checks, initialFiles }));
      state = await loop.step("demo", state.run.id, 0);
      assert.equal(state.run.steps[0].result.ok, true);
      assert.equal(state.run.steps[0].result.changed, true);
      assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, "finish"), !checks || !Object.keys(checks).length || ready);
      const previews = requests[0].questions.next_tool.criteria.write_memory.previews;
      assert.equal(previews.some(preview => preview.choice === "legacy_complete"), ready);
    });
  }
});

test("identical static memory writes are omitted while genuine replacements stay selectable", async t => {
  const { loop, start, requests } = await fixture(t, ["write_memory", "replace"]);
  let state = await start(task({ unchanged: note("task_note", "planned"), replace: note("task_note", "revised") }), {
    task_note: "planned", unrelated: "Keep this entry.",
  });
  state = await loop.step("demo", state.run.id, 0);
  assert.deepEqual(Object.keys(requests[1].questions.arguments.criteria), ["replace"]);
  assert.deepEqual(requests[0].questions.next_tool.criteria.write_memory.previews.map(preview => preview.choice), ["replace"]);
  assert.equal(requests[0].questions.next_tool.criteria.write_memory.previews[0].effect, "Replace memory entry");
  assert.deepEqual(state.memory, { task_note: "revised", unrelated: "Keep this entry." });
  assert.equal(state.run.steps[0].result.changed, true);
});

test("write_memory is unavailable when every supplied note already matches memory", async t => {
  const { loop, start, requests } = await fixture(t, ["finish"]);
  let state = await start(task({ unchanged: note("task_note", "planned") }), { task_note: "planned" });
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, "write_memory"), false);
  assert.equal(state.run.status, "ended");
});

test("remember_excerpt omits a structurally identical source index already stored under another key", async t => {
  const text = "A fact worth retaining.";
  const equivalent = { quote: text, end: text.length, start: 0, path: SOURCE, kind: "index" };
  const { loop, start, requests } = await fixture(t, ["read_file", readSource, "finish"]);
  let state = await start(readerTask(text), { manual_name: equivalent });
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(Object.hasOwn(requests[2].questions.next_tool.criteria, "remember_excerpt"), false);
  assert.equal(Object.hasOwn(requests[2].questions.next_tool.criteria, "edit_memory"), false);
  assert.deepEqual(state.memory, { manual_name: equivalent });
});

test("edit_memory offers only targets with a genuinely different visible excerpt", async t => {
  const text = "A fact worth retaining.";
  const { loop, start, requests } = await fixture(t, ["read_file", readSource, "edit_memory", "outdated", "excerpt_1", "finish"]);
  let state = await start(readerTask(text), { correct: sourceIndex(text), outdated: "An obsolete note." });
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.deepEqual(Object.keys(requests[3].questions.memory_target.criteria), ["outdated"]);
  assert.deepEqual(Object.keys(requests[4].questions.arguments.criteria), ["excerpt_1"]);
  assert.deepEqual(state.memory, { correct: sourceIndex(text), outdated: sourceIndex(text) });
  assert.equal(state.run.steps[1].result.changed, true);
  state = await loop.step("demo", state.run.id, 2);
  assert.equal(Object.hasOwn(requests[5].questions.next_tool.criteria, "edit_memory"), false);
});

test("editing a chosen target removes equal excerpts but keeps different source locations", async t => {
  const first = "a".repeat(120), second = "b".repeat(80);
  const { loop, start, requests } = await fixture(t, ["read_file", readSource, "edit_memory", "note", "excerpt_2"]);
  let state = await start(readerTask(first + second), { note: sourceIndex(first) });
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.deepEqual(Object.keys(requests[4].questions.arguments.criteria), ["excerpt_2"]);
  assert.deepEqual(state.memory.note, sourceIndex(second, 120));
  assert.equal(state.run.steps[1].result.changed, true);
});

test("a memory write that becomes a no-op during selection preserves disk bytes and concurrent entries", async t => {
  let memoryPath;
  const external = '{\n "task_note": "planned",\n "external": "Preserve concurrent work."\n}\n';
  const fixtureResult = await fixture(t, ["write_memory", async () => {
    await writeFile(memoryPath, external);
    return "save";
  }]);
  ({ memoryPath } = fixtureResult);
  const { loop, start } = fixtureResult;
  let state = await start(task({ save: note("task_note", "planned") }));
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.steps[0].result.ok, true);
  assert.equal(state.run.steps[0].result.changed, false);
  assert.match(state.run.steps[0].result.message, /unchanged/i);
  assert.equal(await readFile(memoryPath, "utf8"), external, "An unchanged memory write must not rewrite the file");
  assert.deepEqual(state.memory, JSON.parse(external));
});

test("an excerpt indexed under another key during selection is not duplicated", async t => {
  const text = "A fact worth retaining.";
  let memoryPath;
  const external = JSON.stringify({ concurrent_index: sourceIndex(text), unrelated: "Keep this note." }, null, 1) + "\n";
  const fixtureResult = await fixture(t, ["read_file", readSource, "remember_excerpt", async () => {
    await writeFile(memoryPath, external);
    return "excerpt_1";
  }]);
  ({ memoryPath } = fixtureResult);
  const { loop, start, requests } = fixtureResult;
  let state = await start(readerTask(text));
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(state.run.steps[1].result.ok, true);
  assert.equal(state.run.steps[1].result.changed, false);
  assert.match(state.run.steps[1].result.message, /unchanged.*already indexed/i);
  assert.equal(await readFile(memoryPath, "utf8"), external);
  assert.deepEqual(state.memory, JSON.parse(external));
  const preview = requests[2].questions.next_tool.criteria.remember_excerpt.previews[0];
  assert.deepEqual(preview.source, { path: SOURCE, start: 0, end: text.length });
  assert.equal(JSON.stringify(preview).includes(text), false, "Index previews show source locations rather than repeating page text");
});

test("a completion note is rejected if its required check changes during argument selection", async t => {
  let root;
  const fixtureResult = await fixture(t, ["write_memory", async () => {
    await rm(path.join(root, "demo/sandbox/done.txt"));
    return "guarded";
  }]);
  ({ root } = fixtureResult);
  const { loop, start, memoryPath } = fixtureResult;
  let state = await start(task({ guarded: note("verified", "Checked.", { requiresChecks: true }) }, {
    initialFiles: { "done.txt": "ready" }, checks: { result: { file: "done.txt", equals: "ready" } },
  }), { unrelated: "Retain this note." });
  const memoryBefore = await readFile(memoryPath, "utf8");
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.steps[0].result.ok, false);
  assert.equal(state.run.steps[0].result.changed, false);
  assert.match(state.run.steps[0].result.message, /checks have not passed/i);
  assert.equal(await readFile(memoryPath, "utf8"), memoryBefore);
});

test("tool previews contain at most three viable notes with bounded Unicode values", async t => {
  const long = "🧭".repeat(125);
  const { loop, start, requests } = await fixture(t, ["write_memory", "fourth"]);
  let state = await start(task({
    first: note("first_note", long), second: note("second_note", "two"),
    third: note("third_note", "three"), fourth: note("fourth_note", "four"),
  }));
  state = await loop.step("demo", state.run.id, 0);
  const tool = requests[0].questions.next_tool.criteria.write_memory;
  assert.equal(tool.available_choices, 4);
  assert.equal(tool.previews.length, 3);
  assert.equal(tool.preview_remaining, 1);
  assert.deepEqual(tool.previews.map(preview => preview.choice), ["first", "second", "third"]);
  assert.deepEqual(tool.previews[0], {
    choice: "first", key: "first_note", effect: "Add memory entry",
    value: { text: "🧭".repeat(120), characters: 125, truncated: true },
  });
  assert.equal(state.memory.fourth_note, "four", "Choices beyond the preview remain available at the argument stage");
});

test("file tool previews expose concrete paths and effects without leaking file bodies", async t => {
  const unseen = "UNREAD_PRIVATE_TEXT_".repeat(20);
  const supplied = "COMPLETE_STATIC_FILE_BODY_".repeat(12);
  const { loop, start, requests } = await fixture(t, ["finish"]);
  const state = await start(task({
    create: { tool: "create_file", description: "Create an empty target.", paths: ["new.txt"] },
    read: { tool: "read_file", description: "Read a source page." },
    write: { tool: "write_file", description: "Write supplied contents.", path: "result.txt", content: supplied },
  }, { initialFiles: { [SOURCE]: unseen } }));
  await loop.step("demo", state.run.id, 0);
  const tools = requests[0].questions.next_tool.criteria;
  assert.deepEqual(tools.create_file.previews[0], { choice: "file_0", path: "new.txt", effect: "Create an empty file" });
  assert.equal(tools.read_file.previews[0].path, SOURCE);
  assert.equal(tools.read_file.previews[0].start, 0);
  assert.equal(tools.read_file.previews[0].limit, 200);
  assert.equal(tools.write_file.previews[0].path, "result.txt");
  assert.equal(tools.write_file.previews[0].characters, supplied.length);
  assert.equal(JSON.stringify(tools).includes("UNREAD_PRIVATE_TEXT_"), false);
  assert.equal(JSON.stringify(tools).includes("COMPLETE_STATIC_FILE_BODY_"), false);
});

test("argument instructions describe the selected write, read or delete operation", async t => {
  for (const [name, actions, initialFiles, memory, choices, expected, irrelevant] of [
    ["write", { save: note("task_note", "A supplied note.") }, {}, {}, ["write_memory", "save"], /memory|note/i, /excerpt|source location|unseen file/i],
    ["read", { read: { tool: "read_file", description: "Read a page." } }, { [SOURCE]: "Read this bounded page." }, {}, ["read_file", readSource], /page|read/i, /important excerpt|source location|delete.*memory/i],
    ["delete", { forget: { tool: "delete_memory", description: "Delete a note." } }, {}, { obsolete: "Remove me." }, ["delete_memory", "obsolete"], /delete|forget|remove/i, /excerpt|source location|unseen file/i],
  ]) {
    await t.test(name, async t => {
      const { loop, start, requests } = await fixture(t, choices);
      let state = await start(task(actions, { initialFiles }), memory);
      state = await loop.step("demo", state.run.id, 0);
      assert.equal(state.run.steps[0].result.ok, true);
      const instructions = requests[1].questions.arguments.instructions;
      assert.match(instructions, expected);
      assert.doesNotMatch(instructions, irrelevant);
      if (name === "delete") assert.equal(state.run.steps[0].result.changed, true);
    });
  }
});
