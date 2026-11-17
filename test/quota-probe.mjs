// Unit tests for lib/usage-probe.js — pure parsing / normalisation, no real CLI spawning.
import assert from 'node:assert/strict'
import { parseKeyValue, parseProbeOutput, probeUsage, clearUsageCache, PROBES } from '../lib/usage-probe.js'

const tests = []
const t = (name, fn) => tests.push([name, fn])

const DEVOCO = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                            128 │
│Messages                                             41 │
│Days                                                131 │
└────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                        $1.25 │
│Input                                             11.7K │
│Output                                             6.3K │
│Cache Read                                         2.0M │
└────────────────────────────────────────────────────────┘`

const CURSOR = `About Cursor CLI

CLI Version         2026.05.28-418efe5
Model               Composer 2.5 Fast
Subscription Tier   Pro
OS                  darwin (arm64)
User Email          jane.doe@example.com`

const QODER = `Version: 1.1.90
Username: jane
Email: jane.doe@example.com
User Type: personal_standard
Login Method: browser`

t('parseKeyValue colon + padding', () => {
  const kv = parseKeyValue(QODER)
  assert.equal(kv['user type'], 'personal_standard')
  assert.equal(kv['username'], 'jane')
})

t('parseKeyValue strips box chars', () => {
  const kv = parseKeyValue(DEVOCO)
  assert.equal(kv['sessions'], '128')
  assert.equal(kv['total cost'], '$1.25')
})

t('deveco parse cost/tokens/sessions', () => {
  const v = parseProbeOutput('deveco', DEVOCO)
  assert.equal(v.cost, '$1.25')
  assert.equal(v.sessions, '128')
  assert.equal(v.tokens.input, '11.7K')
  assert.equal(v.tokens.output, '6.3K')
  assert.equal(v.tokens.cacheRead, '2.0M')
  assert.match(v.note, /本地累计/)
})

t('cursor parse tier + masked email', () => {
  const v = parseProbeOutput('cursor-agent', CURSOR)
  assert.equal(v.tier, 'Pro')
  assert.equal(v.identity, 'j***@example.com')
  assert.equal(v.model, 'Composer 2.5 Fast')
  assert.equal(JSON.stringify(v).includes('jane.doe'), false, 'raw email must be masked')
})

t('qoder parse account type', () => {
  const v = parseProbeOutput('qodercli', QODER)
  assert.equal(v.tier, 'personal_standard')
  assert.equal(v.identity, 'j***@example.com')
})

t('empty output yields no data', () => {
  const v = parseProbeOutput('deveco', '\n\n')
  assert.equal(v.tier, undefined)
  assert.equal(v.cost, undefined)
  assert.equal(v.tokens, undefined)
})

t('PROBES has built-in recipes', () => {
  for (const k of ['deveco', 'cursor-agent', 'qodercli']) {
    assert.ok(Array.isArray(PROBES[k].args) && PROBES[k].args.length > 0)
  }
})

t('probeUsage unsupported CLI never throws', async () => {
  clearUsageCache()
  const r = await probeUsage({ id: 'x', command: '/no/such/unknown-cli' })
  assert.equal(r.supported, false)
  assert.equal(r.provider, 'x')
})

let pass = 0, fail = 0
for (const [name, fn] of tests) {
  try { await fn(); pass++ } catch (e) { fail++; console.error('FAIL', name, '\n ', e.message) }
}
console.log(`quota-probe: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
