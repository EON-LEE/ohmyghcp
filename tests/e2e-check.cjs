'use strict';
// Checks an oh-my-ghcp end-to-end run recorded by tests/e2e-ralph.ps1.
// usage: node tests/e2e-check.cjs <run dir>    exit code 0 when every check passes
const fs = require('fs');
const path = require('path');

const dir = path.resolve(process.argv[2] || '.');
const read = (f) => {
  const p = path.join(dir, f);
  if (!fs.existsSync(p)) return '';
  const b = fs.readFileSync(p);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le').slice(1); // Windows PowerShell 5.1 redirection
  return b.toString('utf8').replace(/^\uFEFF/, '');
};
const jsonl = (f) => read(f).split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
let run;
try { run = JSON.parse(read('run.json')); } catch { run = null; }
if (!run) {
  console.error(`no run.json in ${dir}`);
  process.exit(2);
}

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
};
const info = (name, detail) => console.log(`INFO ${name}: ${detail}`);

const out = jsonl('stdout.jsonl');
const ev = jsonl('transcript-events.jsonl');
const shim = jsonl('shim.log');
const result = out.find((e) => e.type === 'result');
const mainUps = shim.find((r) => r.event === 'UserPromptSubmit' && !r.parent);
const sid = (mainUps && mainUps.sid) || '';
// With -p the first user.message of the transcript is the prompt as the model received it, hook context included.
const first = ev.find((e) => e.type === 'user.message');
const seen = String((first && first.data && first.data.transformedContent) || '');
const starts = ev.filter((e) => e.type === 'tool.execution_start').map((e) => e.data || {});
const args = (d) => JSON.stringify(d.arguments || {});
const skillCalls = starts.filter((d) => d.toolName === 'skill').map(args);
const succeeded = new Map(ev.filter((e) => e.type === 'tool.execution_complete' && e.data).map((e) => [e.data.toolCallId, e.data.success === true]));
const skillLoads = starts.filter((d) => d.toolName === 'skill')
  .map((d) => ({ name: String((d.arguments || {}).skill || ''), ok: succeeded.get(d.toolCallId) === true }));
// subagent.started carries the model Copilot actually used; the task call's model argument is only what was requested.
const subagents = new Map(ev.filter((e) => e.type === 'subagent.started' && e.data).map((e) => [e.data.toolCallId, e.data]));
const pinnedModel = run.taskModel || run.model;

const ids = { real: 0, other: new Set() };
for (const d of starts) {
  const a = args(d);
  for (const m of [...a.matchAll(/--session[ =]+([\w-]{8,})/g), ...a.matchAll(/"session_id":"([\w-]{8,})"/g)]) {
    if (m[1] === sid) ids.real++;
    else ids.other.add(m[1]);
  }
}
const ralphStates = [];
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])
  .flatMap((x) => (x.isDirectory() ? walk(path.join(d, x.name)) : [path.join(d, x.name)]));
for (const f of walk(path.join(dir, 'sandbox-omc')).filter((f) => path.basename(f) === 'ralph-state.json')) {
  let st = null;
  try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  ralphStates.push({ file: path.relative(dir, f), active: !!(st && st.active), iteration: st && st.iteration });
}

console.log(`== oh-my-ghcp e2e: ${dir}`);
check('copilot exited with 0', run.exit === 0, `exit ${run.exit}`);
check('the fixture test passes after the run', run.testExit === 0, `node test.js exit ${run.testExit}`);
check('OMC hooks ran (shim log)', !!mainUps, `${shim.length} hook runs`);
check('host note reached the model', seen.includes('[oh-my-ghcp] oh-my-claudecode (OMC) runs inside GitHub Copilot CLI'));
check('host note carries the real session id', !!sid && seen.includes(`Current OMC session id: ${sid}.`), sid || 'no main session id');
check('ralph keyword detected by OMC', seen.includes('[MAGIC KEYWORD: RALPH]'));
check('ralph skill loaded by the skill tool', skillLoads.some((s) => s.ok && s.name === 'ralph'),
  skillLoads.map((s) => `${s.name}${s.ok ? '' : ' (failed)'}`).join(' ') || 'no skill calls');
check('OMC state calls used only the real session id', ids.other.size === 0,
  `${ids.real} real${ids.other.size ? `, other: ${[...ids.other].join(' ')}` : ''}`);
check(`subagents ran on the pinned model (GHCP_TASK_MODEL=${pinnedModel})`, [...subagents.values()].every((s) => s.model === pinnedModel),
  [...subagents.values()].map((s) => `${s.agentName || s.agentType || '?'}=${s.model}`).join(' ') || 'no subagent started');
check('no active ralph state left behind', ralphStates.every((s) => !s.active),
  ralphStates.map((s) => `${s.file} active=${s.active} iteration=${s.iteration}`).join('; ') || 'no ralph-state.json');
if (run.realClaudeUnchanged !== undefined) {
  check('real ~/.claude untouched (OMC config redirected to COPILOT_HOME)', run.realClaudeUnchanged === true, run.realClaudeDiff);
}

const usage = (result && result.usage) || {};
const nanoAiu = [...out, ...ev].map((e) => (e.data && e.data.totalNanoAiu) || e.totalNanoAiu).find((v) => typeof v === 'number');
info('model', run.model);
info('premium requests', usage.premiumRequests === undefined ? 'unknown (no result line)' : usage.premiumRequests);
info('AI credits', nanoAiu === undefined ? 'unknown (no totalNanoAiu)' : (nanoAiu / 1e9).toFixed(2));
info('wall time', `${run.wallSeconds}s`);
info('session id', `${sid}${run.sessionId && sid && run.sessionId !== sid ? ` (requested ${run.sessionId})` : ''}`);
info('tool calls', Object.entries(starts.reduce((a, d) => ((a[d.toolName] = (a[d.toolName] || 0) + 1), a), {}))
  .map(([k, v]) => `${k}=${v}`).join(' ') || 'none');
info('subagents', starts.filter((d) => d.toolName === 'task').map((d) => {
  const a = d.arguments || {};
  const s = subagents.get(d.toolCallId);
  return `${a.agent_type || '?'} requested=${a.model || 'default'} ${s ? `ran=${s.model}` : `not started${succeeded.get(d.toolCallId) === false ? ' (call denied or failed)' : ''}`}`;
}).join('; ') || 'none');
// Model-dependent behaviour the host note and deny-reason translation aim at; reported, not checked.
info('skill calls with the Claude plugin prefix (oh-my-claudecode:X, not found on Copilot)', skillCalls.filter((a) => a.includes('oh-my-claudecode:')).length);
const omcRuns = starts.filter((d) => ['powershell', 'bash', 'shell'].includes(d.toolName))
  .map((d) => String((d.arguments || {}).command || ''))
  .filter((c) => /(?:^|[\s;&|"'(\\/])omc(?:\.cmd)?["']?\s+[a-z-]+/i.test(c));
info('omc CLI runs (e.g. omc ralph verify)', omcRuns.length ? omcRuns.map((c) => c.replace(/\s+/g, ' ').slice(0, 90)).join(' | ') : 'none');
const cfgDir = path.join(dir, 'copilot-home', 'oh-my-ghcp', 'claude');
info('OMC CLAUDE_CONFIG_DIR', fs.existsSync(cfgDir) ? `${path.relative(dir, cfgDir)}: ${fs.readdirSync(cfgDir).join(' ') || '(empty)'}` : 'not created');
if (run.omcHome) info('~/.omc', run.omcHome);
if (run.sessionEndWorkers) info('OMC session-end workers', run.sessionEndWorkers);
const failed = results.filter((x) => !x).length;
console.log(failed ? `\n${failed} of ${results.length} checks FAILED` : `\nall ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
