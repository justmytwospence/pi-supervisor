import { expect, test } from "vitest";
import supervisor from "../src/index.ts";
import { fakeJev, harness } from "./harness.ts";

const toolTurn = (calls: Array<{ name: string; args: unknown; isError?: boolean }>) => ({
  type: "turn_end",
  message: { role: "assistant", content: calls.map((c, i) => ({ type: "toolCall", id: `c${i}`, name: c.name, arguments: c.args })) },
  toolResults: calls.map((c, i) => ({ toolCallId: `c${i}`, toolName: c.name, isError: c.isError === true, content: [{ type: "text", text: "out" }] })),
});

const settle = (text: string) => ({
  type: "agent_before_settle",
  outcome: "completed",
  entries: [],
  continue: false,
  context: { contextMessages: [{ role: "assistant", content: [{ type: "text", text }] }] },
});

function setup(answers: Record<string, any>) {
  const h = harness();
  supervisor(h.pi);
  const jev = fakeJev(() => answers);
  const ctx = h.ctx({ modelRegistry: jev.registry });
  return { h, jev, ctx };
}

const doneAnswers = { claims_done: { type: "bool", probability: 0.95 }, admits_unverified: { type: "bool", probability: 0.05 } };

test("a done claim after unverified edits gets one nudge", async () => {
  const { h, jev, ctx } = setup(doneAnswers);
  await h.emit("before_agent_start", { prompt: "Fix the parser" }, ctx);
  await h.emit("turn_end", toolTurn([{ name: "edit", args: { path: "src/parser.ts" } }]), ctx);
  const result: any = await h.emit("agent_before_settle", settle("Fixed! The parser now handles empty input."), ctx);
  expect(result.continue).toBe(true);
  expect(result.entries[1]).toMatchObject({ type: "custom_message", customType: "supervisor" });
  expect(jev.calls[0]?.state).toMatchObject({ user_request: "Fix the parser", edited_files: ["src/parser.ts"] });
  // Once per user turn.
  expect(await h.emit("agent_before_settle", settle("Fixed!"), ctx)).toBeUndefined();
});

test("no nudge when a check passed after the edit, or nothing was edited", async () => {
  const { h, jev, ctx } = setup(doneAnswers);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  await h.emit("turn_end", toolTurn([{ name: "edit", args: { path: "a.ts" } }, { name: "bash", args: { command: "npm test" } }]), ctx);
  expect(await h.emit("agent_before_settle", settle("Done."), ctx)).toBeUndefined();
  await h.emit("before_agent_start", { prompt: "y" }, ctx);
  expect(await h.emit("agent_before_settle", settle("Done."), ctx)).toBeUndefined();
  expect(jev.calls).toHaveLength(0);
});

test("no nudge when the agent admits it is untested", async () => {
  const { h, ctx } = setup({ claims_done: { type: "bool", probability: 0.9 }, admits_unverified: { type: "bool", probability: 0.9 } });
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  await h.emit("turn_end", toolTurn([{ name: "write", args: { path: "a.ts" } }]), ctx);
  const result: any = await h.emit("agent_before_settle", settle("Done, but I could not run the tests."), ctx);
  expect(result.continue).toBeUndefined();
  expect(result.entries[0].data.action).toBe("none");
});

test("a confirmed loop nudges once, then notifies", async () => {
  const { h, ctx } = setup({ looping: { type: "bool", probability: 0.9 } });
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  const fail = { name: "bash", args: { command: "npm test" }, isError: true };
  await h.emit("turn_end", toolTurn([fail]), ctx);
  await h.emit("turn_end", toolTurn([fail]), ctx);
  const first: any = await h.emit("turn_end", toolTurn([fail]), ctx);
  expect(first.entries[1]).toMatchObject({ type: "custom_message", content: expect.stringMatching(/change approach/u) });
  for (let i = 0; i < 9; i++) await h.emit("turn_end", toolTurn([fail]), ctx);
  const second: any = await h.emit("turn_end", toolTurn([fail]), ctx);
  expect(second.entries[0].data.action).toBe("notify");
  expect(ctx.ui.notes.at(-1)?.message).toMatch(/stuck again/u);
});

test("Jev unavailable: no action", async () => {
  const { h, ctx } = setup({ stopReason: "error", errorMessage: "x", answers: {} } as any);
  await h.emit("before_agent_start", { prompt: "x" }, ctx);
  await h.emit("turn_end", toolTurn([{ name: "edit", args: { path: "a.ts" } }]), ctx);
  expect(await h.emit("agent_before_settle", settle("Done."), ctx)).toBeUndefined();
});
