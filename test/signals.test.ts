import { expect, test } from "vitest";
import { DEFAULT_CHECK_PATTERN, editedFiles, loopSuspected, makeStep, unverifiedEdits } from "../src/signals.ts";

const re = new RegExp(DEFAULT_CHECK_PATTERN, "iu");
const bash = (command: string, failed = false) => makeStep("bash", { command }, "", failed, re);
const edit = (path: string, failed = false) => makeStep("edit", { path, edits: [] }, "", failed, re);

test("check commands", () => {
  for (const c of ["npm test", "npx vitest run", "pytest -q", "cargo test", "go test ./...", "npx tsc --noEmit", "npm run typecheck", "npm run lint", "npm run build", "npm run check", "make"]) {
    expect(bash(c).check, c).toBe(true);
  }
  for (const c of ["ls", "git status", "cat test.txt"]) expect(bash(c).check, c).toBe(c === "cat test.txt");
});

test("unverifiedEdits: an edit after the last passing check", () => {
  expect(unverifiedEdits([bash("ls")])).toBe(false);
  expect(unverifiedEdits([edit("a.ts")])).toBe(true);
  expect(unverifiedEdits([edit("a.ts"), bash("npm test")])).toBe(false);
  expect(unverifiedEdits([edit("a.ts"), bash("npm test", true)])).toBe(true);
  expect(unverifiedEdits([bash("npm test"), edit("a.ts")])).toBe(true);
  expect(unverifiedEdits([edit("a.ts", true)])).toBe(false);
  expect(editedFiles([edit("a.ts"), edit("b.ts"), edit("a.ts")])).toEqual(["a.ts", "b.ts"]);
});

test("loopSuspected: repeats or a failure streak", () => {
  expect(loopSuspected([bash("npm test"), bash("ls"), bash("npm test"), bash("cat x"), bash("npm  test")])).toBe(true);
  expect(loopSuspected([bash("a", true), bash("b", true), bash("c", true)])).toBe(true);
  expect(loopSuspected([bash("a", true), edit("x"), bash("c", true)])).toBe(false);
  expect(loopSuspected([bash("a"), bash("b"), bash("c")])).toBe(false);
});
