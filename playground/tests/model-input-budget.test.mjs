import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_INPUT_TOKENS, createTokenCounter, prepareModelRequest } from "../src/lib/model-input-budget.ts";
import { MODEL_ID } from "../src/lib/model-config.ts";
import { ToolLoop } from "../src/lib/tool-loop-server.ts";

function request(history = [{ number: 1 }, { number: 2 }, { number: 3 }]) {
  return {
    model: MODEL_ID,
    state: {
      goal_memory: { start: 0, end: 25, totalChars: 300, text: "Keep the current goal page" },
      persistent_memory: { index: { path: "notes.txt", start: 0, end: 3, quote: "🌏好!" } },
      reading: { path: "notes.txt", start: 0, end: 4, text: "🌏好!\n", totalChars: 30 },
      last_step: {
        number: 4, tool: "read_file", choice: "read_0_0",
        result: { ok: true, message: "Read notes.txt [0, 4) of 30 characters. Memory unchanged." },
      },
      current_step: {
        number: 5,
        decisions: [{ stage: "tool", choice: "append_file" }, { stage: "write_target", choice: "file_0" }],
        selected_tool: "append_file", selected_path: "addition.py",
      },
      recent_steps: history,
    },
    questions: { next_tool: { type: "choice", instructions: "Choose a tool.", criteria: { read: "Read", finish: "Finish" } } },
  };
}

function assertPreserved(original, compacted) {
  assert.equal(compacted.model, original.model);
  assert.deepEqual(compacted.questions, original.questions);
  for (const protectedField of ["last_step", "current_step"]) {
    assert.deepEqual(compacted.state[protectedField], original.state[protectedField], `${protectedField} must survive every preflight intact`);
  }
  const { recent_steps: ignoredOriginal, ...originalState } = original.state;
  const { recent_steps: ignoredCompacted, ...compactedState } = compacted.state;
  assert.deepEqual(compactedState, originalState);
  assert.ok(ignoredCompacted.length <= ignoredOriginal.length);
}

test("the exact 3000-token boundary is accepted unchanged", async () => {
  assert.equal(MAX_INPUT_TOKENS, 3000);
  for (const tokens of [1, 2999, 3000]) {
    const original = request();
    let calls = 0;
    const result = await prepareModelRequest(original, async value => { calls++; assert.equal(value, original); return tokens; });
    assert.equal(result.request, original);
    assert.equal(result.inputTokens, tokens);
    assert.equal(result.compacted, false);
    assert.equal(calls, 1);
  }
});

test("over-budget input drops the oldest history first without mutating any request content", async () => {
  const original = request();
  const untouched = structuredClone(original);
  const seen = [];
  const result = await prepareModelRequest(original, async value => {
    seen.push(structuredClone(value));
    return 2700 + value.state.recent_steps.length * 200;
  });
  assert.deepEqual(seen.map(value => value.state.recent_steps.map(step => step.number)), [[1, 2, 3], [2, 3], [3]]);
  assert.equal(result.compacted, true);
  assert.equal(result.inputTokens, 2900);
  assert.deepEqual(result.request.state.recent_steps, [{ number: 3 }]);
  assert.deepEqual(original, untouched);
  for (const value of seen) assertPreserved(original, value);
});

test("all older history can be dropped while retaining the previous step, current decision chain and essential context", async () => {
  const original = request();
  const seen = [];
  const result = await prepareModelRequest(original, async value => {
    seen.push(structuredClone(value));
    return value.state.recent_steps.length ? 3001 : 3000;
  });
  assert.equal(result.compacted, true);
  assert.deepEqual(result.request.state.recent_steps, []);
  assert.equal(result.inputTokens, 3000);
  assert.equal(seen.length, 4);
  for (const value of seen) assertPreserved(original, value);
  assert.equal(original.state.recent_steps.length, 3);
});

test("3001 tokens of essential context block rather than dropping the immediate predecessor or in-progress choices", async () => {
  const original = request();
  const untouched = structuredClone(original);
  const seen = [];
  await assert.rejects(prepareModelRequest(original, async value => {
    seen.push(structuredClone(value));
    // Removing either protected field would wrongly make this request fit.
    return value.state.last_step && value.state.current_step ? 3001 : 2900;
  }), error => {
    assert.match(error.message, /blocked before inference: 3,001 input tokens.*3,000-token limit/);
    assert.match(error.message, /Required context, including last_step and current_step, was preserved/);
    return true;
  });
  assert.equal(seen.length, 4);
  assert.deepEqual(seen.at(-1).state.recent_steps, []);
  for (const value of seen) assertPreserved(original, value);
  assert.deepEqual(original, untouched);
  for (const state of ["plain state", null, ["array state"], { goal: "task" }, { recent_steps: [] }]) {
    let calls = 0;
    await assert.rejects(prepareModelRequest({ ...request(), state }, async () => { calls++; return 3001; }), /blocked before inference/);
    assert.equal(calls, 1);
  }
});

test("counter errors or malformed counts fail closed before a prepared request is returned", async () => {
  for (const count of [NaN, Infinity, -1, 3.5, "4000", null, undefined]) {
    await assert.rejects(prepareModelRequest(request(), async () => count), /Cannot verify.*invalid input-token count/);
  }
  await assert.rejects(prepareModelRequest(request(), async () => { throw new Error("tokenizer unavailable"); }), /Cannot verify.*tokenizer unavailable/);
  let calls = 0;
  await assert.rejects(prepareModelRequest(request(), async () => {
    if (++calls === 1) return 3001;
    throw new Error("counter disappeared during compaction");
  }), /Cannot verify.*counter disappeared/);
  assert.equal(calls, 2);
});

test("the HTTP counter uses the inference endpoint's formatter and preserves the complete request", async () => {
  const calls = [];
  const counter = createTokenCounter("http://kev.test/", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ model: MODEL_ID, input_tokens: 4123 });
  }, "local-test-key");
  const original = request();
  assert.equal(await counter(original), 4123, "Counting must return over-budget totals for the caller to compact or reject");
  assert.equal(calls.length, 1);
  const [{ url, options }] = calls;
  assert.equal(url, "http://kev.test/v1/input-tokens");
  assert.equal(options.method, "POST");
  assert.equal(options.headers["content-type"], "application/json");
  assert.equal(options.headers.authorization, "Bearer local-test-key");
  assert.equal(options.cache, "no-store");
  assert.ok(options.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(options.body), original);
});

test("the counter's default endpoint counts without adding an authorization header", async () => {
  const counter = createTokenCounter(undefined, async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8009/v1/input-tokens");
    assert.equal(Object.hasOwn(options.headers, "authorization"), false);
    return Response.json({ model: MODEL_ID, input_tokens: 0 });
  });
  assert.equal(await counter(request()), 0);
});

test("HTTP failures, malformed counters and unexpected model identities fail closed", async t => {
  const cases = [
    ["HTTP error", () => new Response("counter unavailable", { status: 503 }), /HTTP 503: counter unavailable/],
    ["network error", () => { throw new Error("connection refused"); }, /connection refused/],
    ["aborted request", () => { throw new DOMException("counter timed out", "TimeoutError"); }, /counter timed out/],
    ["invalid JSON", () => new Response("not JSON"), /JSON/],
    ["wrong model", () => Response.json({ model: "convaiinnovations/laya", input_tokens: 123 }), /model mismatch/],
    ["router alias", () => Response.json({ model: "laya-rl-agent", input_tokens: 123 }), /model mismatch/],
    ["missing model", () => Response.json({ input_tokens: 123 }), /model mismatch/],
    ["null response", () => Response.json(null), /model mismatch/],
    ...[null, undefined, "123", -1, 2.5, Number.MAX_SAFE_INTEGER + 1].map(value => [
      `bad count ${String(value)}`, () => Response.json({ model: MODEL_ID, input_tokens: value }), /invalid input-token count/,
    ]),
  ];
  for (const [name, response, expected] of cases) {
    await t.test(name, async () => {
      const urls = [];
      const counter = createTokenCounter("http://kev.test", async url => { urls.push(url); return response(); });
      await assert.rejects(counter(request()), error => {
        assert.match(error.message, /Token preflight failed; no inference request was sent/);
        assert.match(error.message, expected);
        return true;
      });
      assert.deepEqual(urls, ["http://kev.test/v1/input-tokens"], "Counter failures never invoke inference");
    });
  }
});

async function budgetLoopFixture(t, counter, reportedTokens = () => 400) {
  const root = await mkdtemp(path.join(process.platform === "darwin" ? "/private/tmp" : "/tmp", "kev-budget-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const requests = [], counts = [];
  const fetcher = async (url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.model, MODEL_ID);
    const [question] = Object.keys(request.questions);
    if (url === "http://budget.test/v1/input-tokens") {
      counts.push(request);
      return Response.json({ model: MODEL_ID, input_tokens: reportedTokens(question) });
    }
    assert.equal(url, "http://budget.test/v1/systemone");
    requests.push(request);
    const choice = question === "next_tool" ? "write_file" : "replace_target";
    const criteria = request.questions[question].criteria;
    assert.ok(Object.hasOwn(criteria, choice));
    return Response.json({
      model: MODEL_ID,
      answers: { [question]: { type: "choice", choice, confidence: 1,
        probabilities: Object.fromEntries(Object.keys(criteria).map(key => [key, key === choice ? 1 : 0])),
      } },
      usage: { input_tokens: reportedTokens(question), output_tokens: 10 }, latency_ms: 1,
    });
  };
  const loop = new ToolLoop(root, "http://budget.test", fetcher, undefined, counter);
  let state = await loop.start("demo", {
    goal: "Replace the target only after both model decisions are valid.", maxSteps: 5,
    initialFiles: { "target.txt": "Keep the original file 🌏." },
    actions: {
      replace_target: { tool: "write_file", description: "Replace the target file.", path: "target.txt", content: "This must not be written after a budget failure." },
      change_memory: { tool: "write_memory", description: "Change a notebook entry.", key: "important", value: "This must not replace the original memory." },
      finish: { tool: "finish", description: "Finish the fixture." },
    },
  });
  const memoryText = '{\n  "important": "Retain this memory index: notes.txt [0, 20)."\n}\n';
  const memoryPath = path.join(root, "demo/memory.json");
  await writeFile(memoryPath, memoryText);
  state = await loop.snapshot("demo");
  return { root, loop, state, requests, counts, memoryPath, memoryText };
}

async function assertBudgetFailurePreservesStorage(fixture, state, errorPattern) {
  assert.equal(state.run.status, "error");
  assert.match(state.run.error, errorPattern);
  assert.deepEqual(state.run.steps, [], "no partially selected action may be recorded as executed");
  assert.deepEqual(state.files, fixture.state.files);
  assert.deepEqual(state.memory, fixture.state.memory);
  assert.equal(await readFile(fixture.memoryPath, "utf8"), fixture.memoryText);
  assert.equal(await readFile(path.join(fixture.root, "demo/sandbox/target.txt"), "utf8"), "Keep the original file 🌏.");
  const reloaded = await new ToolLoop(fixture.root).snapshot("demo");
  assert.deepEqual(reloaded.files, fixture.state.files);
  assert.deepEqual(reloaded.memory, fixture.state.memory);
  assert.equal(reloaded.run.status, "error");
}

test("ToolLoop uses its own Kev endpoint to count every decision and allows exactly 3000 tokens", async t => {
  const fixture = await budgetLoopFixture(t, undefined, () => 3000);
  const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
  assert.equal(state.run.status, "running");
  assert.equal(state.run.steps.length, 1);
  assert.equal(state.run.steps[0].result.ok, true);
  assert.equal(fixture.counts.length, 2);
  assert.deepEqual(fixture.counts, fixture.requests, "The counted and inferred payloads must be identical at each stage");
  for (const decision of state.run.steps[0].decisions) {
    assert.equal(decision.input_tokens, 3000);
    assert.equal(decision.reported_input_tokens, 3000);
  }
  assert.equal(state.files[0].content, state.run.program.actions.replace_target.content);
  assert.deepEqual(state.memory, fixture.state.memory);
});

test("the HTTP token preflight rejects 3001 tokens without sending an inference request", async t => {
  const fixture = await budgetLoopFixture(t, undefined, () => 3001);
  const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
  assert.equal(fixture.counts.length, 1);
  assert.equal(fixture.requests.length, 0);
  await assertBudgetFailurePreservesStorage(fixture, state, /blocked before inference.*3,001 input tokens/);
});

test("ToolLoop blocks 3001-token input before calling the model or changing sandbox files and memory", async t => {
  let counts = 0;
  const fixture = await budgetLoopFixture(t, async () => { counts++; return 3001; });
  const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
  assert.equal(counts, 1);
  assert.equal(fixture.requests.length, 0, "preflight must reject before fetcher is invoked");
  await assertBudgetFailurePreservesStorage(fixture, state, /blocked before inference.*3,001 input tokens/);
});

test("ToolLoop fails closed on a counter error without calling the model or writing files or memory", async t => {
  const fixture = await budgetLoopFixture(t, async () => { throw new Error("local tokenizer is unavailable"); });
  const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
  assert.equal(fixture.requests.length, 0);
  await assertBudgetFailurePreservesStorage(fixture, state, /Cannot verify.*local tokenizer is unavailable/);
});

test("ToolLoop rejects server token-count mismatches before either decision can execute an action", async t => {
  for (const mismatchedStage of ["next_tool", "arguments"]) {
    await t.test(mismatchedStage, async t => {
      const fixture = await budgetLoopFixture(t, async () => 400, question => question === mismatchedStage ? 401 : 400);
      const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
      assert.equal(fixture.requests.length, mismatchedStage === "next_tool" ? 1 : 2);
      assert.ok(fixture.requests.at(-1).questions[mismatchedStage]);
      await assertBudgetFailurePreservesStorage(fixture, state, /tokenizer mismatch.*400 input tokens.*401/);
    });
  }
});

test("ToolLoop blocks an oversized argument stage without executing the already selected file-writing tool", async t => {
  const countedQuestions = [];
  const fixture = await budgetLoopFixture(t, async request => {
    const question = Object.keys(request.questions)[0];
    countedQuestions.push(question);
    return question === "arguments" ? 3001 : 400;
  });
  const state = await fixture.loop.step("demo", fixture.state.run.id, 0);
  assert.deepEqual(countedQuestions, ["next_tool", "arguments"]);
  assert.equal(fixture.requests.length, 1, "only the budget-approved tool selection may reach the model");
  assert.ok(fixture.requests[0].questions.next_tool);
  assert.deepEqual(fixture.requests[0].state.persistent_memory, fixture.state.memory);
  await assertBudgetFailurePreservesStorage(fixture, state, /argument selection for write_file.*blocked before inference.*3,001 input tokens/);
});
