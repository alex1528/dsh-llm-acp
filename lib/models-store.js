// Ported from upstream guozi058/dsh-llm-acp lib/models-store.js (MIT). Local change: list items keep an optional `rate`.
// lib/models-store.js — persists the last discovered model list per provider.
//
// The host asks for the model catalog before every message, and discovery costs a CLI cold start
// (0.6–3.2 s). This store keeps the last good list on disk:
//
//     provider → { fp, at, list: [{ id, name?, description? }], image?, efforts?, effortDefault? }
//
// `fp` is a digest of the profile's command/args/env: a changed profile must never be served the
// old CLI's catalog. Only model metadata goes to disk — no env values, argv, absolute paths,
// prompts or replies. Persistence is best-effort: unreadable or unwritable files degrade to memory
// only and never break a request. Writes are atomic (tmp + rename), 0600, and debounced.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1
const MAX_BYTES = 1024 * 1024
const MAX_MODELS = 500
const MAX_NAME = 200
const MAX_DESCRIPTION = 400
const MAX_ID = 200
const MAX_RATE = 32
const MAX_AGE_MS = 30 * 24 * 3600_000
const MAX_PROVIDERS = 64
const MAX_EFFORTS = 16
const MAX_EFFORT_ID = 64
const MAX_EFFORT_NAME = 80
const MAX_EFFORT_DESCRIPTION = 200
const CONTROL = /[\u0000-\u001f\u007f]/g
const HAS_CONTROL = /[\u0000-\u001f\u007f]/
const FP = /^sha256:[0-9a-f]{64}$/

const clean = (s, max) => s.replace(CONTROL, '').slice(0, max)

/** Drop unknown fields, the pseudo model "default", duplicates, and anything over the caps. */
function cleanList(list) {
  const out = []
  const seen = new Set()
  for (const m of Array.isArray(list) ? list : []) {
    if (out.length >= MAX_MODELS) break
    if (m === null || typeof m !== 'object') continue
    if (typeof m.id !== 'string' || m.id === '' || m.id === 'default' || m.id.length > MAX_ID) continue
    const id = clean(m.id, MAX_ID)
    if (id === '' || id === 'default' || seen.has(id)) continue
    seen.add(id)
    const item = { id }
    if (typeof m.name === 'string' && m.name !== '') item.name = clean(m.name, MAX_NAME)
    if (typeof m.description === 'string' && m.description !== '') item.description = clean(m.description, MAX_DESCRIPTION)
    // Local addition: the credit multiplier learned at discovery ("0.29x", "0x 免费").
    if (typeof m.rate === 'string' && m.rate !== '') { const rate = clean(m.rate, MAX_RATE); if (rate !== '') item.rate = rate }
    out.push(item)
  }
  return out
}

/**
 * The learned reasoning-effort list of one provider, or undefined when the file has none.
 *
 * The list is all-or-nothing: one malformed item (missing id, duplicate, over-long id, control
 * character, more than 16) drops the whole list — a half-trusted list would show the user levels
 * the CLI may not offer. A missing `efforts` key means "unknown" (an old file) and is preserved
 * as missing; `efforts: []` means "this CLI has none" and is preserved as an empty list.
 */
function cleanEfforts(list) {
  if (!Array.isArray(list) || list.length > MAX_EFFORTS) return undefined
  const out = []
  const seen = new Set()
  for (const e of list) {
    if (e === null || typeof e !== 'object') return undefined
    if (typeof e.id !== 'string' || e.id === '' || e.id.length > MAX_EFFORT_ID || HAS_CONTROL.test(e.id)) return undefined
    if (seen.has(e.id)) return undefined
    seen.add(e.id)
    const item = { id: e.id }
    const name = typeof e.name === 'string' ? clean(e.name, MAX_EFFORT_NAME) : ''
    item.name = name !== '' ? name : e.id
    if (typeof e.description === 'string') {
      const description = clean(e.description, MAX_EFFORT_DESCRIPTION)
      if (description !== '') item.description = description
    }
    out.push(item)
  }
  return out
}

function cleanEntry(e) {
  if (e === null || typeof e !== 'object') return undefined
  if (typeof e.fp !== 'string' || !FP.test(e.fp)) return undefined
  if (!Number.isFinite(e.at)) return undefined
  if (!Array.isArray(e.list)) return undefined
  const efforts = cleanEfforts(e.efforts)
  const effortDefault = efforts !== undefined && typeof e.effortDefault === 'string' && efforts.some((x) => x.id === e.effortDefault)
    ? e.effortDefault
    : undefined
  return {
    fp: e.fp,
    at: e.at,
    list: cleanList(e.list),
    ...(typeof e.image === 'boolean' ? { image: e.image } : {}),
    ...(efforts === undefined ? {} : { efforts }),
    ...(effortDefault === undefined ? {} : { effortDefault }),
  }
}

/**
 * @param {object} options
 * @param {string|undefined} options.file JSON file path; undefined ⇒ memory only
 * @param {number} [options.maxAgeMs] entries older than this are ignored and pruned
 * @param {number} [options.maxProviders] keep at most this many providers (newest first)
 * @param {(event: string, fields: object) => void} [options.warn]
 * @param {() => number} [options.now]
 */
export function createModelsStore({ file, maxAgeMs = MAX_AGE_MS, maxProviders = MAX_PROVIDERS, warn = () => {}, now = () => Date.now() }) {
  /** @type {Map<string, object>} */
  let entries = new Map()
  let loaded = false
  let timer
  let broken = false

  const prune = () => {
    const cutoff = now() - maxAgeMs
    for (const [id, e] of entries) if (e.at < cutoff) entries.delete(id)
    if (entries.size > maxProviders) {
      const kept = [...entries].sort((a, b) => a[1].at - b[1].at).slice(-maxProviders)
      entries = new Map(kept)
    }
  }

  const load = () => {
    if (loaded) return
    loaded = true
    if (file === undefined) return
    let text
    try { text = readFileSync(file, 'utf8') } catch (e) {
      if (e?.code !== 'ENOENT') warn('models-cache', { phase: 'read', message: e?.message })
      return
    }
    if (text.length > MAX_BYTES) {
      warn('models-cache', { phase: 'read', message: `file is larger than ${MAX_BYTES} bytes` })
      return
    }
    let doc
    try { doc = JSON.parse(text) } catch (e) {
      warn('models-cache', { phase: 'read', message: `not JSON: ${e?.message}` })
      return
    }
    if (doc === null || typeof doc !== 'object' || doc.version !== VERSION || doc.entries === null || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
      warn('models-cache', { phase: 'read', message: `unsupported file version ${JSON.stringify(doc?.version)}` })
      return
    }
    for (const [id, raw] of Object.entries(doc.entries)) {
      const e = cleanEntry(raw)
      if (e !== undefined) entries.set(id, e)
    }
    prune()
  }

  const write = () => {
    timer = undefined
    if (file === undefined || broken) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) }), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      broken = true // stop retrying every refresh; memory still works
      warn('models-cache', { phase: 'write', message: e?.message })
    }
  }
  const schedule = () => {
    if (file === undefined || timer !== undefined) return
    timer = setTimeout(write, 200)
    timer.unref?.()
  }

  return {
    /** The entry for `provider` when it was produced by the same profile, else undefined. */
    get(provider, fp) {
      load()
      const e = entries.get(provider)
      if (e === undefined || e.fp !== fp) return undefined
      if (e.at < now() - maxAgeMs) { entries.delete(provider); schedule(); return undefined }
      return {
        ...e,
        list: e.list.map((m) => ({ ...m })),
        ...(e.efforts === undefined ? {} : { efforts: e.efforts.map((x) => ({ ...x })) }),
      }
    },
    /** Record a successful discovery for `provider`. */
    set(provider, entry) {
      load()
      const e = cleanEntry(entry)
      if (e === undefined) return
      entries.delete(provider)
      entries.set(provider, e)
      prune()
      schedule()
    },
    /** Forget `provider`'s entry (its profile changed). */
    delete(provider) {
      load()
      if (entries.delete(provider)) schedule()
    },
    /** Write pending changes now (plugin dispose). No write when nothing changed. */
    flush() {
      if (timer !== undefined) { clearTimeout(timer); write() }
    },
  }
}
