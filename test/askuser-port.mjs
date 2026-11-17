// test/askuser-port.mjs — askUser ported from upstream guozi058/dsh-llm-acp 0.4.19 (MIT): a CLI
// permission request the channel would refuse is first put to DSH's approval service.
// Uses the upstream scripted ACP child (FAKE_MODE=permission: one edit request "Write a.txt",
// the reply text is `chose:<optionId>` or `chose:cancelled`).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAcpAdapter } from '../lib/adapter.js'
import { resolveProviders } from '../lib/config.js'
import { createLogger } from '../lib/log.js'

const FAKE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp.mjs')
const WORK = mkdtempSync(join(tmpdir(), 'llm-acp-askuser-'))

let failed = 0
let passed = 0
process.on('unhandledRejection', (e) => { failed++; console.log(`FAIL - unhandled rejection: ${e?.message ?? e}`) })
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 0

/** `answer(q)` plays DSH's approval service; every call is recorded in `asks`. */
function install(fields = {}, answer) {
  const n = ++seq
  const dir = join(WORK, `i${n}`)
  mkdirSync(dir, { recursive: true })
  const rec = join(dir, 'rec.jsonl')
  const providers = resolveProviders({ providers: { fake: {
    command: process.execPath, args: [FAKE],
    env: { FAKE_MODE: 'permission', FAKE_RECORD: rec },
    startupTimeoutMs: 3000, promptTimeoutMs: 8000, idleTimeoutMs: 6000, cancelGraceMs: 300, disposeGraceMs: 300,
    promptRetries: 0, startupRetries: 0, permission: 'reject', ...fields,
  } } })
  const lines = []
  const asks = []
  const ad = createAcpAdapter({
    Base: class {}, providers: () => providers, resolveCwd: async () => dir,
    stateFile: join(dir, 'store.json'), modelsFile: '',
    logger: createLogger({ sink: (l) => lines.push(l), now: () => 1000 }),
    ...(answer === undefined ? {} : { userApproval: { ask: async (q) => { asks.push(q); return answer(q) } } }),
  })
  const records = () => (existsSync(rec) ? readFileSync(rec, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { ad, asks, lines, records, permLog: () => lines.filter((l) => l.event === 'permission' && l.asked === true) }
}

const u = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const opts = (over = {}) => ({ provider: 'fake', model: 'default', sessionId: 's1', messages: [u('hi')], ...over })
async function collect(iter) { const out = []; for await (const c of iter) out.push(c); return out }
const textOf = (chunks) => chunks.filter((c) => typeof c?.text === 'string' && /text/.test(c.type) && !/reason/.test(c.type)).map((c) => c.text).join('')
async function turn(inst, over) { try { return textOf(await collect(inst.ad.stream(opts(over)))) } catch (e) { return `THREW:${e?.code ?? ''}:${e?.message ?? e}` } }
async function caseOf(name, fn) { try { await fn() } catch (e) { failed++; console.log(`FAIL - ${name} threw: ${e?.stack ?? e}`) } }

// A-1 askUser off: refused exactly as before, nobody asked.
await caseOf('A-1', async () => {
  const inst = install({}, () => 'allowed-once')
  try {
    const t = await turn(inst)
    ok(t.includes('chose:cancelled'), 'A-1 askUser off ⇒ refused', t)
    ok(inst.asks.length === 0, 'A-1 askUser off ⇒ DSH never asked', inst.asks)
  } finally { await inst.ad.dispose() }
})

// A-2 askUser on, DSH says allowed-once ⇒ the CLI's allow_once (never allow_always).
await caseOf('A-2', async () => {
  const inst = install({ askUser: true }, () => 'allowed-once')
  try {
    const t = await turn(inst)
    ok(t.includes('chose:opt-once'), 'A-2 allowed-once ⇒ allow_once picked', t)
    ok(inst.asks.length === 1, 'A-2 asked exactly once', inst.asks.length)
    const q = inst.asks[0] ?? {}
    ok(q.sessionId === 's1' && q.providerId === 'fake' && q.title === 'Write a.txt', 'A-2 question carries session, provider and tool title', { sessionId: q.sessionId, providerId: q.providerId, title: q.title })
    ok(q.signal instanceof AbortSignal, 'A-2 question carries an AbortSignal')
    ok(inst.permLog().some((l) => l.outcome === 'allowed-once'), 'A-2 logged asked + outcome', inst.permLog())
    ok(!JSON.stringify(inst.permLog()).includes('Write a.txt'), 'A-2 log line has no tool title')
  } finally { await inst.ad.dispose() }
})

// A-3 every other answer is the same refusal.
for (const [label, answer] of [['rejected', () => 'rejected'], ['cancelled', () => 'cancelled'], ['unavailable', () => 'unavailable'], ['garbage', () => 'yes please'], ['throw', () => { throw new Error('boom') }]]) {
  await caseOf(`A-3 ${label}`, async () => {
    const inst = install({ askUser: true }, answer)
    try {
      const t = await turn(inst)
      ok(t.includes('chose:cancelled') && inst.asks.length === 1, `A-3 answer ${label} ⇒ refused, turn still completes`, t)
    } finally { await inst.ad.dispose() }
  })
}

// A-4 no approval service at all ⇒ refused as before (askUser on but nothing to ask).
await caseOf('A-4', async () => {
  const inst = install({ askUser: true })
  try {
    const t = await turn(inst)
    ok(t.includes('chose:cancelled'), 'A-4 no userApproval ⇒ refused', t)
  } finally { await inst.ad.dispose() }
})

// A-5 permission allow: allowed without asking.
await caseOf('A-5', async () => {
  const inst = install({ askUser: true, permission: 'allow' }, () => 'rejected')
  try {
    const t = await turn(inst)
    ok(t.includes('chose:opt-once') && inst.asks.length === 0, 'A-5 permission allow ⇒ allow_once, never asked', { t, asks: inst.asks.length })
  } finally { await inst.ad.dispose() }
})

// A-6 local `read` policy: an edit it would refuse is asked too.
await caseOf('A-6', async () => {
  const inst = install({ askUser: true, permission: 'read' }, () => 'allowed-once')
  try {
    const t = await turn(inst)
    ok(t.includes('chose:opt-once') && inst.asks.length === 1, 'A-6 read policy: refused edit is put to DSH', { t, asks: inst.asks.length })
  } finally { await inst.ad.dispose() }
})

// A-7 a person thinking longer than idleTimeoutMs does not time the turn out.
await caseOf('A-7', async () => {
  const inst = install({ askUser: true, idleTimeoutMs: 400 }, async () => { await sleep(1300); return 'allowed-once' })
  try {
    const t = await turn(inst)
    ok(t.includes('chose:opt-once'), 'A-7 a 1.3 s approval survives a 0.4 s idle timeout', t)
  } finally { await inst.ad.dispose() }
})

// A-8 the turn is called off while DSH is asking ⇒ the approval's signal is aborted, nothing allowed.
await caseOf('A-8', async () => {
  let seen
  const inst = install({ askUser: true }, (q) => { seen = q.signal; return new Promise((r) => q.signal.addEventListener('abort', () => r('allowed-once'), { once: true })) })
  const ac = new AbortController()
  try {
    const p = turn(inst, { signal: ac.signal })
    for (let i = 0; i < 50 && inst.asks.length === 0; i++) await sleep(50)
    ac.abort()
    const t = await p
    ok(seen?.aborted === true, 'A-8 abort reaches the pending approval', { aborted: seen?.aborted })
    ok(!t.includes('chose:opt-once'), 'A-8 a late allowed-once after abort is not used', t)
    await sleep(200)
    ok(!inst.records().some((x) => x.event === 'permission' && x.outcome?.optionId === 'opt-once'), 'A-8 the CLI was never told allow_once', inst.records().filter((x) => x.event === 'permission'))
  } finally { await inst.ad.dispose() }
})

// A-9 config validation.
{
  let threw = false
  try { resolveProviders({ providers: { f: { command: 'x', askUser: 'yes' } } }) } catch { threw = true }
  ok(threw, 'A-9 askUser must be a boolean')
  ok(resolveProviders({ providers: { f: { command: 'x' } } }).get('f')?.askUser === false, 'A-9 askUser defaults to false')
  ok(resolveProviders({ providers: { f: { command: 'x', askUser: true } } }).get('f')?.askUser === true, 'A-9 askUser true kept')
}

rmSync(WORK, { recursive: true, force: true })
console.log(`\naskuser-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
