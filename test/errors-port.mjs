// test/errors-port.mjs — error classification ported from upstream guozi058/dsh-llm-acp:
//   0.4.23 (3d431bd) quota words must stand alone; a local disk quota (EDQUOT) is not a provider quota
//   classifyError: -32000 counts as AUTH only when the agent advertised authMethods
//   0.4.26 (616ee45) a refusal whose _meta carries the provider's error is a failed turn with it
// Cases adapted from upstream test/quota-0423.mjs and test/refusal-meta-0426.mjs (MIT). The Qoder
// adapter markers ([queue-wait], [cli-sdk-mismatch]) do not exist here and are left out; the
// local-only rules (out of credit, billing / credit limit, overload, SERVER) are covered instead.
// No subprocess; exit code is the verdict.
import { AcpError, classifyError, classifyMessage, refusalFailure } from '../lib/errors.js'

let failed = 0
let passed = 0
const ok = (cond, msg, detail) => {
  if (cond) { passed++; console.log(`ok   - ${msg}`) }
  else { failed++; console.log(`FAIL - ${msg}${detail === undefined ? '' : `\n       ↳ ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`) }
}
const Q = 'QUOTA_EXCEEDED', E = 'ACP_ERROR', R = 'RATE_LIMIT', A = 'AUTH', S = 'SERVER'
const check = (id, text, want) => { const got = classifyMessage(text); ok(got === want, `${id} ${JSON.stringify(text)} ⇒ ${want}`, got) }

// ── quota words (upstream Q-1 … Q-4) ─────────────────────────────────────────────────────────
;[
  ['429 You exceeded your current quota, please check your plan and billing details', Q],
  ['error code: insufficient_quota', Q],
  ['quota_exceeded', Q],
  ['reason: quotaExceeded', Q],
  ['Quota exceeded for model', Q],
  ['monthly quotas exhausted', Q],
  ['insufficient credits', Q],
  ['insufficient_credit', Q],
  ['Claude AI usage limit reached|1731000000', Q],
  ['usage limits reached', Q],
  ['Unterminated string: missing closing quotation mark', E],
  ['write failed: Disk quota exceeded', E],
  ['write failed: Disc quota exceeded', E],
  ['EDQUOT: write /tmp/x', E],
  ['Disk quota exceeded; also insufficient_quota', Q],
  ['Disc quota exceeded; your quota is exceeded', Q],
  ['connection reset by peer', E],
].forEach(([t, w], i) => check(`Q-1.${i + 1}`, t, w))
;['QUOTA_EXCEEDED', 'quota-exceeded', 'Quota123', 'quotaLimitReached', 'QuotaExceededError', 'insufficientQuota',
  'userQuotaExceeded', 'dailyQuota exceeded', 'APIQuotaExceeded', 'quotaExhausted', 'quota.reached',
  'RESOURCE_EXHAUSTED: Quota exceeded for quota metric', 'insufficient credit balance'].forEach((t, i) => check(`Q-3.${i + 1}`, t, Q))
;['missingQuotation', 'QUOTATION_MARK expected', 'unquoted key at 3:7', 'usage limitation notice',
  'misquotation in config', 'insufficient creditworthiness check'].forEach((t, i) => check(`Q-4.${i + 1}`, t, E))

// ── local-only rules keep working ────────────────────────────────────────────────────────────
;[
  ['you are out of credits', Q], ['out of credit', Q], ['billing limit reached', Q], ['credit limit exceeded', Q],
  ['credit limitation policy', E],
  ['429 Too Many Requests', R], ['rate limit exceeded, retry in 20s', R], ['model is overloaded', R], ['please slow down', R],
  ['503 service unavailable', S], ['bad gateway', S], ['internal error', S],
  ['401 Unauthorized', A], ['not logged in', A],
  ['401 Unauthorized: insufficient_quota', Q],          // quota before AUTH
  ['403 forbidden: missing closing quotation mark', A], // no longer swallowed by quota
  ['429 Too Many Requests (Disc quota exceeded on cache dir)', R],
].forEach(([t, w], i) => check(`L-${i + 1}`, t, w))

// ── no regex state carried between calls ─────────────────────────────────────────────────────
{
  const seq = []
  for (let i = 0; i < 5; i++) seq.push(classifyMessage('write failed: Disc quota exceeded'), classifyMessage('insufficient_quota'), classifyMessage('userQuotaExceeded'))
  ok(JSON.stringify(seq) === JSON.stringify(Array.from({ length: 5 }, () => [E, Q, Q]).flat()), 'Q-6 alternating repeated calls are stable', seq)
}

// ── classifyError ────────────────────────────────────────────────────────────────────────────
{
  const e = (code, message, data) => Object.assign(new Error(message), { code, data })
  ok(classifyError(e(-32603, 'upstream refused', { message: 'insufficient_quota' })) === Q, 'C-1 quota in data.message ⇒ QUOTA_EXCEEDED')
  ok(classifyError(e(-32603, 'upstream refused', 'rate limit hit')) === R, 'C-2 string data is read too')
  ok(classifyError(e(-32603, 'write failed: Disc quota exceeded')) === E, 'C-3 local disk quota ⇒ ACP_ERROR')
  ok(classifyError(e(-32000, 'Authentication required'), { authMethods: [] }) === A, 'C-4 the text alone can say AUTH')
  ok(classifyError(e(-32000, 'something went wrong'), { authMethods: [{ id: 'x' }] }) === A, 'C-5 bare -32000 + authMethods ⇒ AUTH')
  ok(classifyError(e(-32000, 'something went wrong'), { authMethods: [] }) === E, 'C-6 bare -32000 without authMethods ⇒ ACP_ERROR')
  ok(classifyError(e(-32000, 'something went wrong')) === E, 'C-7 no context ⇒ ACP_ERROR')
  ok(classifyError(e(-32000, '429 rate limited'), { authMethods: [{ id: 'x' }] }) === R, 'C-8 a named class wins over -32000')
  ok(classifyError(e(-32000, 'bad JSON: missing closing quotation mark'), { authMethods: [{ id: 'x' }] }) === A, 'C-9 a quotation no longer pre-empts the -32000 auth rule')
  ok(classifyError(undefined) === E && classifyError('plain 401') === A, 'C-10 non-Error values never throw')
}

// ── refusalFailure (upstream U-1 … U-14) ─────────────────────────────────────────────────────
const CB_TEXT = 'Quota exceeded: 429 您的使用量已超出频率限制，将在 2026-11-15 23:54:43 UTC+8 重置，您也可以切换其他模型继续使用。 (aaaa/bbbb)'
const CB_META = JSON.stringify({ code: -32003, message: CB_TEXT, data: { statusCode: 429, details: CB_TEXT.replace('Quota exceeded: ', ''), code: 6004, category: 'quota' } })
const KEY = 'codebuddy.ai/errorMessage'
{
  const e = refusalFailure({ stopReason: 'refusal', userMessageId: 'u1', _meta: { 'codebuddy.ai/requestId': 'r1', [KEY]: CB_META } })
  ok(e instanceof AcpError, 'U-1 codebuddy rate-limit refusal ⇒ AcpError', e)
  ok(e?.code === Q && e?.failure?.code === Q, 'U-1 classified QUOTA_EXCEEDED', e?.code)
  ok(e?.message.includes('使用量已超出频率限制') && e?.message.includes('2026-11-15 23:54:43 UTC+8'), 'U-1 the provider\'s own words ride along', e?.message)
  ok(e?.message.startsWith('the agent refused the turn because its provider failed: '), 'U-1 message says what happened', e?.message)
  ok(!e?.message.includes('-32003') && !e?.message.includes('"data"'), 'U-1 the JSON envelope is unwrapped', e?.message)
}
ok(refusalFailure({ stopReason: 'refusal' }) === undefined, 'U-2 refusal without _meta ⇒ unchanged')
ok(refusalFailure({ stopReason: 'refusal', _meta: { 'codebuddy.ai/requestId': 'r1' } }) === undefined, 'U-3 _meta without errorMessage ⇒ unchanged')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: '' } }) === undefined, 'U-4 empty errorMessage ⇒ unchanged')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: '   ' } }) === undefined, 'U-4 blank errorMessage ⇒ unchanged')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: { message: 'x' } } }) === undefined, 'U-5 non-string errorMessage ⇒ unchanged')
ok(refusalFailure({ stopReason: 'refusal', _meta: null }) === undefined, 'U-5 _meta null ⇒ unchanged')
for (const sr of ['end_turn', 'cancelled', 'max_tokens', undefined]) {
  ok(refusalFailure({ stopReason: sr, _meta: { [KEY]: CB_META } }) === undefined, `U-6 stopReason ${sr} ⇒ untouched`)
}
ok(refusalFailure(undefined) === undefined && refusalFailure(null) === undefined && refusalFailure('refusal') === undefined, 'U-7 non-object ⇒ undefined')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: '429 Too Many Requests' } })?.code === R, 'U-8 plain text ⇒ RATE_LIMIT')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: JSON.stringify('401 unauthorized') } })?.code === A, 'U-9 JSON string value ⇒ AUTH')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: '{"message":"backend exploded"}' } })?.code === E, 'U-10 unrecognised ⇒ ACP_ERROR')
ok(refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: JSON.stringify({ code: 1, data: { details: 'rate limit hit' } }) } })?.code === R, 'U-11 data.details still classified')
ok(refusalFailure({ stopReason: 'refusal', _meta: { errorMessage: 'quota exceeded' } })?.code === Q, 'U-12 bare key accepted')
ok(refusalFailure({ stopReason: 'refusal', _meta: { 'x.errorMessage': 'quota exceeded' } })?.code === Q, 'U-12 dotted key accepted')
ok(refusalFailure({ stopReason: 'refusal', _meta: { errorMessageId: 'quota exceeded' } }) === undefined, 'U-13 errorMessageId is not the key')
ok(refusalFailure({ stopReason: 'refusal', _meta: { myerrorMessage: 'quota exceeded' } }) === undefined, 'U-13 myerrorMessage is not the key')
{
  const e = refusalFailure({ stopReason: 'refusal', _meta: { [KEY]: `quota ${'x'.repeat(5000)}` } })
  const prefix = 'the agent refused the turn because its provider failed: '.length
  ok(e !== undefined && e.message.length <= prefix + 601 && e.message.endsWith('…'), 'U-14 long provider text is capped', e?.message.length)
}

console.log(`\nerrors-port: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
