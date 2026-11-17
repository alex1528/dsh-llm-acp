// test/effort-port.mjs — reasoning effort ported from upstream guozi058/dsh-llm-acp (MIT):
// thought_level read from the CLI, reported by resolveModel, applied per turn, never failing a turn.
// Uses the upstream scripted ACP child test/fixtures/fake-acp.mjs (records set-effort / events).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpAdapter } from '../lib/adapter.js'
import { resolveProviders } from '../lib/config.js'
import { createLogger } from '../lib/log.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'llm-acp-effort-'))

let failed = 0
let passed = 0
process.on('unhandledRejection', (e) => { failed++; console.log(`FAIL - unhandled rejection: ${e?.message ?? e}`) })
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
let seq = 0

function install(env = {}, fields = {}) {
  const n = ++seq
  const dir = join(WORK, `i${n}`)
  mkdirSync(dir, { recursive: true })
  const rec = join(dir, 'rec.jsonl')
  const modelsFile = join(dir, 'models.cache.json')
  const providers = resolveProviders({ providers: { fake: {
    command: process.execPath, args: [FAKE],
    env: { FAKE_MODE: 'normal', FAKE_MODEL_OPT: 'm1,m2', FAKE_RECORD: rec, FAKE_STATE: join(dir, 'native.json'), ...env },
    startupTimeoutMs: 3000, promptTimeoutMs: 8000, idleTimeoutMs: 6000, cancelGraceMs: 300, disposeGraceMs: 300,
    promptRetries: 0, startupRetries: 0, ...fields,
  } } })
  const lines = []
  const build = () => createAcpAdapter({
    Base: class {}, providers: () => providers, resolveCwd: async () => dir,
    stateFile: join(dir, 'store.json'), modelsFile,
    logger: createLogger({ sink: (l) => lines.push(l), now: () => 1000 }),
  })
  const records = () => (existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return {
    build, lines, modelsFile, records,
    spawns: () => records().filter((x) => x.event === 'start').length,
    sets: () => records().filter((x) => x.event === 'set-effort'),
    events: () => records().map((x) => x.event),
    effortLog: () => lines.filter((l) => l.event === 'effort'),
  }
}

const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const a = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })
const opts = (over = {}) => ({ provider: 'fake', model: 'default', sessionId: 's1', messages: [u('hi')], ...over })
const history = (n) => { const out = [u('q1')]; for (let i = 1; i <= n; i++) { out.push(a('Hello, world')); out.push(u(`q${i + 1}`)) } return out }
async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }
const textOf = (chunks) => chunks.filter((c) => typeof c?.text === 'string' && /text/.test(c.type) && !/reason/.test(c.type)).map((c) => c.text).join('')
const done = (chunks) => textOf(chunks).includes('Hello, world')
const ids = (r) => r?.efforts?.map((e) => e.id).join()
async function caseOf(name, fn) { try { await fn() } catch (e) { failed++; console.log(`FAIL - ${name} threw: ${e?.stack ?? e}`) } }

// E-1 resolveModel reports the CLI's efforts after discovery, never a default.
await caseOf('E-1', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High' })
  const ad = inst.build()
  try {
    await ad.listModels('fake')
    const mi = await ad.resolveModel('fake', 'm1')
    ok(ids(mi.reasoning) === 'low,high' && mi.reasoning.efforts.map((e) => e.name).join() === 'Low,High', 'E-1 efforts ids/names come from thought_level', mi.reasoning)
    ok(!('defaultEffort' in (mi.reasoning ?? {})), 'E-1 no defaultEffort is returned', mi.reasoning)
    const d = await ad.resolveModel('fake', 'default')
    ok(ids(d.reasoning) === 'low,high', 'E-1 the default model carries the same efforts', d.reasoning)
  } finally { await ad.dispose() }
})

// E-2 a CLI without thought_level: no reasoning key, and resolveModel does not keep respawning it.
await caseOf('E-2', async () => {
  const inst = install({})
  const ad = inst.build()
  try {
    await ad.listModels('fake')
    const before = inst.spawns()
    const mi = await ad.resolveModel('fake', 'm1')
    await ad.resolveModel('fake', 'm1')
    await new Promise((r) => setTimeout(r, 300))
    ok(!('reasoning' in mi), 'E-2 no thought_level ⇒ no reasoning key', Object.keys(mi))
    ok(inst.spawns() === before, 'E-2 "no efforts" is remembered: resolveModel spawns nothing more', { before, after: inst.spawns() })
  } finally { await ad.dispose() }
})

// E-3 cold start: session/new → one set-effort → prompt.
await caseOf('E-3', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High' })
  const ad = inst.build()
  try {
    const chunks = await collect(ad.stream(opts({ reasoningEffort: 'high' })))
    const ev = inst.events()
    const sets = inst.sets()
    ok(done(chunks), 'E-3 the turn completes', chunks.slice(-3))
    ok(sets.length === 1 && sets[0].value === 'high' && sets[0].configId === 'thought_level', 'E-3 exactly one set-effort high on the option id', sets)
    const iNew = ev.indexOf('session/new'), iSet = ev.indexOf('set-effort'), iPrompt = ev.indexOf('prompt')
    ok(iNew >= 0 && iNew < iSet && iSet < iPrompt, 'E-3 order session/new → set-effort → prompt', ev)
  } finally { await ad.dispose() }
  const inst2 = install({ FAKE_EFFORTS: 'low:Low,high:High', FAKE_EFFORT_ID: 'effort' })
  const ad2 = inst2.build()
  try {
    await collect(ad2.stream(opts({ reasoningEffort: 'high' })))
    ok(inst2.sets().length === 1 && inst2.sets()[0].configId === 'effort', 'E-3 option id is not hardcoded (id=effort)', inst2.sets())
  } finally { await ad2.dispose() }
})

// E-4 nothing wanted and no channel effort ⇒ nothing sent.
await caseOf('E-4', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High' })
  const ad = inst.build()
  try {
    await collect(ad.stream(opts()))
    ok(inst.sets().length === 0, 'E-4 no reasoningEffort, no effort ⇒ 0 set-effort', inst.sets())
  } finally { await ad.dispose() }
})

// E-5 precedence: host pick > channel effort, applied once.
await caseOf('E-5', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High' }, { effort: 'low' })
  const ad = inst.build()
  try {
    await collect(ad.stream(opts({ reasoningEffort: 'high' })))
    ok(inst.sets().map((s) => s.value).join() === 'high', 'E-5 host pick wins over channel effort, one switch only', inst.sets())
  } finally { await ad.dispose() }
  const inst2 = install({ FAKE_EFFORTS: 'low:Low,high:High', FAKE_EFFORT_CURRENT: 'high' }, { effort: 'low' })
  const ad2 = inst2.build()
  try {
    await collect(ad2.stream(opts()))
    ok(inst2.sets().map((s) => s.value).join() === 'low', 'E-5 channel effort used when the host sends nothing', inst2.sets())
  } finally { await ad2.dispose() }
})

// E-6 warm session: no resend of the same value; baseline restored when the pick goes away.
await caseOf('E-6', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,medium:Medium,high:High', FAKE_EFFORT_CURRENT: 'medium' })
  const ad = inst.build()
  try {
    await collect(ad.stream(opts({ sessionId: 'w', messages: history(0), reasoningEffort: 'high' })))
    await collect(ad.stream(opts({ sessionId: 'w', messages: history(1) })))
    await collect(ad.stream(opts({ sessionId: 'w', messages: history(2) })))
    ok(inst.sets().map((s) => s.value).join() === 'high,medium', 'E-6 high → (none) restores the baseline once', inst.sets())
    ok(inst.spawns() === 1, 'E-6 the warm session never restarts', inst.spawns())
  } finally { await ad.dispose() }
  const inst2 = install({ FAKE_EFFORTS: 'low:Low,medium:Medium,high:High', FAKE_EFFORT_CURRENT: 'medium' })
  const ad2 = inst2.build()
  try {
    await collect(ad2.stream(opts({ sessionId: 'x', messages: history(0), reasoningEffort: 'high' })))
    await collect(ad2.stream(opts({ sessionId: 'x', messages: history(1), reasoningEffort: 'high' })))
    ok(inst2.sets().length === 1, 'E-6 the same value is not sent again', inst2.sets())
    await collect(ad2.stream(opts({ sessionId: 'x', messages: history(2), reasoningEffort: 'low' })))
    ok(inst2.sets().map((s) => s.value).join() === 'high,low', 'E-6 high → low sends exactly one change', inst2.sets())
  } finally { await ad2.dispose() }
})

// E-8 a value the CLI does not offer is never sent and never fails the turn.
await caseOf('E-8', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,medium:Medium' })
  const ad = inst.build()
  try {
    const chunks = await collect(ad.stream(opts({ reasoningEffort: 'ultra' })))
    ok(done(chunks), 'E-8 the turn still completes', chunks.slice(-3))
    ok(!inst.sets().some((s) => s.value === 'ultra'), 'E-8 the unknown value is never sent', inst.sets())
    ok(inst.effortLog().some((l) => l.code === 'EFFORT_UNKNOWN'), 'E-8 logged as EFFORT_UNKNOWN', inst.effortLog())
  } finally { await ad.dispose() }
  const inst2 = install({ FAKE_EFFORTS: 'low:Low,medium:Medium', FAKE_EFFORT_CURRENT: 'medium' }, { effort: 'low' })
  const ad2 = inst2.build()
  try {
    await collect(ad2.stream(opts({ reasoningEffort: 'ultra' })))
    ok(inst2.sets().map((s) => s.value).join() === 'low', 'E-8 unknown pick falls back to the channel effort', inst2.sets())
  } finally { await ad2.dispose() }
})

// E-9 a CLI refusing the switch never fails the turn.
await caseOf('E-9', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High', FAKE_EFFORT_ERR: '1' })
  const ad = inst.build()
  try {
    const chunks = await collect(ad.stream(opts({ reasoningEffort: 'high' })))
    ok(done(chunks), 'E-9 the turn completes despite the refusal', chunks.slice(-3))
    ok(inst.effortLog().some((l) => l.code === 'EFFORT_REJECTED'), 'E-9 logged as EFFORT_REJECTED', inst.effortLog())
  } finally { await ad.dispose() }
})

// E-10 pi: thought_level and legacy modes are one knob ⇒ no set_mode while an effort is applied.
await caseOf('E-10', async () => {
  const inst = install({ FAKE_MODES: 'pi', FAKE_MODE_CURRENT: 'medium' }, { permission: 'allow', approvals: 'none', mode: 'low' })
  const ad = inst.build()
  try {
    await collect(ad.stream(opts({ reasoningEffort: 'high' })))
    ok(inst.sets().map((s) => s.value).join() === 'high', 'E-10 want=high sent as set_config_option', inst.sets())
    ok(!inst.records().some((x) => x.event === 'set_mode'), 'E-10 no set_mode when an effort is wanted', inst.records().filter((x) => x.event === 'set_mode'))
  } finally { await ad.dispose() }
  const inst2 = install({ FAKE_MODES: 'pi', FAKE_MODE_CURRENT: 'medium' }, { permission: 'allow', approvals: 'none', mode: 'low' })
  const ad2 = inst2.build()
  try {
    await collect(ad2.stream(opts()))
    const sm = inst2.records().filter((x) => x.event === 'set_mode')
    ok(sm.length === 1 && sm[0].modeId === 'low' && inst2.sets().length === 0, 'E-10 without a want, mode: still uses set_mode', { sm, sets: inst2.sets() })
  } finally { await ad2.dispose() }
})

// E-13 efforts persist in the models cache: a restart reports them without starting the CLI.
await caseOf('E-13', async () => {
  const inst = install({ FAKE_EFFORTS: 'low:Low,high:High', FAKE_EFFORT_CURRENT: 'high' })
  const ad = inst.build()
  try { await ad.listModels('fake') } finally { await ad.dispose() }
  const disk = JSON.parse(readFileSync(inst.modelsFile, 'utf8')).entries?.fake
  ok(disk?.efforts?.map((e) => e.id).join() === 'low,high' && disk?.effortDefault === 'high', 'E-13 disk keeps efforts + effortDefault', disk)
  const before = inst.spawns()
  const ad2 = inst.build()
  try {
    const mi = await ad2.resolveModel('fake', 'm1')
    ok(ids(mi.reasoning) === 'low,high', 'E-13 restart reports efforts from disk', mi.reasoning)
    ok(inst.spawns() === before, 'E-13 no CLI started for it', { before, after: inst.spawns() })
  } finally { await ad2.dispose() }
})

// E-14 config validation.
for (const [bad, why] of [['', 'empty'], [7, 'number'], ['x'.repeat(65), 'too long'], ['a\nb', 'control char']]) {
  let threw = false
  try { resolveProviders({ providers: { f: { command: 'x', effort: bad } } }) } catch { threw = true }
  ok(threw, `E-14 effort rejected: ${why}`)
}
ok(resolveProviders({ providers: { f: { command: 'x', effort: ' high ' } } }).get('f')?.effort === 'high', 'E-14 effort trimmed and kept')

rmSync(WORK, { recursive: true, force: true })
console.log(`\neffort-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
