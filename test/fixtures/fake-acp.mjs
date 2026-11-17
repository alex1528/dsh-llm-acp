#!/usr/bin/env node
// test/fixtures/fake-acp.mjs — a scripted ACP agent over stdio NDJSON.
//
// Written against the raw wire format on purpose (no SDK), so the adapter's use of the SDK is
// checked against an independent reading of the protocol.
//
// Behaviour is chosen by FAKE_MODE; FAKE_RECORD (a file path) receives one JSON line per
// interesting event (argv, cwd, prompt text, permission answer, cancel) so tests can assert on
// what the adapter actually sent.
//
//   normal      two agent_message_chunk + one agent_thought_chunk, end_turn
//   interleave  thought, text, tool_call, text, end_turn (block switching)
//   usage       like normal but the prompt response carries a usage object
//   models      session/new advertises models (for listModels discovery)
//   rpc-error   session/prompt answers a JSON-RPC error
//   queue-wait  session/prompt answers the Qoder adapter's [queue-wait] error (0.4.1)
//   auth-error  session/new answers a JSON-RPC error mentioning authentication
//   crash       sends one chunk then exits 3 mid-prompt
//   garbage     non-JSON stdout lines, malformed updates, then a normal reply
//   hang        never answers session/prompt; honours session/cancel with stopReason cancelled
//   deaf        never answers session/prompt and ignores session/cancel (must be killed)
//   slow-init   never answers initialize
//   permission  asks permission before replying; replies with the chosen optionId
//   empty       end_turn with no content at all
//   tools-only  only a tool_call, then end_turn (no text)
//   refusal     stopReason refusal
//   max         stopReason max_tokens after some text
//   no-session  session/new returns no sessionId
//   perm-cancel asks permission for a tool; refused ⇒ stopReason cancelled (codebuddy does this)
//   self-cancel stopReason cancelled without anyone asking
//
// Orthogonal knobs (env):
//   FAKE_LOAD=1|silent|error  advertise loadSession. 1: replays history and remembers it;
//                             silent: succeeds but replays nothing (like an agent that accepts an
//                             unknown id); error: rejects session/load.
//   FAKE_STATE=<file>         persisted "native sessions" for FAKE_LOAD=1 (survives restarts)
//   FAKE_MODES=bypass|ask|config-bypass|none  advertise permission modes (ACP modes or configOptions)
//   FAKE_MODEL_OPT=opus,haiku   offer a `model` select configOption (no --model flag), like Claude Code
//   FAKE_MODES=codex (+FAKE_MODE_CURRENT) Codex-style ids: read-only / auto (asks) / full-access
//   FAKE_MODES=opencode (+FAKE_MODEL_OPT) model select FIRST, then a mode select build / plan
//   FAKE_MODES=pi (+FAKE_MODE_CURRENT) pi-acp shape: the ACP `modes` are THINKING levels
//                             (off…xhigh) and the only mode-ish configOption has
//                             category `thought_level`. There is NO permission mode at all and
//                             the agent never sends session/request_permission.
//   FAKE_MODELS_LEGACY=1      also publish FAKE_MODEL_OPT's ids as the ACP `models` extension
//                             (pi-acp offers BOTH the models list and a model configOption)
//   FAKE_MODELS_FILE=<path>   read this file at every session/new and publish its comma-separated
//                             ids as `availableModels` (name = id). Content "!fail" makes
//                             session/new answer an error; a missing file falls back to FAKE_MODE.
//   FAKE_MODELS_JSON=<path>   0.4.7: read this file at every session/new and publish its JSON array
//                             verbatim as `availableModels` (keeps `_meta`, like codebuddy --acp).
//                             Takes precedence over FAKE_MODELS_FILE; unreadable ⇒ knob off.
//   FAKE_IMAGE=1              advertise promptCapabilities.image
//   FAKE_EFFORTS=low:Low,high:High  offer a `thought_level` select (ids may include an empty one on
//                             purpose: client-side validation is what the tests exercise)
//   FAKE_EFFORT_CURRENT=<id>  its currentValue (default: first id)
//   FAKE_EFFORT_ID=<id>       its id (default thought_level; Codex/Claude may name it differently)
//   FAKE_EFFORT_ERR=1         session/set_config_option on it answers a JSON-RPC error
//   FAKE_LOAD_NO_CONFIG=1     session/load succeeds but returns no configOptions at all
//
// 0.3.0 knobs (MCP bridge):
//   FAKE_MCP_CAPS=http|none|sse  advertise agentCapabilities.mcpCapabilities (http default: false)
//   FAKE_RECORD_MCP=<file>    session/new and session/load append their mcpServers here (token ⇒ sha8)
//   FAKE_LOAD_NEEDS_MCP=1     session/load answered `Invalid params` unless mcpServers is a non-empty array
//   FAKE_PERM_TOOL_NAME=<n>   request_permission carries toolCall.rawInput.toolName (MCP-shaped) and no title
//   FAKE_PERM_KIRO=<json>     kiro-shaped request_permission (mode 'permission'): rawInput only has __tool_use_purpose; identity
//                             {"serverName":..,"toolName":..} in params._meta.mcpToolIdentity (FAKE_PERM_KIRO_AT=toolCall ⇒ toolCall._meta)
//
// 0.2.0 knobs (management layer; all opt-in, none changes the behaviour above):
//   --version argv            print FAKE_VERSION (default "fake-acp 0.0.1") and exit 0
//   FAKE_SLEEP_VERSION=1      `--version` never returns (detection must kill it)
//   FAKE_AUTH=init|session|prompt  that step answers a JSON-RPC error with code -32000
//   FAKE_AUTH_MSG=<text>      message of that error (default "Authentication required")
//   FAKE_AUTH_METHODS=1       initialize advertises a non-empty authMethods (session still works)
//   FAKE_NO_ASK=1             ACP modes offer only bypass-style ids (no asking mode at all)
//   FAKE_SESSION_CLOSE=1      advertise sessionCapabilities.close and answer session/close
//   FAKE_STDERR=<text>        write this to stderr at start (leak checks)
//   FAKE_INIT_DELAY_MS=<n>    answer initialize after n ms (concurrency checks)
//
// 0.4.14 knobs (mid-turn delivery; all opt-in, none changes the behaviour above):
//   FAKE_AGENT_INFO=<json>|none  initialize's agentInfo (default {"name":"fake-acp","version":"0.0.1"};
//                             none ⇒ omitted, like codebuddy --acp, which sends none)
//   steer-turn (FAKE_MODE)    a turn long enough to push into: text, tool_call, then after
//                             FAKE_TURN_MS (default 600) tool_call_update completed + final text,
//                             then after FAKE_TAIL_MS (default 100) end_turn with usage. Prompt n
//                             has request id rid-<n>.
//   FAKE_STEER=steered|steered-noack|steered-wrongack|idle|stale|hang  answer session/steer
//                             (unset ⇒ -32601, as for any unknown method). steered*: like codebuddy,
//                             {steered:true, ownerRequestId} while a steer-turn runs and its
//                             expectedRequestId (if given) matches, else {steered:false, reason:
//                             'idle'|'stale'}; steered then echoes a user_message_chunk whose
//                             _meta['codebuddy.ai/messageId'] is the clientUserMessageId
//                             (-noack: no echo; -wrongack: another id). Empty contentBlocks ⇒ -32602.
//                             With FAKE_STEER set a steer-turn first echoes its own prompt, carrying
//                             _meta['codebuddy.ai/conversationRequestId'] = rid-<n>.
//   FAKE_INJECT=merge|late|mismatch|reject  a second session/prompt while a steer-turn runs
//                             (deveco 0.2.5 shape): merge ⇒ answered in the same instant as the main
//                             prompt, equal usage; late ⇒ main answered first, then a stray text
//                             chunk and the inject answer 200 ms later, other usage; mismatch ⇒
//                             20 ms after main, other usage; reject ⇒ an immediate -32603.
//                             On cancel every inject is answered with the main prompt. Unset ⇒ a
//                             second prompt runs as before.
//   FAKE_STEER_OWNER=<id>     steered*: answer this ownerRequestId (default rid-<n>); expectedRequestId
//                             may then be either rid-<n> or this id
//   FAKE_CANCEL_STOP=<reason> stopReason a steer-turn (and its injects) answers on cancel (default
//                             cancelled; deveco 0.2.5 answers end_turn with zero usage, R0 D2c)
//
// 0.4.15 knobs (an external CLI as Team Lead; all opt-in, none changes the behaviour above):
//   FAKE_MCP_SCRIPT=<file> with { scripts: [ { match?, prompts }, … ] }  several scripts in one
//                             file: the first whose `match` occurs in the prompt text runs (no
//                             match key ⇒ always), each with its own turn counter, so a Lead and a
//                             teammate on the same provider follow different scripts. A step
//                             { list: true } sends tools/list and records the tool names; tools/call
//                             rows then also carry `script` (s<index>) and `ms` (call duration). The
//                             0.3.2 single-script shape ({ match?, prompts }) behaves exactly as before.
//   FAKE_MCP_FETCH_MS=<n>     timeout of each scripted MCP HTTP request (default 5000), for calls that
//                             block on the host (wait_agent) longer than 5 s
//   FAKE_TICK_MS=<n>          steer-turn only: one text chunk '.' every n ms while the turn runs (a long
//                             but talkative turn that never trips the idle timer). Unset ⇒ silent
//                             until FAKE_TURN_MS, as before
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const sha8 = (s) => createHash('sha256').update(String(s)).digest('hex').slice(0, 8)
/** 0.3.0: what initialize advertises about MCP transports (absent ⇒ nothing, like a real CLI that has none). */
const mcpCaps = () => {
  const v = process.env.FAKE_MCP_CAPS
  if (v === 'none') return { mcpCapabilities: { http: false, sse: false } }
  if (v === 'sse') return { mcpCapabilities: { http: false, sse: true } }
  if (v === 'http') return { mcpCapabilities: { http: true, sse: true } }
  return {}
}
/** 0.4.14: initialize's agentInfo; FAKE_AGENT_INFO=none omits it (codebuddy --acp sends none). */
const agentInfoPayload = () => {
  const v = process.env.FAKE_AGENT_INFO
  const dflt = { agentInfo: { name: 'fake-acp', version: '0.0.1' } }
  if (v === undefined) return dflt
  if (v === 'none') return {}
  try { return { agentInfo: JSON.parse(v) } } catch { return dflt }
}
/** 0.3.0: what session/new|load received, with the token reduced to its sha8 (never the full value). */
const viewMcp = (servers) => (Array.isArray(servers) ? servers : []).map((s) => ({
  name: s?.name, type: s?.type, url: s?.url,
  headers: Array.isArray(s?.headers)
    ? s.headers.map((h) => ({ name: h?.name, value: typeof h?.value === 'string' && h.value.startsWith('Bearer ') ? `Bearer sha8:${sha8(h.value.slice(7))}` : h?.value }))
    : s?.headers,
}))
const recordMcp = (event, servers) => {
  const file = process.env.FAKE_RECORD_MCP
  if (!file) return
  appendFileSync(file, JSON.stringify({ event, mcpServers: viewMcp(servers) }) + '\n')
}

// 0.3.1: act like a real MCP client. After the handshake, each prompt asks the bridge for its
// tool list WITH THE TOKEN THIS PROCESS HOLDS. A warm CLI holds the token from its session/new
// forever, so this is what catches "the bridge revoked a token the CLI is still using".
let lastMcpServers
const probeMcp = (servers) => {
  const file = process.env.FAKE_MCP_PROBE
  if (!file) return
  const row = (value) => appendFileSync(file, JSON.stringify({ event: 'mcp-probe', ...value }) + '\n')
  const server = (Array.isArray(servers) ? servers : []).find((s) => s !== null && typeof s === 'object' && typeof s.url === 'string')
  if (server === undefined) return
  const auth = Array.isArray(server.headers) ? server.headers.find((h) => h?.name === 'Authorization')?.value : undefined
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth : undefined
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  fetch(server.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: token }) },
    body,
    signal: AbortSignal.timeout(2000),
  }).then(async (res) => {
    let tools
    try {
      const json = await res.json()
      tools = Array.isArray(json?.result?.tools) ? json.result.tools.length : undefined
    } catch {}
    row({ status: res.status, tools, sha8: token === undefined ? undefined : sha8(token.slice(7)) })
  }).catch((e) => row({ status: 0, error: String(e?.code ?? e?.message ?? e).slice(0, 80) }))
}

if (process.argv.includes('--version')) {
  if (process.env.FAKE_SLEEP_VERSION === '1') setInterval(() => {}, 1 << 30)
  else { process.stdout.write(`${process.env.FAKE_VERSION ?? 'fake-acp 0.0.1'}\n`); process.exit(0) }
}
// 0.3.2: a scripted MCP client. `FAKE_MCP_SCRIPT` is a JSON file shaped
//   { match?: 'substring of the prompt', prompts: [ [ { name, arguments }, ... ], ... ] }
// One batch runs per prompt, sequentially, with the token this process holds. `match` narrows the
// script to one member's prompts (the Lead and a teammate share a provider). Each call's outcome
// (name, status, isError, ≤300 chars of text, sha8) is appended to FAKE_MCP_CALLS (or
// FAKE_MCP_PROBE) — never the token or the URL.
let scriptTurn = 0
// 0.4.15: `{ scripts: [ { match?, prompts }, ... ] }` — the first script whose `match` is in the
// prompt runs, with its own turn counter (a Lead and a teammate share one provider). A step
// `{ list: true }` records the tools/list names. FAKE_MCP_FETCH_MS (default 5000) bounds each
// request. A single-script file (the 0.3.2 shape) behaves exactly as before.
const scriptTurns = new Map()
const runMcpScript = async (servers, promptText = '') => {
  const file = process.env.FAKE_MCP_SCRIPT
  const outFile = process.env.FAKE_MCP_CALLS ?? process.env.FAKE_MCP_PROBE
  if (file === undefined || outFile === undefined) return
  let doc
  try { doc = JSON.parse(readFileSync(file, 'utf8')) } catch { return }
  let which = 'single'
  if (Array.isArray(doc?.scripts)) {
    const at = doc.scripts.findIndex((s) => typeof s?.match !== 'string' || promptText.includes(s.match))
    if (at < 0) return
    which = `s${at}`
    doc = doc.scripts[at]
  } else if (typeof doc?.match === 'string' && !promptText.includes(doc.match)) return
  const server = (Array.isArray(servers) ? servers : []).find((s) => s !== null && typeof s === 'object' && typeof s.url === 'string')
  if (server === undefined) return
  const turn = which === 'single' ? scriptTurn : (scriptTurns.get(which) ?? 0)
  if (which === 'single') scriptTurn += 1
  else scriptTurns.set(which, turn + 1)
  const batch = Array.isArray(doc?.prompts?.[turn]) ? doc.prompts[turn] : []
  const auth = Array.isArray(server.headers) ? server.headers.find((h) => h?.name === 'Authorization')?.value : undefined
  const token = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth : undefined
  const sha = token === undefined ? undefined : sha8(token.slice(7))
  const row = (value) => appendFileSync(outFile, JSON.stringify({ event: 'mcp-call', turn, sha8: sha, ...(which === 'single' ? {} : { script: which }), ...value }) + '\n')
  const rpc = async (method, params, id) => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === undefined ? {} : { authorization: token }) },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(Number(process.env.FAKE_MCP_FETCH_MS ?? 5000)),
    })
    let json
    try { json = await res.json() } catch {}
    return { status: res.status, json }
  }
  try {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fake-acp', version: '0.0.1' } }, 500)
  } catch {}
  for (let i = 0; i < batch.length; i += 1) {
    const step = batch[i] ?? {}
    // 0.4.13: two control steps so a real-host test can act in the MIDDLE of a member's turn.
    // `signal` writes a file (the test waits for it); `waitFile` holds this turn until the test
    // writes one. Neither makes a call or writes a row; scripts without them behave as before.
    if (typeof step.signal === 'string') { try { writeFileSync(step.signal, String(Date.now())) } catch {} continue }
    if (typeof step.waitFile === 'string') {
      const until = Date.now() + (Number.isSafeInteger(step.timeoutMs) ? step.timeoutMs : 15000)
      while (!existsSync(step.waitFile) && Date.now() < until) await new Promise((r) => setTimeout(r, 50))
      continue
    }
    if (step.list === true) {
      try {
        const res = await rpc('tools/list', {}, 401 + i)
        row({ i, list: (res.json?.result?.tools ?? []).map((t) => t?.name), status: res.status, rpcError: res.json?.error?.code })
      } catch (e) { row({ i, list: null, status: 0, error: String(e?.code ?? e?.message ?? e).slice(0, 80) }) }
      continue
    }
    const startedAt = Date.now()
    try {
      const res = await rpc('tools/call', { name: step.name, arguments: step.arguments ?? {} }, 501 + i)
      const result = res.json?.result
      const texts = Array.isArray(result?.content) ? result.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text) : []
      const text = texts[0]
      // `tail` only when there is more than one text block (0.4.13 A+ hint); old rows are unchanged.
      row({ i, name: step.name, status: res.status, isError: result?.isError === true, rpcError: res.json?.error?.code, text: typeof text === 'string' ? text.slice(0, 300) : undefined, ...(texts.length > 1 ? { tail: texts.at(-1).slice(0, 300) } : {}), ...(which === 'single' ? {} : { ms: Date.now() - startedAt }) })
    } catch (e) {
      row({ i, name: step.name, status: 0, error: String(e?.code ?? e?.message ?? e).slice(0, 80) })
    }
  }
}

const mode = process.env.FAKE_MODE ?? 'normal'
const record = (obj) => { if (process.env.FAKE_RECORD) appendFileSync(process.env.FAKE_RECORD, JSON.stringify(obj) + '\n') }
record({ event: 'start', argv: process.argv.slice(2), cwd: process.cwd(), pid: process.pid })
if (process.env.FAKE_STDERR) process.stderr.write(`${process.env.FAKE_STDERR}\n`)
const AUTH = process.env.FAKE_AUTH
const authError = (id) => send({ id, error: { code: -32000, message: process.env.FAKE_AUTH_MSG ?? 'Authentication required' } })

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } })
const text = (sessionId, t) => update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } })
const thought = (sessionId, t) => update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } })
const SID = 'fake-session-1'
let nextOutId = 1000
const pendingOut = new Map()
let pendingPrompt
/** 0.4.14: the steer-turn now running ({ id, rid, timers, injects, usage }), or undefined. */
let activeTurn
let cancelled = false

process.on('SIGTERM', () => { record({ event: 'sigterm' }); if (mode !== 'deaf') process.exit(0) })
// deaf: stay alive no matter what (only SIGKILL ends it)
if (mode === 'deaf') setInterval(() => {}, 1 << 30)

let promptCount = 0
let currentSid = SID
const loadMode = process.env.FAKE_LOAD
const state = () => { try { return JSON.parse(readFileSync(process.env.FAKE_STATE, 'utf8')) } catch { return {} } }
const saveState = (st) => { if (process.env.FAKE_STATE) writeFileSync(process.env.FAKE_STATE, JSON.stringify(st)) }
const MODEL_OPT = process.env.FAKE_MODEL_OPT   // comma list of model ids offered as a `model` configOption
const MODEL_VALUES = MODEL_OPT ? ['default', ...MODEL_OPT.split(',').map((x) => x.trim()).filter(Boolean)] : []
let model_ = MODEL_OPT ? 'default' : undefined
// Reasoning efforts as a `thought_level` configOption: "id:Name,id:Name" (name defaults to the id).
// Deliberately keeps an empty id: validation of bad CLI data belongs to the client.
const EFFORTS = (process.env.FAKE_EFFORTS ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
  const i = s.indexOf(':')
  return i < 0 ? { id: s, name: s } : { id: s.slice(0, i), name: s.slice(i + 1) }
})
const EFFORT_ID = process.env.FAKE_EFFORT_ID ?? 'thought_level'
const EFFORT_ERR = process.env.FAKE_EFFORT_ERR === '1'
let effort_ = process.env.FAKE_EFFORT_CURRENT ?? EFFORTS[0]?.id
const MODELS_FILE = process.env.FAKE_MODELS_FILE
/** Read at every session/new: undefined = knob off, { error } = "!fail", { models } = the list. */
function modelsFilePayload() {
  if (!MODELS_FILE) return undefined
  let raw
  try { raw = readFileSync(MODELS_FILE, 'utf8') } catch { return undefined } // missing ⇒ old behaviour
  if (raw.trim() === '!fail') return { error: { code: -32000, message: 'model discovery unavailable' } }
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean)
  return { models: { currentModelId: ids[0] ?? 'default', availableModels: ids.map((id) => ({ modelId: id, name: id })) } }
}
const MODELS_JSON = process.env.FAKE_MODELS_JSON
/** 0.4.7: the file's JSON array as the `models` extension, entries untouched; undefined = knob off. */
function modelsJsonPayload() {
  if (!MODELS_JSON) return undefined
  try {
    const list = JSON.parse(readFileSync(MODELS_JSON, 'utf8'))
    return Array.isArray(list) ? { currentModelId: list[0]?.modelId ?? 'default', availableModels: list } : undefined
  } catch { return undefined }
}
const CODEX = process.env.FAKE_MODES === 'codex'
// opencode: a `model` select AND a `mode` select in the same session, model first on the wire.
const OPENCODE = process.env.FAKE_MODES === 'opencode'
// pi-acp: `modes` are thinking levels, the configOption is category `thought_level`, and nothing
// here is a permission mode — the agent never asks before a tool runs.
const PI = process.env.FAKE_MODES === 'pi'
const PI_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']
let mode_ = PI ? (process.env.FAKE_MODE_CURRENT ?? 'high') : OPENCODE ? (process.env.FAKE_MODE_CURRENT ?? 'build') : CODEX ? (process.env.FAKE_MODE_CURRENT ?? 'read-only') : process.env.FAKE_MODES === 'bypass' ? 'bypassPermissions' : process.env.FAKE_MODES === 'ask' ? 'default' : process.env.FAKE_MODES === 'config-bypass' ? 'bypassPermissions' : undefined
const modelOptPayload = () => (MODEL_OPT
  ? [{ type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model_, options: MODEL_VALUES.map((value) => ({ value, name: value })) }]
  : [])
const modesPayload = () => {
  const inner = modesPayloadInner()
  const legacy = process.env.FAKE_MODELS_LEGACY === '1' && MODEL_OPT
    ? { models: { currentModelId: model_, availableModels: MODEL_VALUES.map((id) => ({ modelId: id, name: id })) } }
    : {}
  if (!MODEL_OPT) return { ...inner, ...legacy }
  // opencode and pi send the model option FIRST; a client that grabs "the first select" is wrong.
  const list = OPENCODE || PI ? [...modelOptPayload(), ...(inner.configOptions ?? [])] : [...(inner.configOptions ?? []), ...modelOptPayload()]
  return { ...inner, ...legacy, configOptions: list }
}
const modesPayloadInner = () => {
  const ids = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
  if (process.env.FAKE_NO_ASK === '1') return { modes: { currentModeId: 'bypassPermissions', availableModes: ['bypassPermissions', 'dontAsk'].map((id) => ({ id, name: id })) } }
  if (process.env.FAKE_MODES === 'bypass' || process.env.FAKE_MODES === 'ask') return { modes: { currentModeId: mode_, availableModes: ids.map((id) => ({ id, name: id })) } }
  if (CODEX) return { configOptions: [{ type: 'select', id: 'mode', name: 'Approval Preset', category: 'mode', currentValue: mode_, options: ['read-only', 'auto', 'full-access'].map((value) => ({ value, name: value })) }] }
  if (OPENCODE) return { configOptions: [{ type: 'select', id: 'mode', name: 'Session Mode', category: 'mode', currentValue: mode_, options: ['build', 'plan'].map((value) => ({ value, name: value })) }] }
  // pi-acp: thinking levels on BOTH the legacy `modes` field and a `thought_level` configOption.
  // Neither is a permission mode; `category: 'mode'` is deliberately absent.
  if (PI) {
    return {
      modes: { currentModeId: mode_, availableModes: PI_LEVELS.map((id) => ({ id, name: `Thinking: ${id}`, description: null })) },
      configOptions: [{ type: 'select', id: 'thought_level', name: 'Thinking', category: 'thought_level', currentValue: mode_, options: PI_LEVELS.map((value) => ({ value, name: `Thinking: ${value}` })) }],
    }
  }
  if (process.env.FAKE_MODES === 'config-bypass') return { configOptions: [{ type: 'select', id: 'mode', name: 'Permission Mode', category: 'mode', currentValue: mode_, options: ids.map((value) => ({ value, name: value })) }] }
  // A standalone reasoning option, like codebuddy's `thought_level`.
  if (EFFORTS.length > 0) return { configOptions: [{ type: 'select', id: EFFORT_ID, name: 'Reasoning', category: 'thought_level', currentValue: effort_, options: EFFORTS.map((e) => ({ value: e.id, name: e.name })) }] }
  return {}
}
async function onPrompt(id, params) {
  const promptText = (params.prompt ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  const images = (params.prompt ?? []).filter((b) => b.type === 'image').map((b) => ({ mimeType: b.mimeType, bytes: Buffer.from(b.data ?? '', 'base64').length }))
  promptCount++
  record({ event: 'prompt', text: promptText, images, sessionId: params.sessionId, turn: promptCount, pid: process.pid, mode: mode_, ...(MODEL_OPT ? { modelOpt: model_ } : {}) })
  if (loadMode === '1' && process.env.FAKE_STATE) { const st = state(); (st[params.sessionId] ??= []).push(promptText); saveState(st) }
  const done = (stopReason, extra = {}) => send({ id, result: { stopReason, ...extra } })
  switch (mode) {
    case 'normal':
    case 'models':
      thought(SID, 'thinking…')
      text(SID, 'Hello, ')
      text(SID, 'world')
      return done('end_turn')
    case 'usage':
      text(SID, 'counted')
      return done('end_turn', { usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 } })
    // A turn that ends cleanly having produced no update at all (Q-1: nothing to time).
    case 'silent-turn':
      return done('end_turn')
    case 'interleave':
      thought(SID, 'plan')
      text(SID, 'A')
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file x.js', kind: 'read', status: 'pending' })
      text(SID, 'B')
      return done('end_turn')
    case 'rpc-error':
      return send({ id, error: { code: -32603, message: 'model backend exploded' } })
    case 'queue-wait':
      // 0.4.1: what the Qoder adapter sends when the model queue is too long. The marker decides
      // the class (llm-acp L-1) and the code must never be retried.
      return send({ id, error: { code: -32000, message: '[queue-wait] qoder model queue is too long: model=DeepSeek-Flash estimated=1668s limit=120s position=3563 type=p3; the request was cancelled' } })
    case 'crash':
      text(SID, 'partial')
      setTimeout(() => process.exit(3), 20)
      return
    case 'garbage':
      process.stdout.write('this is not json\n')
      process.stdout.write('{"broken": \n')
      update(SID, { sessionUpdate: 'agent_message_chunk' }) // content missing
      update(SID, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'xx', mimeType: 'image/png' } })
      update(SID, { sessionUpdate: 'something_new', foo: 1 })
      send({ method: 'session/update', params: { sessionId: SID } }) // update missing
      text(SID, 'survived')
      return done('end_turn')
    case 'hang':
      pendingPrompt = id
      return
    case 'deaf':
      return
    case 'permission': {
      const outId = nextOutId++
      pendingOut.set(outId, (msg) => {
        const outcome = msg.result?.outcome
        record({ event: 'permission', outcome })
        text(SID, outcome?.outcome === 'selected' ? `chose:${outcome.optionId}` : 'chose:cancelled')
        done('end_turn')
      })
      send({ id: outId, method: 'session/request_permission', params: {
        sessionId: SID,
        toolCall: process.env.FAKE_PERM_KIRO
          // kiro-cli 2.24.1 shape: no rawInput.toolName; identity in _meta.mcpToolIdentity (params level, or toolCall level when FAKE_PERM_KIRO_AT=toolCall)
          ? { toolCallId: 'w1', title: `Running: ${process.env.FAKE_PERM_KIRO}`, rawInput: { __tool_use_purpose: 'fake purpose' }, ...(process.env.FAKE_PERM_KIRO_AT === 'toolCall' ? { _meta: { mcpToolIdentity: JSON.parse(process.env.FAKE_PERM_KIRO) } } : {}) }
          : { toolCallId: 'w1', title: 'Write a.txt', kind: 'edit', status: 'pending', ...(process.env.FAKE_PERM_TOOL_NAME ? { rawInput: { toolName: process.env.FAKE_PERM_TOOL_NAME, params: {} } } : {}) },
        ...(process.env.FAKE_PERM_KIRO && process.env.FAKE_PERM_KIRO_AT !== 'toolCall' ? { _meta: { mcpToolIdentity: JSON.parse(process.env.FAKE_PERM_KIRO) } } : {}),
        options: [
          { optionId: 'opt-always', name: 'Always', kind: 'allow_always' },
          { optionId: 'opt-once', name: 'Once', kind: 'allow_once' },
          { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
        ],
      } })
      return
    }
    case 'flaky': {
      // Rate-limit only the FIRST prompt this recorded run ever saw — even across process restarts,
      // because a retry spawns a brand new child and its in-process counter would reset.
      const seen = process.env.FAKE_RECORD && existsSync(process.env.FAKE_RECORD)
        ? readFileSync(process.env.FAKE_RECORD, 'utf8').split('\n').filter((l) => l.includes('"event":"prompt"')).length
        : promptCount
      if (seen <= 1) return send({ id, error: { code: -32000, message: '429 Too Many Requests: rate limit exceeded' } })
      text(SID, 'Hello, ')
      text(SID, 'world')
      return done('end_turn')
    }
    case 'flaky-after-text':
      // Emits text BEFORE failing: a retry here would duplicate output, so it must not happen.
      text(SID, 'partial-before-error')
      return send({ id, error: { code: -32000, message: '429 Too Many Requests' } })
    case 'stall-after-text': {
      // 0.4.4 (S-3): output arrives, then the agent goes quiet forever ⇒ an idle timeout AFTER the
      // host has seen chunks. Such a turn is still never replayed.
      text(SID, 'partial-before-silence')
      pendingPrompt = id
      return
    }
    case 'steer-turn': {
      // 0.4.14: a turn long enough to push into (see the 0.4.14 knobs). settleTurn() answers it and,
      // per FAKE_INJECT, any second prompt that arrived meanwhile.
      const n = promptCount
      const rid = `rid-${n}`
      const turn = { id, rid, timers: [], injects: [], usage: { inputTokens: 0, outputTokens: 10 * n, totalTokens: 100 * n } }
      activeTurn = turn
      if (process.env.FAKE_STEER !== undefined) {
        update(SID, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: promptText }, _meta: { 'codebuddy.ai/messageId': `cli-msg-${n}`, 'codebuddy.ai/conversationRequestId': rid, 'codebuddy.ai/requestId': rid } })
      }
      text(SID, 'working… ')
      update(SID, { sessionUpdate: 'tool_call', toolCallId: `s${n}`, title: 'Run step', kind: 'execute', status: 'pending' })
      const turnMs = Number(process.env.FAKE_TURN_MS ?? 600)
      const tailMs = Number(process.env.FAKE_TAIL_MS ?? 100)
      // 0.4.15: FAKE_TICK_MS=<n> ⇒ one text chunk every n ms while this turn runs (a long but
      // talkative turn). Unset ⇒ silent until FAKE_TURN_MS, as before.
      const tickMs = Number(process.env.FAKE_TICK_MS ?? 0)
      if (tickMs > 0) turn.timers.push(setInterval(() => text(SID, '.'), tickMs))
      turn.timers.push(setTimeout(() => {
        update(SID, { sessionUpdate: 'tool_call_update', toolCallId: `s${n}`, status: 'completed' })
        text(SID, 'final answer')
        turn.timers.push(setTimeout(() => settleTurn(turn, 'end_turn'), tailMs))
      }, turnMs))
      return
    }
    case 'slowtick': {
      // One character per 800 ms: lets tests measure whether chunks arrive incrementally.
      let n = 0
      const iv = setInterval(() => {
        n++
        text(SID, `c${n}`)
        if (n >= 3) { clearInterval(iv); done('end_turn') }
      }, 800)
      return
    }
    case 'perm-cancel': {
      // Like codebuddy: asks for a tool; if refused, ends the turn with stopReason "cancelled".
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 'w1', title: 'Write notes.md', kind: 'edit', status: 'pending' })
      const outId = nextOutId++
      pendingOut.set(outId, (msg) => {
        if (msg.result?.outcome?.outcome !== 'selected') return done('cancelled')
        text(SID, 'wrote it')
        done('end_turn')
      })
      send({ id: outId, method: 'session/request_permission', params: { sessionId: SID, toolCall: { toolCallId: 'w1', ...(process.env.FAKE_PERM_TOOL_NAME ? { rawInput: { toolName: process.env.FAKE_PERM_TOOL_NAME, params: {} } } : {}) }, /* no title, like codebuddy */
        options: [{ optionId: 'aa', name: 'Always', kind: 'allow_always' }, { optionId: 'a1', name: 'Allow', kind: 'allow_once' }, { optionId: 'r1', name: 'Reject', kind: 'reject_once' }] } })
      return
    }
    case 'self-cancel':
      return done('cancelled')
    case 'recall': {
      // Answers with how many prompts the NATIVE session has seen (across processes, via FAKE_STATE).
      const seen = loadMode === '1' ? (state()[params.sessionId] ?? []).length : promptCount
      text(currentSid, `native-turn-${seen}`)
      return done('end_turn')
    }
    case 'reuse':
      text(SID, `turn-${promptCount}`)
      return done('end_turn', { usage: { inputTokens: promptCount * 100, outputTokens: promptCount * 10, totalTokens: promptCount * 110 } })
    case 'empty':
      return done('end_turn')
    case 'tools-only':
      update(SID, { sessionUpdate: 'tool_call', toolCallId: 't9', title: 'Edit main.js', kind: 'edit', status: 'pending' })
      update(SID, { sessionUpdate: 'tool_call_update', toolCallId: 't9', status: 'completed' })
      return done('end_turn')
    case 'refusal':
      // 0.4.26: FAKE_REFUSAL_META=<string> ⇒ the refusal carries it as _meta['codebuddy.ai/errorMessage'],
      // like codebuddy 2.176 under a rate limit (FAKE_REFUSAL_META_KEY overrides the key).
      return done('refusal', process.env.FAKE_REFUSAL_META === undefined ? {} : { _meta: { [process.env.FAKE_REFUSAL_META_KEY ?? 'codebuddy.ai/errorMessage']: process.env.FAKE_REFUSAL_META, 'codebuddy.ai/requestId': 'rid-fake' } })
    case 'max':
      text(SID, 'truncated…')
      return done('max_tokens')
    default:
      text(SID, `unknown mode ${mode}`)
      return done('end_turn')
  }
}

/** 0.4.14: answer a steer-turn and, per FAKE_INJECT, the prompts injected into it. */
function settleTurn(turn, stopReason, usage = turn.usage, cancel = false) {
  for (const t of turn.timers) clearTimeout(t)
  turn.timers.length = 0
  if (activeTurn === turn) activeTurn = undefined
  record({ event: 'turn-end', rid: turn.rid, stopReason, injects: turn.injects.length })
  const how = process.env.FAKE_INJECT
  const answer = (u) => { for (const inj of turn.injects) send({ id: inj.id, result: { stopReason, usage: u } }) }
  const other = { inputTokens: 0, outputTokens: usage.outputTokens + 7, totalTokens: usage.totalTokens + 7 }
  // deveco 0.2.5 (R0 dv-live): a merged inject is answered in the same instant as the main prompt,
  // with equal usage, written just before it; the same happens on cancel.
  if (how === 'merge' || cancel) answer(usage)
  send({ id: turn.id, result: { stopReason, usage } })
  if (cancel) return
  // Only a prompt that was actually injected starts the extra turn; without one the turn is plain.
  if (turn.injects.length === 0) return
  if (how === 'late') setTimeout(() => { record({ event: 'late-reply', rid: turn.rid }); text(SID, 'LATE-NEWTURN-REPLY'); answer(other) }, 200)
  if (how === 'mismatch') setTimeout(() => answer(other), 20)
}

/** 0.4.14: a second session/prompt while a steer-turn runs (FAKE_INJECT set). */
function onInject(id, params) {
  const body = (params.prompt ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
  record({ event: 'inject', text: body, rid: activeTurn?.rid, sessionId: params.sessionId })
  if (process.env.FAKE_INJECT === 'reject') return send({ id, error: { code: -32603, message: 'session is busy' } })
  activeTurn.injects.push({ id, text: body })
}

function onMessage(msg) {
  if (msg.id !== undefined && msg.method === undefined) { // response to our request
    const cb = pendingOut.get(msg.id); pendingOut.delete(msg.id); cb?.(msg); return
  }
  switch (msg.method) {
    case 'initialize':
      if (mode === 'slow-init') return
      record({ event: 'initialize' })
      if (AUTH === 'init') return authError(msg.id)
      if (process.env.FAKE_INIT_DELAY_MS) { const id = msg.id; delete msg.id; setTimeout(() => onMessage({ ...msg, id, method: 'initialize-now' }), Number(process.env.FAKE_INIT_DELAY_MS)); return }
      // fall through
    case 'initialize-now':
      return send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: loadMode !== undefined, ...mcpCaps(), ...(process.env.FAKE_IMAGE === '1' ? { promptCapabilities: { image: true } } : {}), ...(process.env.FAKE_SESSION_CLOSE === '1' ? { sessionCapabilities: { close: {} } } : {}) }, authMethods: process.env.FAKE_AUTH_METHODS === '1' ? [{ id: 'browser', name: 'Log in with a browser', description: 'opens a browser' }] : [], ...agentInfoPayload() } })
    case 'session/new': {
      record({ event: 'session/new', cwd: msg.params?.cwd, mcpServers: viewMcp(msg.params?.mcpServers) })
      recordMcp('session/new', msg.params?.mcpServers)
      lastMcpServers = msg.params?.mcpServers
      probeMcp(lastMcpServers)
      if (AUTH === 'session') return authError(msg.id)
      if (mode === 'auth-error') return send({ id: msg.id, error: { code: -32000, message: 'Authentication required: please login' } })
      if (mode === 'no-session') return send({ id: msg.id, result: { modes: null } })
      const fromFile = modelsFilePayload()
      if (fromFile?.error !== undefined) return send({ id: msg.id, error: fromFile.error })
      const fromJson = modelsJsonPayload()
      currentSid = loadMode === '1' ? `native-${process.pid}-${Date.now()}` : SID
      return send({ id: msg.id, result: {
        sessionId: currentSid,
        ...modesPayload(),
        ...(fromJson !== undefined
          ? { models: fromJson }
          : fromFile?.models !== undefined
          ? { models: fromFile.models }
          : mode === 'models' ? { models: { currentModelId: 'auto', availableModels: [
            { modelId: 'auto', name: 'auto', description: 'pick for me' },
            { modelId: 'big-1', name: 'Big One' },
            { modelId: 'big-1', name: 'duplicate should be dropped' },
            { name: 'no id should be dropped' },
          ] } } : {}),
      } })
    }
    case 'session/load': {
      const sid = msg.params?.sessionId
      record({ event: 'session/load', sessionId: sid, mcpServers: viewMcp(msg.params?.mcpServers) })
      recordMcp('session/load', msg.params?.mcpServers)
      lastMcpServers = msg.params?.mcpServers
      probeMcp(lastMcpServers)
      // M0: codebuddy rejects session/load without mcpServers (`Invalid params`). Reproduce it.
      if (process.env.FAKE_LOAD_NEEDS_MCP === '1' && !(Array.isArray(msg.params?.mcpServers) && msg.params.mcpServers.length > 0)) {
        return send({ id: msg.id, error: { code: -32602, message: 'Invalid params: mcpServers is required' } })
      }
      if (loadMode === 'error') return send({ id: msg.id, error: { code: -32603, message: 'Internal error' } })
      if (process.env.FAKE_LOAD_NO_CONFIG === '1') {
        // A real agent may replay the history yet return no configOptions (R0.3): the load is
        // accepted, but neither the effort list nor its current value is known.
        const known = state()[sid]
        if (known !== undefined) {
          currentSid = sid
          for (const t of known) {
            update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } })
            update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD-REPLY-SHOULD-NOT-LEAK' } })
          }
        }
        return send({ id: msg.id, result: {} })
      }
      if (loadMode === 'silent') return send({ id: msg.id, result: { ...modesPayload() } })
      const past = state()[sid]
      if (past === undefined) return send({ id: msg.id, error: { code: -32603, message: 'Internal error' } })
      currentSid = sid
      // Replay history as notifications BEFORE answering (that is what real agents do).
      for (const t of past) {
        update(sid, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: t } })
        update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD-REPLY-SHOULD-NOT-LEAK' } })
      }
      return send({ id: msg.id, result: { ...modesPayload() } })
    }
    case 'session/set_mode':
      mode_ = msg.params?.modeId; record({ event: 'set_mode', modeId: mode_ })
      return send({ id: msg.id, result: {} })
    case 'session/set_config_option': {
      // F-4 (0.4.4): a CLI that stops answering config writes once a prompt is under way.
      // FAKE_DEAF_CONFIG_AFTER = answer while fewer than this many prompts have arrived, ignore after.
      if (process.env.FAKE_DEAF_CONFIG_AFTER !== undefined && promptCount >= Number(process.env.FAKE_DEAF_CONFIG_AFTER)) {
        record({ event: 'set_config_option-ignored', configId: msg.params?.configId })
        return
      }
      const cid = msg.params?.configId
      const val = msg.params?.value
      if (cid === 'model') {
        // A real agent validates the value (Claude Code answers "Invalid value for config option model").
        if (!MODEL_VALUES.includes(val)) return send({ id: msg.id, error: { code: -32602, message: `Invalid params: Invalid value for config option model: ${val}` } })
        model_ = val
      } else if ((PI || EFFORTS.length > 0) && cid === EFFORT_ID) {
        const offered = PI ? PI_LEVELS : EFFORTS.map((e) => e.id)
        if (EFFORT_ERR) return send({ id: msg.id, error: { code: -32602, message: 'Invalid params: this agent refuses the change' } })
        if (!offered.includes(val)) return send({ id: msg.id, error: { code: -32602, message: `Invalid params: Invalid value for config option ${cid}: ${val}` } })
        effort_ = val
        if (PI) mode_ = val // pi backs both the legacy mode and the option with one value
        record({ event: 'set-effort', configId: cid, value: val })
      } else { mode_ = val }
      record({ event: 'set_config_option', configId: cid, value: val })
      return send({ id: msg.id, result: { configOptions: [] } })
    }
    case 'session/prompt':
      if (AUTH === 'prompt') { record({ event: 'prompt', auth: true }); return authError(msg.id) }
      if (activeTurn !== undefined && process.env.FAKE_INJECT !== undefined) return onInject(msg.id, msg.params ?? {})
      // A warm CLI keeps its handshake token; every prompt uses exactly that token.
      probeMcp(lastMcpServers)
      // A scripted turn runs its calls BEFORE the prompt is answered, so they belong to this turn.
      if (process.env.FAKE_MCP_SCRIPT === undefined) return onPrompt(msg.id, msg.params ?? {})
      const promptText = (msg.params?.prompt ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('')
      runMcpScript(lastMcpServers, promptText).then(() => onPrompt(msg.id, msg.params ?? {}))
      return
    case 'session/steer': {
      const kind = process.env.FAKE_STEER
      // Unset ⇒ exactly the default branch below (an unknown method).
      if (kind === undefined) { record({ event: 'method', method: msg.method }); return send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } }) }
      const p = msg.params ?? {}
      const blocks = Array.isArray(p.contentBlocks) ? p.contentBlocks : []
      const body = blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('')
      record({ event: 'steer', text: body, expectedRequestId: p.expectedRequestId, clientUserMessageId: p.clientUserMessageId, sessionId: p.sessionId, rid: activeTurn?.rid })
      // codebuddy (R0 cb-live.log:22): empty contentBlocks is an Invalid params error.
      if (blocks.length === 0) return send({ id: msg.id, error: { code: -32602, message: 'Invalid params', data: 'Missing or empty "contentBlocks" array' } })
      if (kind === 'hang') return
      if (kind === 'idle') return send({ id: msg.id, result: { steered: false, reason: 'idle' } })
      if (kind === 'stale') return send({ id: msg.id, result: { steered: false, reason: 'stale' } })
      const turn = activeTurn
      if (turn === undefined) return send({ id: msg.id, result: { steered: false, reason: 'idle' } })
      const owner = process.env.FAKE_STEER_OWNER ?? turn.rid
      if (p.expectedRequestId !== undefined && p.expectedRequestId !== turn.rid && p.expectedRequestId !== owner) return send({ id: msg.id, result: { steered: false, reason: 'stale' } })
      send({ id: msg.id, result: { steered: true, ownerRequestId: owner } })
      if (kind === 'steered-noack') return
      const ackId = kind === 'steered-wrongack' ? 'someone-else' : p.clientUserMessageId
      // The echo comes when the CLI next consumes it (later than the answer), and only within the turn.
      setTimeout(() => {
        if (activeTurn !== turn) return
        update(SID, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: body }, _meta: { 'codebuddy.ai/requestId': turn.rid, 'codebuddy.ai/conversationRequestId': turn.rid, ...(ackId === undefined ? {} : { 'codebuddy.ai/messageId': ackId, 'codebuddy.ai/messageRequestId': ackId }) } })
      }, 30)
      return
    }
    case 'session/close':
      record({ event: 'session/close', sessionId: msg.params?.sessionId })
      return send({ id: msg.id, result: {} })
    case 'session/cancel':
      record({ event: 'cancel' })
      cancelled = true
      if (mode === 'hang' && pendingPrompt !== undefined) send({ id: pendingPrompt, result: { stopReason: 'cancelled' } })
      if (activeTurn !== undefined) settleTurn(activeTurn, process.env.FAKE_CANCEL_STOP ?? 'cancelled', { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, true)
      return
    default:
      record({ event: 'method', method: msg.method })
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    try { onMessage(JSON.parse(line)) } catch (e) { record({ event: 'bad-line', line, error: String(e) }) }
  }
})
process.stdin.on('end', () => { record({ event: 'stdin-end', cancelled }); if (mode !== 'deaf') process.exit(0) })
