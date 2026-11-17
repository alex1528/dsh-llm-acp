// lib/acp-session.js — one fresh ACP child per call: spawn → initialize → session/new →
// session/prompt, with updates delivered as an async queue, and guaranteed teardown.
//
// Uses @agentclientprotocol/sdk (the same client the official dsh-subagent-acp uses).
// Teardown order: session/cancel (if a prompt is live) → stdin EOF → SIGTERM → SIGKILL,
// each step bounded by a grace timer, so a child that ignores everything is still killed.
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { PROTOCOL_VERSION, client, methods, ndJsonStream } from '@agentclientprotocol/sdk'
import { AcpError, classifyError } from './errors.js'

const CLIENT_INFO = { name: 'dsh-llm-acp' }
const STDERR_KEEP = 4000

/** Minimal async queue: producers push, one consumer pulls; `end(err?)` terminates. */
function queue() {
  const items = []
  let waiter
  let done = false
  let error
  return {
    push(v) { if (done) return; if (waiter) { const w = waiter; waiter = undefined; w.resolve({ value: v, done: false }) } else items.push(v) },
    end(err) { if (done) return; done = true; error = err; if (waiter) { const w = waiter; waiter = undefined; err ? w.reject(err) : w.resolve({ value: undefined, done: true }) } },
    next() {
      if (items.length) return Promise.resolve({ value: items.shift(), done: false })
      if (done) return error ? Promise.reject(error) : Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve, reject) => { waiter = { resolve, reject } })
    },
  }
}

const rpcMessage = (e) => {
  const m = e?.message ?? String(e)
  const data = e?.data
  const detail = typeof data === 'string' ? data : data?.message ?? data?.details
  return detail && !m.includes(detail) ? `${m}: ${detail}` : m
}

/**
 * Start one ACP child and open a session.
 * @param {object} spec
 * @param {string} spec.command
 * @param {string[]} spec.args
 * @param {Record<string,string>} spec.env extra environment
 * @param {string} spec.cwd
 * @param {'allow'|'reject'} spec.permission
 * @param {number} spec.startupTimeoutMs
 * @param {number} spec.disposeGraceMs
 * @param {(child: import('node:child_process').ChildProcess) => () => void} [spec.track] registry hook, returns untrack
 * @param {AbortSignal} [spec.signal]
 * @returns {Promise<AcpSession>}
 */
export async function openSession(spec) {
  spec.signal?.throwIfAborted()
  let child
  try {
    child = spawn(spec.command, spec.args, {
      cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
  } catch (e) {
    throw new AcpError(`could not start ACP CLI "${spec.command}": ${e?.message ?? e}`, 'ACP_SPAWN', { cause: e })
  }
  const untrack = spec.track?.(child) ?? (() => {})
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_KEEP) })
  child.stdin.on('error', () => {}) // EPIPE after the child died is reported through 'exit'

  /** @type {{code: number|null, signal: string|null} | undefined} */
  let exit
  let spawnError
  const exited = new Promise((resolve) => {
    child.once('error', (e) => { spawnError = e; exit ??= { code: null, signal: null }; resolve(exit) })
    child.once('exit', (code, signal) => { exit = { code, signal }; resolve(exit) })
  })
  const closingError = () => new AcpError('llm-acp was reloaded or stopped (its config changed, the plugin was disabled, or DSH is exiting), so this turn was ended; the CLI did not crash', 'DISPOSED')
  const exitError = () => {
    if (spawnError) return new AcpError(`could not start ACP CLI "${spec.command}": ${spawnError.message}`, spawnError.code === 'ENOENT' || spawnError.code === 'EACCES' ? 'ACP_SPAWN' : 'TRANSPORT', { cause: spawnError })
    // The plugin itself is shutting down (config change ⇒ hot reload, plugin disabled, DSH exit):
    // the CLI exiting is our doing, not a crash. Say so, or the user goes hunting a CLI bug.
    if (spec.closing?.() === true) return closingError()
    const how = exit?.signal ? `signal ${exit.signal}` : `exit code ${exit?.code}`
    const tail = stderr.trim().split('\n').slice(-3).join(' | ')
    return new AcpError(`ACP CLI "${spec.command}" exited unexpectedly (${how})${tail ? `: ${tail}` : ''}`, 'TRANSPORT')
  }

  const updates = queue()
  let permissionPolicy = spec.permission
  /** Tool names `permission: read` approves even when their ACP kind is not read/search. */
  const readTools = new Set(Array.isArray(spec.readTools) ? spec.readTools : [])
  /** Tool titles refused since the last prompt started (an agent may end its turn over them). */
  const denied = []
  /** toolCallId → title from tool_call updates (some agents send permission requests without a title). */
  const toolTitles = new Map()
  /** toolCallId → ACP tool kind (read, edit, execute, …) from tool_call updates. */
  const toolKinds = new Map()
  // While session/load runs the agent replays the OLD conversation as session/update
  // notifications. Those are history, not this turn's output: count them (proof the load really
  // found the session) and drop them.
  let replaying = false
  let replayed = 0
  const conn = client(CLIENT_INFO)
    .onNotification(methods.client.session.update, ({ params }) => {
      if (replaying) { if (HISTORY_UPDATES.has(params?.update?.sessionUpdate)) replayed++; return Promise.resolve() }
      const up = params?.update
      if (up?.sessionUpdate === 'tool_call' && typeof up.toolCallId === 'string' && typeof up.title === 'string') toolTitles.set(up.toolCallId, up.title)
      if ((up?.sessionUpdate === 'tool_call' || up?.sessionUpdate === 'tool_call_update') && typeof up.toolCallId === 'string' && typeof up.kind === 'string') toolKinds.set(up.toolCallId, up.kind)
      updates.push(up)
      return Promise.resolve()
    })
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      const options = Array.isArray(params?.options) ? params.options : []
      // allow ⇒ the narrowest allow only. `allow_always` would grant a standing permission the user
      // never approved, so an agent that offers only that gets "cancelled" instead.
      // read ⇒ allow_once only for tools whose ACP kind is read-only (read / search); edits,
      // deletes, moves, commands and network fetches are still refused.
      const tc = params?.toolCall
      const kind = typeof tc?.kind === 'string' ? tc.kind : toolKinds.get(tc?.toolCallId)
      // Some CLIs label read-only tools with kind "other" (codebuddy ViewImage); those are approved
      // by tool NAME (the first word of the title) when listed in readTools.
      const title = typeof tc?.title === 'string' && tc.title !== '' ? tc.title : toolTitles.get(tc?.toolCallId)
      const toolName = typeof title === 'string' ? title.trim().split(/\s+/)[0] : undefined
      const mayRun = permissionPolicy === 'allow' || (permissionPolicy === 'read' && (READ_KINDS.has(kind) || (toolName !== undefined && readTools.has(toolName))))
      const pick = mayRun ? options.find((o) => o.kind === 'allow_once') : undefined
      if (!pick) {
        denied.push(typeof tc?.title === 'string' && tc.title !== '' ? tc.title : toolTitles.get(tc?.toolCallId) ?? (typeof tc?.kind === 'string' ? `a ${tc.kind} tool` : 'a tool'))
      }
      return Promise.resolve(pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } })
    })
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
  const agent = conn.agent

  let disposed
  let sessionId
  let promptLive = false
  /** Tear the child down; idempotent; resolves once the process is gone (or abandoned). */
  const dispose = () => disposed ??= (async () => {
    if (promptLive && sessionId !== undefined && !exit) agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {})
    const wait = (ms) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))])
    if (!exit) { try { child.stdin.end() } catch {} ; await wait(spec.disposeGraceMs) }
    if (!exit) { killTree(child, 'SIGTERM'); await wait(spec.disposeGraceMs) }
    if (!exit) { killTree(child, 'SIGKILL'); await wait(1000) }
    try { conn.close?.() } catch {}
    updates.end()
    untrack()
  })()

  // Startup: initialize → (session/load | session/new) → permission alignment, raced against
  // exit, timeout and abort.
  let capabilities = {}
  // authMethods from initialize: lets a bare -32000 count as auth_required (classifyError).
  let authMethods = []
  let loaded = false
  let loadNote
  let permissionNote
  let modelNote
  const startup = async () => {
    const init = await agent.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    capabilities = init?.agentCapabilities ?? {}
    authMethods = Array.isArray(init?.authMethods) ? init.authMethods : []
    let s
    // Resume the CLI's own native session when asked for and advertised (ACP `loadSession`).
    if (typeof spec.loadSessionId === 'string' && spec.loadSessionId !== '') {
      if (capabilities.loadSession !== true) loadNote = 'agent does not advertise loadSession'
      else {
        stage = 'session/load'
        replaying = true
        try {
          s = await agent.request(methods.agent.session.load, { sessionId: spec.loadSessionId, cwd: spec.cwd, mcpServers: [] })
          // Some agents answer an unknown id with success and an empty session. Accept the load
          // only when the agent actually replayed at least one message of the old conversation.
          if (replayed > 0) { loaded = true; s = { ...s, sessionId: spec.loadSessionId } }
          else { loadNote = 'load replayed no history (unknown or empty session)'; s = undefined }
        } catch (e) {
          if (exit || isClosed(e)) throw e
          loadNote = `load failed: ${rpcMessage(e)}`
          s = undefined
        } finally { replaying = false }
      }
    }
    if (s === undefined) {
      stage = 'session/new'
      s = await agent.request(methods.agent.session.new, { cwd: spec.cwd, mcpServers: [] })
      if (typeof s?.sessionId !== 'string' || s.sessionId === '') throw new AcpError('ACP agent returned no sessionId from session/new', 'ACP_PROTOCOL')
    }
    // Model by ACP config option, for agents that take no --model argument. Applied before mode
    // and permission: selecting a model must never undo the permission alignment.
    if (spec.modelVia === 'configOption' && typeof spec.model === 'string' && spec.model !== '' && spec.model !== 'default') {
      stage = 'model'
      s = await applyModel(agent, s, spec.model)
      modelNote = spec.model
    }
    // Optional agent mode (ACP modes / mode config option), e.g. a planner profile. Applied
    // BEFORE permission alignment so `permission` always has the last word.
    if (typeof spec.mode === 'string' && spec.mode !== '') {
      stage = 'mode'
      s = await applyMode(agent, s, spec.mode)
    }
    stage = 'permission'
    permissionNote = await alignPermission(agent, s, spec.permission, spec.approvalModes, spec.approvals)
    return s
  }
  let stage = 'initialize'
  let session
  try {
    session = await race(startup(), {
      exited: exited.then(() => { throw exitError() }),
      timeoutMs: spec.startupTimeoutMs,
      onTimeout: () => new AcpError(`ACP CLI "${spec.command}" did not finish ${stage} within ${spec.startupTimeoutMs} ms (startup timeout)`, 'TIMEOUT'),
      signal: spec.signal,
    })
  } catch (e) {
    // Classify BEFORE teardown: dispose() ends stdin, after which the child exits normally.
    let err
    if (e instanceof AcpError) err = e
    else if (spec.signal?.aborted) err = abortError(spec.signal)
    else if (exit || isClosed(e)) { await settleExit(exited, 500); err = exit ? exitError() : new AcpError(`ACP ${stage} failed: ${rpcMessage(e)}`, 'TRANSPORT', { cause: e }) }
    else { const msg = rpcMessage(e); err = new AcpError(`ACP ${stage} failed: ${msg}`, classifyError({ message: msg, code: e?.code, data: e?.data }, { authMethods }), { cause: e }) }
    await dispose()
    throw err
  }
  sessionId = session.sessionId

  return {
    sessionId,
    info: session,
    updates,
    /** agentCapabilities from initialize (promptCapabilities.image, loadSession, …). */
    capabilities,
    /** true when this session is the CLI's own resumed session (session/load succeeded). */
    loaded,
    /** why a requested load did not happen, if it did not. */
    loadNote,
    /** how the agent's own permission mode was aligned with `permission` (diagnostics). */
    permissionNote,
    /** model selected over ACP (modelVia: configOption), if any (diagnostics). */
    get modelNote() { return modelNote },
    /** tool titles refused during the current prompt. */
    get denied() { return [...denied] },
    /** Send the prompt (a string, or ACP content blocks); resolves with the PromptResponse. */
    prompt(input) {
      promptLive = true
      denied.length = 0
      const prompt = typeof input === 'string' ? [{ type: 'text', text: input }] : input
      const p = agent.request(methods.agent.session.prompt, { sessionId, prompt })
      // `p` may still reject AFTER the race is decided (e.g. the session is disposed mid-turn).
      // Attach a no-op rejection handler so it can never surface as an unhandled rejection; the
      // race below is what the caller actually observes.
      p.catch(() => {})
      return Promise.race([p, exited.then(() => { throw exitError() })]).then(
        (r) => {
          promptLive = false
          // dispose() sends session/cancel; the CLI answering "cancelled" is our shutdown, not its choice.
          if (r?.stopReason === 'cancelled' && spec.closing?.() === true) throw closingError()
          return r
        },
        async (e) => {
          promptLive = false
          if (spec.closing?.() === true) throw closingError()
          if (e instanceof AcpError) throw e
          // "connection closed" usually races the child's exit event; give exit a moment to land.
          if (!exit && isClosed(e)) await settleExit(exited, 500)
          if (exit) throw exitError()
          const m = rpcMessage(e)
          throw new AcpError(`ACP session/prompt failed: ${m}`, isClosed(e) ? 'TRANSPORT' : classifyError({ message: m, code: e?.code, data: e?.data }, { authMethods }), { cause: e })
        },
      )
    },
    cancel() { if (!exit) agent.notify(methods.agent.session.cancel, { sessionId }).catch(() => {}) },
    dispose,
    get exited() { return exit !== undefined },
    get stderr() { return stderr },
  }
}

/** ACP tool kinds that only look at things; `permission: read` approves these and nothing else. */
const READ_KINDS = new Set(['read', 'search'])

/** session/update kinds that only exist when a real conversation was replayed. */
const HISTORY_UPDATES = new Set(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk', 'tool_call'])

/**
 * Agent permission modes, by ACP-visible id, from most to least restrictive. Matching is by id so it
 * works for any CLI that exposes ACP `modes` / a `mode` config option; unknown ids are never chosen.
 *   reject ⇒ the agent must ASK before every tool use, so our permission handler can refuse it.
 *   allow  ⇒ the agent may edit without asking, but must not run in a "bypass everything" mode
 *            the user never chose; if it already asks, asking is fine (we answer allow_once).
 */
const ASKING_MODES = ['default', 'ask', 'always-ask', 'alwaysAsk']
const BYPASS_MODES = ['bypassPermissions', 'fullAccess', 'full-access', 'dontAsk', 'yolo', 'auto']
const EDIT_MODES = ['acceptEdits']

/**
 * Mode-id lists for one provider. Built-in names follow Claude-style CLIs; a CLI whose ids mean
 * something else (Codex: `auto` ASKS, `full-access` bypasses) declares its own `approvalModes`
 * in config, which then replaces the built-ins entirely: { ask, edit, bypass } each a list of ids.
 */
function modeLists(approvalModes) {
  if (approvalModes === undefined) return { ask: ASKING_MODES, edit: EDIT_MODES, bypass: new Set(BYPASS_MODES) }
  return { ask: approvalModes.ask, edit: approvalModes.edit, bypass: new Set(approvalModes.bypass) }
}

/**
 * One `select` configOption of a session, by category or id. Claude Code offers `model`,
 * `mode`, `effort`; Codex offers `mode`, `model`. Returns undefined when the agent has none.
 */
function configOption(s, want) {
  const opts = Array.isArray(s?.configOptions) ? s.configOptions : []
  const opt = opts.find((o) => o?.category === want || o?.id === want)
  if (opt === undefined || !Array.isArray(opt.options)) return undefined
  return { id: opt.id, current: opt.currentValue, values: opt.options.map((o) => o?.value).filter((v) => typeof v === 'string') }
}

/**
 * Select the model over ACP (`session/set_config_option`, category `model`) instead of the CLI
 * command line. Needed by agents that take no --model flag, e.g. the Claude Code ACP adapter:
 * it ignores unknown argv, so passing --model there would silently run the CLI default.
 * @returns {Promise<object>} `s` with the model option's currentValue updated
 */
export async function applyModel(agent, s, model) {
  const opt = configOption(s, 'model')
  if (opt === undefined) throw new AcpError(`ACP agent offers no model option; cannot select model "${model}" with modelVia: configOption`, 'ACP_MODEL')
  if (!opt.values.includes(model)) throw new AcpError(`ACP agent has no model "${model}" (offers: ${opt.values.join(', ')})`, 'ACP_MODEL')
  if (opt.current === model) return s
  await agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: opt.id, value: model })
  return { ...s, configOptions: s.configOptions.map((o) => (o?.id === opt.id ? { ...o, currentValue: model } : o)) }
}

/** Current mode and the ids the agent offers, from session/new|load (modes and/or configOptions). */
function modeState(s) {
  const opt = Array.isArray(s?.configOptions) ? s.configOptions.find((o) => o?.category === 'mode' || o?.id === 'mode') : undefined
  if (opt && Array.isArray(opt.options)) {
    return { via: 'config', configId: opt.id, current: opt.currentValue, ids: opt.options.map((o) => o?.value).filter((v) => typeof v === 'string') }
  }
  const m = s?.modes
  if (m && Array.isArray(m.availableModes)) return { via: 'mode', current: m.currentModeId, ids: m.availableModes.map((x) => x?.id).filter((v) => typeof v === 'string') }
  return undefined
}

/**
 * Make the agent's OWN permission mode agree with the plugin's `permission`.
 * Without this an agent whose default mode bypasses approval (it never sends
 * session/request_permission) would ignore `permission: reject` entirely.
 * @returns {Promise<string>} what was done, for logs
 */
/** Switch the agent to `modeId`; returns `s` with its current mode updated. Unknown id ⇒ error. */
export async function applyMode(agent, s, modeId) {
  const st = modeState(s)
  if (st === undefined) throw new AcpError(`ACP agent exposes no modes; cannot apply mode "${modeId}"`, 'ACP_MODE')
  if (!st.ids.includes(modeId)) throw new AcpError(`ACP agent has no mode "${modeId}" (offers: ${st.ids.join(', ')})`, 'ACP_MODE')
  if (st.current === modeId) return s
  if (st.via === 'config') {
    await agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: st.configId, value: modeId })
    return { ...s, configOptions: s.configOptions.map((o) => (o?.id === st.configId ? { ...o, currentValue: modeId } : o)) }
  }
  await agent.request(methods.agent.session.setMode, { sessionId: s.sessionId, modeId })
  return { ...s, modes: { ...s.modes, currentModeId: modeId } }
}

export async function alignPermission(agent, s, permission, approvalModes, approvals) {
  // An agent that declares it never asks cannot be made safe by any mode switch. Say that once,
  // here, instead of letting the heuristic below mistake an unrelated mode id (a thinking level,
  // a persona) for an approval prompt.
  // `read` needs the agent to ASK just like `reject` does: only then can the handler approve reads
  // and refuse the rest. So for mode alignment both are strict; only `allow` is lenient.
  const strict = permission !== 'allow'
  if (approvals === 'none') {
    if (strict) throw new AcpError(`this ACP agent never asks before it runs a tool (approvals: none in its llm-acp config), so permission: ${permission} cannot be honoured; it offers no mode that would ask. Use permission: allow if this agent may edit files and run commands, or remove the provider.`, 'ACP_PERMISSION')
    return 'agent never asks (approvals: none)'
  }
  const st = modeState(s)
  if (st === undefined) return 'agent exposes no permission modes'
  const L = modeLists(approvalModes)
  const bypassing = L.bypass.has(st.current)
  let target
  if (strict) {
    // With declared approvalModes, "safe" is only what the config calls ask; built-ins keep the
    // historical rule (anything not known to bypass or auto-edit counts as asking).
    const safe = approvalModes === undefined ? !bypassing && !L.edit.includes(st.current) : L.ask.includes(st.current)
    if (safe) return `kept ${st.current}`
    target = L.ask.find((id) => st.ids.includes(id))
  } else {
    if (!bypassing) return `kept ${st.current}`
    target = [...L.edit, ...L.ask].find((id) => st.ids.includes(id))
  }
  if (target === undefined) {
    if (strict) throw new AcpError(`ACP agent runs in "${st.current}" (no approval prompts) and offers no asking mode; refusing to run it with permission: ${permission}`, 'ACP_PERMISSION')
    return `kept ${st.current} (no safer mode offered)`
  }
  try {
    if (st.via === 'config') await agent.request(methods.agent.session.setConfigOption, { sessionId: s.sessionId, configId: st.configId, value: target })
    else await agent.request(methods.agent.session.setMode, { sessionId: s.sessionId, modeId: target })
  } catch (e) {
    if (strict) throw new AcpError(`could not switch ACP agent out of "${st.current}" for permission: ${permission}: ${rpcMessage(e)}`, 'ACP_PERMISSION', { cause: e })
    return `kept ${st.current} (switch failed: ${rpcMessage(e)})`
  }
  return `${st.current} → ${target}`
}

const isClosed = (e) => /connection closed|stream (closed|ended)|EPIPE|ECONNRESET/i.test(String(e?.message ?? e))
const settleExit = (exited, ms) => Promise.race([exited, new Promise((r) => setTimeout(r, ms))])

function killTree(child, signal) {
  try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal); else child.kill(signal) }
  catch { try { child.kill(signal) } catch {} }
}

export function abortError(signal) {
  const reason = signal?.reason
  const e = new AcpError(reason instanceof Error ? reason.message : 'aborted', 'ABORTED', { cause: reason })
  return e
}

/** Promise.race with exit / timeout / abort arms; clears its timers. */
export function race(p, { exited, timeoutMs, onTimeout, signal }) {
  return new Promise((resolve, reject) => {
    let timer
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    const onAbort = () => { cleanup(); reject(abortError(signal)) }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (timeoutMs) timer = setTimeout(() => { cleanup(); reject(onTimeout()) }, timeoutMs)
    p.then((v) => { cleanup(); resolve(v) }, (e) => { cleanup(); reject(e) })
    exited?.then(() => {}, (e) => { cleanup(); reject(e) })
  })
}
