// lib/errors.js — error type the host's LLM boundary understands without importing it.
//
// The host normalises adapter failures by reading an own data property `failure`
// ({message, code}) and an own `code` (see dsh-llm normalizeLlmFailure). Matching that shape
// lets us classify errors (AUTH / TIMEOUT / TRANSPORT…) even when `@deepseek-ai/dsh-llm`
// cannot be imported from the plugin directory.

export class AcpError extends Error {
  /**
   * @param {string} message non-empty human-readable summary
   * @param {string} code stable machine code (AUTH, TIMEOUT, TRANSPORT, ACP_ERROR, …)
   * @param {{cause?: unknown}} [options]
   */
  constructor(message, code, options) {
    super(message || 'ACP adapter failed', options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AcpError'
    Object.defineProperty(this, 'code', { value: code, enumerable: true, writable: false, configurable: true })
    Object.defineProperty(this, 'failure', {
      value: Object.freeze({ message: this.message, code }),
      enumerable: false, writable: false, configurable: true,
    })
  }
}

/**
 * Classify a provider-side error message into a host error code.
 * Retry decisions key off these codes, so only clearly-recognised texts get a retryable class.
 * @param {string} message
 * @returns {string}
 */
export function classifyMessage(message) {
  const m = String(message ?? '')
  // Permanent failures first: retrying these only burns time and quota.
  if (/quota|insufficient[_ ]credit|out of credit|usage limit|billing limit|credit limit/i.test(m)) return 'QUOTA_EXCEEDED'
  if (/\b(401|403)\b|unauthori[sz]ed|authenticat|not logged in|log ?in required|please log ?in|forbidden/i.test(m)) return 'AUTH'
  // Transient provider conditions. CLIs word rate limits and overloads in many ways; classify
  // them as RATE_LIMIT so the prompt retry path backs off exponentially (see retryDelayFor).
  if (/\b429\b|rate.?limit|too many requests|request limit|overloaded|overload|capacity|throttl|slow down/i.test(m)) return 'RATE_LIMIT'
  if (/\b5\d{2}\b|server error|internal error|service unavailable|temporarily unavailable|bad gateway|gateway timeout|upstream (?:error|failure)/i.test(m)) return 'SERVER'
  return 'ACP_ERROR'
}

/** Failure record for an in-band `finish` chunk. */
export const failure = (message, code) => Object.freeze({ message: message || code, code })
