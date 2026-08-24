# ohmyghcp — Test Plan

Every test case traces to a rule in `DESIGN.md`. No rule ships without a test; no test exists without a rule.

## 0. Strategy

The riskiest thing in this project is not our logic — it is **whether the platform behaves as documented**. So the test pyramid is inverted at the base: platform characterization tests run *first* and gate all other work.

| Layer | Name | Runner | Speed | Gates |
| --- | --- | --- | --- | --- |
| **L0** | Platform characterization | Real `copilot` CLI, manual + scripted | slow | **Everything.** If L0 fails, the design is void |
| **L1** | Unit — decision logic | vitest, subprocess per case | fast | every commit |
| **L2** | Contract — hook I/O discipline | vitest | fast | every commit |
| **L3** | Cross-platform parity | vitest | fast | every commit |
| **L4** | Manifest & schema validation | vitest | fast | every commit |
| **L5** | Integration — real CLI | scripted `copilot -p` | slow | pre-release |
| **L6** | Resilience & security | vitest | fast | every commit |
| **L7** | Performance budget | vitest | fast | every commit |
| **L8** | Extension / HUD | vitest + manual | medium | pre-release |

**Tooling:** Node + `vitest`. Tests invoke `gate.ps1` and `gate.sh` as **subprocesses** so the same suite exercises both implementations. Fixtures are JSON files under `tests/fixtures/`; expected decisions are golden files under `tests/golden/`.

**Definition of done for a rule:** unit case + contract case + parity case all green on Windows *and* Linux.

---

## L0 — Platform characterization (the spike)

These validate documented behaviour we cannot afford to assume. **Run before writing the engine.**

| ID | Assumption under test | Method | Pass criteria | If it fails |
| --- | --- | --- | --- | --- |
| **S-01** | `agentStop` returning `{"decision":"block","reason":X}` forces another turn with `X` as the prompt | Minimal hook that blocks twice then allows; log each invocation | Exactly 3 invocations; agent visibly continues; `reason` text appears to influence the turn | **Project is void.** Redesign around external runner only |
| **S-02** | State written by the hook persists and is re-read across forced turns | Hook increments a counter in `.omg/state/probe.json` | Counter reads 1, 2, 3 across turns | Move state into `reason` payload (lossy) |
| **S-03** | The runaway guard is 8 consecutive blocks | Hook blocks unconditionally | Turn ends by itself at 8; no hang | Recalibrate `SELF_LIMIT` to the observed value |
| **S-04** | `stop_hook_active` is delivered on forced turns | Echo the raw payload to a log | Field present and `true` on turns ≥ 2 | Track continuation count in our own state file instead |
| **S-05** | Two JSON objects on stdout are ignored (documented) | Hook emits two objects | Hook output ignored, no crash | Tighten C-01 enforcement |
| **S-06** | Plugin-contributed `hooks.json` is actually loaded from an installed plugin | Install locally, trigger hook | Hook fires | Fall back to `~/.copilot/hooks/` install path |
| **S-07** | PowerShell hook stdout has no BOM / no extra newline that breaks `JSON.parse` | Byte-inspect stdout on Windows | Clean UTF-8, parseable | Add explicit BOM-less writer |

---

## L1 — Unit: decision logic

Table-driven. Each case = a fixture state + an `agentStop` payload → an expected decision.

### Rule coverage

| ID | Rule | Given | Expect |
| --- | --- | --- | --- |
| U-R1-01 | R1 | no `flow.json` | `allow` |
| U-R1-02 | R1 | `.omg/` exists but `state/` empty | `allow` |
| U-R2-01 | R2 | evidence missing, attempts 1 of 3 | `block`; `attempts` → 2 |
| U-R2-02 | R2 | 2 evidence paths, only 1 exists | `block` |
| U-R2-03 | R2 | evidence file exists but is **empty** | `block` (non-empty required) |
| U-R2-04 | R2 | `reason` names the missing artifact paths | `block`, reason contains each missing path |
| U-R3-01 | R3 | evidence missing, attempts 3 of 3 | `allow`; `status` → `failed` |
| U-R3-02 | R3 | failure reason recorded in `history` | history has `outcome:"failed"` |
| U-R4-01 | R4 | evidence present, phase 0 of 4 | `block`; `phaseIndex` → 1 |
| U-R4-02 | R4 | next phase's `attempts` reset to 1 | `attempts[next] === 1` |
| U-R4-03 | R4 | `reason` names the next phase and its evidence targets | reason contains both |
| U-R5-01 | R5 | evidence present, final phase | `allow`; `status` → `complete` |
| U-R6-01 | R6 | `stop_hook_active`, `consecutiveBlocks` 6 | `allow` (self-limit) |
| U-R6-02 | R6 | `stop_hook_active`, `consecutiveBlocks` 5 | normal logic, **not** limited |
| U-R6-03 | R6 | self-limit persists a resume hint | state has resume hint |
| U-R7-01 | R7 | malformed JSON | `allow` |
| U-R7-02 | R7 | `version: 999` | `allow` |
| U-R7-03 | R7 | `phases: []` | `allow` |
| U-R7-04 | R7 | `phaseIndex` out of range | `allow` |
| U-R7-05 | R7 | `evidence` missing the current phase key | `allow` |
| U-R8-01 | R8 | `status: "complete"` | `allow` |
| U-R8-02 | R8 | `status: "cancelled"` | `allow` |
| U-R8-03 | R8 | `status: "failed"` | `allow` |

### Precedence (the subtle bugs live here)

| ID | Given | Expect | Proves |
| --- | --- | --- | --- |
| U-PREC-01 | `status:"failed"` **and** evidence present with phases remaining | `allow`, no phase advance | R8 beats R4 |
| U-PREC-02 | self-limit reached **and** evidence present with phases remaining | `allow`, no phase advance | R6 beats R4 |
| U-PREC-03 | malformed JSON **and** no state file semantics ambiguous | `allow`, no write attempted | R7 beats R1 |
| U-PREC-04 | self-limit reached **and** evidence missing at max attempts | `allow`, `status` **not** overwritten to `failed` | R6 beats R3 |

### Idempotence & mutation safety

| ID | Given | Expect |
| --- | --- | --- |
| U-MUT-01 | `allow` decisions (R1, R7) | state file **not** modified |
| U-MUT-02 | same input run twice on R2 | attempts increments exactly once per run, no double-increment |
| U-MUT-03 | state write is atomic (temp + rename) | no truncated file observable mid-write |
| U-MUT-04 | unknown extra keys in state | preserved after write, not dropped |

---

## L2 — Contract: hook I/O discipline

The CLI concatenates non-progress stdout lines and runs **one** `JSON.parse`. Violations silently disable the engine, so these are non-negotiable.

| ID | Assertion |
| --- | --- |
| C-01 | stdout parses as exactly one JSON object |
| C-02 | no stray output: no BOM, no banner, no trailing text, no PowerShell warning stream on stdout |
| C-03 | `decision` ∈ `{"block","allow"}` |
| C-04 | every `block` carries a non-empty `reason` |
| C-05 | `allow` carries no `reason` field |
| C-06 | any progress line is single-line valid JSON with `type:"progress"` |
| C-07 | exit code is `0` for all decisions |
| C-08 | warnings go to stderr only; stderr content never appears on stdout |
| C-09 | `reason` is truncated to the documented budget (well under the 10 MiB cap) |
| C-10 | output is UTF-8 **without BOM** on Windows |
| C-11 | non-ASCII task text (Korean) round-trips correctly in `reason` |
| C-12 | `preToolUse` gate returns `{}` (not `null`, not empty) when falling through |

---

## L3 — Cross-platform parity

The **entire L1 fixture corpus** is replayed through both implementations.

| ID | Assertion |
| --- | --- |
| PAR-01 | For every L1 fixture, `gate.ps1` and `gate.sh` produce semantically identical JSON (key order normalized) |
| PAR-02 | Resulting state file after each run is identical across platforms (timestamps normalized) |
| PAR-03 | Both handle CRLF and LF state files identically |
| PAR-04 | Both handle paths containing spaces and non-ASCII characters identically |

---

## L4 — Manifest & schema validation

| ID | Target | Assertion |
| --- | --- | --- |
| M-01 | `plugin.json` | parses; `name` present, kebab-case, ≤ 64 chars |
| M-02 | `plugin.json` | every component path resolves to an existing directory/file |
| M-03 | `hooks/hooks.json` | `version: 1`; every event name is in the documented set |
| M-04 | `hooks/hooks.json` | every command entry supplies **both** `bash` and `powershell` |
| M-05 | `hooks/hooks.json` | every `timeoutSec` is within the performance budget |
| M-06 | `skills/*/SKILL.md` | frontmatter has `name` + `description`; `name` matches the directory; lowercase-hyphen |
| M-07 | `skills/*/SKILL.md` | **no name collides with a native feature** (`plan`, `autopilot`, `orchestrate`, `fleet`, `research`, `explore`, `task`) — enforces design principle 2 |
| M-08 | `agents/*.agent.md` | frontmatter has `name` + `description`; `model`, if present, is a known model id |
| M-09 | `.github/plugin/marketplace.json` | validates; every `source` path exists |
| M-10 | `LICENSE-THIRD-PARTY.md` | contains the full MIT text and copyright line for each upstream |
| M-11 | `docs/ATTRIBUTION.md` | every file derived from an upstream is listed with a commit SHA |
| M-12 | repo | no `allowed-tools: shell` pre-approval in any `SKILL.md` without an explicit review note |

---

## L5 — Integration: real CLI

Slow, run pre-release. Executed in a scratch git repo, never the user's workspace.

| ID | Scenario | Pass criteria |
| --- | --- | --- |
| I-01 | `copilot plugin install ./` | exits 0; `copilot plugin list` shows `ohmyghcp` |
| I-02 | Component discovery | skills and agents appear in the session |
| I-03 | **Happy path** — 2 trivial phases whose evidence the agent can create | phases advance in order; `status:"complete"`; artifacts exist |
| I-04 | **Unsatisfiable flow** — evidence can never be produced | run terminates via self-limit or the 8-guard; **never hangs**; `status:"failed"` |
| I-05 | **Non-interference** — no `flow.json` present | a normal session completes with no behavioural change (regression guard for principle 3) |
| I-06 | **Resume** — interrupt mid-flow, restart | resumes at the persisted phase, not from the start |
| I-07 | **Compaction survival** — force a long context, trigger compaction mid-flow | phase state intact after compaction (validates the no-`postCompact` mitigation) |
| I-08 | Uninstall | `copilot plugin uninstall` leaves no hooks firing |

---

## L6 — Resilience & security

| ID | Given | Expect |
| --- | --- | --- |
| E-01 | `flow.json` locked / unreadable | `allow`, no crash |
| E-02 | truncated / partially-written JSON | `allow`, no crash |
| E-03 | `.omg/state/` directory missing | `allow` |
| E-04 | evidence path contains `../` traversal | rejected; treated as unsatisfied; never reads outside the repo |
| E-05 | evidence path is an absolute path outside the repo | rejected |
| E-06 | evidence path is a symlink pointing outside the repo | rejected |
| E-07 | `reason` field built from state containing shell metacharacters | emitted as JSON string, no shell interpolation |
| E-08 | state file contains a 10 MB `task` string | output stays within budget, truncated |
| E-09 | two gate processes race on the same state file | atomic write; file never left corrupt |
| E-10 | hook script invoked with no stdin | `allow`, no hang |

---

## L7 — Performance

`preToolUse` timeouts **fail open**, so a slow gate silently stops enforcing.

| ID | Assertion |
| --- | --- |
| PERF-01 | gate p95 latency < 200 ms cold start |
| PERF-02 | gate does no network I/O |
| PERF-03 | gate has zero third-party runtime dependencies |

---

## L8 — Extension / HUD

| ID | Assertion |
| --- | --- |
| X-01 | `extension.mjs` loads; `extensions_manage list` reports it running, not failed |
| X-02 | HUD renders current phase, attempts, and evidence status |
| X-03 | **Engine works identically with the extension removed** (validates "HUD is optional") |
| X-04 | Extension crash does not block or slow the agent turn |

---

## CI matrix

| Axis | Values |
| --- | --- |
| OS | `windows-latest`, `ubuntu-latest` |
| Layers on PR | L1, L2, L3, L4, L6, L7 |
| Layers on release | all, plus L0 re-characterization and L5 |

L0 is re-run on every Copilot CLI version bump — it is our early-warning system for upstream behaviour changes.

## Traceability

| Rule | Unit | Contract | Parity | Integration |
| --- | --- | --- | --- | --- |
| R1 | U-R1-01/02 | C-01..C-05 | PAR-01 | I-05 |
| R2 | U-R2-01..04 | C-04 | PAR-01 | I-03 |
| R3 | U-R3-01/02 | C-03 | PAR-01 | I-04 |
| R4 | U-R4-01..03 | C-04, C-11 | PAR-01/02 | I-03 |
| R5 | U-R5-01 | C-05 | PAR-01 | I-03 |
| R6 | U-R6-01..03 | — | PAR-01 | I-04 |
| R7 | U-R7-01..05 | C-01, C-08 | PAR-01 | — |
| R8 | U-R8-01..03 | — | PAR-01 | I-06 |
| P1–P3 | — | C-12 | PAR-01 | I-05 |
