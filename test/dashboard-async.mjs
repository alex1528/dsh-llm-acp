// Offline test: the dashboard payload answers fast and marks slow provider probes as pending.
import assert from 'node:assert/strict'
import { buildPayload } from '../lib/dashboard-host.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])

function fakeState({ catalogMs }) {
  let calls = 0
  let cached
  const p = { id: 'slow', displayName: 'Slow', command: '/usr/bin/true', args: ['acp'], permission: 'reject', modelVia: 'args', env: {} }
  const state = {
    providers: new Map([[p.id, p]]),
    prefs: { isProviderDisabled: () => false, get: () => ({ disabledModels: {}, disabledProviders: [] }) },
    usage: { read: () => [], file: '' },
    adapter: {
      // Same contract as the real adapter: the in-flight promise is cached, so polls reuse it.
      catalog: () => { if (!cached) { calls++; cached = new Promise((r) => setTimeout(() => r([{ id: 'default', name: 'd' }, { id: 'm1', name: 'M1' }]), catalogMs)) } return cached },
      runtime: () => ({}),
      sessionDirectory: () => [],
    },
  }
  return { state, calls: () => calls }
}

t('slow catalog ⇒ fast answer marked pending, then filled in without re-running', async () => {
  const { state, calls } = fakeState({ catalogMs: 2000 })
  const t0 = Date.now()
  const first = await buildPayload(state, '7', { waitMs: 300 })
  const ms = Date.now() - t0
  assert.ok(ms < 1500, `first answer took ${ms}ms`)
  assert.equal(first.pending, true)
  assert.equal(first.providers[0].models, null)
  assert.equal(first.providers[0].status, 'loading')
  await new Promise((r) => setTimeout(r, 2100))
  const second = await buildPayload(state, '7', { waitMs: 300 })
  assert.equal(second.providers[0].models.length, 2)
  assert.equal(second.providers[0].status, 'ok')
  assert.equal(calls(), 1, 'catalog discovery must not restart per poll')
})

t('without waitMs (refresh button) it still waits for everything', async () => {
  const { state } = fakeState({ catalogMs: 600 })
  const r = await buildPayload(state, '7', {})
  assert.equal(r.pending, false)
  assert.equal(r.providers[0].models.length, 2)
})

let failed = 0
for (const [name, fn] of tests) {
  try { await fn(); console.log(`ok   ${name}`) } catch (e) { failed++; console.log(`FAIL ${name}\n     ${e?.stack?.split('\n').slice(0, 3).join('\n     ')}`) }
}
console.log(`\ndashboard-async: ${tests.length - failed}/${tests.length} passed`)
process.exit(failed ? 1 : 0)
