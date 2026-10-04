'use strict';
// Offline self-test for the oh-my-ghcp hook shim (no model calls). Builds a test plugin from an OMC checkout with
// adapter/build-overlay.cjs (agents and subagents pinned to gpt-5-mini), replays Copilot CLI 1.0.91-shaped hook events
// through its hooks/hooks.json the way Copilot runs them (same-event hooks sequentially, each started in the plugin
// root, per-hook timeout) and checks shim outputs, OMC state and the omc wrapper.
// usage: node tests/selftest-shim.cjs [--omc <OMC checkout with runtime dependencies>]
//   default --omc: the checkout installed by scripts/install.*, ${COPILOT_HOME:-~/.copilot}/oh-my-ghcp/omc
const { spawnSync, execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const omcArg = process.argv.indexOf('--omc');
const omcDir = path.resolve(omcArg >= 0 && process.argv[omcArg + 1] ? process.argv[omcArg + 1]
  : path.join(process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot'), 'oh-my-ghcp', 'omc'));
const omcDeps = path.join(omcDir, 'node_modules', 'commander');
if (!fs.existsSync(omcDeps)) {
  console.error(`no OMC checkout with runtime dependencies at ${omcDir}; run scripts/install.* first or pass --omc <dir>`);
  process.exit(2);
}
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ghcp-selftest-'));
const plugin = path.join(base, 'plugin');
const built = spawnSync(process.execPath, [path.join(repo, 'adapter', 'build-overlay.cjs'), '--omc', omcDir, '--out', plugin,
  '--agent-model', 'gpt-5-mini', '--task-model', 'gpt-5-mini'], { encoding: 'utf8' });
if (built.status !== 0) {
  console.error(`test plugin build failed:\n${built.stdout}${built.stderr}`);
  fs.rmSync(base, { recursive: true, force: true });
  process.exit(1);
}
console.log(`test plugin: ${built.stdout.trim()}`);
const hooksOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'hooks', 'hooks.json'), 'utf8')).hooks;
const manifest = hooksOf(plugin);
const srcManifest = hooksOf(omcDir);
const shimCfgPath = path.join(plugin, 'ghcp-shim.json');
const proj = path.join(base, 'proj');
const cph = path.join(base, 'cph');
const logFile = path.join(base, 'shim.log');
fs.mkdirSync(proj);
fs.mkdirSync(cph);
execFileSync('git', ['init', '-q', proj]);
fs.writeFileSync(path.join(proj, 'README.md'), 'selftest\n');

const home = os.homedir();
// The real home must stay untouched: Claude Code's config dir (OMC must use CLAUDE_CONFIG_DIR under COPILOT_HOME) and
// OMC's own global dir (hook children get a fake home below). Must not change: whether ~/.claude exists, and existence +
// mtime of the probes below and of each top-level entry OMC wrote to its config dirs during the test. Other changes
// in ~/.claude, for example from a Claude Code session running at the same time (projects, sessions), are reported.
const HOME_PROBES = ['.omc', '.claude/.session-stats.json', '.claude/.omc', '.claude/hooks', '.claude/hud',
  '.claude/settings.json', '.claude/CLAUDE.md'];
const omcConfigDir = path.join(cph, 'oh-my-ghcp', 'claude');
const rawConfigDir = path.join(cph, 'raw-claude');
const mtimeOf = (p) => { try { return fs.statSync(path.join(home, p)).mtimeMs; } catch { return null; } };
const homeState = () => {
  const s = Object.fromEntries(HOME_PROBES.map((p) => [p, mtimeOf(p)]));
  s['.claude'] = fs.existsSync(path.join(home, '.claude')) ? 'exists' : null;
  let top = [];
  try { top = fs.readdirSync(path.join(home, '.claude')); } catch {}
  for (const n of top) s[`.claude/${n}`] = mtimeOf(`.claude/${n}`);
  return s;
};
const homeBefore = homeState();
const homeCheck = (name, now) => {
  const omcPaths = new Set(['.claude', ...HOME_PROBES]);
  for (const dir of [omcConfigDir, rawConfigDir]) if (fs.existsSync(dir)) for (const n of fs.readdirSync(dir)) omcPaths.add(`.claude/${n}`);
  const prev = (p) => homeBefore[p] ?? null;
  const cur = (p) => now[p] ?? null;
  const changed = [...new Set([...Object.keys(homeBefore), ...Object.keys(now), ...omcPaths])].filter((p) => prev(p) !== cur(p));
  const leaked = changed.filter((p) => omcPaths.has(p));
  check(name, leaked.length === 0, leaked.length
    ? `${leaked.map((p) => `${p}: ${prev(p)} -> ${cur(p)}`).join('; ')} (OMC on Claude Code writes these too; re-run when it is idle)`
    : `watched: ${[...omcPaths].join(', ')}`);
  const other = changed.filter((p) => !omcPaths.has(p));
  if (other.length) info('real ~/.claude changed outside OMC paths (another Claude Code session?), not counted', other.join(', '));
};
// OMC keeps global config and state in ~/.omc (OMC_HOME; XDG dirs on Linux), shared with OMC on Claude Code. Its
// detached session-end workers keep only allowlisted variables (HOME and USERPROFILE, not OMC_HOME or XDG_*), so a
// fake home is what keeps every OMC process of this test away from the real one.
const fakeHome = path.join(base, 'home');
fs.mkdirSync(fakeHome);
const env = { ...process.env, COPILOT_HOME: cph, GHCP_SHIM_LOG: logFile, CLAUDE_PLUGIN_ROOT: plugin, HOME: fakeHome, USERPROFILE: fakeHome };
for (const k of ['CLAUDE_CONFIG_DIR', 'OMC_HOME', 'OMC_STATE_DIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
  'GHCP_TASK_MODEL', 'OMC_SESSION_ID', 'OMC_ROUTING_FORCE_INHERIT', 'NODE_ENV', 'OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS',
  'COPILOT_AGENT_SESSION_ID', 'CLAUDE_SESSION_ID']) delete env[k];
// OMC session-end workers outlive the hook; their command line carries the job payload, which names the project.
function liveWorkers() {
  const tag = path.basename(base);
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true })
      : execFileSync('ps', ['-A', '-o', 'args='], { encoding: 'utf8' });
    return out.split(/\r?\n/).filter((l) => l.includes(tag) && l.includes('session-end')).length;
  } catch {
    return -1;
  }
}

const MAIN = 'aaaaaaaa-0000-4000-8000-00000000000a';
const SUB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const RAW = 'cccccccc-0000-4000-8000-00000000000c';
const ALT = 'dddddddd-0000-4000-8000-00000000000d';
const HOST_NOTE = 'runs inside GitHub Copilot CLI, not Claude Code';
// run.cjs gives SessionEnd a 300ms foreground budget and the OMC worker waits a 30s producer grace before it
// clears mode state; widen the first and shorten the second (both honored only under NODE_ENV=test). The budget is
// wide (under the manifest's 30s) because these checks test what OMC does, not how fast: on a busy Windows machine
// session-end.mjs can take over 5s and run.cjs then ends it before it publishes its cleanup job.
const FAST_SESSION_END = { NODE_ENV: 'test', OMC_SESSION_END_TEST_FOREGROUND_TIMEOUT_MS: '20000', OMC_SESSION_END_TEST_PRODUCER_GRACE_MS: '500' };

const results = [];
const check = (name, ok, detail) => {
  results.push(!!ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? '\n      ' + String(detail).replace(/\n/g, ' | ').slice(0, 300) : ''}`);
};
const section = (s) => console.log(`\n== ${s}`);
const info = (name, detail) => console.log(`INFO ${name}${detail ? '\n      ' + detail : ''}`);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const stateFile = (sid, name) => path.join(proj, '.omc', 'state', 'sessions', sid, name);
const ghcpState = (kind, id) => readJson(path.join(cph, 'oh-my-ghcp', 'state', kind, `${id}.json`));
const promptKey = (s) => crypto.createHash('sha1').update(s.replace(/\s+/g, ' ').trim().slice(0, 400)).digest('hex');
const count = (s, sub) => s.split(sub).length - 1;
const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeoutMs) return { ok: false, ms: Date.now() - t0 };
    sleep(250);
  }
  return { ok: true, ms: Date.now() - t0 };
}

function hookList(event, toolName) {
  const list = [];
  for (const g of manifest[event] || []) {
    const m = g.matcher;
    if (m && m !== '*' && !(toolName && new RegExp(`^(?:${m})$`).test(toolName))) continue;
    list.push(...g.hooks);
  }
  return list;
}
function shimArgs(command) {
  const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/ghcp-shim\.cjs" (.+)$/.exec(command);
  if (!m) throw new Error(`unexpected hook command: ${command}`);
  return [path.join(plugin, 'ghcp-shim.cjs'), ...m[1].trim().split(/\s+/)];
}
const hookLabel = (args) => (args.includes('--host-note') ? 'host-note' : args.slice(3).map((a) => path.basename(a)).join(' '));
const timings = {};

// One Copilot hook event: every matching hook gets the same payload, sequentially, started in the plugin root.
function fire(event, payload = {}, { sid = MAIN, envExtra = {}, eventName = event } = {}) {
  const input = JSON.stringify({ session_id: sid, timestamp: Date.now(), cwd: proj, hook_event_name: eventName, ...payload });
  const logStart = readLog().length;
  const runs = [];
  for (const h of hookList(event, payload.tool_name)) {
    const args = shimArgs(h.command);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, args, {
      cwd: plugin, env: { ...env, ...envExtra }, input, encoding: 'utf8', timeout: h.timeout * 1000, windowsHide: true,
    });
    const ms = Date.now() - t0;
    let out = null;
    try { out = JSON.parse((r.stdout || '').trim() || 'null'); } catch {}
    const label = hookLabel(args);
    runs.push({ hook: label, code: r.status, out, ms, timedOut: !!(r.error && r.error.code === 'ETIMEDOUT') });
    (timings[`${event} ${label}`] ||= []).push(ms);
  }
  const outs = runs.map((x) => x.out).filter((o) => o && typeof o === 'object');
  const hsos = outs.map((o) => o.hookSpecificOutput).filter((h) => h && typeof h === 'object');
  // What the model receives on Copilot CLI 1.0.91 (measured, see docs/DESIGN.md): UserPromptSubmit keeps only the
  // last hook's additionalContext; SessionStart, PreToolUse and PostToolUse join them with a blank line.
  const ctxs = outs.map((o) => o.additionalContext).filter((s) => typeof s === 'string' && s.trim());
  return {
    runs,
    log: readLog().slice(logStart),
    context: outs.map((o) => o.additionalContext).filter((s) => typeof s === 'string').join('\n'),
    seen: event === 'UserPromptSubmit' ? ctxs[ctxs.length - 1] || '' : ctxs.join('\n\n'),
    deny: hsos.find((h) => h.permissionDecision === 'deny'),
    updated: hsos.map((h) => h.updatedInput).filter(Boolean),
    block: outs.find((o) => o.decision === 'block'),
    timedOut: runs.filter((x) => x.timedOut).map((x) => x.hook),
    nestedContext: hsos.some((h) => typeof h.additionalContext === 'string'),
  };
}

// Claude Code-style direct run of an unmodified OMC hook (A/B baseline): project cwd, no shim.
function rawOmc(script, payload, sid, envExtra = {}) {
  const input = JSON.stringify({ session_id: sid, cwd: proj, ...payload });
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(plugin, 'scripts', 'run.cjs'), path.join(plugin, 'scripts', script)], {
    cwd: proj, env: { ...env, CLAUDE_CONFIG_DIR: rawConfigDir, ...envExtra }, input, encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  const ms = Date.now() - t0;
  let out = null;
  try { out = JSON.parse((r.stdout || '').trim() || 'null'); } catch {}
  const hso = (out && out.hookSpecificOutput) || {};
  return { code: r.status, ms, stderr: (r.stderr || '').trim(), out, deny: hso.permissionDecision === 'deny' ? hso : null };
}

let origShimCfg = null;
try {
  section('overlay manifest');
  const all = Object.entries(manifest).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => ({ ev, ...h }))));
  check('setup hooks (SessionStart init/maintenance matchers) dropped', !all.some((h) => /setup-(init|maintenance)/.test(h.command)));
  check('every hook goes through the shim with --event matching its event',
    all.every((h) => `${h.command} `.startsWith(`node "\${CLAUDE_PLUGIN_ROOT}/ghcp-shim.cjs" --event ${h.ev} `)));
  const first = (ev) => manifest[ev][0].hooks[0].command;
  check('host-note hooks run first (the UPS one also synthesizes SubagentStart)',
    first('UserPromptSubmit').endsWith('--host-note --subagent-start ./scripts/subagent-tracker.mjs start') && first('SessionStart').endsWith('--host-note'));
  const srcTimeout = {};
  for (const [ev, gs] of Object.entries(srcManifest)) for (const g of gs) for (const h of g.hooks) {
    const m = /scripts\/([\w-]+\.mjs)"?((?:\s+[\w-]+)*)\s*$/.exec(h.command);
    if (m) srcTimeout[`${ev} ${m[1]}${m[2]}`] = h.timeout;
  }
  const badTimeouts = all.filter((h) => !h.command.includes('--host-note')).filter((h) => {
    const m = /scripts\/([\w-]+\.mjs)((?:\s+[\w-]+)*)\s*$/.exec(h.command);
    const src = m && srcTimeout[`${h.ev} ${m[1]}${m[2]}`];
    return !src || h.timeout !== Math.max(10, Math.ceil(src * 3));
  });
  check('timeouts = max(10, 3x OMC) for Windows spawn overhead', badTimeouts.length === 0, badTimeouts.map((h) => h.command.slice(-40)).join('; '));
  // Copilot starts plugin MCP servers in the plugin root; OMC anchors MCP state on the server cwd (~/.omc if non-git).
  const mcpServers = Object.entries((readJson(path.join(plugin, '.mcp.json')) || {}).mcpServers || {});
  check('MCP servers start in the project (cwd ".")', mcpServers.length > 0 && mcpServers.every(([, s]) => s.cwd === '.'),
    mcpServers.map(([n, s]) => `${n}:${s.cwd}`).join(', '));
  origShimCfg = fs.readFileSync(shimCfgPath, 'utf8');
  check('ghcp-shim.json pins the subagent model', JSON.parse(origShimCfg).taskModel === 'gpt-5-mini', origShimCfg.trim());
  const agentModels = fs.readdirSync(path.join(plugin, 'agents')).filter((f) => f.endsWith('.md')).map((f) => {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(fs.readFileSync(path.join(plugin, 'agents', f), 'utf8'));
    return fm && (/^model:\s*(\S+)/m.exec(fm[1]) || [])[1];
  }).filter(Boolean);
  check('agent definitions name the Copilot model', agentModels.length > 0 && agentModels.every((m) => m === 'gpt-5-mini'),
    `${agentModels.length} agents: ${[...new Set(agentModels)].join(',')}`);
  // OMC docs name Claude Code tools (ToolSearch, mcp__plugin_<plugin>_<server>__<tool>); Copilot: tool_search_tool, <server>-<tool>.
  const docs = ['skills', 'agents', 'commands'].flatMap((d) => fs.readdirSync(path.join(plugin, d), { recursive: true }).map(String)
    .filter((f) => f.endsWith('.md')).map((f) => path.join(plugin, d, f)));
  const claudeNamed = docs.filter((p) => /mcp__plugin_|\bToolSearch\b/.test(fs.readFileSync(p, 'utf8')));
  check('overlay docs use Copilot tool names (no mcp__plugin_*, no ToolSearch)', docs.length > 0 && claudeNamed.length === 0,
    `${docs.length} docs; Claude-named: ${claudeNamed.map((p) => path.relative(plugin, p)).join(', ')}`);
  const cancelDoc = fs.readFileSync(path.join(plugin, 'skills', 'cancel', 'SKILL.md'), 'utf8');
  check('cancel skill loads its state tools by Copilot name',
    cancelDoc.includes('tool_search_tool(pattern="^(t-state_clear|t-state_read|t-state_write|t-state_list_active|t-state_get_status)$")'),
    (cancelDoc.match(/[^\n]*tool_search_tool[^\n]*/g) || []).join(' | '));
  check('cancel skill makes tool_search_tool conditional (Copilot lists non-deferred tools directly)',
    cancelDoc.includes('`tool_search_tool` (only if they are missing from your tool list'),
    (cancelDoc.match(/[^\n]*`tool_search_tool`[^\n]*/g) || []).join(' | '));

  section('main session start (-p order: UserPromptSubmit before SessionStart)');
  // Installed layout: the omc wrapper next to the plugin (<root>/bin), which the host note names.
  const binCmd = path.join(base, 'bin', process.platform === 'win32' ? 'omc.cmd' : 'omc');
  fs.mkdirSync(path.dirname(binCmd));
  fs.copyFileSync(path.join(repo, 'adapter', path.basename(binCmd)), binCmd);
  const PROMPT = 'ralph: make the failing test in this repo pass (check with: node test.js).';
  let r = fire('UserPromptSubmit', { prompt: PROMPT });
  check('UPS: host note once, with the real session id', count(r.seen, HOST_NOTE) === 1 && r.seen.includes(`Current OMC session id: ${MAIN}.`));
  const noteLines = ['state_clear -> t-state_clear', 'ToolSearch -> tool_search_tool', 'there is no omc cancel command', '/goal does not exist here',
    'OMC_SESSION_ID is not set in shells here'];
  check('UPS: host note maps MCP/ToolSearch names, the cancel path, the missing /goal and OMC_SESSION_ID',
    noteLines.every((s) => r.seen.includes(s)), noteLines.filter((s) => !r.seen.includes(s)).join('; '));
  const omcLine = (s) => (s.match(/[^\n]*omc \(OMC's CLI[^\n]*/) || [''])[0];
  check('UPS: host note names omc as a shell command, by absolute path while its bin is not first on PATH',
    omcLine(r.seen).includes('is a shell command, not a tool') && omcLine(r.seen).includes(binCmd), omcLine(r.seen) || '(no omc line)');
  check('UPS: [MAGIC KEYWORD: RALPH] at top level, invocation rewritten to the skill tool',
    r.seen.includes('[MAGIC KEYWORD: RALPH]') && r.seen.includes('call the skill tool with skill "ralph"'), (r.seen.match(/Preferred invocation:[^\n]*/) || [''])[0]);
  const upsTurns = new Set(r.log.map((x) => x.turn));
  check('UPS: one turn key for all hooks; keyword-detector carries the host note forward (Copilot keeps only the last context)',
    upsTurns.size === 1 && !upsTurns.has(undefined) && r.log.some((x) => /keyword-detector/.test(x.hook) && x.carried === 1),
    r.log.map((x) => `${x.hook.split(' ')[0]}:${x.turn}:${x.carried || 0}`).join(', '));
  // The host note itself names "/oh-my-claudecode:<name>" in its translation table; OMC hook output must not.
  // Later hooks carry the host note forward (Copilot keeps only the last context), so strip it before checking.
  const noteRun = r.runs.find((x) => x.hook === 'host-note' && x.out && typeof x.out.additionalContext === 'string');
  const noteCtx = noteRun ? noteRun.out.additionalContext : '';
  const omcContext = r.runs.filter((x) => x.hook !== 'host-note' && x.out && typeof x.out.additionalContext === 'string')
    .map((x) => (noteCtx ? x.out.additionalContext.split(noteCtx).join('') : x.out.additionalContext)).join('\n');
  check('UPS: OMC output has no Claude slash command, no nested additionalContext', !omcContext.includes('/oh-my-claudecode:') && !r.nestedContext,
    [...(omcContext.match(/[^\n]*\/oh-my-claudecode:[^\n]*/g) || []).map((s) => `slash: ${s.slice(0, 160)}`),
      ...r.runs.filter((x) => x.out && x.out.hookSpecificOutput && typeof x.out.hookSpecificOutput.additionalContext === 'string')
        .map((x) => `nested: ${x.hook} ${JSON.stringify(x.out).slice(0, 200)}`)].join(' | '));
  check('UPS: no hook timed out', r.timedOut.length === 0, r.timedOut.join(','));
  let rs = readJson(stateFile(MAIN, 'ralph-state.json'));
  check('UPS: ralph-state in the project .omc, awaiting confirmation', rs && rs.active === true && rs.awaiting_confirmation === true);
  r = fire('SessionStart', { source: 'new' });
  check('SessionStart after UPS: no second host note, no timeout', count(r.seen, HOST_NOTE) === 0 && r.timedOut.length === 0,
    `hooks=${r.runs.length} timedOut=${r.timedOut.join(',')}`);
  rs = readJson(stateFile(MAIN, 'ralph-state.json'));
  check('SessionStart: ralph-state survives', rs && rs.active === true);

  section('skill tool (Copilot: tool "skill", bare name)');
  r = fire('PreToolUse', { tool_name: 'skill', tool_input: { skill: 'ralph' } });
  rs = readJson(stateFile(MAIN, 'ralph-state.json'));
  check('skill "ralph" reaches OMC as Skill(oh-my-claudecode:ralph): confirmation cleared', rs && rs.active === true && !rs.awaiting_confirmation);
  check('shim log: skill mapping recorded', r.log.some((x) => x.tool === 'skill:ralph'));

  section('permission request (Copilot sends an empty hook_event_name)');
  r = fire('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git status' } }, { eventName: '' });
  const dec = r.runs[0] && r.runs[0].out && r.runs[0].out.hookSpecificOutput;
  check('event name filled; OMC allows a safe command', r.log.length === 1 && r.log[0].event === 'PermissionRequest' &&
    dec && dec.decision && dec.decision.behavior === 'allow', JSON.stringify(dec));

  section('task tool: subagent model policy');
  const P1 = 'ultrawork: inspect test.js and report the root cause of the failing assertion.';
  const T1 = { description: 'Find root cause', prompt: P1, agent_type: 'oh-my-claudecode:architect', name: 'architect', model: 'claude-opus-5', mode: 'sync' };
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: T1 });
  let u = r.updated[0] || {};
  check('claude-opus-5 -> gpt-5-mini through one updatedInput, no deny', r.updated.length === 1 && u.model === 'gpt-5-mini' && !r.deny, JSON.stringify(u).slice(0, 200));
  check('updatedInput keeps the Copilot fields, no subagent_type leak',
    ['description', 'prompt', 'agent_type', 'name', 'mode'].every((k) => u[k] === T1[k]) && !('subagent_type' in u) && Object.keys(u).length === 6, Object.keys(u).join(','));
  check('OMC spawn advisory still emitted (top-level context)', r.context.includes('Spawning agent: oh-my-claudecode:architect'),
    (r.context.match(/Spawning agent:[^\n]*/) || ['(none)'])[0]);
  const sp = ghcpState('spawn', promptKey(P1));
  check('spawn recorded for subagent linking (parent, agent_type, final model)',
    sp && sp.parent === MAIN && sp.agent_type === 'oh-my-claudecode:architect' && sp.model === 'gpt-5-mini', JSON.stringify(sp));
  check('shim log: model claude-opus-5->gpt-5-mini', r.log.some((x) => x.model === 'claude-opus-5->gpt-5-mini'));
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Explore', prompt: 'List the files in src.', agent_type: 'oh-my-claudecode:explore', name: 'explore', mode: 'sync' } });
  check('no model argument -> pinned model added', r.updated.length === 1 && r.updated[0].model === 'gpt-5-mini' && !r.deny,
    JSON.stringify(r.updated[0] || r.deny || {}).slice(0, 200));
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Summarize', prompt: 'Summarize README.md in one line.', agent_type: 'oh-my-claudecode:executor', name: 'executor', model: 'gpt-5-mini', mode: 'sync' } });
  check('already the pinned model -> input untouched', r.updated.length === 0 && !r.deny, JSON.stringify(r.updated[0] || r.deny || {}).slice(0, 200));
  const T3 = { description: 'Run ralph', prompt: 'Run the ralph loop for the failing test.', agent_type: 'oh-my-claudecode:ralph', name: 'ralph', mode: 'sync' };
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: T3 });
  const why = (r.deny && r.deny.permissionDecisionReason) || '';
  check('OMC deny passes through (skill passed as agent_type)', r.deny && /SKILL vs AGENT/.test(why) && r.updated.length === 0, why.slice(0, 200));
  check('deny reason names the Copilot skill call, not Claude Skill(...)/Agent(...)',
    why.includes('call the skill tool with skill "ralph"') && why.includes('the task tool (agent_type=...)') && !/\b(?:Skill|Agent)\(/.test(why), why.slice(0, 400));
  let ab = rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { ...T3, subagent_type: T3.agent_type } }, RAW);
  check('A/B raw OMC (Claude input): deny reason uses Claude syntax Skill(skill="oh-my-claudecode:ralph")',
    ab.deny && (ab.deny.permissionDecisionReason || '').includes('Skill(skill="oh-my-claudecode:ralph")'), JSON.stringify(ab.out).slice(0, 200));
  ab = rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: T3 }, RAW);
  check('A/B raw OMC with Copilot input (agent_type only): guard blind, no deny', !ab.deny, JSON.stringify(ab.out).slice(0, 160));
  const FI = { OMC_ROUTING_FORCE_INHERIT: 'true' };
  const T4 = { ...T1, prompt: 'Review src/sum.js for edge cases.' };
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: T4 }, { envExtra: FI });
  check('forceInherit: not denied, still pinned (OMC never sees the Copilot model)', !r.deny && r.updated.length === 1 && r.updated[0].model === 'gpt-5-mini',
    ((r.deny && r.deny.permissionDecisionReason) || JSON.stringify(r.updated[0] || {})).slice(0, 200));
  ab = rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { ...T4, subagent_type: T4.agent_type, model: 'gpt-5-mini' } }, RAW, FI);
  check('A/B raw OMC + forceInherit + a Copilot model id: denied [MODEL ROUTING]', ab.deny && /MODEL ROUTING/.test(ab.deny.permissionDecisionReason || ''),
    ((ab.deny && ab.deny.permissionDecisionReason) || JSON.stringify(ab.out)).slice(0, 200));
  const OFF = { GHCP_TASK_MODEL: 'off' };
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: { ...T1, prompt: 'Tier hint test.', model: 'opus' } }, { envExtra: OFF });
  check('GHCP_TASK_MODEL=off: bare tier "opus" dropped', r.updated.length === 1 && !('model' in r.updated[0]) && !r.deny, JSON.stringify(r.updated[0] || {}).slice(0, 200));
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: { ...T1, prompt: 'Explicit model test.', model: 'gpt-4.1' } }, { envExtra: OFF });
  check('GHCP_TASK_MODEL=off: explicit Copilot model kept', r.updated.length === 0 && !r.deny, JSON.stringify(r.updated[0] || {}).slice(0, 200));
  fs.writeFileSync(shimCfgPath, JSON.stringify({ taskModelMap: { opus: 'claude-sonnet-5', sonnet: 'gpt-5-mini', haiku: 'gpt-4.1' } }));
  r = fire('PreToolUse', { tool_name: 'Agent', tool_input: { ...T1, prompt: 'Map test opus.' } });
  const r2 = fire('PreToolUse', { tool_name: 'Agent', tool_input: { ...T1, prompt: 'Map test haiku.', model: 'claude-haiku-4.5' } });
  fs.writeFileSync(shimCfgPath, origShimCfg);
  check('taskModelMap: claude-opus-5 -> claude-sonnet-5, claude-haiku-4.5 -> gpt-4.1',
    (r.updated[0] || {}).model === 'claude-sonnet-5' && (r2.updated[0] || {}).model === 'gpt-4.1', `${(r.updated[0] || {}).model} ${(r2.updated[0] || {}).model}`);

  section('subagent lifecycle (Copilot: own session id, fires UPS/Stop, never SubagentStart)');
  r = fire('UserPromptSubmit', { prompt: P1 }, { sid: SUB });
  const alias = ghcpState('alias', SUB);
  check('subagent linked to its parent through the spawn prompt', alias && alias.parent === MAIN && alias.agent_type === 'oh-my-claudecode:architect', JSON.stringify(alias));
  check('subagent note names the parent session; no main host note', r.seen.includes(`You are a subagent of OMC session ${MAIN}`) && count(r.seen, HOST_NOTE) === 0);
  check('synthesized SubagentStart reached the OMC tracker (context goes to the subagent)', r.seen.includes(`Agent oh-my-claudecode:architect started (${SUB})`), r.seen.slice(-160));
  check('OMC UPS hooks skipped for the subagent (no keyword activation)',
    r.log.filter((x) => x.skip === 'subagent-UserPromptSubmit').length === 2 && !r.seen.includes('[MAGIC KEYWORD'));
  let tr = readJson(stateFile(MAIN, 'subagent-tracking-state.json'));
  let ag = tr && (tr.agents || []).find((a) => a.agent_id === SUB);
  check('tracker (parent session): subagent running with the pinned model',
    ag && ag.status === 'running' && ag.agent_type === 'oh-my-claudecode:architect' && ag.model === 'gpt-5-mini', JSON.stringify(ag));
  r = fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'node test.js', description: 'run tests' } }, { sid: SUB });
  check('subagent PreToolUse reported under the parent session', r.log.length === 2 && r.log.every((x) => x.parent === MAIN && !x.skip) && !r.deny);
  r = fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node test.js', description: 'run tests' }, tool_response: 'FAIL sum' }, { sid: SUB });
  check('subagent PostToolUse reported under the parent session', r.log.length === 4 && r.log.every((x) => x.parent === MAIN && !x.skip));
  r = fire('Stop', { stop_hook_active: false, transcript_path: path.join(base, 'sub.jsonl') }, { sid: SUB });
  check('subagent Stop: every OMC Stop hook skipped, no block', r.log.length === 5 && r.log.every((x) => x.skip === 'subagent-Stop') && !r.block);
  r = fire('SubagentStop', { agent_id: SUB, agent_type: 'oh-my-claudecode:architect', agent_name: 'architect', stop_hook_active: false,
    last_assistant_message: 'Root cause: sum() skips the last element.', transcript_path: path.join(base, 'main.jsonl') });
  tr = readJson(stateFile(MAIN, 'subagent-tracking-state.json'));
  ag = tr && (tr.agents || []).find((a) => a.agent_id === SUB);
  check('SubagentStop: tracker marks the subagent completed', ag && ag.status === 'completed', JSON.stringify(ag && { status: ag.status }));
  check('no OMC state under the subagent session id; no ultrawork activation',
    !fs.existsSync(path.join(proj, '.omc', 'state', 'sessions', SUB)) && !fs.existsSync(stateFile(MAIN, 'ultrawork-state.json')));

  section(`omc wrapper (OMC_SESSION_ID mapping, adapter/${process.platform === 'win32' ? 'omc.cmd' : 'omc'})`);
  // Installed layout: <root>/bin/omc[.cmd] runs <root>/plugin/bin/oh-my-claudecode.js (a stub here).
  const wdir = path.join(base, 'wrap');
  const win = process.platform === 'win32';
  const wrapper = path.join(wdir, 'bin', win ? 'omc.cmd' : 'omc');
  fs.mkdirSync(path.join(wdir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(wdir, 'plugin', 'bin'), { recursive: true });
  fs.copyFileSync(path.join(repo, 'adapter', path.basename(wrapper)), wrapper);
  if (!win) fs.chmodSync(wrapper, 0o755);
  fs.writeFileSync(path.join(wdir, 'plugin', 'bin', 'oh-my-claudecode.js'),
    'process.stdout.write(JSON.stringify({ sid: process.env.OMC_SESSION_ID || "", cfg: process.env.CLAUDE_CONFIG_DIR || "", args: process.argv.slice(2) }))');
  const omc = (extra) => {
    const opts = { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true };
    const w = win ? spawnSync(`"${wrapper}" state list`, { ...opts, shell: true }) : spawnSync(wrapper, ['state', 'list'], opts);
    try { return JSON.parse(w.stdout.trim()); } catch { return { raw: `${w.stdout || ''}${w.stderr || ''}` }; }
  };
  let w = omc({ COPILOT_AGENT_SESSION_ID: MAIN });
  check('main shell: OMC_SESSION_ID = Copilot session id, config under COPILOT_HOME, args passed', w.sid === MAIN &&
    String(w.cfg).toLowerCase() === path.join(cph, 'oh-my-ghcp', 'claude').toLowerCase() && JSON.stringify(w.args) === '["state","list"]', JSON.stringify(w));
  w = omc({ COPILOT_AGENT_SESSION_ID: SUB });
  check('subagent-linked id: not mapped', w.sid === '', JSON.stringify(w));
  w = omc({ COPILOT_AGENT_SESSION_ID: 'eeeeeeee-0000-4000-8000-00000000000e' });
  check('unknown id (a subagent shell carries a third id): not mapped', w.sid === '', JSON.stringify(w));
  w = omc({ COPILOT_AGENT_SESSION_ID: MAIN, OMC_SESSION_ID: 'explicit-id' });
  check('explicit OMC_SESSION_ID wins', w.sid === 'explicit-id', JSON.stringify(w));
  // copilot-omc puts <root>/bin first on PATH, so the host note can say plain "omc".
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const launched = spawnSync(process.execPath, [path.join(plugin, 'ghcp-shim.cjs'), '--event', 'SessionStart', '--host-note'], {
    cwd: plugin, env: { ...env, [pathKey]: `${path.dirname(binCmd)}${path.delimiter}${env[pathKey] || ''}` }, encoding: 'utf8', windowsHide: true,
    input: JSON.stringify({ session_id: 'dddddddd-0000-4000-8000-00000000000d', timestamp: Date.now(), cwd: proj, hook_event_name: 'SessionStart', source: 'startup' }),
  });
  let launchedNote = '';
  try { launchedNote = JSON.parse(launched.stdout.trim()).additionalContext || ''; } catch {}
  check('host note with the bin first on PATH (copilot-omc): plain omc, no path',
    omcLine(launchedNote).endsWith('run it with your shell tool.') && !launchedNote.includes(binCmd), omcLine(launchedNote) || `${launched.stdout}${launched.stderr}`.slice(0, 200));

  section('ultragoal /goal guard (Copilot has no Claude Code /goal)');
  const GOAL = 'ffffffff-0000-4000-8000-00000000000f';
  const ugPath = stateFile(GOAL, 'ultragoal-state.json');
  fs.mkdirSync(path.dirname(ugPath), { recursive: true });
  fs.writeFileSync(ugPath, JSON.stringify({ active: true, session_id: GOAL, project_path: proj, started_at: new Date().toISOString() }));
  const STRICT = { ALLOW_ULTRAGOAL_WITHOUT_GOAL: '0' };
  const viewCall = { tool_name: 'view', tool_input: { path: path.join(proj, 'README.md') } };
  const searchCall = { tool_name: 'tool_search_tool', tool_input: { pattern: '^(t-state_clear)$' } };
  let g = rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', ...viewCall }, GOAL, STRICT);
  check('A/B raw OMC: active ultragoal denies every tool without a Claude /goal (gap reproduced)',
    g.deny && /ULTRAGOAL \/GOAL REQUIRED/.test(g.deny.permissionDecisionReason || ''), JSON.stringify(g.out).slice(0, 200));
  g = rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', ...searchCall }, GOAL, STRICT);
  check('A/B raw OMC: Copilot tool_search_tool is not a cancel bootstrap tool (denied)', !!g.deny, JSON.stringify(g.out).slice(0, 200));
  r = fire('PreToolUse', viewCall, { sid: GOAL });
  check('via shim: ultragoal guard bypassed (ALLOW_ULTRAGOAL_WITHOUT_GOAL=1), tool allowed', !r.deny, JSON.stringify(r.deny || ''));
  r = fire('PreToolUse', searchCall, { sid: GOAL, envExtra: STRICT });
  check('via shim, guard on: tool_search_tool reaches OMC as ToolSearch (allowed)', !r.deny, JSON.stringify(r.deny || ''));
  r = fire('PreToolUse', { tool_name: 't-state_clear', tool_input: { mode: 'ultragoal', session_id: GOAL } }, { sid: GOAL, envExtra: STRICT });
  check('via shim, guard on: t-state_clear allowed', !r.deny, JSON.stringify(r.deny || ''));
  r = fire('PreToolUse', viewCall, { sid: GOAL, envExtra: STRICT });
  check('via shim, guard explicitly on: plain tool still denied (bypass only by default)', r.deny && /ULTRAGOAL/.test(r.deny.permissionDecisionReason || ''));
  fs.rmSync(path.dirname(ugPath), { recursive: true, force: true });

  section('v2 carry-overs');
  rawOmc('pre-tool-enforcer.mjs', { hook_event_name: 'PreToolUse', tool_name: 'Skill', tool_input: { skill: 'plan' } }, RAW);
  check('A/B raw OMC, bare "plan": skill-active-state NOT written (gap reproduced)', !fs.existsSync(stateFile(RAW, 'skill-active-state.json')));
  fire('PreToolUse', { tool_name: 'skill', tool_input: { skill: 'plan' } }, { sid: ALT });
  const sas = readJson(stateFile(ALT, 'skill-active-state.json'));
  check('A/B via shim, skill "plan": skill-active-state written', sas && sas.active === true && sas.skill_name === 'plan');
  fire('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'node test.js' }, error: 'exit code 1' });
  check('PostToolUseFailure: error state lands in the project .omc', fs.existsSync(stateFile(MAIN, 'last-tool-error-state.json')));
  fire('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'node test.js', description: 'run tests' }, tool_response: 'ok' });

  section('Stop -> SessionEnd -> continuation prompt (Copilot -p order)');
  r = fire('Stop', { stop_hook_active: false, transcript_path: path.join(base, 'main.jsonl') });
  const reason = (r.block && r.block.reason) || '';
  check('Stop: ralph loop blocks; reason uses the skill tool, no slash command',
    reason.includes('RALPH LOOP') && reason.includes('"cancel" skill') && !reason.includes('/oh-my-claudecode:'), reason.slice(0, 200));
  const mark = ghcpState('stopblock', MAIN);
  check('stop-block marker records the reason', mark && !mark.resumed && (mark.reasons || []).includes(reason));
  r = fire('SessionEnd', { reason: 'complete' }, { envExtra: FAST_SESSION_END });
  const jobFile = (sid) => path.join(proj, '.omc', 'state', 'session-end-jobs', `${sid}.json`);
  // OMC session-end only publishes a cleanup job; a detached worker clears the mode state after the producer grace.
  const cleanupScheduled = (sid) => !!(((readJson(jobFile(sid)) || {}).actions || {})['foreground-cleanup']);
  // The worker's outcome is OMC's, not the shim's, so it is reported as INFO. FAST_SESSION_END widens OMC's 300ms
  // foreground budget, which session-end.mjs usually misses on Windows with shipped settings (see docs/DESIGN.md).
  const workerOutcome = (sid) => {
    const w = waitFor(() => !fs.existsSync(stateFile(sid, 'ralph-state.json')), 10000);
    const job = readJson(jobFile(sid)) || {};
    return w.ok ? `OMC worker cleared ralph-state after ${w.ms}ms`
      : `ralph-state still present after ${w.ms}ms; job owner=${job.owner ? 'claimed' : 'none'} ` +
        `foreground-cleanup=${((job.actions || {})['foreground-cleanup'] || {}).status}${job.owner ? '' : ' (OMC worker has not claimed the job)'}`;
  };
  check('SessionEnd right after the block: skipped, no OMC cleanup job, ralph-state kept',
    r.log.length === 2 && r.log.every((x) => x.skip === 'session-continues-after-stop-block') && !fs.existsSync(jobFile(MAIN)) &&
    !!readJson(stateFile(MAIN, 'ralph-state.json')));
  // A/B: the same SessionEnd reaching unmodified OMC schedules cleanup of the live ralph-state (the loop would die
  // 30s later wherever OMC's worker runs).
  const rawRalph = { ...readJson(stateFile(MAIN, 'ralph-state.json')) };
  if ('session_id' in rawRalph) rawRalph.session_id = RAW;
  fs.mkdirSync(path.dirname(stateFile(RAW, 'ralph-state.json')), { recursive: true });
  fs.writeFileSync(stateFile(RAW, 'ralph-state.json'), JSON.stringify(rawRalph, null, 2));
  const rawEnd = rawOmc('session-end.mjs', { hook_event_name: 'SessionEnd', reason: 'complete' }, RAW, FAST_SESSION_END);
  check('A/B raw OMC: that SessionEnd schedules cleanup of the live ralph-state (loop would die)', cleanupScheduled(RAW),
    `session-end.mjs exit ${rawEnd.code} after ${rawEnd.ms}ms${rawEnd.stderr ? `: ${rawEnd.stderr}` : ''}`);
  info('A/B raw OMC worker', workerOutcome(RAW));
  r = fire('UserPromptSubmit', { prompt: reason });
  check('continuation prompt: OMC UPS hooks skipped (Claude Code fires none), no second host note',
    r.log.filter((x) => x.skip === 'stop-block-continuation').length === 2 && count(r.seen, HOST_NOTE) === 0, r.log.map((x) => x.skip || x.hook).join(','));
  check('marker resumed, so the next SessionEnd is real', (ghcpState('stopblock', MAIN) || {}).resumed > 0);
  rs = readJson(stateFile(MAIN, 'ralph-state.json'));
  check('ralph still active in the loop', rs && rs.active === true);
  r = fire('Stop', { stop_hook_active: true, transcript_path: path.join(base, 'main.jsonl') });
  check('Stop with stop_hook_active=true: no block (OMC semantics)', !r.block);
  r = fire('SessionEnd', { reason: 'complete' }, { envExtra: FAST_SESSION_END });
  check('real SessionEnd runs and schedules OMC cleanup', r.log.length === 2 && r.log.every((x) => !x.skip) && cleanupScheduled(MAIN),
    r.log.map((x) => `${x.hook}:${x.skip || x.code}`).join(','));
  info('real SessionEnd OMC worker', workerOutcome(MAIN));
  r = fire('UserPromptSubmit', { prompt: 'thanks' });
  check('a genuine prompt clears the marker', !ghcpState('stopblock', MAIN) && r.log.every((x) => !x.skip));
  check('next turn carries nothing from earlier turns (no host note, no stale RALPH keyword)',
    count(r.seen, HOST_NOTE) === 0 && !r.seen.includes('[MAGIC KEYWORD: RALPH]') && r.log.every((x) => !x.carried),
    r.log.map((x) => `${x.hook.split(' ')[0]}:${x.carried || 0}`).join(', '));

  // Keep in sync with the keyword table in README.md. One fresh session per prompt; all UPS hooks run as on Copilot, and
  // r.seen is the context the model receives. Mode state: OMC's keyword detector activates it for these modes only.
  section('README keyword table (what the model receives)');
  const MODE_STATE = /^(ralph|autopilot|ralplan|ultragoal|ultrawork|deep-interview|team)-state\.json$/;
  const KEYWORD_ROWS = [
    { mode: 'ralph', state: true, prompts: ['ralph: 실패하는 테스트 고쳐줘', '랄프 실행: 실패하는 테스트 고쳐줘'] },
    { mode: 'autopilot', state: true, prompts: ['autopilot: 할 일 관리 CLI 만들어줘', '오토파일럿으로 할 일 관리 CLI 만들어줘'] },
    { mode: 'ralplan', state: true, prompts: ['ralplan: 인증 모듈 리팩터링 계획 세워줘', '랄플랜으로 인증 모듈 리팩터링 계획 세워줘'] },
    { mode: 'deep-interview', prompts: ['딥인터뷰로 요구사항부터 정리해줘', 'deep interview: build a todo CLI'] },
    { mode: 'ultragoal', state: true, prompts: ['use ultragoal to ship the release checklist', '$ultragoal ship the release checklist'] },
    { mode: 'helper modes', tags: ['<think-mode>', '<tdd-mode>', '<code-review-mode>', '<security-review-mode>', '<search-mode>'],
      prompts: ['ultrathink: test.js 실패 원인 찾아줘', 'tdd: sum 함수 고쳐줘', '코드 리뷰 해줘', 'security review 해줘', 'deepsearch: 인증 코드 위치 찾아줘'] },
    { mode: 'cancel', prompts: ['cancelomc', 'stopomc'] },
    { mode: 'no trigger', none: true, prompts: ['ralph가 뭐야?', '랄프: 실패하는 테스트 고쳐줘', '랄프로 실패하는 테스트 고쳐줘'] },
  ];
  let kwSeq = 0;
  for (const row of KEYWORD_ROWS) {
    const seenRow = row.prompts.map((prompt, i) => {
      const sid = `eeeeeeee-0000-4000-8000-${String(++kwSeq).padStart(12, '0')}`;
      const kr = fire('UserPromptSubmit', { prompt }, { sid });
      const sdir = path.dirname(stateFile(sid, 'x'));
      const states = fs.existsSync(sdir) ? fs.readdirSync(sdir).filter((f) => MODE_STATE.test(f)) : [];
      const got = [...new Set([...kr.seen.matchAll(/\[MAGIC KEYWORDS?(?: DETECTED)?: [^\]\n]+\]|<[a-z-]+-mode>/g)].map((m) => m[0]))];
      const want = row.none ? [] : [row.tags ? row.tags[i] : `[MAGIC KEYWORD: ${row.mode.toUpperCase()}]`];
      const ok = got.join() === want.join() && kr.timedOut.length === 0 &&
        states.join() === (row.state ? `${row.mode}-state.json` : '') &&
        (row.none || row.tags || kr.seen.includes(`call the skill tool with skill "${row.mode}"`));
      return { ok, text: `${prompt} -> ${got.join(' ') || 'nothing'}${states.length ? ` + ${states.join(' ')}` : ''}` };
    });
    check(`keyword ${row.mode}: ${row.none ? 'no mode starts' : row.state ? 'marker, skill-tool invocation, mode state'
      : row.tags ? 'mode instructions' : 'marker, skill-tool invocation, no mode state'}`, seenRow.every((x) => x.ok),
    seenRow.filter((x) => !x.ok).map((x) => `FAILED ${x.text}`).concat(seenRow.filter((x) => x.ok).map((x) => x.text)).join('; '));
  }

  section('isolation');
  const ran = readLog().filter((x) => !x.skip);
  check('every hook child ran in the project dir', ran.length > 0 && ran.every((x) => x.cwd === proj), JSON.stringify([...new Set(ran.map((x) => x.cwd))]));
  homeCheck('OMC paths in the real ~/.claude and ~/.omc unchanged', homeState());
  const cfgFiles = fs.existsSync(omcConfigDir) ? fs.readdirSync(omcConfigDir, { recursive: true }).map(String) : [];
  check('CLAUDE_CONFIG_DIR writes land under COPILOT_HOME', cfgFiles.includes('.session-stats.json'), cfgFiles.slice(0, 6).join(', ') || '(not created)');

  section('per-hook wall time, ms (node start included)');
  for (const [k, v] of Object.entries(timings)) console.log(`  ${k}: avg ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)} x${v.length}`);
} finally {
  if (origShimCfg !== null && fs.readFileSync(shimCfgPath, 'utf8') !== origShimCfg) fs.writeFileSync(shimCfgPath, origShimCfg);
  // Let detached OMC session-end workers finish before checking the homes and removing their project.
  if (liveWorkers() < 0) sleep(3000);
  else {
    const lw = waitFor(() => liveWorkers() === 0, 60000);
    info('OMC session-end workers', lw.ok ? `all exited ${lw.ms}ms after the last hook` : `still running after ${lw.ms}ms`);
  }
  homeCheck('OMC paths in the real ~/.claude and ~/.omc still unchanged after session-end workers', homeState());
  check('nothing written to the (fake) home ~/.claude by any OMC process', !fs.existsSync(path.join(fakeHome, '.claude')),
    fs.existsSync(path.join(fakeHome, '.claude')) ? fs.readdirSync(path.join(fakeHome, '.claude'), { recursive: true }).map(String).slice(0, 6).join(', ') : '');
  const fakeOmc = path.join(fakeHome, '.omc');
  info('OMC global dir (~/.omc) after the test', fs.existsSync(fakeOmc)
    ? fs.readdirSync(fakeOmc, { recursive: true }).map(String).join(', ') || '(empty dir)' : '(not created)');
  // The test plugin shares the checkout's node_modules through a link; unlink it so nothing deletes through it.
  let linkGone = true;
  try {
    if (fs.lstatSync(path.join(plugin, 'node_modules')).isSymbolicLink()) fs.unlinkSync(path.join(plugin, 'node_modules'));
  } catch (e) {
    if (e.code !== 'ENOENT') linkGone = false;
  }
  try {
    if (!linkGone) throw Object.assign(new Error('node_modules link not removed'), { code: 'LINK' });
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    console.log(`\nnote: temp dir not removed (${e.code}); an OMC session-end worker may still run in it: ${base}`);
  }
  check('OMC checkout dependencies intact after cleanup', fs.existsSync(omcDeps), omcDeps);
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exitCode = failed ? 1 : 0;
