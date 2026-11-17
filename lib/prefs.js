// lib/prefs.js — ACP console switches: which providers and models are switched off.
//
//     { version: 1, disabledProviders: [id…], disabledModels: { [provider]: [modelId…] } }
//
// Kept in the plugin's own state file, not in cordis.patch.yml: a switch takes effect at once
// (no plugin restart, no interrupted turn) and the user's YAML comments are never rewritten.
// Reads are cheap (one stat per check); an external edit of the file is picked up by mtime.
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1
const empty = () => ({ disabledProviders: [], disabledModels: {} })
const strs = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string' && x !== ''))].sort() : [])
const statKey = (f) => { try { const s = statSync(f); return `${s.size}:${s.mtimeMs}` } catch { return '-' } }

export function normalizePrefs(raw) {
  const out = empty()
  out.disabledProviders = strs(raw?.disabledProviders)
  const dm = raw?.disabledModels
  if (dm && typeof dm === 'object' && !Array.isArray(dm)) {
    for (const [k, v] of Object.entries(dm)) { const list = strs(v); if (list.length) out.disabledModels[k] = list }
  }
  return out
}

/**
 * @param {object} options
 * @param {string|undefined} options.file JSON path; empty/undefined ⇒ memory only
 * @param {(event: string, fields: object) => void} [options.warn]
 */
export function createPrefs({ file, warn = () => {} }) {
  let state = empty()
  let key
  const load = () => {
    if (!file) return state
    const k = statKey(file)
    if (k === key) return state
    key = k
    if (k === '-') { state = empty(); return state }
    try { state = normalizePrefs(JSON.parse(readFileSync(file, 'utf8'))) }
    catch (e) { warn('prefs', { phase: 'read', message: e?.message }) }
    return state
  }
  return {
    file,
    get: () => load(),
    isProviderDisabled: (id) => load().disabledProviders.includes(id),
    isModelDisabled: (id, model) => (load().disabledModels[id] ?? []).includes(model),
    /** Apply `change(copy)` and persist atomically; throws when the file cannot be written. */
    update(change) {
      const next = normalizePrefs(change(structuredClone(load())))
      if (file) {
        mkdirSync(dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        writeFileSync(tmp, JSON.stringify({ version: VERSION, ...next }, null, 1), { mode: 0o600 })
        renameSync(tmp, file)
        key = statKey(file)
      }
      state = next
      return next
    },
  }
}
