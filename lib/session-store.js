// lib/session-store.js — remembers which CLI-native session belongs to which host session.
//
// A warm CLI process is only a speed-up. The context that matters (files the CLI read, tools it
// ran, its own compaction) lives in the CLI's OWN session, which ACP agents that advertise
// `loadSession` can reopen in a fresh process. This store keeps
//
//     key (cwd + host session + provider + model) → { acpSessionId, historyKey, historyCount, lastReply, at }
//
// so a reaped/evicted process, or a DSH restart, resumes the CLI's native session instead of
// re-sending a flattened transcript. The marker (historyKey/historyCount) is the same prefix check
// the warm path uses: a load is attempted only when the host history still extends what the
// CLI was last told.
//
// Persistence is best-effort: a store that cannot be read or written degrades to memory only and
// never breaks a turn. Writes are atomic (tmp + rename) and debounced.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1

/**
 * @param {object} options
 * @param {string|undefined} options.file JSON file path; undefined ⇒ memory only
 * @param {number} options.maxEntries oldest entries beyond this are pruned
 * @param {number} options.maxAgeMs entries older than this are ignored and pruned
 * @param {(event: string, fields: object) => void} [options.warn]
 * @param {() => number} [options.now]
 */
export function createSessionStore({ file, maxEntries = 500, maxAgeMs = 7 * 24 * 3600_000, warn = () => {}, now = () => Date.now() }) {
  /** @type {Map<string, object>} */
  let entries = new Map()
  let loaded = false
  let timer
  let broken = false

  const load = () => {
    if (loaded) return
    loaded = true
    if (file === undefined) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      if (raw?.version === VERSION && raw.entries && typeof raw.entries === 'object') {
        for (const [k, v] of Object.entries(raw.entries)) if (valid(v)) entries.set(k, v)
      }
    } catch (e) {
      if (e?.code !== 'ENOENT') warn('session-store', { phase: 'read', message: e?.message })
    }
    prune()
  }

  const prune = () => {
    const cutoff = now() - maxAgeMs
    for (const [k, v] of entries) if (v.at < cutoff) entries.delete(k)
    if (entries.size > maxEntries) {
      const sorted = [...entries].sort((a, b) => a[1].at - b[1].at)
      entries = new Map(sorted.slice(sorted.length - maxEntries))
    }
  }

  const flush = () => {
    timer = undefined
    if (file === undefined || broken) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: VERSION, entries: Object.fromEntries(entries) }), { mode: 0o600 })
      renameSync(tmp, file)
    } catch (e) {
      broken = true // stop retrying every turn; memory still works
      warn('session-store', { phase: 'write', message: e?.message })
    }
  }
  const schedule = () => {
    if (file === undefined || timer !== undefined) return
    timer = setTimeout(flush, 200)
    timer.unref?.()
  }

  return {
    /** @returns {object|undefined} a fresh-enough record for `key` */
    get(key) {
      load()
      const v = entries.get(key)
      if (v === undefined) return undefined
      if (v.at < now() - maxAgeMs) { entries.delete(key); schedule(); return undefined }
      return v
    },
    /** Record (or refresh) the CLI session behind `key` after a clean turn. */
    set(key, record) {
      load()
      const v = { ...record, at: now() }
      if (!valid(v)) return
      entries.delete(key) // re-insert ⇒ newest last, for pruning
      entries.set(key, v)
      prune()
      schedule()
    },
    /** Forget `key` (the CLI session is unusable or the conversation moved on). */
    delete(key) {
      load()
      if (entries.delete(key)) schedule()
    },
    /** Write pending changes now (plugin dispose). */
    flush() { if (timer !== undefined) { clearTimeout(timer); flush() } },
    size() { load(); return entries.size },
    /** Snapshot of all live entries, for the console's session directory. */
    list() { load(); return [...entries].map(([key, v]) => ({ key, ...v })) },
  }
}

function valid(v) {
  return v !== null && typeof v === 'object'
    && typeof v.acpSessionId === 'string' && v.acpSessionId !== ''
    && typeof v.historyKey === 'string' && /^sha256:[0-9a-f]{64}$/.test(v.historyKey) && Number.isInteger(v.historyCount) && v.historyCount > 0
    && (v.lastReply === undefined || v.lastReply === '' || /^sha256:[0-9a-f]{64}$/.test(v.lastReply))
    && Number.isFinite(v.at)
}
