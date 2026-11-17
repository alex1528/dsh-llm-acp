// lib/session-cache.js — warm ACP sessions, one per host session (plan B).
//
// Cold start dominates a turn (kiro: ~3.2 s before the first token). Keeping the CLI alive between
// turns of the same host session removes that cost. Three invariants make this safe:
//
//   1. ONE TURN AT A TIME per entry — prompts on one ACP session are serialized, otherwise two
//      turns would interleave their `session/update` notifications.
//   2. HISTORY IS NOT REPLAYED — a warm CLI already holds the conversation, so a reused turn must
//      send only the new messages; replaying everything would duplicate the transcript.
//   3. A DEAD (OR STALE) ENTRY IS NEVER HANDED OUT — it is evicted and the next turn rebuilds.
//
// Turns STREAM: `stream()` hands back an async generator immediately, so chunks flow to the host
// while the per-entry lock is held, instead of being buffered until the turn ends.
import { AcpError } from './errors.js'

/**
 * @param {object} options
 * @param {number} options.maxEntries LRU cap on warm processes
 * @param {number} options.idleMs reap a warm process after this much inactivity
 * @param {() => number} [options.now] clock, for tests
 * @param {(event: { reason: string, size: number }) => void} [options.onEvict] diagnostics hook
 */
export function createSessionCache({ maxEntries, idleMs, now = () => Date.now(), onEvict }) {
  /** key → { session, sessionId, replyKey, busy, lastUsed, chain } */
  const entries = new Map()
  let reapTimer

  const stopReaper = () => {
    if (reapTimer !== undefined) { clearInterval(reapTimer); reapTimer = undefined }
  }

  /** Open the CLI for `key` if it does not exist yet. */
  async function ensure(key, entry, io) {
    if (entry.session !== undefined) return entry.session
    const session = await io.open()
    if (entries.get(key) !== entry) {
      await session.dispose()
      throw new AcpError('llm-acp: session evicted while opening', 'ABORTED')
    }
    entry.session = session
    entry.sessionId = session.sessionId
    entry.replyKey = undefined
    return session
  }

  /**
   * Drop one entry.
   *
   * Deliberately does NOT wait for `entry.chain`: an aborted turn drops its own entry from inside
   * the turn, so waiting for the chain would deadlock (the turn waits for the drop, the drop waits
   * for the turn). Disposing the session is enough — the in-flight generator sees the closed stream
   * and winds itself up.
   */
  async function drop(key, reason) {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    // `lru` means the cap — not the session — ended this turn's warmth, which is the thrash signal
    // an operator needs when a Team has more CLI members than maxSessions.
    if (onEvict !== undefined) {
      try { onEvict({ reason, size: entries.size }) } catch { /* diagnostics must never break a turn */ }
    }
    try { await entry.session?.dispose() } catch { /* already gone */ }
  }

  function reap() {
    const cutoff = now() - idleMs
    for (const [key, entry] of entries) if (!entry.busy && entry.lastUsed <= cutoff) void drop(key, 'idle')
  }

  function trim() {
    if (maxEntries <= 0) return
    while (entries.size > maxEntries) {
      let victim
      for (const [key, entry] of entries) {
        if (entry.busy) continue
        if (victim === undefined || entry.lastUsed < victim.entry.lastUsed) victim = { key, entry }
      }
      if (victim === undefined) return // everything is busy; let them finish
      void drop(victim.key, 'lru')
    }
  }

  /** Get or create the entry for `key`. */
  async function acquire(key, io) {
    let entry = entries.get(key)
    if (entry !== undefined && entry.session !== undefined && !io.alive(entry.session)) {
      await drop(key, 'dead')
      entry = undefined
    }
    if (entry === undefined) {
      entry = { session: undefined, sessionId: undefined, replyKey: undefined, busy: false, lastUsed: now(), chain: Promise.resolve() }
      entries.set(key, entry)
      if (reapTimer === undefined && idleMs > 0) {
        reapTimer = setInterval(reap, Math.min(Math.max(idleMs / 2, 1000), 30_000))
        reapTimer.unref?.()
      }
      trim()
    }
    return entry
  }

  /**
   * One turn on a warm session, streaming.
   * @returns {AsyncGenerator<object, object>} chunks; its return value is `{ chars, aborted? }`
   */
  async function* driveStream(key, io) {
    // STALE_SESSION is raised before anything is sent to the CLI, so rebuilding once is safe.
    for (let attempt = 0; ; attempt++) {
      const result = yield* driveOnce(key, io)
      if (result.stale !== true) return result.outcome
      if (attempt >= 1) throw new AcpError('llm-acp: warm session still stale after a rebuild', 'ACP_PROTOCOL')
    }
  }

  /** One turn under the entry lock. Returns `{ outcome }`, or `{ stale: true }` after dropping the entry. */
  async function* driveOnce(key, io) {
    const entry = await acquire(key, io)
    // Serialize behind the previous turn on this entry: one prompt at a time per CLI session.
    let releaseLock
    const previous = entry.chain
    entry.chain = new Promise((resolve) => { releaseLock = resolve })
    entry.busy = true
    // Only a clean finish leaves the CLI reusable; error, abort, crash or an early return by the
    // host leave it in an unknown state, so it is dropped and the next turn rebuilds.
    let reusable = false
    try {
      try { await previous } catch { /* an earlier turn's failure must not block this one */ }
      const session = await ensure(key, entry, io)
      let outcome
      try {
        // yield* forwards an early iterator.return() from the host into the turn's own finally.
        outcome = yield* io.turn(session, entry.replyKey)
      } catch (error) {
        if (error?.code === 'STALE_SESSION') { await drop(key, 'stale'); return { stale: true } }
        throw error
      }
      if (outcome?.aborted !== true && outcome?.failed !== true) {
        entry.replyKey = io.replyKey(session)
        reusable = true
      }
      return { outcome }
    } finally {
      entry.busy = false
      entry.lastUsed = now()
      if (!reusable && entries.get(key) === entry) void drop(key, 'unusable')
      releaseLock?.()
      reap()
    }
  }

  return {
    /** Streaming turn: the returned generator drives the prompt as the caller iterates it. */
    stream(key, io) { return driveStream(key, io) },
    size: () => entries.size,
    has: (key) => entries.has(key),
    drop,
    async clear() {
      stopReaper()
      await Promise.allSettled([...entries.keys()].map((key) => drop(key, 'clear')))
    },
  }
}
