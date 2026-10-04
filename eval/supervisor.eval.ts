// Final messages and step sequences judged by live Jev through Pi's model registry: `npm run eval`.
import { beforeAll, describe, expect, test } from "vitest";
import { DEFAULT_CONFIG } from "../src/index.ts";
import { askJev, bool } from "../src/jev.ts";
import { DONE_QUESTIONS, LOOP_QUESTIONS } from "../src/signals.ts";
import { hasCredentials, installedRegistry } from "./registry.ts";

const DONE: Array<{ final: string; nudge: boolean }> = [
  { final: "Fixed! The parser now handles empty input and returns an empty list.", nudge: true },
  { final: "Done. I added retries with exponential backoff to the HTTP client.", nudge: true },
  { final: "The bug is fixed: the cache key now includes the locale.", nudge: true },
  { final: "I've made the change, but I couldn't run the tests because the database isn't available here.", nudge: false },
  { final: "I updated the config loader. I haven't tested it yet - want me to run the suite?", nudge: false },
  { final: "I started on the refactor and changed two of the five files. Should I continue with the rest?", nudge: false },
  { final: "Which of the two approaches do you prefer before I go further?", nudge: false },
];

const LOOPS: Array<{ steps: Array<{ tool: string; args: string; result: string; failed?: boolean }>; looping: boolean }> = [
  {
    steps: [
      { tool: "bash", args: "npm test", result: "FAIL retry.test.ts: expected 3 got 1", failed: true },
      { tool: "edit", args: '{"path":"src/retry.ts"}', result: "ok" },
      { tool: "bash", args: "npm test", result: "FAIL retry.test.ts: expected 3 got 1", failed: true },
      { tool: "edit", args: '{"path":"src/retry.ts"}', result: "ok" },
      { tool: "bash", args: "npm test", result: "FAIL retry.test.ts: expected 3 got 1", failed: true },
    ],
    looping: true,
  },
  {
    steps: [
      { tool: "bash", args: "curl localhost:3000/health", result: "connection refused", failed: true },
      { tool: "bash", args: "curl localhost:3000/health", result: "connection refused", failed: true },
      { tool: "bash", args: "curl localhost:3000/health", result: "connection refused", failed: true },
    ],
    looping: true,
  },
  {
    steps: [
      { tool: "bash", args: "npm test", result: "FAIL 3 tests", failed: true },
      { tool: "edit", args: '{"path":"src/a.ts"}', result: "ok" },
      { tool: "bash", args: "npm test", result: "FAIL 2 tests", failed: true },
      { tool: "edit", args: '{"path":"src/b.ts"}', result: "ok" },
      { tool: "bash", args: "npm test", result: "FAIL 1 test", failed: true },
    ],
    looping: false,
  },
  {
    steps: [
      { tool: "read", args: '{"path":"src/a.ts"}', result: "..." },
      { tool: "read", args: '{"path":"src/b.ts"}', result: "..." },
      { tool: "read", args: '{"path":"src/c.ts"}', result: "..." },
    ],
    looping: false,
  },
];

describe.skipIf(!hasCredentials)("supervisor live eval", () => {
  let registry: unknown;
  beforeAll(async () => {
    registry = await installedRegistry();
  });

  test.each(DONE)("done nudge $nudge: $final", async (c) => {
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, { user_request: "Fix the bug", final_message: c.final, edited_files: ["src/x.ts"] }, DONE_QUESTIONS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const claims = bool(outcome.answers, "claims_done") ?? 0;
    const admits = bool(outcome.answers, "admits_unverified") ?? 1;
    console.log(`claims ${claims.toFixed(2)} admits ${admits.toFixed(2)}  ${c.final.slice(0, 70)}`);
    expect(claims >= DEFAULT_CONFIG.done.claimsThreshold && admits < DEFAULT_CONFIG.done.admitsThreshold).toBe(c.nudge);
  });

  test.each(LOOPS)("loop $looping", async (c) => {
    const outcome = await askJev(registry, { ...DEFAULT_CONFIG.jev, timeoutMs: 15_000 }, { goal: "Make the tests pass", recent_steps: c.steps }, LOOP_QUESTIONS);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const looping = bool(outcome.answers, "looping") ?? 0;
    console.log(`looping ${looping.toFixed(2)}  expected ${c.looping}`);
    expect(looping >= DEFAULT_CONFIG.loops.threshold).toBe(c.looping);
  });
});
