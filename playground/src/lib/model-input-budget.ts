import type { SystemOneRequest } from "./kev.ts";
import { MAX_INPUT_TOKENS, MODEL_ID } from "./model-config.ts";

export { MAX_INPUT_TOKENS } from "./model-config.ts";
export type TokenCounter = (request: SystemOneRequest) => Promise<number>;
const COUNTER_TIMEOUT_MS = 10000;

function verifiedCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("Token counter returned an invalid input-token count.");
  return Number(value);
}

// Count with the same loaded tokenizer and formatter that serve inference.
export function createTokenCounter(
  endpoint = "http://127.0.0.1:8009", fetcher: typeof fetch = fetch, apiKey?: string,
): TokenCounter {
  return async request => {
    try {
      const response = await fetcher(`${endpoint.replace(/\/$/, "")}/v1/input-tokens`, {
        method: "POST", headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
        body: JSON.stringify(request), signal: AbortSignal.timeout(COUNTER_TIMEOUT_MS), cache: "no-store",
      });
      if (!response.ok) throw new Error(`Token counter HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
      const result: unknown = await response.json();
      if (result === null || typeof result !== "object" || !("model" in result) || result.model !== MODEL_ID) {
        throw new Error(`Token counter model mismatch: expected ${MODEL_ID}.`);
      }
      return verifiedCount("input_tokens" in result ? result.input_tokens : undefined);
    } catch (error) {
      throw new Error(`Token preflight failed; no inference request was sent. ${(error as Error).message}`);
    }
  };
}

export const countInputTokens: TokenCounter = createTokenCounter();

export async function prepareModelRequest(
  request: SystemOneRequest, counter: TokenCounter = countInputTokens,
): Promise<{ request: SystemOneRequest; inputTokens: number; compacted: boolean }> {
  let inputTokens: number;
  const count = async (value: SystemOneRequest) => {
    try { return verifiedCount(await counter(value)); }
    catch (error) { throw new Error(`Cannot verify the ${MAX_INPUT_TOKENS.toLocaleString("en-US")}-token input limit before model inference: ${(error as Error).message}`); }
  };
  inputTokens = await count(request);
  if (inputTokens <= MAX_INPUT_TOKENS) return { request, inputTokens, compacted: false };
  const state = request.state;
  if (state !== null && typeof state === "object" && !Array.isArray(state) && Array.isArray(state.recent_steps)) {
    for (let dropped = 1; dropped <= state.recent_steps.length; dropped++) {
      // recent_steps contains only older, optional history. Never remove last_step
      // or current_step: every decision needs its immediate predecessor and the
      // choices already made in this step, along with memory, pages and dictionaries.
      const compacted: SystemOneRequest = { ...request, state: { ...state, recent_steps: state.recent_steps.slice(dropped) } };
      inputTokens = await count(compacted);
      if (inputTokens <= MAX_INPUT_TOKENS) return { request: compacted, inputTokens, compacted: true };
    }
  }
  throw new Error(`Model request blocked before inference: ${inputTokens.toLocaleString("en-US")} input tokens exceeds the ${MAX_INPUT_TOKENS.toLocaleString("en-US")}-token limit even without older optional history. Required context, including last_step and current_step, was preserved. Shorten the goal, memory, reading, or tool dictionary before continuing.`);
}
