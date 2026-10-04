// pi-supervisor: two checks on the agent, each a fixed signal confirmed by Jev (through Pi's own
// classifier models), each nudging the agent at most once:
//
// - "Done" with nothing verified (`agent_before_settle`): files were edited this user turn and no
//   passing check ran after the last edit, and Jev reads the final message as claiming the work is
//   done without admitting it is untested. The agent is asked to run a check, once per turn.
// - Stuck loops (`turn_end`): 3 identical calls among the last 6, or 3 failures in a row from one
//   tool, confirmed by Jev. The agent is told to change approach; a second loop in the same user
//   turn notifies you instead.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { type JevConfig, askJev, bool } from "./jev.ts";
import {
  DEFAULT_CHECK_PATTERN,
  DONE_NUDGE,
  DONE_QUESTIONS,
  LOOP_NUDGE,
  LOOP_QUESTIONS,
  type Step,
  editedFiles,
  loopSuspected,
  makeStep,
  unverifiedEdits,
} from "./signals.ts";
import { clip, clipTail, messageText } from "./transcript.ts";

export interface SupervisorConfig extends Record<string, unknown> {
  enabled: boolean;
  jev: JevConfig;
  done: { enabled: boolean; claimsThreshold: number; admitsThreshold: number };
  loops: { enabled: boolean; threshold: number; minCallsBetween: number };
  /** Regular expression (case-insensitive) for bash commands that count as checks. */
  checkPattern: string;
}

export const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: true,
  jev: { enabled: true, provider: "typesafe", model: "jev-latest", timeoutMs: 2_500 },
  done: { enabled: true, claimsThreshold: 0.7, admitsThreshold: 0.5 },
  loops: { enabled: true, threshold: 0.7, minCallsBetween: 10 },
  checkPattern: DEFAULT_CHECK_PATTERN,
};

const MESSAGE_TYPE = "supervisor";

type Block = { type?: string; id?: string; name?: string; arguments?: unknown };
type ToolResult = { toolCallId?: string; toolName?: string; isError?: boolean; content?: unknown };

export default function supervisor(pi: ExtensionAPI) {
  let config: SupervisorConfig = DEFAULT_CONFIG;
  let checkPattern = new RegExp(DEFAULT_CHECK_PATTERN, "iu");
  let steps: Step[] = [];
  let request = "";
  let doneNudged = false;
  let loopNudges = 0;
  let lastLoopNudgeAt = Number.NEGATIVE_INFINITY;

  const reload = (cwd: string) => {
    config = loadConfig("supervisor", DEFAULT_CONFIG, cwd);
    try {
      checkPattern = new RegExp(config.checkPattern, "iu");
    } catch {
      checkPattern = new RegExp(DEFAULT_CHECK_PATTERN, "iu");
    }
  };

  pi.on("session_start", (_event, ctx) => reload(ctx.cwd));

  pi.on("before_agent_start", (event, ctx) => {
    reload(ctx.cwd);
    steps = [];
    request = event.prompt;
    doneNudged = false;
    loopNudges = 0;
    lastLoopNudgeAt = Number.NEGATIVE_INFINITY;
  });

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { role?: string; content?: unknown };
    const calls = Array.isArray(message?.content) ? (message.content as Block[]).filter((b) => b?.type === "toolCall") : [];
    const results = (event.toolResults ?? []) as ToolResult[];
    for (const call of calls) {
      const result = results.find((r) => r.toolCallId === call.id);
      steps.push(makeStep(String(call.name ?? "tool"), call.arguments, messageText(result?.content), result?.isError === true, checkPattern));
    }
    if (!config.enabled || !config.loops.enabled || calls.length === 0) return undefined;
    if (steps.length - lastLoopNudgeAt < config.loops.minCallsBetween || !loopSuspected(steps)) return undefined;

    const state = {
      goal: clip(request || "(continue the work)", 1_500),
      recent_steps: steps.slice(-8).map((s) => ({ tool: s.tool, args: clip(s.args, 300), result: clipTail(s.result, 300), ...(s.failed ? { failed: true } : {}) })),
    };
    const outcome = await askJev(ctx.modelRegistry, config.jev, state, LOOP_QUESTIONS, ctx.signal);
    if (!outcome.ok) return undefined;
    const looping = bool(outcome.answers, "looping") ?? 0;
    const decision = { kind: "loop", looping, steps: steps.length, latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input };
    if (looping < config.loops.threshold) return { entries: [{ type: "custom", customType: "supervisor:decision", data: { ...decision, action: "none" } }] };
    lastLoopNudgeAt = steps.length;
    loopNudges++;
    if (loopNudges > 1) {
      notify(ctx, "The agent looks stuck again in this turn; you may want to step in.");
      return { entries: [{ type: "custom", customType: "supervisor:decision", data: { ...decision, action: "notify" } }] };
    }
    return {
      entries: [
        { type: "custom", customType: "supervisor:decision", data: { ...decision, action: "nudge" } },
        { type: "custom_message", customType: MESSAGE_TYPE, content: LOOP_NUDGE, display: true },
      ],
    };
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    if (!config.enabled || !config.done.enabled || doneNudged || event.outcome !== "completed") return undefined;
    if (!unverifiedEdits(steps)) return undefined;
    const final = lastAssistantText(event.context?.contextMessages ?? []);
    if (!final) return undefined;
    const state = { user_request: clip(request, 3_000), final_message: clipTail(final, 3_000), edited_files: editedFiles(steps) };
    const outcome = await askJev(ctx.modelRegistry, config.jev, state, DONE_QUESTIONS, ctx.signal);
    if (!outcome.ok) return undefined;
    const claims = bool(outcome.answers, "claims_done") ?? 0;
    const admits = bool(outcome.answers, "admits_unverified") ?? 1;
    const nudge = claims >= config.done.claimsThreshold && admits < config.done.admitsThreshold;
    const decision = { kind: "done", claims, admits, action: nudge ? "nudge" : "none", latencyMs: outcome.latencyMs, inputTokens: outcome.usage?.input };
    if (!nudge) return { entries: [{ type: "custom", customType: "supervisor:decision", data: decision }] };
    doneNudged = true;
    return {
      entries: [
        { type: "custom", customType: "supervisor:decision", data: decision },
        { type: "custom_message", customType: MESSAGE_TYPE, content: DONE_NUDGE, display: true },
      ],
      continue: true,
    };
  });

  pi.registerCommand("supervisor", {
    description: "supervisor: show this turn's tracked steps and settings",
    handler: async (_args, ctx) => {
      const checks = steps.filter((s) => s.check);
      ctx.ui.notify(
        [
          `supervisor ${config.enabled ? "on" : "off"}: done-claims ${config.done.enabled ? "on" : "off"}, loops ${config.loops.enabled ? "on" : "off"}.`,
          `This turn: ${steps.length} tool calls, ${steps.filter((s) => s.edit).length} edits, ${checks.length} checks (${checks.filter((s) => !s.failed).length} passing).`,
          `Unverified edits: ${unverifiedEdits(steps) ? "yes" : "no"}.`,
        ].join("\n"),
        "info",
      );
    },
  });
}

function notify(ctx: ExtensionContext, message: string) {
  if (ctx.hasUI) ctx.ui.notify(`supervisor: ${message}`, "warning");
}

function lastAssistantText(messages: readonly unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as { role?: string; content?: unknown };
    if (message?.role !== "assistant") continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return "";
}
