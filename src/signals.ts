import type { ClassifierQuestion } from "./jev.ts";

/** One top-level tool call of the current user turn, as the supervisor tracks it. */
export interface Step {
  tool: string;
  /** Normalized arguments, for spotting repeats. */
  key: string;
  args: string;
  result: string;
  failed: boolean;
  check: boolean;
  edit: boolean;
}

export const DEFAULT_CHECK_PATTERN =
  "\\b(test|tests|vitest|jest|mocha|pytest|cargo (test|check|clippy|build)|go (test|vet|build)|tsc|typecheck|lint|eslint|biome|ruff|mypy|pyright|build|check|make)\\b";

export function normalizeArgs(tool: string, args: unknown): string {
  if (tool === "bash" && args && typeof args === "object") {
    return String((args as { command?: unknown }).command ?? "").replace(/\s+/gu, " ").trim();
  }
  return JSON.stringify(args ?? {});
}

export function makeStep(tool: string, args: unknown, result: string, failed: boolean, checkPattern: RegExp): Step {
  const key = `${tool}:${normalizeArgs(tool, args)}`;
  const command = tool === "bash" ? normalizeArgs(tool, args) : "";
  return {
    tool,
    key,
    args: normalizeArgs(tool, args),
    result,
    failed,
    check: tool === "bash" && checkPattern.test(command),
    edit: (tool === "edit" || tool === "write") && !failed,
  };
}

/** Edits happened this turn and no passing check ran after the last one. */
export function unverifiedEdits(steps: readonly Step[]): boolean {
  const lastEdit = steps.findLastIndex((s) => s.edit);
  if (lastEdit < 0) return false;
  const lastPass = steps.findLastIndex((s) => s.check && !s.failed);
  return lastPass < lastEdit;
}

export function editedFiles(steps: readonly Step[]): string[] {
  const files = new Set<string>();
  for (const step of steps) {
    if (!step.edit) continue;
    try {
      const path = (JSON.parse(step.args) as { path?: unknown }).path;
      if (typeof path === "string") files.add(path);
    } catch {
      // Not JSON: ignore.
    }
  }
  return [...files];
}

/**
 * The code trigger for a possible loop: among the last 6 calls, 3 identical ones, or the last 3 or
 * more calls failing from the same tool.
 */
export function loopSuspected(steps: readonly Step[]): boolean {
  const recent = steps.slice(-6);
  const counts = new Map<string, number>();
  for (const step of recent) counts.set(step.key, (counts.get(step.key) ?? 0) + 1);
  if ([...counts.values()].some((n) => n >= 3)) return true;
  let streak = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i] as Step;
    if (!step.failed || step.tool !== steps.at(-1)?.tool) break;
    streak++;
  }
  return streak >= 3;
}

export const DONE_QUESTIONS: Record<string, ClassifierQuestion> = {
  claims_done: {
    type: "bool",
    instructions: "Does `final_message` tell the user the requested work is finished, fixed, or working?",
    criteria: { true: "It reports the work as done or working", false: "It reports progress, asks something, or says the work is not finished" },
  },
  admits_unverified: {
    type: "bool",
    instructions: "Does `final_message` say plainly that the changes were not tested or verified, or why they could not be?",
    criteria: { true: "It says the work is untested or unverified", false: "It does not mention verification, or implies it was verified" },
  },
};

export const LOOP_QUESTIONS: Record<string, ClassifierQuestion> = {
  looping: {
    type: "bool",
    instructions:
      "Is the agent stuck: repeating the same action, or failing the same way, in `recent_steps` without changing its approach or making progress toward `goal`?",
    criteria: {
      true: "It repeats itself or keeps failing the same way",
      false: "Each step changes something or learns something new",
    },
  },
};

export const DONE_NUDGE =
  "You reported this as done, but no test, build, or check ran after your last edit. Run the most relevant check now, or say plainly why it can't be run.";

export const LOOP_NUDGE =
  "You seem to be repeating the same step without progress. Stop and re-read the last error, check your assumptions, and change approach, or ask the user.";
