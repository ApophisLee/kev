import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

const finish = { tool: "finish", description: "Finish the edit fixture." };
const length = value => Array.from(value).length;
const slice = (value, start, end) => Array.from(value).slice(start, end).join("");
const ascii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(index + 32)).join("") + "\n";

async function fixture(t, plan, counter = async () => 100) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "edit-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pending = [...plan], calls = [], counted = [];
  const tokenCounter = async request => {
    counted.push(structuredClone(request));
    return counter(request);
  };
  const fetcher = async (url, options) => {
    assert.equal(url, "http://edit.test/v1/systemone");
    const request = JSON.parse(options.body);
    const [stage] = Object.keys(request.questions);
    const criteria = request.questions[stage].criteria;
    assert.ok(pending.length, `Unexpected model request at ${stage}`);
    const next = pending.shift();
    const choice = typeof next === "function" ? await next(request, root) : next;
    assert.ok(Object.hasOwn(criteria, choice), `Unavailable ${stage} choice: ${choice}`);
    calls.push({ request, stage, choice });
    return Response.json({ answers: { [stage]: {
      type: "choice", choice, confidence: 1,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, Number(key === choice)])),
    } }, usage: { input_tokens: 100 }, latency_ms: 1 });
  };
  const loop = new ToolLoop(root, "http://edit.test", fetcher, undefined, tokenCounter);
  return { root, loop, calls, counted, assertDone: () => assert.deepEqual(pending, []) };
}

async function advance(loop, state, count = 1) {
  for (let index = 0; index < count; index++) {
    state = await loop.step(state.workspace, state.run.id, state.run.steps.length);
    assert.notEqual(state.run.status, "error", state.run.error);
  }
  return state;
}

function editingProgram(initialFiles, additions = {}) {
  return {
    goal: "Extend or revise the source using the supplied text pieces.", maxSteps: 10,
    readLimit: 80, writeLimit: 20, initialFiles,
    actions: {
      read: { tool: "read_file", description: "Read the needed source page." },
      append: { tool: "append_file", description: "Append a piece.", paths: ["addition.py"], fragments: { one: "1", close_call: ")\n" } },
      revise: { tool: "replace_file_range", description: "Replace visible text.", paths: ["addition.py"], fragments: { one: "1", close_call: ")\n" } },
      finish, ...additions,
    },
  };
}

function toolWithoutAppend(request) {
  assert.ok(request.questions.next_tool);
  assert.equal(Object.hasOwn(request.questions.next_tool.criteria, "append_file"), false,
    "append must not be offered without a current view of the target's end");
  return "read_file";
}

function assertLiteralPreview(request, key, expected) {
  const [question] = Object.values(request.questions);
  const candidate = question.criteria[key];
  assert.equal(typeof candidate, "object", "input choices must describe effects, not just a text label");
  assert.equal(candidate.insert, expected.insert);
  assert.equal(typeof candidate.effect, "string");
  assert.ok(candidate.effect.length > 0);
  for (const field of ["before", "after", "removed"]) {
    assert.equal((field === "after" ? candidate.preview : request.state.edit_preview)[field], expected[field], `the ${field} preview must match the selected edit`);
  }
  assert.equal(request.state.edit.operation, expected.operation);
  assert.equal(request.state.edit.start, expected.start);
  assert.equal(request.state.edit.end, expected.end);
  return key;
}

test("a new run preserves the existing prefix but must read it before appending", async t => {
  const data = await fixture(t, [
    toolWithoutAppend, "read_0_0", "append_file", "file_0", "fragment", "one", "finish",
    request => {
      assert.equal(request.state.last_step, null);
      assert.equal(request.state.reading, null);
      return toolWithoutAppend(request);
    }, "read_0_0", request => {
      assert.equal(request.state.reading.text, "print(1");
      assert.ok(request.questions.next_tool.criteria.append_file);
      return "finish";
    },
  ]);
  const program = editingProgram({ "addition.py": "print(" });
  let state = await data.loop.start("demo", program);
  state = await advance(data.loop, state, 3);
  assert.equal(state.run.status, "ended");
  state = await data.loop.start("demo", program);
  assert.equal(state.files[0].content, "print(1", "initialFiles must not overwrite a previous run's work");
  state = await advance(data.loop, state, 2);
  assert.equal(state.files[0].content, "print(1");
  data.assertDone();
});

test("a first page cannot authorize append, but an explicit bounded tail reading can", async t => {
  const source = "UNREAD_PREFIX_" + "x".repeat(180) + "print(1";
  const tail = length(source) - 80;
  const data = await fixture(t, [
    toolWithoutAppend, request => {
      assert.ok(request.questions.arguments.criteria[`read_0_${tail}`], "tail must be directly selectable before reading intermediate pages");
      return "read_0_0";
    }, toolWithoutAppend, `read_0_${tail}`, request => {
      assert.equal(request.state.reading.start, tail);
      assert.equal(request.state.reading.end, length(source));
      assert.equal(request.state.reading.text, slice(source, tail));
      assert.equal(JSON.stringify(request.state).includes("UNREAD_PREFIX_"), false,
        "edit context must not replay an older page after the model selects the tail");
      assert.ok(request.questions.next_tool.criteria.append_file);
      return "append_file";
    }, "file_0", "fragment", request => {
      const shown = { ...request.state.edit_preview, ...request.questions.write_fragment.criteria.close_call.preview };
      assert.ok(shown.preview_start >= tail && shown.preview_end <= length(source));
      assert.equal(shown.preview_end, length(source));
      assert.equal(shown.after_preview_end, length(source) + 2);
      const key = assertLiteralPreview(request, "close_call", {
        operation: "append", start: length(source), end: length(source), insert: ")\n",
        before: slice(source, shown.preview_start, shown.preview_end),
        after: slice(source + ")\n", shown.preview_start, shown.after_preview_end), removed: "",
      });
      assert.equal(JSON.stringify(request.questions).includes("UNREAD_PREFIX_"), false);
      return key;
    },
  ]);
  let state = await data.loop.start("demo", editingProgram({ "addition.py": source }));
  state = await advance(data.loop, state, 3);
  assert.equal(await readFile(path.join(data.root, "demo/sandbox/addition.py"), "utf8"), source + ")\n");
  assert.ok(length(state.run.reading.text) <= 80);
  data.assertDone();
});

for (const operation of ["append", "replace"]) {
  test(`${operation} close_call shows the literal outcome that is committed to disk`, async t => {
    const before = "print(1";
    const after = operation === "append" ? "print(1)\n" : ")\n";
    const start = operation === "append" ? length(before) : 0;
    let shown;
    const data = await fixture(t, [
      "read_file", "read_0_0", operation === "append" ? "append_file" : "replace_file_range",
      operation === "append" ? "file_0" : "current_view", "fragment", request => {
        assertLiteralPreview(request, "close_call", {
          operation, start, end: length(before), insert: ")\n", before, after,
          removed: operation === "append" ? "" : before,
        });
        shown = request.questions.write_fragment.criteria.close_call.preview;
        return "close_call";
      },
    ]);
    let state = await data.loop.start("demo", editingProgram({ "addition.py": before }));
    state = await advance(data.loop, state, 2);
    const step = state.run.steps[1];
    assert.equal(step.result.ok, true);
    assert.equal(step.action.content, ")\n");
    assert.equal(step.result.fileChange.start, start);
    assert.equal(step.result.fileChange.end, length(before));
    assert.equal(await readFile(path.join(data.root, "demo/sandbox/addition.py"), "utf8"), shown.after);
    data.assertDone();
  });
}

test("single-line edits offer a small Unicode range whose preview preserves neighboring text", async t => {
  const data = await fixture(t, [
    "read_file", "read_0_0", "replace_file_range", request => {
      const entries = Object.entries(request.questions.write_range.criteria);
      const selected = entries.find(([, value]) => value.start === 1 && value.end === 2);
      assert.ok(selected, "the one Unicode character must be selectable without replacing the whole line");
      assert.ok(entries.length <= 40, "range dictionaries must stay bounded");
      return selected[0];
    }, "fragment", request => assertLiteralPreview(request, "one", {
      operation: "replace", start: 1, end: 2, insert: "1", before: "a🌏b", after: "a1b", removed: "🌏",
    }),
  ]);
  let state = await data.loop.start("demo", editingProgram({ "addition.py": "a🌏b" }));
  state = await advance(data.loop, state, 2);
  assert.equal(state.files[0].content, "a1b");
  assert.deepEqual(state.run.steps[1].result.fileChange, { path: "addition.py", start: 1, end: 2, insertedChars: 1, totalChars: 3 });
  data.assertDone();
});

test("an insertion cursor exposes available fragment literals and preserves the existing closing parenthesis", async t => {
  const fragments = { one: "1", close_call: ")\n" };
  const data = await fixture(t, [
    "read_file", "read_0_0", "replace_file_range", request => {
      const cursor = request.questions.write_range.criteria.insert_at_6;
      assert.ok(cursor, "the position between the existing parentheses must be selectable");
      assert.equal(cursor.start, 6);
      assert.equal(cursor.end, 6);
      assert.equal(cursor.delete, "", "an insertion cursor must not advertise deletion of the closing parenthesis");
      return "insert_at_6";
    }, request => {
      const modes = request.questions.write_mode.criteria;
      assert.deepEqual(modes.fragment.fragments, fragments,
        "the model must see the raw available fragments before choosing fragment versus character input");
      assert.ok(modes.character);
      assert.deepEqual(request.state.edit, { operation: "insert", path: "addition.py", start: 6, end: 6 });
      return "fragment";
    }, request => assertLiteralPreview(request, "one", {
      operation: "insert", start: 6, end: 6, insert: "1", before: "print()", after: "print(1)", removed: "",
    }),
  ]);
  const program = editingProgram({ "addition.py": "print()" }, {
    revise: { tool: "replace_file_range", description: "Edit visible text.", paths: ["addition.py"], fragments, characters: "1+" },
  });
  let state = await data.loop.start("demo", program);
  state = await advance(data.loop, state, 2);
  assert.equal(await readFile(path.join(data.root, "demo/sandbox/addition.py"), "utf8"), "print(1)");
  assert.equal(state.run.steps[1].action.content, "1");
  assert.deepEqual(state.run.steps[1].result.fileChange, {
    path: "addition.py", start: 6, end: 6, insertedChars: 1, totalChars: 8,
  });
  data.assertDone();
});

test("large Unicode readings can focus recursively on an exact character without replacing its neighbors", async t => {
  const prefix = "外🌏".repeat(120) + "n".repeat(190);
  const source = prefix + "🎯" + "尾".repeat(89);
  const target = length(prefix), tail = length(source) - 300;
  const expected = prefix + "1" + "尾".repeat(89);
  let parentRange = { start: tail, end: length(source) };
  let groupCount = 0;
  const choosePart = request => {
    const criteria = request.questions.write_range_group?.criteria;
    assert.ok(criteria, "large ranges must be narrowed before selecting an exact character");
    const parts = Object.entries(criteria);
    assert.equal(parts.length, 4);
    assert.equal(parts[0][1].start, parentRange.start);
    assert.equal(parts.at(-1)[1].end, parentRange.end);
    for (const [index, [, part]] of parts.entries()) {
      assert.ok(part.end > part.start);
      assert.equal(part.text, slice(source, part.start, part.start + length(part.text)));
      assert.ok(length(part.text) <= 40);
      if (index > 0) assert.equal(parts[index - 1][1].end, part.start, "groups must partition the visible range without gaps");
    }
    const selected = parts.find(([, part]) => part.start <= target && part.end > target);
    assert.ok(selected);
    parentRange = { start: selected[1].start, end: selected[1].end };
    groupCount++;
    assert.equal(request.state.current_step.execution_status, "not_executed");
    return selected[0];
  };
  const data = await fixture(t, [
    "read_file", `read_0_${tail}`, "replace_file_range", request => {
      const criteria = request.questions.write_range.criteria;
      assert.deepEqual(Object.keys(criteria).sort(), ["current_view", "focus_range"]);
      assert.equal(criteria.current_view.start, tail);
      assert.equal(criteria.current_view.end, length(source));
      assert.equal(criteria.current_view.delete, slice(source, tail, tail + 80));
      assert.equal(criteria.current_view.delete_clipped, true,
        "a deletion preview must disclose that its 80 characters are only part of the selected range");
      return "focus_range";
    }, choosePart, choosePart, choosePart, request => {
      const criteria = request.questions.write_range.criteria;
      assert.ok(parentRange.end - parentRange.start <= 16);
      const selected = Object.entries(criteria).find(([, part]) => part.start === target && part.end === target + 1);
      assert.ok(selected, "fine ranges must retain absolute Unicode offsets after recursive focusing");
      assert.equal(selected[1].delete, "🎯");
      assert.equal(request.state.current_step.decisions.filter(item => item.stage === "write_range_group").length, groupCount);
      return selected[0];
    }, "fragment", request => {
      const shown = { ...request.state.edit_preview, ...request.questions.write_fragment.criteria.one.preview };
      assert.ok(shown.preview_start >= tail);
      return assertLiteralPreview(request, "one", {
        operation: "replace", start: target, end: target + 1, insert: "1", removed: "🎯",
        before: slice(source, shown.preview_start, shown.preview_end),
        after: slice(expected, shown.preview_start, shown.after_preview_end),
      });
    },
  ]);
  const program = { ...editingProgram({ "addition.py": source }), readLimit: 300 };
  let state = await data.loop.start("demo", program);
  state = await advance(data.loop, state, 2);
  assert.equal(groupCount, 3);
  assert.equal(await readFile(path.join(data.root, "demo/sandbox/addition.py"), "utf8"), expected);
  assert.deepEqual(state.run.steps[1].result.fileChange, {
    path: "addition.py", start: target, end: target + 1, insertedChars: 1, totalChars: length(source),
  });
  data.assertDone();
});

test("an external file change invalidates the tail view before the next tool selection", async t => {
  const data = await fixture(t, ["read_file", "read_0_0", request => {
    assert.equal(request.state.reading, null);
    return toolWithoutAppend(request);
  }, "read_0_0"]);
  let state = await data.loop.start("demo", editingProgram({ "addition.py": "print(" }));
  state = await advance(data.loop, state);
  await writeFile(path.join(data.root, "demo/sandbox/addition.py"), "print(1");
  state = await advance(data.loop, state);
  assert.equal(state.run.reading.text, "print(1");
  data.assertDone();
});

test("character choices retain stable dictionary keys after selecting a small character group", async t => {
  const data = await fixture(t, [
    "read_file", "read_0_0", "append_file", "file_0", "character", request => {
      assert.ok(request.questions.write_character_group, "large alphabets require an explicit group decision");
      const groups = Object.entries(request.questions.write_character_group.criteria);
      assert.ok(groups.length <= 16);
      const selected = groups.find(([, value]) => value.characters.includes("1"));
      assert.ok(selected, "group choices must disclose the available literal characters");
      return selected[0];
    }, request => {
      const candidates = request.questions.write_character.criteria;
      assert.ok(Object.keys(candidates).length <= 16, "do not offer all 96 characters in one choice");
      assertLiteralPreview(request, "char_17", {
        operation: "append", start: 6, end: 6, insert: "1", before: "print(", after: "print(1", removed: "",
      });
      assert.ok(request.state.current_step.decisions.some(item => item.stage === "write_character_group"));
      return "char_17";
    },
  ]);
  const program = editingProgram({ "addition.py": "print(" }, {
    append: { tool: "append_file", description: "Type one character.", paths: ["addition.py"], characters: ascii },
  });
  let state = await data.loop.start("demo", program);
  state = await advance(data.loop, state, 2);
  assert.equal(state.files[0].content, "print(1");
  assert.equal(state.run.steps[1].action.content, "1");
  assert.equal(state.run.steps[1].decisions.at(-1).choice, "char_17");
  data.assertDone();
});

test("an over-budget edit preview is blocked before the final decision or a file mutation", async t => {
  const data = await fixture(t, ["read_file", "read_0_0", "append_file", "file_0", "fragment"], async request =>
    request.questions.write_fragment ? 3001 : 100);
  let state = await data.loop.start("demo", editingProgram({ "addition.py": "print(1" }));
  state = await advance(data.loop, state);
  state = await data.loop.step(state.workspace, state.run.id, state.run.steps.length);
  assert.equal(state.run.status, "error");
  assert.match(state.run.error, /3,001 input tokens.*3,000-token limit/);
  assert.equal(data.calls.some(call => call.stage === "write_fragment"), false);
  assert.equal(state.run.steps.length, 1, "partial selection does not count as an executed edit");
  assert.equal(await readFile(path.join(data.root, "demo/sandbox/addition.py"), "utf8"), "print(1");
  const rejected = data.counted.find(request => request.questions.write_fragment);
  assert.equal(rejected.state.last_step.tool, "read_file");
  assert.equal(rejected.state.current_step.execution_status, "not_executed");
  data.assertDone();
});
