// lib/usage.js — per-turn usage log for the ACP console.
//
// One JSON line per finished turn (see adapter #recordTurn):
//   { at, provider, model, session?, cwd?, ok, ms, aborted?, code?, message?, chars?,
//     inputTokens?, outputTokens?, cacheReadTokens?, cacheWriteTokens?, estimated? }
// `estimated: true` means the CLI reported no token usage and the figures are chars/4.
// The file rotates once to `.1` past 20 MB; reads are cached by size+mtime.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_BYTES = 20 * 1024 * 1024
const statKey = (f) => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

export function createUsageLog({ file, warn = () => {} }) {
  let broken = false
  let cache = { key: '', records: [] }
  return {
    file,
    append(rec) {
      if (!file || broken) return
      try {
        mkdirSync(dirname(file), { recursive: true })
        try { if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`) } catch { /* no file yet */ }
        appendFileSync(file, `${JSON.stringify(rec)}\n`, { mode: 0o600 })
      } catch (e) {
        broken = true // stop retrying every turn
        warn('usage', { phase: 'write', message: e?.message })
      }
    },
    read() {
      if (!file) return []
      const key = `${statKey(`${file}.1`)}|${statKey(file)}`
      if (cache.key === key) return cache.records
      const records = []
      for (const f of [`${file}.1`, file]) {
        let text
        try { text = readFileSync(f, 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          if (!line) continue
          try { const r = JSON.parse(line); if (r && typeof r.at === 'number' && typeof r.provider === 'string') records.push(r) } catch { /* torn line */ }
        }
      }
      cache = { key, records }
      return records
    },
  }
}

/** Local calendar day, YYYY-MM-DD. */
export const dayOf = (t) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const bucket = (extra) => ({ ...extra, turns: 0, ok: 0, failed: 0, aborted: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, chars: 0, estimatedTokens: 0, ms: 0, estimated: 0, lastAt: 0 })
/** A turn ended by us (abort, plugin reload) rather than by a CLI failure. Old records lack `aborted` for DISPOSED. */
export const isAborted = (r) => r?.aborted === true || r?.code === 'DISPOSED'
const add = (b, r) => {
  b.turns++
  if (r.ok) b.ok++; else if (isAborted(r)) b.aborted++; else b.failed++
  b.inputTokens += num(r.inputTokens)
  b.outputTokens += num(r.outputTokens)
  b.cacheReadTokens += num(r.cacheReadTokens)
  b.cacheWriteTokens += num(r.cacheWriteTokens)
  b.chars += num(r.chars)
  b.ms += num(r.ms)
  if (r.estimated) { b.estimated++; b.estimatedTokens += num(r.inputTokens) + num(r.outputTokens) }
  b.lastAt = Math.max(b.lastAt, num(r.at))
}
const get = (map, key, extra) => { let b = map.get(key); if (!b) { b = bucket(extra); map.set(key, b) } return b }
/** Per-day slice for one model (or provider): token split + turns, for the trend chart's dimensions. */
const addSlice = (map, key, r) => {
  const e = map[key] ?? (map[key] = { inputTokens: 0, outputTokens: 0, turns: 0 })
  e.inputTokens += num(r.inputTokens)
  e.outputTokens += num(r.outputTokens)
  e.turns++
}

/** Totals, per provider / model / day / session, error codes and the most recent turns since `since`.
 *  Each byDay bucket also carries `providers` (provider → total tokens, kept a number for the
 *  provider sparkline) and `models` (`provider/model` → { inputTokens, outputTokens, turns }) so
 *  the daily trend can be split by model or by provider. bySession carries the same model slices
 *  per session (top 100 by tokens; sessionCount is the uncapped distinct-session count). */
export function aggregate(records, { since = 0, until = 0, recent = 100, now = Date.now() } = {}) {
  const rows = records.filter((r) => num(r.at) >= since && (until <= 0 || num(r.at) <= until))
  const end = until > 0 ? Math.min(now, until) : now
  const total = bucket()
  const byP = new Map()
  const byM = new Map()
  const byD = new Map()
  const byS = new Map()
  const errs = new Map()
  const hours = Array.from({ length: 24 }, () => 0)
  const lat = []
  for (const r of rows) {
    const model = r.model ?? 'default'
    add(total, r)
    add(get(byP, r.provider, { provider: r.provider }), r)
    add(get(byM, `${r.provider}/${model}`, { provider: r.provider, model }), r)
    const day = get(byD, dayOf(r.at), { date: dayOf(r.at), providers: {}, models: {} })
    add(day, r)
    day.providers[r.provider] = (day.providers[r.provider] ?? 0) + num(r.inputTokens) + num(r.outputTokens)
    addSlice(day.models, `${r.provider}/${model}`, r)
    const sb = get(byS, r.session ?? '', { session: r.session ?? '', cwd: '', firstAt: 0, models: {} })
    add(sb, r)
    if (r.cwd) sb.cwd = r.cwd
    if (!sb.firstAt || num(r.at) < sb.firstAt) sb.firstAt = num(r.at)
    addSlice(sb.models, `${r.provider}/${model}`, r)
    hours[new Date(num(r.at)).getHours()]++
    if (r.ok) lat.push(num(r.ms))
    if (!r.ok && !isAborted(r)) {
      const code = r.code ?? 'UNKNOWN'
      const e = errs.get(code) ?? { code, count: 0, lastAt: 0 }
      e.count++
      if (num(r.at) >= e.lastAt) Object.assign(e, { lastAt: num(r.at), message: r.message, provider: r.provider, model })
      errs.set(code, e)
    }
  }
  // Continuous days (empty ones as zero buckets), so charts keep a real time axis.
  const days = []
  const first = since > 0 ? since : rows.length ? Math.min(...rows.map((r) => num(r.at))) : end
  const cur = new Date(first)
  cur.setHours(0, 0, 0, 0)
  for (let guard = 0; cur.getTime() <= end && guard < 400; guard++) {
    const k = dayOf(cur.getTime())
    days.push(byD.get(k) ?? bucket({ date: k, providers: {}, models: {} }))
    cur.setDate(cur.getDate() + 1)
  }
  lat.sort((a, b) => a - b)
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.round(p * (lat.length - 1)))] : 0)
  const sessions = [...byS.values()].sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.turns - a.turns)
  return {
    since,
    count: rows.length,
    total,
    latency: { p50: q(0.5), p90: q(0.9), max: lat.length ? lat[lat.length - 1] : 0 },
    hours,
    byProvider: [...byP.values()].sort((a, b) => b.turns - a.turns),
    byModel: [...byM.values()].sort((a, b) => b.turns - a.turns),
    byDay: days,
    bySession: sessions.slice(0, 100),
    sessionCount: sessions.length,
    errors: [...errs.values()].sort((a, b) => b.count - a.count),
    recent: recent > 0 ? rows.slice(-recent).reverse() : [],
  }
}

/** Daily activity for the heatmap: the last `days` days, independent of the selected range. */
export function activity(records, { days = 84, now = Date.now() } = {}) {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - (days - 1))
  const map = new Map()
  for (const r of records) {
    if (num(r.at) < start.getTime()) continue
    const k = dayOf(r.at)
    const e = map.get(k) ?? { turns: 0, tokens: 0, failed: 0 }
    e.turns++
    e.tokens += num(r.inputTokens) + num(r.outputTokens)
    if (!r.ok && !isAborted(r)) e.failed++
    map.set(k, e)
  }
  const out = []
  const c = new Date(start)
  for (let i = 0; i < days; i++) {
    const k = dayOf(c.getTime())
    out.push({ date: k, dow: c.getDay(), ...(map.get(k) ?? { turns: 0, tokens: 0, failed: 0 }) })
    c.setDate(c.getDate() + 1)
  }
  return out
}

export const CSV_COLUMNS = ['at', 'provider', 'model', 'session', 'cwd', 'ok', 'aborted', 'code', 'ms', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'estimated', 'chars', 'message']
const cell = (v) => {
  if (v === undefined || v === null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
export function csvOf(records) {
  const lines = [CSV_COLUMNS.join(',')]
  for (const r of records) lines.push(CSV_COLUMNS.map((c) => cell(c === 'at' ? new Date(r.at).toISOString() : r[c])).join(','))
  return `${lines.join('\r\n')}\r\n`
}
