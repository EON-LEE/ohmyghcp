# oh-my-ghcp verification

What was tested, how to repeat it, and what is not covered. Results are from 2026-10-04 with OMC v5.6.1
(`13543f9d6fc1`, pinned in [`upstream.json`](../upstream.json)) and the adapter in this repository. Design and the
gaps the adapter closes: [DESIGN.md](DESIGN.md).

## Environment

| | Windows | Linux |
| --- | --- | --- |
| OS | Windows 11 Enterprise | Ubuntu 26.04 LTS on WSL |
| Node.js | 24.19.0 | 24.18.1 |
| Shells | Windows PowerShell 5.1, PowerShell 7.6.6 | bash, sh |
| GitHub Copilot CLI | 1.0.91 | 1.0.78 installed, not used for a real run |

## Tests

| Test | What it covers | Model calls | Run on |
| --- | --- | --- | --- |
| [`tests/selftest-shim.cjs`](../tests/selftest-shim.cjs) | Builds a test plugin from an OMC checkout and replays Copilot CLI 1.0.91-shaped hook events through the shim: generated `/omc` router skill and its OMC skill names, `hooks.json`, the host note, every example prompt in the README's keyword table, skill and task tool mapping, the subagent model policy and lifecycle, the `omc` wrapper, the ultragoal `/goal` guard, Stop → SessionEnd → continuation, and that OMC leaves the real `~/.claude` and `~/.omc` untouched (other changes in `~/.claude`, for example from a Claude Code session running at the same time, are reported, not counted). Where the shim changes behaviour, an A/B check runs the same input through unmodified OMC. This verifies the generated skill file, not live slash-command selection by Copilot. | None | Windows, Linux |
| [`tests/e2e-ralph.ps1`](../tests/e2e-ralph.ps1) and [`tests/e2e-check.cjs`](../tests/e2e-check.cjs) | A real `copilot -p "ralph: ..."` run on a small repository with a failing test ([`tests/fixtures/ralph-sandbox`](../tests/fixtures/ralph-sandbox)), with its own `COPILOT_HOME`. The checker reads Copilot's session events and the shim log. | Yes, `gpt-5-mini` by default (about 4 to 10 AIC per run) | Windows |
| [`tests/user-path.test.ps1`](../tests/user-path.test.ps1) | The installer's user `PATH` helper, against a throwaway registry key. | None | Windows |
| Installers | Fresh install, re-run, `-Force`, uninstall, each in a temporary `COPILOT_HOME`. | None | Windows, Linux |

## How to run

```powershell
# Windows, after scripts\install.ps1 (the tests use the installed OMC checkout and plugin)
node tests\selftest-shim.cjs                   # --omc <dir> to test another OMC checkout
pwsh -File tests\e2e-ralph.ps1                 # -Model, -Prompt, -Root, -OutDir; uses AI credits
node tests\e2e-check.cjs <run directory>       # check a recorded run again
powershell -NoProfile -ExecutionPolicy Bypass -File tests\user-path.test.ps1
```

```sh
# Linux, after sh scripts/install.sh
node tests/selftest-shim.cjs
```

To keep a test installation apart from your own, set `COPILOT_HOME` to an empty directory before you run the installer
(with `-NoPath` on Windows) and the tests.

Interactive check, as done for the session described below:

1. Copy `tests/fixtures/ralph-sandbox` to a scratch directory and make it a git repository.
2. Set `GHCP_TASK_MODEL=gpt-5-mini` so that subagents use the same model, start `copilot-omc --model gpt-5-mini` there
   and enter `ralph: make the failing test in this repo pass (check with: node test.js).`
3. Watch for the ralph skill loading through the skill tool, `omc ralph verify` runs, a
   `[RALPH LOOP - ITERATION n/100]` continuation, the cancel skill at the end, and no hook errors.
4. Afterwards `node test.js` passes, no active `ralph-state.json` is left in `.omc/state/sessions/<session id>/`, and
   `~/.claude` is unchanged.

## Results

### Installers

| | Windows (PowerShell 5.1 and 7) | Linux (WSL) |
| --- | --- | --- |
| Fresh install | 60 to 84 s | 12 to 19 s |
| Re-run (keeps the OMC checkout, rebuilds the plugin) | 15 to 16 s | 2 s |
| `-Force` (clones OMC again) | 58 s | not measured |
| Uninstall (`-Uninstall -NoPath`, `--uninstall`) | install directory removed | install directory removed |

The build step reported 28 OMC hook commands routed through the shim plus 2 host-note hooks, 2 setup hooks dropped,
19 agent model aliases dropped, the MCP server set to start in the session directory (`"cwd": "."`) and 7 Claude tool
names in docs replaced.

`tests/user-path.test.ps1` passed 16 of 16 checks on Windows PowerShell 5.1 and PowerShell 7. It found one bug, fixed
before these runs: an empty result came back as `$null` instead of an empty array.

### Offline selftest

88 of 88 checks passed on Windows (114 s) and on Linux (31 s).

- All 20 example prompts of the README's keyword table behave as documented. ralph, autopilot, ralplan and ultragoal
  get OMC's `[MAGIC KEYWORD: ...]` marker, the skill-tool invocation and their mode state; deep-interview and cancel
  the marker and the invocation; the five helper modes their `<...-mode>` instructions. `ralph가 뭐야?`, `랄프: ...`
  and `랄프로 ...` start nothing.
- The A/B checks reproduce each gap with unmodified OMC and show the shim closing it, for example OMC's deny reason in
  Claude syntax, the SessionEnd that would end a running ralph loop under `-p`, and the ultragoal guard that denies
  every tool without Claude Code's `/goal`.
- Hook cost on Windows, Node start included: 0.15 to 1.1 s per hook, 3.4 s for OMC's `session-start.mjs`. Each prompt
  runs three UserPromptSubmit hooks, about 1.9 s in total.
- The selftest runs OMC's SessionEnd with OMC's test settings (`NODE_ENV=test`, a 20 s foreground budget and a 0.5 s
  grace period), so its INFO lines show the cleanup working on Windows too. The next section shows the shipped
  behaviour.

### SessionEnd cleanup with OMC's shipped settings

A one-off measurement, not part of the test suite: an active ralph state, then SessionEnd as Copilot sends it, then up
to 60 s of waiting.

| | Hook result | Cleanup job published | ralph state |
| --- | --- | --- | --- |
| Windows, through the shim, 3 runs | `session-end.mjs` and `wiki-session-end.mjs` time out at OMC's 300 ms budget and exit fail-open | 0 of 3 | still there after 60 s |
| Windows, unmodified OMC run directly as Claude Code runs it, 3 runs | `session-end.mjs` times out at 300 ms | 1 of 3 | not measured |
| Linux (WSL), through the shim, 3 runs | both hooks finish (190 to 280 ms each, Node start included) | 3 of 3 | cleared after 30 s, OMC's grace period |

This is why the README asks Windows users to end modes with `cancelomc` before they exit.

### End-to-end run with a real model (Windows)

`pwsh -File tests\e2e-ralph.ps1` with the defaults: `gpt-5-mini` for the session and, through `GHCP_TASK_MODEL`, for
the subagents, and the prompt `ralph: make the failing test in this repo pass (check with: node test.js).` All 11 checks
passed:

1. Copilot exited with 0.
2. The fixture's test passes after the run.
3. OMC hooks ran (shim log).
4. The host note reached the model.
5. The host note carries the real session id.
6. OMC detected the ralph keyword.
7. The ralph skill loaded through the skill tool.
8. OMC state calls used only the real session id.
9. Subagents ran on the pinned model.
10. No active ralph state is left behind.
11. The real `~/.claude` is untouched.

| | |
| --- | --- |
| Wall time | 695 s |
| Premium requests | 0 |
| AI credits | 9.71 AIC |
| Hook runs | 211 |
| Tool calls | `skill` 5, `powershell` 11, `grep` 6, `view` 4, `edit` 2, `task` 2, `t-state_clear` 1, `t-state_get_status` 1 |
| `omc` CLI runs | 7, for example `omc ralph verify` |
| Skill calls with the Claude plugin prefix | 0 |
| Subagent | `oh-my-claudecode:architect`: the main model asked for `gpt-5.4`, the pin (`GHCP_TASK_MODEL`) ran it on `gpt-5-mini` |

OMC's Stop hook continued the loop (`[RALPH LOOP - ITERATION 2/100]`). A `cancel` call through the task tool was denied
by OMC with the translated reason (`... call the skill tool with skill "cancel"`). OMC's `git-guardrails.mjs`, which OMC
registers for Claude Code's `Bash` tool, ran for each of the 11 `powershell` calls and for no other tool, while OMC's
PreToolUse hook for all tools (`pre-tool-enforcer.mjs`) ran for all 32 tool calls. `~/.omc` was not created,
`~/.claude` was not touched, and no OMC worker was left running.

A false positive, found and fixed: an earlier run, made before the two fixes below, passed the checks of the time
although ralph never ran. The model first called ralph through the task tool; OMC denied it with advice in Claude Code
syntax (`Skill(skill="oh-my-claudecode:ralph")`); the model copied that name into its only ralph skill call, which
failed with `Skill not found`. The old check looked only at the requested skill name. The checker now counts a skill
only when Copilot reports it loaded, and reads subagent models from Copilot's `subagent.started` events instead of the
requested arguments. With the current checker that run fails 1 of 11 checks (395 s, 4.12 AIC).

### Interactive session (Windows)

`copilot-omc --model gpt-5-mini --yolo` with `GHCP_TASK_MODEL=gpt-5-mini`, in a terminal, on the same fixture with the
same prompt, before the two fixes below: 11 min 41 s, 21 requests, 0 premium requests, 6.85 AIC. The test passed, the
ralph state was cleared, no hook exited with an error, the subagent was linked to its parent and ran on the pinned
model, no OMC worker was left running, and the real home directory was unchanged. As with `-p`, Copilot 1.0.91 fired
UserPromptSubmit before SessionStart.

Two gaps found there and fixed in the shim:

- OMC's deny reasons named Claude invocations (`Skill(skill="oh-my-claudecode:X")`), which the model copied into skill
  calls that fail on Copilot. The shim now rewrites them to `call the skill tool with skill "X"`.
- The model took the `omc ...` steps in OMC's skills (such as `omc ralph verify`) for a missing tool and skipped them.
  The host note now says that `omc` is a shell command.

The interactive session was not repeated after the fixes. The end-to-end run above was made after them and shows both
working (no prefixed skill calls, 7 `omc` runs).

### Model behaviour seen with gpt-5-mini

Not adapter failures, but worth knowing: repeated calls of the cancel skill, an invalid `rg` regex, an MCP tool name
typed into a shell command, `.omc/` committed to git, and skills called through the task tool (OMC denies those; the
shim translates the reason).

## Not verified

- macOS.
- A real Copilot CLI run on Linux. WSL had Copilot CLI 1.0.78; only the installer and the offline tests ran there.
- autopilot, ralplan, deep-interview and ultragoal with a real model, past the start of the mode.
- `omc team` (tmux workers), the HUD/statusline, and Copilot in VS Code.
- Copilot CLI versions other than 1.0.91. The installers warn when the installed version is older.
- OMC's slash forms such as `/ultrawork`: Copilot CLI parses a leading `/` itself.
- The generated `/omc` router has not been exercised as a live interactive slash command; the offline selftest checks its generated skill definition.
- Claude Code itself. Comparisons with Claude Code come from OMC's code and from running unmodified OMC hooks directly
  (the A/B checks).
