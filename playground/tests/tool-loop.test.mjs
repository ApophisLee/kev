import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { completionChecks, EXAMPLE, EXAMPLES, parseProgram } from "../src/lib/tool-loop.ts";
import { exclusive, localRequest, ToolLoop } from "../src/lib/tool-loop-server.ts";
import { MODEL_ID } from "../src/lib/model-config.ts";

const END = { tool: "END", description: "Finish when the goal is complete." };
const BASIC = {
  goal: "Write a greeting and remember the project name, then finish.",
  maxSteps: 12,
  checks: {
    greeting_created: { file: "notes/hello.txt", equals: "Hello from Kev!" },
    project_remembered: { memory: "project", equals: "Kev Playground" },
  },
  actions: {
    create_greeting: { tool: "write_file", description: "Write the greeting.", path: "notes/hello.txt", content: "Hello from Kev!" },
    create_farewell: { tool: "write_file", description: "Write a farewell instead.", path: "notes/hello.txt", content: "Goodbye from Kev!" },
    remember_project: { tool: "write_memory", description: "Remember the project name.", key: "project", value: "Kev Playground" },
    END,
  },
};

const BUILDER = {
  goal: 'Create hello.py that prints exactly "Hello, world!" using separate function and string choices.',
  maxSteps: 16,
  readLimit: 300,
  initialFiles: {
    "docs/python-intro.md": "Python programs are plain text files. A function call has a name, parentheses, and an argument. print displays a value; len and repr return values. ".repeat(4),
  },
  checks: { hello_world_written: { file: "hello.py", pythonPrints: "Hello, world!" } },
  actions: {
    compose: { tool: "write_python", description: "Choose a file, function, and string independently.", paths: ["hello.py", "scratch.py"], functions: ["print", "len", "repr"], strings: { greeting: "Hello, world!", name: "Kev", empty: "" } },
    note_progress: { tool: "write_memory", description: "Record task progress.", key: "task_status", value: "Writing a simple Python program." },
    read: { tool: "read_file", description: "Read a tutorial page." },
    remember: { tool: "remember_excerpt", description: "Keep a useful source index." },
    revise: { tool: "edit_memory", description: "Revise a memory with current evidence." },
    forget: { tool: "delete_memory", description: "Remove irrelevant memory." },
    finish: { tool: "finish", description: "Finish when the program is correct." },
  },
};

function readerProgram(content, overrides = {}) {
  return {
    goal: "Read the document in short pages. Select useful evidence to index in memory, revise or delete memory when needed, then finish.",
    maxSteps: 16,
    readLimit: 200,
    initialFiles: { "notes/source.txt": content },
    actions: {
      read: { tool: "read_file", description: "Read a bounded page of a sandbox file." },
      index: { tool: "remember_excerpt", description: "Index a useful excerpt from the current reading." },
      revise: { tool: "edit_memory", description: "Replace a memory entry with current evidence." },
      forget: { tool: "delete_memory", description: "Delete a memory entry." },
      END,
    },
    ...overrides,
  };
}

function segmentedProgram(content, fragments = { chunk: "next fragment" }) {
  return {
    goal: "Edit the target using short fragments while preserving the text outside each edit.",
    maxSteps: 16,
    readLimit: 120,
    writeLimit: 40,
    initialFiles: content === null ? {} : { "notes/source.txt": content },
    actions: {
      create: { tool: "create_file", description: "Create an empty target.", paths: ["notes/source.txt"] },
      append: { tool: "append_file", description: "Append a short fragment.", paths: ["notes/source.txt"], fragments },
      replace: { tool: "replace_file_range", description: "Revise an observed range.", paths: ["notes/source.txt"], fragments },
      read: { tool: "read_file", description: "Read a bounded source page." },
      remember: { tool: "write_memory", description: "Keep a task note.", key: "task_note", value: "Preserve surrounding text." },
      finish: { tool: "finish", description: "Finish editing." },
    },
  };
}

const argument = predicate => request => {
  assert.deepEqual(Object.keys(request.questions), ["arguments"]);
  const selected = Object.entries(request.questions.arguments.criteria).find(([, value]) => predicate(value));
  assert.ok(selected, `No matching argument in ${JSON.stringify(request.questions.arguments.criteria)}`);
  return selected[0];
};
const page = offset => argument(value => value.tool === "read_file" && value.path === "notes/source.txt" && value.offset === offset);
const containsText = (value, text) => typeof value === "string" ? value.includes(text)
  : value && typeof value === "object" ? Object.values(value).some(nested => containsText(nested, text)) : false;

async function fixture(t, decisions) {
  // /private/tmp is canonical on macOS, avoiding /var's OS-level symlink.
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-tool-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(url, "http://model.test/v1/systemone");
    const request = JSON.parse(options.body);
    requests.push(request);
    const [question] = Object.keys(request.questions);
    assert.equal(Object.keys(request.questions).length, 1);
    assert.ok(["next_tool", "memory_target", "arguments", "python_file", "python_function", "python_string", "write_target", "write_range", "write_fragment", "write_mode", "write_character"].includes(question));
    assert.ok(decisions.length, "Unexpected extra model request");
    let decision = decisions.shift();
    if (typeof decision === "function") decision = await decision(request);
    if (decision instanceof Error) throw decision;
    const { choice, latency_ms = 12, confidence = 0.9 } = typeof decision === "string" ? { choice: decision } : decision;
    if (typeof decision === "object" && decision.question) assert.equal(question, decision.question);
    return Response.json({ answers: { [question]: {
      type: "choice", choice, confidence,
      probabilities: Object.fromEntries(Object.keys(request.questions[question].criteria).map(k => [k, k === choice ? 1 : 0])),
    } }, latency_ms });
  };
  const loop = new ToolLoop(root, "http://model.test", fetcher, undefined, async () => 100);
  return { root, loop, requests };
}

test("the default program builds hello.py one bounded fragment at a time before finish", async t => {
  const tools = Object.values(EXAMPLE.actions).map(action => action.tool);
  for (const tool of ["create_file", "append_file", "replace_file_range", "read_file", "remember_excerpt", "edit_memory", "delete_memory", "finish"]) assert.ok(tools.includes(tool));
  assert.ok(!tools.includes("write_file") && !tools.includes("write_python") && !tools.includes("write_memory"));
  for (const { program } of Object.values(EXAMPLES)) {
    assert.equal(Object.hasOwn(program.actions, "note_progress"), false);
    assert.equal(Object.hasOwn(program.actions, "note_complete"), false);
    assert.ok(Object.values(program.actions).every(action => action.tool !== "write_memory"), "presets must not replace removed progress notes with another static memory action");
  }
  const { root, loop, requests } = await fixture(t, [
    "create_file", "file_0",
    "append_file", "file_0", "fragment", "open_print",
    "append_file", "file_0", "fragment", "greeting",
    "append_file", "file_0", "fragment", "close_call",
    "finish",
  ]);
  let state = await loop.start("fragment-hello", EXAMPLE);
  const tutorial = state.files.find(file => file.path === "docs/python-intro.md").content;
  const contents = ["", "print(", 'print("Hello, world!"', 'print("Hello, world!")\n'];
  for (let step = 0; step < contents.length; step++) {
    const previousReading = structuredClone(state.run.reading);
    const firstRequest = requests.length;
    state = await loop.step("fragment-hello", state.run.id, step);
    assert.equal(state.run.status, "running");
    assert.equal(state.run.steps[step].result.ok, true);
    assert.equal(await readFile(path.join(root, "fragment-hello/sandbox/hello.py"), "utf8"), contents[step]);
    assert.deepEqual(state.memory, {});
    assert.ok(Array.from(state.run.reading.text).length <= EXAMPLE.readLimit);
    assert.equal(state.run.reading.path, "hello.py");
    assert.equal(state.run.steps[step].result.fileChange.path, "hello.py");
    assert.ok(state.run.steps[step].result.fileChange.insertedChars <= EXAMPLE.writeLimit);
    assert.equal(Object.hasOwn(requests[firstRequest].questions.next_tool.criteria, "finish"), false);
    for (const request of requests.slice(firstRequest)) {
      assert.deepEqual(request.state.reading, previousReading);
      assert.deepEqual(request.state.persistent_memory, {});
    }
    assert.equal(completionChecks(EXAMPLE, state)[0].met, step === 3);
  }
  assert.deepEqual(state.run.steps[0].decisions.map(decision => decision.stage), ["tool", "arguments"]);
  for (const step of state.run.steps.slice(1)) assert.deepEqual(step.decisions.map(decision => decision.stage), ["tool", "write_target", "write_mode", "write_fragment"]);
  const finalReading = structuredClone(state.run.reading);
  state = await loop.step("fragment-hello", state.run.id, 4);
  assert.equal(state.run.status, "ended");
  assert.equal(state.run.steps[4].action.tool, "finish");
  assert.equal(state.run.steps[4].result.ok, true);
  assert.ok(Object.hasOwn(requests.at(-1).questions.next_tool.criteria, "finish"));
  assert.deepEqual(requests.at(-1).state.reading, finalReading);
  assert.ok(requests.at(-1).state.completion_checks.every(check => check.startsWith("DONE:")));
  assert.equal(containsText(EXAMPLE, 'print("Hello, world!")'), false);
  for (const request of requests.slice(0, -1)) {
    assert.equal(containsText(request.state, 'print("Hello, world!")'), false, "State cannot contain an unbuilt answer");
    const options = request.questions.write_fragment?.criteria;
    if (options) for (const option of Object.values(options)) {
      assert.equal(option.preview.after, request.state.reading.text + option.insert, "Preview only combines observed code with one literal fragment");
      assert.equal(containsText(option.insert, 'print("Hello, world!")'), false);
    }
  }
  for (const request of requests) {
    assert.equal(containsText(request, tutorial), false);
    assert.equal(containsText(request, "Python programs are plain text files"), false);
  }
});

test("addition and variable presets build programs from small pieces and validate their output", async t => {
  for (const [preset, file, fragments, source, output] of [
    ["addition", "addition.py", ["open_print", "one", "plus", "one", "close_call"], "print(1 + 1)\n", "2\n"],
    ["variables", "variables.py", ["assign_a", "two", "newline", "assign_b", "three", "newline", "open_print", "variable_a", "plus", "variable_b", "close_call"], "a = 2\nb = 3\nprint(a + b)\n", "5\n"],
  ]) {
    await t.test(preset, async t => {
      const program = EXAMPLES[preset].program;
      assert.deepEqual(program.checks.output_matches, { file, pythonOutput: output });
      assert.equal(containsText(program, source.trim()), false, "Preset dictionaries must not supply the complete answer");
      const decisions = ["create_file", "file_0", ...fragments.flatMap(fragment => ["append_file", "file_0", "fragment", fragment]), "finish"];
      const { root, loop, requests } = await fixture(t, decisions);
      let state = await loop.start(preset, program);
      for (let step = 0; step < fragments.length + 2; step++) state = await loop.step(preset, state.run.id, step);
      assert.equal(state.run.status, "ended");
      assert.ok(state.run.steps.every(step => step.result.ok));
      assert.equal(await readFile(path.join(root, preset, "sandbox", file), "utf8"), source);
      assert.ok(completionChecks(program, state).every(check => check.met));
      assert.ok(requests.at(-1).state.completion_checks.every(check => check.startsWith("DONE:")));
      for (const step of state.run.steps.filter(step => step.action.tool === "append_file")) {
        assert.ok(step.result.fileChange.insertedChars <= program.writeLimit);
      }
      for (const request of requests.slice(0, -1)) {
        assert.equal(containsText(request.state, source.trim()), false);
        const options = request.questions.write_fragment?.criteria;
        if (options) for (const option of Object.values(options)) {
          assert.equal(option.preview.after, request.state.reading.text + option.insert);
          assert.equal(containsText(option.insert, source.trim()), false, "No complete answer is supplied as an insertion");
        }
      }
      for (const request of requests) assert.equal(containsText(request, "Python programs are plain text files"), false);
    });
  }
});

test("character mode types one Unicode codepoint and also works for range replacement", async t => {
  const program = { ...segmentedProgram(null, { chunk: "Z" }), writeLimit: 1 };
  program.actions.append.characters = "🧭+\n";
  program.actions.replace.characters = "🧭+\n";
  const { root, loop, requests } = await fixture(t, [
    "write_memory", "remember", "create_file", "file_0",
    "append_file", "file_0", "character", "char_0",
    "append_file", "file_0", "character", "char_1",
    "replace_file_range", "current_view", "character", "char_2", "finish",
  ]);
  let state = await loop.start("characters", program);
  state = await loop.step("characters", state.run.id, 0);
  state = await loop.step("characters", state.run.id, 1);
  const memory = structuredClone(state.memory);
  for (const [step, expected] of [[2, "🧭"], [3, "🧭+"], [4, "\n"]]) {
    const priorReading = structuredClone(state.run.reading);
    const firstRequest = requests.length;
    state = await loop.step("characters", state.run.id, step);
    assert.equal(state.run.steps[step].result.ok, true);
    assert.equal(state.run.steps[step].result.fileChange.insertedChars, 1);
    assert.equal(await readFile(path.join(root, "characters/sandbox/notes/source.txt"), "utf8"), expected);
    assert.deepEqual(state.memory, memory);
    assert.equal(state.run.steps[step].decisions.at(-1).stage, "write_character");
    for (const request of requests.slice(firstRequest)) {
      assert.deepEqual(request.state.persistent_memory, memory);
      assert.deepEqual(request.state.reading, priorReading);
    }
    const labels = requests.at(-1).questions.write_character.criteria;
    for (const [key, value] of Object.entries({ char_0: "🧭", char_1: "+", char_2: "\n" })) assert.equal(labels[key].insert, value);
    assert.match(labels.char_2.effect, /newline/);
  }
  await loop.step("characters", state.run.id, 5);
  assert.equal(requests.at(-1).state.reading.text, "\n");
});

test("append preserves the existing prefix, returns a bounded edit view, and keeps memory in every decision", async t => {
  const prefix = "Older content. ".repeat(20);
  const fragment = "\n🧭 New ending.";
  const program = segmentedProgram(prefix, { chunk: fragment });
  const { root, loop, requests } = await fixture(t, [
    "write_memory", "remember", "read_file", page(Array.from(prefix).length - program.readLimit), "append_file", "file_0", "fragment", "chunk", "finish",
  ]);
  let state = await loop.start("append-demo", program);
  state = await loop.step("append-demo", state.run.id, 0);
  state = await loop.step("append-demo", state.run.id, 1);
  const memory = structuredClone(state.memory);
  const previousReading = structuredClone(state.run.reading);
  state = await loop.step("append-demo", state.run.id, 2);
  assert.equal(state.run.steps[2].result.ok, true);
  assert.equal(await readFile(path.join(root, "append-demo/sandbox/notes/source.txt"), "utf8"), prefix + fragment);
  assert.deepEqual(state.memory, memory);
  const reading = state.run.reading;
  assert.ok(Array.from(reading.text).length <= program.readLimit);
  assert.equal(reading.text, Array.from(prefix + fragment).slice(reading.start, reading.end).join(""));
  assert.ok(reading.text.includes(fragment));
  assert.deepEqual(state.run.steps[2].result.fileChange, {
    path: "notes/source.txt", start: Array.from(prefix).length, end: Array.from(prefix).length,
    insertedChars: Array.from(fragment).length, totalChars: Array.from(prefix + fragment).length,
  });
  for (const request of requests.slice(4, 8)) {
    assert.deepEqual(request.state.persistent_memory, memory);
    assert.deepEqual(request.state.reading, previousReading);
  }
  for (const request of requests.slice(6, 8)) assert.deepEqual(request.state.edit, {
    operation: "append", path: "notes/source.txt", start: Array.from(prefix).length, end: Array.from(prefix).length,
  });
  await loop.step("append-demo", state.run.id, 3);
  assert.deepEqual(requests[8].state.persistent_memory, memory);
  assert.deepEqual(requests[8].state.reading, reading);
});

test("fragment budgets count Unicode characters and reject oversized choices before a run starts", async t => {
  const program = { ...segmentedProgram(null, { chunk: "🧭界" }), writeLimit: 2 };
  assert.doesNotThrow(() => parseProgram(program));
  const { root, loop } = await fixture(t, ["create_file", "file_0", "append_file", "file_0", "fragment", "chunk"]);
  let state = await loop.start("unicode-fragment", program);
  state = await loop.step("unicode-fragment", state.run.id, 0);
  state = await loop.step("unicode-fragment", state.run.id, 1);
  assert.equal(state.run.steps[1].result.ok, true);
  assert.equal(state.run.steps[1].result.fileChange.insertedChars, 2);
  assert.equal(state.run.reading.totalChars, 2);
  assert.equal(await readFile(path.join(root, "unicode-fragment/sandbox/notes/source.txt"), "utf8"), "🧭界");
  const oversized = { ...segmentedProgram(null, { chunk: "🧭界!" }), writeLimit: 2 };
  assert.throws(() => parseProgram(oversized), /fragments/);
  await assert.rejects(loop.start("oversized-fragment", oversized), /fragments/);
  assert.deepEqual((await loop.snapshot("oversized-fragment")).files, []);
  for (const writeLimit of [0, 401, 1.5, "2", null]) assert.throws(() => parseProgram({ ...program, writeLimit }), /writeLimit/);
});

test("replacing the observed range preserves the file prefix and suffix and returns the edit for the next decision", async t => {
  const prefix = "P".repeat(120), oldRange = "O".repeat(120), suffix = "S".repeat(120);
  const replacement = "updated 🧭";
  const program = segmentedProgram(prefix + oldRange + suffix, { chunk: replacement });
  const { root, loop, requests } = await fixture(t, [
    "write_memory", "remember", "read_file", page(0), "read_file", page(120),
    "replace_file_range", "current_view", "fragment", "chunk", "finish",
  ]);
  let state = await loop.start("range-demo", program);
  for (let step = 0; step < 3; step++) state = await loop.step("range-demo", state.run.id, step);
  const memory = structuredClone(state.memory);
  const priorReading = structuredClone(state.run.reading);
  assert.equal(priorReading.text, oldRange);
  state = await loop.step("range-demo", state.run.id, 3);
  assert.equal(state.run.steps[3].result.ok, true);
  const updated = prefix + replacement + suffix;
  assert.equal(await readFile(path.join(root, "range-demo/sandbox/notes/source.txt"), "utf8"), updated);
  assert.deepEqual(state.memory, memory);
  assert.deepEqual(state.run.steps[3].result.fileChange, {
    path: "notes/source.txt", start: 120, end: 240,
    insertedChars: Array.from(replacement).length, totalChars: Array.from(updated).length,
  });
  const reading = structuredClone(state.run.reading);
  assert.ok(Array.from(reading.text).length <= program.readLimit);
  assert.equal(reading.text, Array.from(updated).slice(reading.start, reading.end).join(""));
  assert.ok(reading.text.includes(replacement));
  assert.deepEqual(state.run.steps[3].decisions.map(decision => decision.stage), ["tool", "write_range", "write_mode", "write_fragment"]);
  for (const request of requests.slice(6, 10)) {
    assert.deepEqual(request.state.persistent_memory, memory);
    assert.deepEqual(request.state.reading, priorReading);
  }
  for (const request of requests.slice(8, 10)) assert.deepEqual(request.state.edit, {
    operation: "replace", path: "notes/source.txt", start: 120, end: 240,
  });
  await loop.step("range-demo", state.run.id, 4);
  assert.deepEqual(requests[10].state.persistent_memory, memory);
  assert.deepEqual(requests[10].state.reading, reading);
});

test("stale append and range selections cannot overwrite externally changed files", async t => {
  for (const tool of ["append_file", "replace_file_range"]) {
    await t.test(tool, async t => {
      let root;
      const externalContent = "A newer external edit must survive.";
      const duringSelection = async request => {
        assert.deepEqual(Object.keys(request.questions), ["write_fragment"]);
        await writeFile(path.join(root, "stale-edit/sandbox/notes/source.txt"), externalContent);
        return "chunk";
      };
      const decisions = tool === "append_file"
        ? ["read_file", page(Array.from("Original evidence. ".repeat(10)).length - 120), tool, "file_0", "fragment", duringSelection]
        : ["read_file", page(0), tool, "current_view", "fragment", duringSelection];
      const setup = await fixture(t, decisions);
      root = setup.root;
      let state = await setup.loop.start("stale-edit", segmentedProgram("Original evidence. ".repeat(10), { chunk: "Model change" }));
      state = await setup.loop.step("stale-edit", state.run.id, 0);
      state = await setup.loop.step("stale-edit", state.run.id, state.run.steps.length);
      assert.equal(state.run.status, "running");
      assert.equal(state.run.steps.at(-1).result.ok, false);
      assert.match(state.run.steps.at(-1).result.message, /changed|stale/i);
      assert.equal(await readFile(path.join(root, "stale-edit/sandbox/notes/source.txt"), "utf8"), externalContent);
      assert.equal(state.run.steps.at(-1).result.fileChange, undefined);
      assert.deepEqual(state.memory, {});
    });
  }
});

test("create_file refuses to overwrite a file created after its dictionary was shown", async t => {
  let root;
  const setup = await fixture(t, ["create_file", async request => {
    assert.deepEqual(Object.keys(request.questions), ["arguments"]);
    const target = path.join(root, "create-race/sandbox/notes/source.txt");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "External content");
    return "file_0";
  }]);
  root = setup.root;
  let state = await setup.loop.start("create-race", segmentedProgram(null));
  state = await setup.loop.step("create-race", state.run.id, 0);
  assert.equal(state.run.status, "running");
  assert.equal(state.run.steps[0].result.ok, false);
  assert.equal(await readFile(path.join(root, "create-race/sandbox/notes/source.txt"), "utf8"), "External content");
  assert.deepEqual(state.memory, {});
});

test("the optional Python builder composes Python from separate dictionaries without offering the complete answer", async t => {
  assert.deepEqual([...new Set(Object.values(BUILDER.actions).map(action => action.tool))].sort(), [
    "delete_memory", "edit_memory", "finish", "read_file", "remember_excerpt", "write_memory", "write_python",
  ]);
  const { root, loop, requests } = await fixture(t, ["write_python", "file_0", "print", "greeting", "finish"]);
  let state = await loop.start("hello-world", BUILDER);
  const tutorial = state.files.find(file => file.path === "docs/python-intro.md");
  assert.equal(tutorial.content, BUILDER.initialFiles["docs/python-intro.md"]);
  assert.equal(state.files.some(file => file.path === "hello.py"), false);
  state = await loop.step("hello-world", state.run.id, 0);
  assert.deepEqual(Object.keys(requests[0].questions.next_tool.criteria).sort(), ["read_file", "write_memory", "write_python"]);
  assert.deepEqual(requests.slice(0, 4).map(request => Object.keys(request.questions)[0]), ["next_tool", "python_file", "python_function", "python_string"]);
  assert.deepEqual(requests[1].questions.python_file.criteria, { file_0: "hello.py", file_1: "scratch.py" });
  assert.deepEqual(Object.keys(requests[2].questions.python_function.criteria).sort(), ["len", "print", "repr"]);
  assert.deepEqual(requests[3].questions.python_string.criteria, { greeting: "Hello, world!", name: "Kev", empty: "" });
  assert.equal(requests[2].state.selected_file, "hello.py");
  assert.equal(requests[3].state.selected_function, "print");
  assert.deepEqual(state.run.steps[0].decisions.map(decision => decision.stage), ["tool", "python_file", "python_function", "python_string"]);
  assert.equal(await readFile(path.join(root, "hello-world/sandbox/hello.py"), "utf8"), 'print("Hello, world!")\n');
  assert.deepEqual(state.memory, {});
  state = await loop.step("hello-world", state.run.id, 1);
  assert.equal(state.run.status, "ended");
  assert.equal(state.run.steps[1].action.tool, "finish");
  assert.equal(state.run.steps[1].result.ok, true);
  assert.ok(completionChecks(BUILDER, state).every(check => check.met));
  assert.ok(requests[4].state.completion_checks.every(check => check.startsWith("DONE:")));
  assert.equal(containsText(BUILDER, 'print("Hello, world!")'), false);
  for (const request of requests) {
    assert.equal(request.state.reading, null);
    assert.deepEqual(request.state.persistent_memory, {});
    assert.equal(containsText(request, 'print("Hello, world!")'), false, "A model request must not reveal the complete target program");
    assert.equal(containsText(request, tutorial.content), false);
    assert.equal(containsText(request, "Python programs are plain text files"), false);
  }
});

test("every Python composition stage receives the current memory and bounded reading", async t => {
  const { loop, requests } = await fixture(t, [
    "write_memory", "note_progress", "read_file", argument(value => value.path === "docs/python-intro.md" && value.offset === 0),
    "write_python", "file_0", "print", "greeting",
  ]);
  let state = await loop.start("compose-context", BUILDER);
  state = await loop.step("compose-context", state.run.id, 0);
  state = await loop.step("compose-context", state.run.id, 1);
  const memory = structuredClone(state.memory);
  const reading = structuredClone(state.run.reading);
  assert.ok(Object.keys(memory).length > 0);
  assert.equal(Array.from(reading.text).length, BUILDER.readLimit);
  state = await loop.step("compose-context", state.run.id, 2);
  assert.equal(state.run.steps[2].result.ok, true);
  assert.equal(requests.length, 8);
  for (const request of requests.slice(4)) {
    assert.deepEqual(request.state.persistent_memory, memory);
    assert.deepEqual(request.state.reading, reading);
  }
});

test("invalid Python choices never write a partially selected program", async t => {
  for (const [stage, decisions] of [
    ["python_file", ["write_python", "greeting"]],
    ["python_function", ["write_python", "file_0", "file_0"]],
    ["python_string", ["write_python", "file_0", "print", "print"]],
  ]) {
    await t.test(stage, async t => {
      const { root, loop, requests } = await fixture(t, decisions);
      let state = await loop.start("invalid-python", BUILDER);
      const filesBefore = structuredClone(state.files);
      state = await loop.step("invalid-python", state.run.id, 0);
      assert.equal(state.run.status, "error");
      assert.match(state.run.error, new RegExp(`invalid ${stage} choice`));
      assert.deepEqual(Object.keys(requests.at(-1).questions), [stage]);
      assert.deepEqual(state.files, filesBefore);
      assert.deepEqual(state.memory, {});
      assert.equal(state.run.steps.length, 0);
      await assert.rejects(readFile(path.join(root, "invalid-python/sandbox/hello.py")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(root, "invalid-python/sandbox/scratch.py")), { code: "ENOENT" });
    });
  }
});

test("finish is unavailable and unmet-output feedback persists for missing or incorrect Python programs", async t => {
  const readTutorial = argument(value => value.path === "docs/python-intro.md" && value.offset === 0);
  for (const [name, decisions, steps] of [
    ["missing program", ["read_file", readTutorial], 1],
    ["function does not print", ["write_python", "file_0", "len", "greeting", "read_file", readTutorial], 2],
    ["wrong greeting", ["write_python", "file_0", "print", "name", "read_file", readTutorial], 2],
  ]) {
    await t.test(name, async t => {
      const { loop, requests } = await fixture(t, decisions);
      let state = await loop.start("unfinished-python", BUILDER);
      for (let step = 0; step < steps; step++) state = await loop.step("unfinished-python", state.run.id, step);
      assert.equal(state.run.status, "running");
      assert.equal(state.run.steps.at(-1).action.tool, "read_file");
      assert.equal(state.run.steps.at(-1).result.ok, true);
      assert.ok(completionChecks(BUILDER, state).every(check => !check.met));
      const latestToolRequest = requests.at(-2);
      assert.equal(Object.hasOwn(latestToolRequest.questions.next_tool.criteria, "finish"), false);
      assert.equal(latestToolRequest.state.completion_status, "INCOMPLETE");
      assert.ok(latestToolRequest.state.completion_checks.every(check => check.startsWith("NOT DONE:")));
    });
  }
});

test("executes two-stage decisions and feeds full persistent memory into every subsequent decision", async t => {
  const { root, loop, requests } = await fixture(t, ["write_memory", "remember_project", "write_file", "create_greeting", "END", "END"]);
  let state = await loop.start("demo", BASIC);
  for (let i = 0; i < 3; i++) state = await loop.step("demo", state.run.id, i);
  assert.equal(state.run.status, "ended");
  assert.deepEqual(state.memory, { project: "Kev Playground" });
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes/hello.txt"), "utf8"), "Hello from Kev!");
  assert.deepEqual(requests[0].state.persistent_memory, {});
  assert.deepEqual(requests[1].state.persistent_memory, {});
  for (const request of requests.slice(2)) assert.deepEqual(request.state.persistent_memory, state.memory);
  assert.equal(requests[4].state.sandbox_files[0].path, "notes/hello.txt");
  assert.equal(requests[4].state.sandbox_files[0].content, undefined);
  assert.deepEqual(state.run.steps[0].decisions.map(({ stage, choice }) => ({ stage, choice })), [
    { stage: "tool", choice: "write_memory" },
    { stage: "arguments", choice: "remember_project" },
  ]);
  assert.equal(state.run.steps[0].latency_ms, 24);
  assert.deepEqual((await new ToolLoop(root).snapshot("demo")).memory, state.memory);
  state = await loop.start("demo", BASIC);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "ended");
  assert.deepEqual(requests[5].state.persistent_memory, state.memory);
  assert.deepEqual((await loop.snapshot("other")).memory, {});
});

test("read pages count Unicode characters, feed content into the next decision, and never auto-copy into memory", async t => {
  const firstPage = "🧭".repeat(120);
  const secondPage = "B".repeat(120);
  const content = `${firstPage}${secondPage}The last page.`;
  const { loop, requests } = await fixture(t, ["read_file", page(0), "read_file", page(120), "END"]);
  let state = await loop.start("demo", readerProgram(content, { readLimit: 120 }));
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.reading.path, "notes/source.txt");
  assert.equal(state.run.reading.start, 0);
  assert.equal(state.run.reading.end, 120);
  assert.equal(state.run.reading.totalChars, Array.from(content).length);
  assert.equal(state.run.reading.text, firstPage);
  assert.equal(Array.from(state.run.reading.text).length, 120);
  assert.equal(state.run.reading.hasMore, true);
  assert.match(state.run.reading.version, /^[a-f0-9]{64}$/);
  assert.deepEqual(state.memory, {});
  const reading = structuredClone(state.run.reading);
  assert.equal(requests[0].state.reading, null);
  assert.ok(!JSON.stringify(requests[0]).includes(firstPage), "Unread seed file contents must stay out of the prompt");
  assert.ok(!JSON.stringify(requests[1]).includes(firstPage), "Read arguments must describe pages without exposing their contents");
  state = await loop.step("demo", state.run.id, 1);
  for (const request of requests.slice(2, 4)) assert.deepEqual(request.state.reading, reading);
  assert.equal(state.run.reading.start, 120);
  assert.equal(state.run.reading.end, 240);
  assert.equal(state.run.reading.text, secondPage);
  assert.deepEqual(state.memory, {});
  state = await loop.step("demo", state.run.id, 2);
  assert.equal(state.run.status, "ended");
  assert.equal(requests[4].state.reading.text, secondPage);
  assert.ok(!JSON.stringify(requests[4]).includes(firstPage), "Previous unremembered pages must not leak through recent steps");
  assert.ok(!JSON.stringify(requests[4].state.recent_steps).includes(secondPage));
});

test("the model selectively indexes only a bounded excerpt with exact source coordinates", async t => {
  const content = "The launch review is on Tuesday. Bring the working prototype. ".repeat(6);
  let selectedIndex;
  const selectExcerpt = argument(value => {
    if (value.tool !== "remember_excerpt" || value.value.start !== 0) return false;
    selectedIndex = { key: value.key, value: value.value };
    return true;
  });
  const { root, loop, requests } = await fixture(t, ["read_file", page(0), "remember_excerpt", selectExcerpt, "END", "END"]);
  let state = await loop.start("demo", readerProgram(content));
  state = await loop.step("demo", state.run.id, 0);
  assert.deepEqual(state.memory, {});
  assert.deepEqual(Object.keys(requests[0].questions.next_tool.criteria).sort(), ["END", "read_file"]);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(state.run.status, "running");
  assert.deepEqual(Object.keys(state.memory), [selectedIndex.key]);
  assert.deepEqual(state.memory[selectedIndex.key], selectedIndex.value);
  const index = selectedIndex.value;
  assert.equal(index.kind, "index");
  assert.equal(index.path, "notes/source.txt");
  assert.ok(Array.from(index.quote).length > 0 && Array.from(index.quote).length <= 120);
  assert.equal(index.quote, Array.from(content).slice(index.start, index.end).join(""));
  assert.ok(index.quote.length < content.length);
  for (const request of requests.slice(2, 4)) {
    assert.deepEqual(request.state.persistent_memory, {});
    assert.equal(request.state.reading.text, Array.from(content).slice(0, 200).join(""));
  }
  assert.deepEqual(Object.keys(requests[2].questions.next_tool.criteria).sort(), ["END", "read_file", "remember_excerpt"]);
  state = await loop.step("demo", state.run.id, 2);
  assert.deepEqual(Object.keys(requests[4].questions.next_tool.criteria).sort(), ["END", "delete_memory", "edit_memory", "read_file", "remember_excerpt"]);
  assert.deepEqual(requests[4].state.persistent_memory, state.memory);
  assert.deepEqual((await new ToolLoop(root).snapshot("demo")).memory, state.memory);
  state = await loop.start("demo", readerProgram(content));
  assert.equal(state.run.reading, null);
  await loop.step("demo", state.run.id, 0);
  assert.deepEqual(requests[5].state.persistent_memory, { [selectedIndex.key]: index });
  assert.equal(requests[5].state.reading, null);
});

test("editing and deleting chosen memory changes the next loop without altering other entries", async t => {
  const content = "The latest decision is to launch a prototype first. ".repeat(5);
  let replacement;
  const chooseTarget = request => {
    assert.deepEqual(Object.keys(request.questions), ["memory_target"]);
    const target = Object.entries(request.questions.memory_target.criteria).find(([key, value]) => key === "note" || value.key === "note");
    assert.ok(target);
    return target[0];
  };
  const chooseReplacement = argument(value => {
    if (value.tool !== "edit_memory" || value.key !== "note" || value.value.start !== 0) return false;
    replacement = value.value;
    return true;
  });
  const { root, loop, requests } = await fixture(t, [
    "read_file", page(0), "edit_memory", chooseTarget, chooseReplacement,
    "delete_memory", argument(value => value.tool === "delete_memory" && value.key === "note"), "END",
  ]);
  await loop.snapshot("demo");
  await writeFile(path.join(root, "demo/memory.json"), JSON.stringify({ note: "Old draft", keep: "Retain this memory" }));
  let state = await loop.start("demo", readerProgram(content));
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(state.run.status, "running");
  assert.deepEqual(state.memory, { note: replacement, keep: "Retain this memory" });
  assert.deepEqual(state.run.steps[1].decisions.map(d => d.stage), ["tool", "memory_target", "arguments"]);
  for (const request of requests.slice(0, 5)) assert.deepEqual(request.state.persistent_memory, { note: "Old draft", keep: "Retain this memory" });
  state = await loop.step("demo", state.run.id, 2);
  assert.deepEqual(state.memory, { keep: "Retain this memory" });
  for (const request of requests.slice(5, 7)) assert.deepEqual(request.state.persistent_memory, { note: replacement, keep: "Retain this memory" });
  await loop.step("demo", state.run.id, 3);
  assert.deepEqual(requests[7].state.persistent_memory, { keep: "Retain this memory" });
});

test("a changed source invalidates its reading buffer before another decision", async t => {
  const content = "Old evidence that must not remain visible. ".repeat(6);
  const program = readerProgram(content);
  program.actions.replace = { tool: "write_file", description: "Replace the old source.", path: "notes/source.txt", content: "Updated evidence." };
  const { loop, requests } = await fixture(t, ["read_file", page(0), "write_file", "replace", "END"]);
  let state = await loop.start("demo", program);
  state = await loop.step("demo", state.run.id, 0);
  const previousText = state.run.reading.text;
  state = await loop.step("demo", state.run.id, 1);
  state = await loop.step("demo", state.run.id, 2);
  assert.equal(state.run.status, "ended");
  assert.equal(requests[4].state.reading, null);
  assert.ok(!JSON.stringify(requests[4]).includes(previousText));
});

test("a source changed during excerpt selection cannot be saved as fresh memory", async t => {
  let root;
  const content = "Only index evidence actually read from this revision. ".repeat(5);
  const { root: fixtureRoot, loop } = await fixture(t, ["read_file", page(0), "remember_excerpt", async request => {
    const choice = argument(value => value.tool === "remember_excerpt" && value.value.start === 0)(request);
    await writeFile(path.join(root, "demo/sandbox/notes/source.txt"), "The source changed after the model received its reading.");
    return choice;
  }]);
  root = fixtureRoot;
  let state = await loop.start("demo", readerProgram(content));
  state = await loop.step("demo", state.run.id, 0);
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(state.run.status, "running");
  assert.equal(state.run.steps[1].result.ok, false);
  assert.match(state.run.steps[1].result.message, /changed/);
  assert.equal(state.run.reading, null);
  assert.deepEqual(state.memory, {});
  await assert.rejects(readFile(path.join(root, "demo/memory.json")), { code: "ENOENT" });
});

test("read failure is returned as an observation so the model can recover", async t => {
  let root;
  const { root: fixtureRoot, loop, requests } = await fixture(t, ["read_file", async request => {
    const choice = page(0)(request);
    await rm(path.join(root, "demo/sandbox/notes/source.txt"));
    return choice;
  }, "END"]);
  root = fixtureRoot;
  let state = await loop.start("demo", readerProgram("A document that disappears during the model request."));
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "running");
  assert.equal(state.run.steps[0].result.ok, false);
  assert.match(state.run.steps[0].result.message, /File not found/);
  assert.equal(state.run.reading, null);
  assert.deepEqual(state.memory, {});
  state = await loop.step("demo", state.run.id, 1);
  assert.equal(state.run.status, "ended");
  assert.equal(requests[2].state.last_step.outcome.ok, false);
  assert.match(requests[2].state.last_step.outcome.message, /File not found/);
});

test("initial files are seeded only when absent and never expose unread content in model requests", async t => {
  const source = "UNREAD_PRIVATE_CONTENT_".repeat(10);
  const program = readerProgram(source);
  const { root, loop, requests } = await fixture(t, ["END", "END"]);
  let state = await loop.start("demo", program);
  assert.equal(await readFile(path.join(root, "demo/sandbox/notes/source.txt"), "utf8"), source);
  state = await loop.step("demo", state.run.id, 0);
  assert.ok(!JSON.stringify(requests[0]).includes("UNREAD_PRIVATE_CONTENT_"));
  await writeFile(path.join(root, "demo/sandbox/notes/source.txt"), "User's newer document.");
  state = await loop.start("demo", program);
  assert.equal(state.files[0].content, "User's newer document.");
  await loop.step("demo", state.run.id, 0);
  assert.ok(!JSON.stringify(requests[1]).includes("User's newer document."));
});

test("conflicting initial file paths are rejected before any files are seeded", async t => {
  for (const entries of [
    [["notes", "A file"], ["notes/source.txt", "A child"]],
    [["notes/source.txt", "A child"], ["notes", "A file"]],
    [["notes", "A file"], ["notes.txt", "A sibling"], ["notes/archive/source.txt", "A descendant"]],
  ]) {
    await t.test(entries.map(([file]) => file).join(", "), async t => {
      const { loop } = await fixture(t, []);
      const program = { ...BASIC, initialFiles: Object.fromEntries([["safe.txt", "Must not be seeded"], ...entries]) };
      assert.throws(() => parseProgram(program), /file paths conflict/);
      await assert.rejects(loop.start("demo", program), /file paths conflict/);
      const state = await loop.snapshot("demo");
      assert.deepEqual(state.files, []);
      assert.equal(state.run, null);
    });
  }
});

test("initial file conflicts with existing ancestors or descendants leave the sandbox and prior run unchanged", async t => {
  for (const [existing, addition] of [["notes", "notes/source.txt"], ["notes/archive/source.txt", "notes"]]) {
    await t.test(`${addition} conflicts with existing ${existing}`, async t => {
      const { loop } = await fixture(t, []);
      const started = await loop.start("demo", { ...BASIC, initialFiles: { [existing]: "Existing content" } });
      const before = await loop.stop("demo", started.run.id);
      await assert.rejects(loop.start("demo", {
        ...BASIC, initialFiles: { "safe.txt": "Must not be seeded", [addition]: "Conflicting content" },
      }), /file paths conflict/);
      const after = await loop.snapshot("demo");
      assert.deepEqual(after.files, before.files);
      assert.deepEqual(after.memory, before.memory);
      assert.deepEqual(after.run, before.run);
    });
  }
});

test("an early END outside the available dictionary is rejected without executing a step", async t => {
  const { loop, requests } = await fixture(t, ["END"]);
  let state = await loop.start("demo", BASIC);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "error");
  assert.match(state.run.error, /invalid tool choice/);
  assert.equal(state.run.steps.length, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.memory, {});
  assert.equal(requests[0].state.completion_checks.length, 2);
  assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, "END"), false);
  assert.equal(requests.length, 1, "END must not request arguments");
});

test("maxSteps and manual stop differ from END, with no calls after stopping", async t => {
  const { loop, requests } = await fixture(t, ["write_memory", "remember_project"]);
  let state = await loop.start("demo", { ...BASIC, maxSteps: 1 });
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "limit");
  await loop.step("demo", state.run.id, 1);
  assert.equal(requests.length, 2);
  state = await loop.start("demo", BASIC);
  await loop.stop("demo", state.run.id);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "stopped");
  assert.equal(requests.length, 2);
});

test("stale run IDs and duplicate steps cannot mutate the workspace", async t => {
  const { loop, requests } = await fixture(t, ["write_memory", "remember_project"]);
  const state = await loop.start("demo", BASIC);
  await assert.rejects(loop.start("demo", BASIC), /Stop the current/);
  await assert.rejects(loop.step("demo", "old-run", 0), /stale/);
  const concurrent = () => exclusive("test-demo", () => loop.step("demo", state.run.id, 0));
  const results = await Promise.allSettled([concurrent(), concurrent()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  assert.equal(requests.length, 2);
});

test("API failures and unknown choices stop without executing tools", async t => {
  const { loop } = await fixture(t, [new Error("connection refused"), "made_up_tool"]);
  let state = await loop.start("demo", BASIC);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "error");
  assert.match(state.run.error, /connection refused/);
  state = await loop.start("demo", BASIC);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "error");
  assert.equal(state.run.steps.length, 0);
  assert.deepEqual(state.files, []);
  assert.deepEqual(state.memory, {});
});

test("the first decision previews tools without full file contents; the second receives the selected argument dictionary", async t => {
  const program = {
    goal: "Write the blue greeting to the sandbox.",
    maxSteps: 3,
    actions: {
      red: { tool: "write_file", description: "Write the red greeting.", path: "red.txt", content: "Hello, red!" },
      blue: { tool: "write_file", description: "Write the blue greeting.", path: "blue.txt", content: "Hello, blue!" },
      remember: { tool: "write_memory", description: "Remember a greeting.", key: "greeting", value: "Remembered greeting" },
      END: { tool: "END", description: "Finish." },
    },
  };
  const { root, loop, requests } = await fixture(t, [
    { question: "next_tool", choice: "write_file", confidence: 0.8, latency_ms: 7 },
    { question: "arguments", choice: "blue", confidence: 0.95, latency_ms: 19 },
  ]);
  let state = await loop.start("demo", program);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(state.run.status, "running");
  assert.equal(requests.length, 2);
  const toolCriteria = requests[0].questions.next_tool.criteria;
  assert.deepEqual(Object.keys(toolCriteria).sort(), ["END", "write_file", "write_memory"]);
  const assertNoPayloadFields = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, nested] of Object.entries(value)) {
      assert.notEqual(key, "content", "Tool-stage previews must not expose complete file contents");
      assertNoPayloadFields(nested);
    }
  };
  assertNoPayloadFields(toolCriteria);
  assert.equal(containsText(toolCriteria, "Hello, red!"), false);
  assert.equal(containsText(toolCriteria, "Hello, blue!"), false);
  const argumentsRequest = requests[1];
  assert.equal(argumentsRequest.state.selected_tool, "write_file");
  assert.deepEqual(Object.keys(argumentsRequest.questions.arguments.criteria).sort(), ["blue", "red"]);
  for (const name of ["red", "blue"]) {
    const candidate = argumentsRequest.questions.arguments.criteria[name];
    assert.equal(candidate.tool, "write_file");
    assert.equal(candidate.path, program.actions[name].path);
    assert.equal(candidate.content, program.actions[name].content);
  }
  assert.deepEqual(state.files, [{ path: "blue.txt", content: "Hello, blue!" }]);
  assert.equal(await readFile(path.join(root, "demo/sandbox/blue.txt"), "utf8"), "Hello, blue!");
  assert.deepEqual(state.memory, {});
  const [step] = state.run.steps;
  assert.equal(step.choice, "blue");
  assert.deepEqual(step.action, program.actions.blue);
  assert.equal(step.latency_ms, 26);
  assert.deepEqual(step.decisions, [
    { stage: "tool", choice: "write_file", probabilities: { write_file: 1, write_memory: 0, END: 0 }, confidence: 0.8, latency_ms: 7, input_tokens: 100, model: MODEL_ID },
    { stage: "arguments", choice: "blue", probabilities: { red: 0, blue: 1 }, confidence: 0.95, latency_ms: 19, input_tokens: 100, model: MODEL_ID },
  ]);
});

test("a tool with one argument option still requires a second model decision", async t => {
  const program = {
    goal: "Remember project = Kev Playground, then finish.",
    maxSteps: 3,
    actions: { remember_project: BASIC.actions.remember_project, END: BASIC.actions.END },
  };
  const { loop, requests } = await fixture(t, [
    { question: "next_tool", choice: "write_memory" },
    { question: "arguments", choice: "remember_project" },
  ]);
  let state = await loop.start("demo", program);
  state = await loop.step("demo", state.run.id, 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(Object.keys(requests[0].questions.next_tool.criteria).sort(), ["END", "write_memory"]);
  assert.deepEqual(Object.keys(requests[1].questions.arguments.criteria), ["remember_project"]);
  assert.deepEqual(state.memory, { project: "Kev Playground" });
  assert.equal(state.run.steps[0].decisions.length, 2);
});

test("invalid argument selections and second-stage API failures cannot write files or memory", async t => {
  const cases = [
    { name: "file tool cannot choose a memory action", tool: "write_file", argument: "remember_project" },
    { name: "memory tool cannot choose a file action", tool: "write_memory", argument: "create_greeting" },
    { name: "unknown argument is rejected", tool: "write_file", argument: "made_up_arguments" },
    { name: "END is not an argument option", tool: "write_file", argument: "END" },
    { name: "file arguments API fails", tool: "write_file", argument: new Error("arguments connection refused") },
    { name: "memory arguments API fails", tool: "write_memory", argument: new Error("arguments connection refused") },
  ];
  for (const { name, tool, argument } of cases) {
    await t.test(name, async t => {
      const { root, loop, requests } = await fixture(t, [tool, argument]);
      let state = await loop.start("demo", BASIC);
      state = await loop.step("demo", state.run.id, 0);
      assert.equal(requests.length, 2);
      assert.equal(state.run.status, "error");
      assert.equal(state.run.steps.length, 0);
      assert.deepEqual(state.files, []);
      assert.deepEqual(state.memory, {});
      await assert.rejects(readFile(path.join(root, "demo/memory.json")), { code: "ENOENT" });
      await assert.rejects(readFile(path.join(root, "demo/sandbox/notes/hello.txt")), { code: "ENOENT" });
      if (argument instanceof Error) assert.match(state.run.error, /arguments connection refused/);
      const saved = await new ToolLoop(root).snapshot("demo");
      assert.equal(saved.run.status, "error");
      assert.deepEqual(saved.files, []);
      assert.deepEqual(saved.memory, {});
    });
  }
});

test("rejects path traversal, unknown tools, reserved keys, invalid limits and missing END", () => {
  for (const value of ["../escape.txt", "/tmp/escape.txt", "notes/../../escape", "notes\\escape", ".hidden"]) {
    const program = structuredClone(BASIC);
    program.actions.create_greeting.path = value;
    assert.throws(() => parseProgram(program), /relative sandbox/);
    assert.throws(() => parseProgram({ ...BASIC, initialFiles: { [value]: "unsafe" } }), /relative sandbox/);
  }
  const program = structuredClone(BASIC);
  program.actions.remember_project.key = "constructor";
  assert.throws(() => parseProgram(program), /Reserved/);
  assert.throws(() => parseProgram({ ...BASIC, maxSteps: 0 }), /maxSteps/);
  for (const readLimit of [0, 79, 1201, 200.5, "200", null]) assert.throws(() => parseProgram({ ...BASIC, readLimit }), /readLimit/);
  assert.throws(() => parseProgram({ ...BASIC, actions: { a: { tool: "exec", description: "shell" }, END: BASIC.actions.END } }), /unknown tool/);
  assert.throws(() => parseProgram({ ...BASIC, actions: { a: { tool: "read_file_to_memory", description: "Obsolete file copy", path: "notes/source.txt", key: "source" }, END } }), /read_file and remember_excerpt/);
  assert.throws(() => parseProgram({ ...BASIC, actions: { ...BASIC.actions, END: undefined } }));
});

test("sandbox and memory symlinks cannot read or overwrite outside files", async t => {
  const { root, loop } = await fixture(t, []);
  await assert.rejects(loop.snapshot("../escape"), /Workspace/);
  await loop.snapshot("demo");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "hello.txt"), "untouched");
  await symlink(outside, path.join(root, "demo/sandbox/notes"));
  await assert.rejects(loop.start("demo", BASIC), /Symlinks/);
  assert.equal(await readFile(path.join(outside, "hello.txt"), "utf8"), "untouched");
  await loop.snapshot("memory-link");
  await symlink(path.join(outside, "hello.txt"), path.join(root, "memory-link/memory.json"));
  await assert.rejects(loop.snapshot("memory-link"));
  await symlink(outside, path.join(root, "workspace-link"));
  await assert.rejects(loop.snapshot("workspace-link"), /Not a real directory/);
});

test("local request guard rejects foreign origins and remote hosts", () => {
  localRequest(new Request("http://127.0.0.1:3001/api/tool-loop", { headers: { origin: "http://127.0.0.1:3001" } }));
  assert.throws(() => localRequest(new Request("http://127.0.0.1:3001/api/tool-loop", { headers: { origin: "https://example.com" } })), /local origin/);
  assert.throws(() => localRequest(new Request("http://attacker.test/api/tool-loop")), /local origin/);
});
