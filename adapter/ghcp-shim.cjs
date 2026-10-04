#!/usr/bin/env node
'use strict';
// oh-my-ghcp hook shim (v3): runs an unmodified OMC hook under GitHub Copilot CLI.
//   node "${CLAUDE_PLUGIN_ROOT}/ghcp-shim.cjs" --event <Event> ./scripts/<hook>.mjs [args]
//   node "${CLAUDE_PLUGIN_ROOT}/ghcp-shim.cjs" --event <Event> --host-note [--subagent-start ./scripts/<hook>.mjs [args]]
// Bridges Claude Code hook-contract gaps observed on Copilot CLI 1.0.91:
//   - hooks start in the plugin root; Claude Code starts them in the project dir
//   - the skill tool is reported as "skill" with a bare skill name; OMC expects "Skill" + "oh-my-claudecode:<name>"
//   - the task tool input uses agent_type; OMC reads subagent_type
//   - only top-level additionalContext is injected; OMC emits hookSpecificOutput.additionalContext
//   - OMC guidance uses Claude slash commands (/oh-my-claudecode:<skill>) and Claude model tiers (opus/sonnet/haiku),
//     which the task tool's model argument turns into real (possibly premium) Copilot models
//   - OMC deny reasons name Claude calls (Skill(skill="oh-my-claudecode:<name>"), Agent(subagent_type=...)); Copilot
//     shows them verbatim and the model copies them into a failing skill call
//   - OMC writes Claude config under CLAUDE_CONFIG_DIR (default ~/.claude); keep it under the Copilot home
//   - PermissionRequest payloads carry no hook_event_name
//   - subagents get their own session_id, fire UserPromptSubmit/Stop and never SubagentStart; Claude Code reports
//     subagent tool hooks under the parent session_id and fires SubagentStart/SubagentStop instead
//   - with -p, SessionEnd fires right after a Stop hook blocks although the session continues
//   - a blocking Stop hook's reason comes back as a new user prompt and fires UserPromptSubmit; Claude Code continues
//     without UserPromptSubmit
//   - OMC names tools as Claude Code exposes them: ToolSearch and mcp__plugin_<plugin>_<server>__<tool>; Copilot calls
//     them tool_search_tool and <server>-<tool> (the overlay builder rewrites the skill docs, the host note does the rest)
//   - OMC's ultragoal PreToolUse guard denies every tool until it sees Claude Code's native /goal, which Copilot lacks
//   - for UserPromptSubmit Copilot keeps only the last hook's additionalContext (SessionStart, PreToolUse and
//     PostToolUse join them); Claude Code delivers every hook's context, so each shim carries the turn's earlier ones
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = __dirname;
const argv = process.argv.slice(2);
const opts = { event: '', note: false };
while (argv[0] === '--event' || argv[0] === '--host-note' || argv[0] === '--subagent-start') {
  const flag = argv.shift();
  if (flag === '--event') opts.event = argv.shift() || '';
  if (flag === '--host-note') opts.note = true;
  if (flag === '--subagent-start') break;
}
const [rel, ...extra] = argv;
if (!opts.note && !rel) process.exit(0);
const hookName = opts.note ? `host-note${rel ? '+' + path.basename(rel) : ''}` : path.basename(rel);
const TOOL_NAMES = { skill: 'Skill', tool_search_tool: 'ToolSearch' };
const SUBAGENT_SKIP = new Set(['UserPromptSubmit', 'Stop', 'SessionEnd']);
const SUBAGENT_REMAP = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const started = Date.now();
const copilotHome = process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
const stateDir = path.join(copilotHome, 'oh-my-ghcp', 'state');
const cfg = readJson(path.join(root, 'ghcp-shim.json')) || {};
const pluginName = (readJson(path.join(root, '.claude-plugin', 'plugin.json')) || {}).name || 'oh-my-claudecode';
const mcpServer = Object.keys((readJson(path.join(root, '.mcp.json')) || {}).mcpServers || {})[0] || 't';

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => main(Buffer.concat(chunks).toString('utf8')));
process.stdin.on('error', () => main(''));

let ran = false;
function main(rawIn) {
  if (ran) return;
  ran = true;
  let payload = null;
  try { payload = JSON.parse(rawIn); } catch {}
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = null;
  const ctx = { event: (payload && payload.hook_event_name) || opts.event, sid: '', parent: '', spawn: {}, cwd: root };
  if (payload) {
    if (!payload.hook_event_name && opts.event) payload.hook_event_name = opts.event;
    ctx.sid = typeof payload.session_id === 'string' ? payload.session_id : '';
    if (typeof payload.cwd === 'string' && isDir(payload.cwd)) ctx.cwd = payload.cwd;
    if (ctx.event === 'UserPromptSubmit') ctx.turn = turnKey(payload);
    trackSession(payload, ctx);
  }
  if (opts.note) return hostNoteMode(payload, ctx);
  const skip = skipReason(ctx);
  if (skip) return emit('', ctx, '', 0, skip);
  if (ctx.event === 'SubagentStart' && payload && safeId(payload.agent_id)) {
    writeState('substart', safeId(payload.agent_id), { t: Date.now() });
  }
  runHook(payload, rawIn, ctx, (out, raw, code) => emit(out, ctx, raw, code));
}

// Copilot gives each subagent its own session_id. Link it to the parent through the spawn prompt:
// the parent's task tool_input.prompt arrives verbatim as the subagent's first UserPromptSubmit.
function trackSession(p, ctx) {
  const sid = safeId(ctx.sid);
  if (!sid) return;
  const alias = readState('alias', sid);
  if (alias && alias.parent) {
    ctx.parent = alias.parent;
    ctx.spawn = alias;
  }
  if (ctx.event === 'UserPromptSubmit' && !ctx.parent && typeof p.prompt === 'string') {
    const spawned = readState('spawn', promptKey(p.prompt));
    if (spawned && spawned.parent && spawned.parent !== sid && Date.now() - spawned.t < 30 * 60e3) {
      ctx.parent = spawned.parent;
      ctx.spawn = spawned;
      writeState('alias', sid, { ...spawned, t: Date.now() });
    }
  }
  const ti = p.tool_input;
  // Recorded before OMC runs so a hook timeout cannot lose the link; applyTaskPolicy corrects the model if needed.
  if (ctx.event === 'PreToolUse' && isTaskTool(p.tool_name) && isObj(ti)) recordSpawn(ctx, ti, taskModelFor(ti.model));
  if (!ctx.parent) {
    if (ctx.event === 'UserPromptSubmit') resumeAfterStopBlock(sid, p.prompt, ctx);
    return;
  }
  if (SUBAGENT_REMAP.has(ctx.event)) {
    p.session_id = ctx.parent;
    if (p.agent_id === undefined) p.agent_id = sid;
    if (p.agent_type === undefined && ctx.spawn.agent_type) p.agent_type = ctx.spawn.agent_type;
  }
}

// The stopblock marker lives from a blocking Stop round until the session resumes: SessionEnd is skipped meanwhile,
// and the resuming prompt (the block reason) skips OMC's UserPromptSubmit hooks.
function resumeAfterStopBlock(sid, prompt, ctx) {
  const block = readState('stopblock', sid);
  if (!block) return;
  const text = norm(prompt);
  const reasons = Array.isArray(block.reasons) ? block.reasons.map(norm).filter(Boolean) : [];
  if (!text || !reasons.some((r) => text.includes(r))) return removeState('stopblock', sid);
  ctx.continuation = true;
  if (!block.resumed) writeState('stopblock', sid, { ...block, resumed: Date.now() });
}

function noteStopBlock(ctx, out) {
  const o = parseObj(out);
  const sid = safeId(ctx.sid);
  if (!o || o.decision !== 'block' || !sid) return;
  const prev = readState('stopblock', sid);
  const reasons = prev && !prev.resumed && Array.isArray(prev.reasons) ? prev.reasons : [];
  writeState('stopblock', sid, { t: Date.now(), hook: hookName, reasons: [...reasons, str(o.reason).slice(0, 4000)] });
}

function skipReason(ctx) {
  if (ctx.parent && SUBAGENT_SKIP.has(ctx.event)) return `subagent-${ctx.event}`;
  if (ctx.continuation) return 'stop-block-continuation';
  if (ctx.event === 'SessionEnd') {
    const block = readState('stopblock', safeId(ctx.sid));
    if (block && !block.resumed && Date.now() - block.t < 15 * 60e3) return 'session-continues-after-stop-block';
  }
  return '';
}

// Main session: one note per session. Subagent: a short note on its first prompt, plus a synthesized
// SubagentStart (Copilot never fires one) whose context goes to the subagent, as in Claude Code.
function hostNoteMode(payload, ctx) {
  if (ctx.event === 'SessionStart') prune();
  const sid = safeId(ctx.sid);
  if (!sid || readState('note', sid) || (ctx.parent && ctx.event !== 'UserPromptSubmit')) return emit('', ctx, '', 0);
  writeState('note', sid, { t: Date.now(), event: ctx.event });
  if (!ctx.parent) return emit(contextOut(hostNote(sid)), ctx, '', 0);
  const note = subagentNote(ctx.parent);
  if (!rel || readState('substart', sid)) return emit(contextOut(note), ctx, '', 0);
  writeState('substart', sid, { t: Date.now(), synthesized: true });
  const start = {
    session_id: ctx.parent,
    transcript_path: payload.transcript_path,
    cwd: payload.cwd,
    hook_event_name: 'SubagentStart',
    agent_id: ctx.sid,
    agent_type: ctx.spawn.agent_type || '',
    prompt: payload.prompt,
    name: ctx.spawn.name,
    description: ctx.spawn.description,
    model: ctx.spawn.model,
  };
  runHook(start, '', ctx, (out, raw, code) => {
    const startContext = contextOf(out);
    emit(contextOut(startContext ? `${note}\n${startContext}` : note), ctx, raw, code);
  });
}

function runHook(payload, rawIn, ctx, done) {
  let input = rawIn;
  let task = null;
  if (payload) {
    if (TOOL_NAMES[payload.tool_name]) {
      ctx.from = payload.tool_name;
      payload.tool_name = TOOL_NAMES[payload.tool_name];
    }
    // Copilot passes plugin skills by bare name ("ralph"); OMC only protects namespaced ones.
    const ti = payload.tool_input;
    if (payload.tool_name === 'Skill' && isObj(ti) && typeof ti.skill === 'string' && !ti.skill.includes(':') &&
        /^[\w-]+$/.test(ti.skill) && fs.existsSync(path.join(root, 'skills', ti.skill, 'SKILL.md'))) {
      payload.tool_input = { ...ti, skill: `${pluginName}:${ti.skill}` };
      ctx.from = `${ctx.from || 'Skill'}:${ti.skill}`;
    }
    if (ctx.event === 'PreToolUse' && isTaskTool(payload.tool_name) && isObj(ti)) {
      task = { orig: ti, input: { ...ti } };
      if (task.input.subagent_type === undefined && typeof ti.agent_type === 'string') task.input.subagent_type = ti.agent_type;
      // OMC's model routing knows only Claude tiers and Bedrock/Vertex ids (with routing.forceInherit it denies any
      // other id), so it never sees a Copilot model; applyTaskPolicy picks the final one.
      delete task.input.model;
      payload.tool_input = task.input;
    }
    input = JSON.stringify(payload);
  }
  const env = { ...process.env };
  if (!env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = path.join(copilotHome, 'oh-my-ghcp', 'claude');
  // No Claude /goal to observe here, so take OMC's documented bypass of the ultragoal guard (docs/HOOKS.md).
  if (env.ALLOW_ULTRAGOAL_WITHOUT_GOAL === undefined) env.ALLOW_ULTRAGOAL_WITHOUT_GOAL = '1';

  const output = [];
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'run.cjs'), path.join(root, rel), ...extra], {
    cwd: ctx.cwd,
    env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  child.stdout.on('data', (c) => output.push(c));
  child.on('error', () => finish(0));
  child.on('close', (code) => finish(code == null ? 0 : code));

  let finished = false;
  function finish(code) {
    if (finished) return;
    finished = true;
    const raw = Buffer.concat(output).toString('utf8');
    let out = adapt(raw);
    if (task) out = applyTaskPolicy(out, task, ctx);
    if (ctx.event === 'Stop' && !ctx.parent) noteStopBlock(ctx, out);
    done(out, raw, code);
  }
}

function adapt(raw) {
  const o = parseObj(raw);
  if (!o) return raw;
  const hso = o.hookSpecificOutput;
  if (isObj(hso) && typeof hso.additionalContext === 'string' && o.additionalContext === undefined) {
    o.additionalContext = hso.additionalContext;
    delete hso.additionalContext;
    if (Object.keys(hso).every((k) => k === 'hookEventName')) delete o.hookSpecificOutput;
  }
  for (const k of ['additionalContext', 'reason', 'systemMessage', 'permissionDecisionReason']) {
    if (typeof o[k] === 'string') o[k] = toCopilotInvocations(o[k]);
  }
  // Copilot shows a deny reason to the model verbatim; OMC's names Claude's Skill(...) syntax, which fails here.
  if (isObj(o.hookSpecificOutput) && typeof o.hookSpecificOutput.permissionDecisionReason === 'string') {
    o.hookSpecificOutput.permissionDecisionReason = toCopilotInvocations(o.hookSpecificOutput.permissionDecisionReason);
  }
  return JSON.stringify(o) + '\n';
}

// Whatever OMC decides, the task call that reaches Copilot keeps Copilot field names and a Copilot model.
// Copilot 1.0.91 applies hookSpecificOutput.updatedInput (verified: it changes the subagent's model).
function applyTaskPolicy(out, task, ctx) {
  const o = parseObj(out) || (out.trim() ? null : { continue: true });
  if (!o) return out;
  const hso = isObj(o.hookSpecificOutput) ? o.hookSpecificOutput : null;
  if ((hso && hso.permissionDecision === 'deny') || o.permissionDecision === 'deny' || o.decision === 'block' || o.continue === false) {
    return out;
  }
  const fromOmc = [hso && hso.updatedInput, o.updatedInput, o.modifiedArgs].find(isObj);
  const final = { ...(fromOmc || task.input) };
  if (task.orig.subagent_type === undefined) delete final.subagent_type;
  // As in Claude Code, OMC's per-agent model (config agents.<name>.model) applies only when the call names none.
  setModel(final, taskModelFor(task.orig.model || (fromOmc && fromOmc.model)));
  if ((final.model || '') !== (taskModelFor(task.orig.model) || '')) recordSpawn(ctx, final, final.model);
  delete o.updatedInput;
  delete o.modifiedArgs;
  if (hso) delete hso.updatedInput;
  if (!sameInput(final, task.orig)) {
    o.hookSpecificOutput = { ...(hso || {}), hookEventName: 'PreToolUse', updatedInput: final };
    ctx.model = `${task.orig.model || '-'}->${final.model || '-'}`;
  }
  if (isObj(o.hookSpecificOutput) && Object.keys(o.hookSpecificOutput).every((k) => k === 'hookEventName')) delete o.hookSpecificOutput;
  return JSON.stringify(o) + '\n';
}

// ghcp-shim.json {"taskModel": "<model>"} (or env GHCP_TASK_MODEL; "off" disables) pins every subagent's model.
// Otherwise {"taskModelMap": {"opus": ..., "sonnet": ..., "haiku": ...}} maps Claude tiers; bare tier aliases are dropped.
function taskModelFor(model) {
  const pin = process.env.GHCP_TASK_MODEL !== undefined ? process.env.GHCP_TASK_MODEL : cfg.taskModel;
  if (pin && pin !== 'off') return pin;
  if (typeof model !== 'string' || !model) return undefined;
  const tier = (/(?:^|[^a-z])(opus|sonnet|haiku)(?![a-z])/i.exec(model) || [])[1];
  const mapped = tier && isObj(cfg.taskModelMap) ? cfg.taskModelMap[tier.toLowerCase()] : undefined;
  if (typeof mapped === 'string' && mapped) return mapped;
  return /^(opus|sonnet|haiku|inherit)$/i.test(model) ? undefined : model;
}

function toCopilotInvocations(s) {
  return s
    .replace(/Preferred invocation: \/oh-my-claudecode:([\w-]+)([^\n]*)/g, (_, name, a) =>
      `Preferred invocation: call the skill tool with skill "${name}"${a.trim() ? ` (skill arguments: ${a.trim()})` : ''}`)
    .replace(/If the slash invocation is unavailable/g, 'If the skill tool is unavailable')
    .replace(/(^|[^\w/])\/oh-my-claudecode:([\w-]+)((?:[ \t]+--[\w-]+)*)/g, (_, pre, name, flags) =>
      `${pre}the "${name}" skill (skill tool${flags.trim() ? `, arguments: ${flags.trim()}` : ''})`)
    .replace(/\bSkill\(\s*(?:skill\s*=\s*)?(["'`])oh-my-claudecode:([\w-]+)\1\s*\)/g, (_, q, name) =>
      `call the skill tool with skill "${name}"`)
    .replace(/\b(?:Agent|Task)\(subagent_type=\.\.\.\)/g, 'the task tool (agent_type=...)');
}

function hostNote(sid) {
  return [
    '[oh-my-ghcp] oh-my-claudecode (OMC) runs inside GitHub Copilot CLI, not Claude Code. Translate its instructions:',
    '- "/oh-my-claudecode:<name>" or Skill("oh-my-claudecode:<name>") -> call the skill tool with skill "<name>".',
    '- Task(subagent_type="oh-my-claudecode:<agent>", ...) -> call the task tool with agent_type "oh-my-claudecode:<agent>". Ignore Claude model hints (model="opus"/"sonnet"/"haiku"); omit the model argument.',
    `- OMC MCP tools are named ${mcpServer}-<tool> here (Claude Code: mcp__plugin_${pluginName}_${mcpServer}__<tool>), e.g. state_clear -> ${mcpServer}-state_clear. ToolSearch -> tool_search_tool, needed only when such a tool is not in your tool list.`,
    `- To cancel or clear an OMC mode, use the cancel skill, which calls ${mcpServer}-state_clear; there is no omc cancel command.`,
    '- Claude Code /goal does not exist here: skip steps that set or snapshot /goal.',
    `- Current OMC session id: ${sid}. Use exactly this value wherever OMC needs a session id: session_id of ${mcpServer}-state_* tools and omc CLI --session. OMC_SESSION_ID is not set in shells here; wherever OMC says to read it, use this value instead. Never derive a session id from paths or other environment variables.`,
    ...omcCliLine(),
    '- Run OMC mode-control skills (ralph, cancel, autopilot, ...) in this main agent, never inside a subagent; subagents have different session ids.',
  ].join('\n');
}

// The installers put the omc wrapper in <root>/../bin and the copilot-omc launcher puts that dir first on PATH.
// Models otherwise take "omc ..." in OMC skills for a missing tool and skip it (seen with ralph's omc ralph verify).
function omcCliLine() {
  const win = process.platform === 'win32';
  const bin = path.join(root, '..', 'bin');
  const cmd = path.join(bin, win ? 'omc.cmd' : 'omc');
  if (!fs.existsSync(cmd)) return [];
  const names = win ? ['omc.exe', 'omc.cmd', 'omc.bat', 'omc.ps1'] : ['omc'];
  const first = (process.env.PATH || '').split(path.delimiter).map((p) => p.replace(/^"(.*)"$/, '$1'))
    .find((p) => p && names.some((n) => fs.existsSync(path.join(p, n))));
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };
  const ours = !!first && (win ? real(first).toLowerCase() === real(bin).toLowerCase() : real(first) === real(bin));
  const how = ours ? '' : ` as ${win ? `& "${cmd}"` : `"${cmd}"`}`;
  return [`- omc (OMC's CLI, e.g. omc ralph verify --session <id>) is a shell command, not a tool: run it with your shell tool${how}.`];
}

function subagentNote(parent) {
  return `[oh-my-ghcp] You are a subagent of OMC session ${parent} (GitHub Copilot CLI). For OMC state tools or the omc CLI use session id ${parent} (OMC_SESSION_ID=${parent}); your shell's COPILOT_AGENT_SESSION_ID is not the OMC session.`;
}

function contextOut(text) {
  return JSON.stringify({ additionalContext: text }) + '\n';
}

// Copilot runs one event's hooks in hooks.json order with one shared payload; its timestamp and prompt identify the turn.
// Without a timestamp two identical prompts would share a key, so the carry is off.
function turnKey(p) {
  if (p.timestamp == null || p.timestamp === '') return '';
  return crypto.createHash('sha1').update(`${p.timestamp}\n${str(p.prompt)}`).digest('hex');
}

function carryTurnContext(out, ctx) {
  const sid = safeId(ctx.sid);
  const o = parseObj(out);
  if (!sid || !o || typeof o.additionalContext !== 'string') return out;
  const own = o.additionalContext.trim() ? o.additionalContext : '';
  const prev = readState('turnctx', sid);
  const parts = prev && prev.turn === ctx.turn && Array.isArray(prev.parts) && Date.now() - prev.t < 10 * 60e3 ? prev.parts : [];
  if (own) writeState('turnctx', sid, { turn: ctx.turn, parts: [...parts, own], t: Date.now() });
  if (!parts.length) return out;
  ctx.carried = parts.length;
  // An empty context would also replace the earlier ones in Copilot's merge.
  o.additionalContext = (own ? [...parts, own] : parts).join('\n\n');
  return JSON.stringify(o) + '\n';
}

function contextOf(out) {
  const o = parseObj(out);
  return o && typeof o.additionalContext === 'string' ? o.additionalContext : '';
}

function recordSpawn(ctx, ti, model) {
  if (typeof ti.prompt !== 'string') return;
  writeState('spawn', promptKey(ti.prompt), {
    parent: ctx.parent || safeId(ctx.sid),
    agent_type: str(ti.agent_type) || str(ti.subagent_type),
    name: str(ti.name),
    description: str(ti.description),
    ...(model ? { model } : {}),
    t: Date.now(),
  });
}

function isTaskTool(name) {
  return name === 'Agent' || name === 'Task' || name === 'task';
}

function setModel(o, model) {
  if (model) o.model = model;
  else delete o.model;
}

function sameInput(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

function parseObj(s) {
  const text = String(s || '').trim();
  if (!text.startsWith('{')) return null;
  try {
    const o = JSON.parse(text);
    return isObj(o) ? o : null;
  } catch { return null; }
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

function safeId(s) {
  return typeof s === 'string' && /^[\w-]{1,128}$/.test(s) ? s : '';
}

function norm(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function promptKey(s) {
  return crypto.createHash('sha1').update(norm(s).slice(0, 400)).digest('hex');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function statePath(kind, id) {
  return path.join(stateDir, kind, `${id}.json`);
}

function readState(kind, id) {
  return id ? readJson(statePath(kind, id)) : null;
}

function writeState(kind, id, value) {
  if (!id) return;
  try {
    fs.mkdirSync(path.join(stateDir, kind), { recursive: true });
    fs.writeFileSync(statePath(kind, id), JSON.stringify(value));
  } catch {}
}

function removeState(kind, id) {
  if (!id) return;
  try { fs.unlinkSync(statePath(kind, id)); } catch {}
}

function prune() {
  const cutoff = Date.now() - 3 * 864e5;
  for (const kind of ['spawn', 'alias', 'note', 'substart', 'stopblock', 'turnctx']) {
    let names = [];
    try { names = fs.readdirSync(path.join(stateDir, kind)); } catch { continue; }
    for (const n of names) {
      const p = path.join(stateDir, kind, n);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch {}
    }
  }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function emit(out, ctx, raw, code, skip) {
  if (ctx.turn) out = carryTurnContext(out, ctx);
  if (out) process.stdout.write(out);
  process.exitCode = code;
  const file = process.env.GHCP_SHIM_LOG;
  if (!file) return;
  const rec = {
    t: new Date(started).toISOString(),
    ms: Date.now() - started,
    hook: hookName + (extra.length ? ' ' + extra.join(' ') : ''),
    event: ctx.event,
    sid: ctx.sid,
    parent: ctx.parent || undefined,
    skip: skip || undefined,
    tool: ctx.from,
    model: ctx.model,
    turn: ctx.turn ? ctx.turn.slice(0, 12) : undefined,
    carried: ctx.carried,
    cwd: ctx.cwd === root ? '<root>' : ctx.cwd,
    code,
    lifted: raw.trim() !== out.trim(),
    raw: raw.trim().slice(0, 4000),
    out: out.trim().slice(0, 600),
  };
  try { fs.appendFileSync(file, JSON.stringify(rec) + '\n'); } catch {}
}
