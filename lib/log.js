// lib/log.js — structured, redacting logger.
//
// A CLI turn can fail in ways only visible in logs (startup timeout, transport death, rate limit),
// and a free-form string is not enough: we need who / which stage / how long / which code. Every
// line is one JSON object so it can be grepped or shipped. Two hard rules:
//
//   * the sink must never break a request — a throwing sink is swallowed;
//   * credentials are never written: fields that look secret are dropped, long text is clipped.
const SECRET_KEY = /(key|token|secret|password|authorization|credential|apikey|cookie)/i
const LONG_TEXT = /(prompt|text|message|content|body)/i
const MAX_TEXT = 200
const MAX_DEPTH = 3

/** Drop secret-looking fields, clip long text, bound the depth. */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[deep]'
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => sanitize(v, depth + 1))
  if (value instanceof Error) return { name: value.name, message: clip(value.message), code: value.code }
  if (typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k)) { out[k] = '[redacted]'; continue }
      if (LONG_TEXT.test(k) && typeof v === 'string') { out[k] = clip(v); continue }
      if (LONG_TEXT.test(k) && v !== null && typeof v === 'object') { out[k] = '[redacted-object]'; continue }
      out[k] = sanitize(v, depth + 1)
    }
    return out
  }
  return String(value)
}

const clip = (s) => {
  const text = String(s ?? '')
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…(${text.length})` : text
}

/**
 * @param {object} [options]
 * @param {(line: object) => void} [options.sink] receives one plain object per line
 * @param {() => number} [options.now] clock, for tests
 * @param {string} [options.namespace]
 */
export function createLogger(options = {}) {
  const sink = typeof options.sink === 'function' ? options.sink : undefined
  const now = typeof options.now === 'function' ? options.now : Date.now
  const namespace = options.namespace ?? 'llm-acp'

  const emit = (level, event, fields) => {
    const line = { ns: namespace, level, event, ts: now(), ...sanitize(fields ?? {}) }
    if (sink !== undefined) {
      try { sink(line) } catch { /* a broken log sink must never break a turn */ }
    }
    // Warnings and errors also reach the console so they show up in the host's own log.
    if (level === 'warn' || level === 'error') {
      try {
        const text = `${namespace}: ${event}${fields === undefined ? '' : ` ${JSON.stringify(sanitize(fields))}`}`
        if (level === 'error') console.error(text); else console.warn(text)
      } catch { /* ignore */ }
    }
  }

  const logger = {
    /** Marks this object as an already-structured logger, so callers never re-wrap it. */
    structured: true,
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /** Timed helper: returns a function that logs `event` with the elapsed ms. */
    timed(event, fields) {
      const start = now()
      let done = false
      return (extra) => {
        if (done) return
        done = true
        emit('info', event, { ...fields, ...extra, ms: Math.max(0, now() - start) })
      }
    },
  }
  return logger
}

/** Adapter for a plain console-like logger the host may already provide. */
export function fromHostLogger(host, namespace = 'llm-acp') {
  if (host === undefined || host === null) return createLogger({ namespace })
  return createLogger({
    namespace,
    sink: (line) => {
      if (line.level === 'warn') host.warn?.(`${line.ns}: ${line.event}`, line)
      else if (line.level === 'error') host.error?.(`${line.ns}: ${line.event}`, line)
      else host.info?.(`${line.ns}: ${line.event}`, line)
    },
  })
}
