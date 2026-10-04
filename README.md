# pi-supervisor

A [pi](https://pi.dev) extension with two checks on the agent. Each starts from a fixed signal in
code, is confirmed by [Jev](https://docs.typesafe.ai) through Pi's own classifier models
(`ctx.modelRegistry.classify`), and nudges the agent at most once.

**"Done" with nothing verified.** When the agent is about to stop (`agent_before_settle`) after
editing files in this user turn, and no check passed after its last edit, Jev reads the final
message: does it say the work is done, and does it admit the changes are untested? If it claims done
(>= 0.7) without admitting that (< 0.5), the agent gets one message and continues: "You reported this
as done, but no test, build, or check ran after your last edit. Run the most relevant check now, or
say plainly why it can't be run." Checks are bash commands matching `checkPattern` (test, vitest,
jest, pytest, cargo test, go test, tsc, typecheck, lint, build, `npm run check`, make, ...).

**Stuck loops.** After each turn with tool calls (`turn_end`), 3 identical calls among the last 6, or
3 or more failures in a row from one tool, ask Jev whether the agent is repeating itself or failing
the same way without progress. If so (>= 0.7), the agent is told to re-read the error, check its
assumptions, and change approach or ask you. At most once per 10 tool calls; a second loop in the
same user turn notifies you instead.

When Jev is unavailable, nothing happens. Decisions are recorded as `supervisor:decision` session
entries (never sent to the model). `/supervisor` shows what the current turn tracked.

## Settings

`~/.pi/agent/supervisor.json`, with `<project>/.pi/supervisor.json` merged on top:

```json
{
  "enabled": true,
  "jev": { "enabled": true, "provider": "typesafe", "model": "jev-latest", "timeoutMs": 2500 },
  "done": { "enabled": true, "claimsThreshold": 0.7, "admitsThreshold": 0.5 },
  "loops": { "enabled": true, "threshold": 0.7, "minCallsBetween": 10 },
  "checkPattern": "\\b(test|vitest|pytest|tsc|lint|build|check)\\b"
}
```

Requires Pi 0.99 or newer for classifier models.

## Development

```sh
npm run check   # typecheck and unit tests
npm run eval    # final messages and step sequences against live Jev (needs TYPESAFE_API_KEY)
```
