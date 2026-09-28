import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

const chars = text => Array.from(text);
const view = (text, offset, limit) => {
  const all = chars(text), end = Math.min(offset + limit, all.length);
  return { start: offset, end, totalChars: all.length, text: all.slice(offset, end).join("") };
};
const containsText = (value, text) => typeof value === "string" ? value.includes(text)
  : value && typeof value === "object" ? Object.values(value).some(nested => containsText(nested, text)) : false;

function program(goal, readLimit = 80) {
  return {
    goal, readLimit, maxSteps: 12,
    initialFiles: { "notes/source.txt": "Keep this file reading while paging the goal." },
    actions: {
      note: { tool: "write_memory", description: "Save a task note.", key: "note", value: "The file view and the goal view are independent." },
      read: { tool: "read_file", description: "Read a source page." },
      finish: { tool: "finish", description: "Finish this example." },
    },
  };
}

const argument = predicate => request => {
  assert.deepEqual(Object.keys(request.questions), ["arguments"]);
  const chosen = Object.entries(request.questions.arguments.criteria).find(([, candidate]) => predicate(candidate));
  assert.ok(chosen, `No matching argument in ${JSON.stringify(request.questions.arguments.criteria)}`);
  return chosen[0];
};
const goalPage = offset => argument(candidate => candidate.tool === "read_goal" && candidate.offset === offset);

async function fixture(t, choices) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-goal-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [];
  const fetcher = async (url, options) => {
    assert.equal(url, "http://goal.test/v1/systemone");
    const request = JSON.parse(options.body);
    requests.push(request);
    const [question] = Object.keys(request.questions);
    assert.ok(choices.length, `Unexpected model request for ${question}`);
    const next = choices.shift();
    const choice = typeof next === "function" ? next(request) : typeof next === "object" ? next.choice : next;
    const criteria = request.questions[question].criteria;
    assert.equal(Object.hasOwn(criteria, choice), !next?.unavailable, `Choice availability: ${choice}`);
    return Response.json({ answers: { [question]: {
      type: "choice", choice, confidence: 0.9,
      probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])),
    } }, usage: { input_tokens: 100, output_tokens: 1 }, latency_ms: 5 });
  };
  return { root, requests, loop: new ToolLoop(root, "http://goal.test", fetcher, undefined, async () => 100) };
}

test("long Unicode goals page independently of file reading and working memory and persist across reloads", async t => {
  const first = "🧭".repeat(80);
  const second = "SECOND_GOAL_PAGE_" + "b".repeat(63);
  assert.equal(chars(second).length, 80);
  const last = "LAST_GOAL_PAGE_Keep the immutable original goal.";
  const goal = first + second + last;
  const { root, loop, requests } = await fixture(t, [
    "write_memory", "note", "read_file", argument(candidate => candidate.path === "notes/source.txt" && candidate.offset === 0),
    "read_goal", goalPage(80), "read_goal", goalPage(160), "read_goal", goalPage(80), "finish",
  ]);
  let state = await loop.start("paged", program(goal));
  assert.deepEqual(state.run.goalReading, view(goal, 0, 80));
  assert.equal(state.run.program.goal, goal);
  state = await loop.step("paged", state.run.id, 0);
  assert.equal(state.run.steps[0].result.changed, true);
  state = await loop.step("paged", state.run.id, 1);
  const memory = structuredClone(state.memory);
  const fileReading = structuredClone(state.run.reading);
  assert.ok(fileReading?.text);
  for (const [step, offset] of [[2, 80], [3, 160], [4, 80]]) {
    state = await loop.step("paged", state.run.id, step);
    assert.equal(state.run.steps[step].result.ok, true);
    assert.deepEqual(state.run.goalReading, view(goal, offset, 80));
    assert.deepEqual(state.run.steps[step].result.goalReading, state.run.goalReading);
    assert.deepEqual(state.run.reading, fileReading);
    assert.deepEqual(state.memory, memory);
    assert.equal(state.run.program.goal, goal);
    const reloaded = await new ToolLoop(root).snapshot("paged");
    assert.deepEqual(reloaded.run.goalReading, state.run.goalReading);
  }
  state = await loop.step("paged", state.run.id, 5);
  assert.equal(state.run.status, "ended");
  assert.equal(requests.length, 11);
  assert.ok(requests[0].questions.next_tool.criteria.read_goal, "Long goals offer paging even when read_goal is not in the program actions");
  for (let i = 0; i < requests.length; i++) {
    const request = requests[i];
    const offset = i < 6 ? 0 : i < 8 ? 80 : i < 10 ? 160 : 80;
    assert.deepEqual(request.state.goal_memory, view(goal, offset, 80));
    assert.equal(Object.hasOwn(request.state, "goal"), false);
    assert.equal(containsText(request, goal), false);
    assert.deepEqual(request.state.persistent_memory, i < 2 ? {} : memory);
    if (i >= 2 && request.questions.next_tool) assert.equal(Object.hasOwn(request.questions.next_tool.criteria, "write_memory"), false, "paging the goal must not reoffer an unchanged memory write");
    if (i >= 4) assert.deepEqual(request.state.reading, fileReading);
    if (i < 6) {
      assert.equal(containsText(request, "SECOND_GOAL_PAGE_"), false);
      assert.equal(containsText(request, "LAST_GOAL_PAGE_"), false);
    }
  }
  const persisted = JSON.parse(await readFile(path.join(root, "paged/run.json"), "utf8"));
  assert.equal(persisted.program.goal, goal);
  assert.deepEqual(persisted.goalReading, view(goal, 80, 80));
});

test("old runs without goalReading receive a bounded first page and persist it after the next step", async t => {
  const goal = "🧭".repeat(80) + "UNSEEN_LEGACY_GOAL_TAIL";
  const { root, loop, requests } = await fixture(t, ["write_memory", "note"]);
  const started = await loop.start("legacy", program(goal));
  const oldRun = JSON.parse(await readFile(path.join(root, "legacy/run.json"), "utf8"));
  delete oldRun.goalReading;
  await writeFile(path.join(root, "legacy/run.json"), JSON.stringify(oldRun));
  const state = await loop.step("legacy", started.run.id, 0);
  assert.equal(state.run.status, "running");
  assert.deepEqual(state.run.goalReading, view(goal, 0, 80));
  assert.deepEqual((await new ToolLoop(root).snapshot("legacy")).run.goalReading, view(goal, 0, 80));
  for (const request of requests) {
    assert.deepEqual(request.state.goal_memory, view(goal, 0, 80));
    assert.equal(containsText(request, "UNSEEN_LEGACY_GOAL_TAIL"), false);
    assert.equal(Object.hasOwn(request.state, "goal"), false);
  }
});

test("a goal fitting one Unicode page does not offer unnecessary read_goal choices", async t => {
  const goal = "🧭".repeat(80);
  const { loop, requests } = await fixture(t, ["finish"]);
  let state = await loop.start("one-page", program(goal));
  state = await loop.step("one-page", state.run.id, 0);
  assert.equal(state.run.status, "ended");
  assert.deepEqual(requests[0].state.goal_memory, view(goal, 0, 80));
  assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, "read_goal"), false);
});

test("finish and legacy END become available only after their checks pass", async t => {
  for (const terminal of ["finish", "END"]) {
    await t.test(terminal, async t => {
      const task = {
        goal: "Write done.txt containing done, then finish.", maxSteps: 6, readLimit: 80,
        checks: { result_written: { file: "done.txt", equals: "done" } },
        actions: {
          write: { tool: "write_file", description: "Write the requested result.", path: "done.txt", content: "done" },
          [terminal]: { tool: terminal, description: "Finish after the check passes." },
        },
      };
      const { root, loop, requests } = await fixture(t, ["write_file", "write", terminal]);
      let state = await loop.start("recover", task);
      state = await loop.step("recover", state.run.id, 0);
      assert.equal(state.run.status, "running");
      assert.equal(state.run.steps[0].result.ok, true);
      assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, terminal), false);
      assert.ok(requests[0].state.completion_checks.every(check => check.startsWith("NOT DONE:")));
      state = await loop.step("recover", state.run.id, 1);
      assert.equal(state.run.status, "ended");
      assert.equal(state.run.steps[1].result.ok, true);
      assert.equal(await readFile(path.join(root, "recover/sandbox/done.txt"), "utf8"), "done");
      assert.ok(Object.hasOwn(requests[2].questions.next_tool.criteria, terminal));
      assert.ok(requests[2].state.completion_checks.every(check => check.startsWith("DONE:")));
    });
  }
});

test("an out-of-dictionary finish or legacy END is rejected before execution", async t => {
  for (const terminal of ["finish", "END"]) {
    await t.test(terminal, async t => {
      const task = {
        goal: "Write the missing file before finishing.", maxSteps: 3,
        checks: { missing: { file: "missing.txt", equals: "required" } },
        actions: {
          write: { tool: "write_file", description: "Write the file.", path: "missing.txt", content: "required" },
          [terminal]: { tool: terminal, description: "Finish when ready." },
        },
      };
      const { loop, requests } = await fixture(t, [{ choice: terminal, unavailable: true }]);
      let state = await loop.start("unavailable-finish", task);
      const goalReading = structuredClone(state.run.goalReading);
      state = await loop.step("unavailable-finish", state.run.id, 0);
      assert.equal(state.run.status, "error");
      assert.match(state.run.error, /invalid tool choice/);
      assert.equal(state.run.steps.length, 0);
      assert.deepEqual(state.files, []);
      assert.deepEqual(state.memory, {});
      assert.deepEqual(state.run.goalReading, goalReading);
      assert.equal(requests.length, 1);
    });
  }
});

test("incomplete runs obey the step budget and remain manually stoppable", async t => {
  const task = {
    goal: "Write the missing file before finishing.", maxSteps: 1,
    checks: { missing: { file: "missing.txt", equals: "required" } },
    actions: {
      write: { tool: "write_file", description: "Write the file.", path: "missing.txt", content: "required" },
      note: { tool: "write_memory", description: "Remember progress.", key: "progress", value: "The output still needs to be written." },
      finish: { tool: "finish", description: "Finish when ready." },
    },
  };
  const { loop, requests } = await fixture(t, ["write_memory", "note", "write_memory", "note"]);
  let state = await loop.start("limited", task);
  state = await loop.step("limited", state.run.id, 0);
  assert.equal(state.run.status, "limit");
  assert.equal(state.run.steps[0].result.ok, true);
  assert.equal(Object.hasOwn(requests[0].questions.next_tool.criteria, "finish"), false);
  await loop.step("limited", state.run.id, 1);
  assert.equal(requests.length, 2);
  state = await loop.start("stoppable", { ...task, maxSteps: 3 });
  state = await loop.step("stoppable", state.run.id, 0);
  assert.equal(state.run.status, "running");
  await loop.stop("stoppable", state.run.id);
  state = await loop.step("stoppable", state.run.id, 1);
  assert.equal(state.run.status, "stopped");
  assert.equal(requests.length, 4);
});
