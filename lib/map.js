// lib/map.js — ACP `session/update` notifications → host LLM stream chunks.
//
//   agent_message_chunk (text)   → text block   (text-delta)
//   agent_thought_chunk (text)   → reasoning block (reasoning-delta)
//   tool_call                    → one reasoning line "[CLI tool: title]" — the CLI ran its OWN
//                                  tool; the host must never see a tool-call it would execute.
//   usage_update                 → remembered as reported usage (some CLIs report only here)
//   everything else              → ignored
//
// Blocks are emitted explicitly (block-start / deltas / block-end) with unique indices.
import { failure } from './errors.js'

const textOf = (content) => (content && content.type === 'text' && typeof content.text === 'string' ? content.text : '')
const estimate = (chars) => Math.ceil(chars / 4)
// Some CLIs (qoder) settle every prompt with an all-zero usage object. That is "not reported",
// not a real zero — trusting it would log 0 tokens with estimated:false.
const hasTokens = (u) => !!u && ['inputTokens', 'outputTokens', 'totalTokens', 'cachedReadTokens', 'cachedWriteTokens'].some((k) => Number.isFinite(u[k]) && u[k] > 0)

export function mapStopReason(stopReason) {
  switch (stopReason) {
    case 'end_turn': return { kind: 'stop' }
    case 'max_tokens': case 'max_turn_requests': return { kind: 'max-tokens' }
    case 'cancelled': return { kind: 'aborted', failure: failure('the ACP turn was cancelled', 'ABORTED') }
    case 'refusal': return { kind: 'error', failure: failure('the external CLI agent refused to answer', 'ACP_REFUSAL') }
    default: return { kind: 'error', failure: failure(`unknown ACP stop reason ${JSON.stringify(stopReason)}`, 'ACP_PROTOCOL') }
  }
}

/**
 * @param {{inputChars?: number}} [opts] size of the prompt text, for the usage estimate
 */
export function createChunkMapper(opts = {}) {
  let next = 0
  let open // { index, kind: 'text'|'reasoning', text }
  let textChars = 0
  let reasoningChars = 0
  let toolCalls = 0
  let ended = false

  const close = () => {
    if (!open) return []
    const c = { type: 'block-end', index: open.index, block: { type: open.kind, text: open.text } }
    open = undefined
    return [c]
  }
  const push = (kind, text) => {
    if (text === '' || ended) return []
    const out = []
    if (open?.kind !== kind) { out.push(...close()); open = { index: next++, kind, text: '' }; out.push({ type: 'block-start', index: open.index, blockType: kind }) }
    open.text += text
    if (kind === 'text') textChars += text.length; else reasoningChars += text.length
    out.push({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index: open.index, text })
    return out
  }
  let lastUsage
  let endReason
  let streamUsage
  /** Terminal usage chunk; also remembered (with `estimated`) for the ACP console's usage log. */
  const usage = (reported) => {
    const src = hasTokens(reported) ? reported : hasTokens(streamUsage) ? streamUsage : undefined
    const c = usageChunk(src)
    lastUsage = { ...c.usage, estimated: src === undefined }
    return c
  }
  const usageChunk = (src) => {
    if (src) {
      const inputTokens = Number.isFinite(src.inputTokens) ? src.inputTokens : 0
      const outputTokens = Number.isFinite(src.outputTokens) ? src.outputTokens : 0
      return { type: 'usage', usage: {
        inputTokens, outputTokens,
        totalTokens: Number.isFinite(src.totalTokens) ? src.totalTokens : inputTokens + outputTokens,
        ...(src.cachedReadTokens > 0 ? { cacheReadTokens: src.cachedReadTokens } : {}),
        ...(src.cachedWriteTokens > 0 ? { cacheWriteTokens: src.cachedWriteTokens } : {}),
      } }
    }
    const inputTokens = estimate(opts.inputChars ?? 0)
    const outputTokens = estimate(textChars + reasoningChars)
    return { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
  }
  const end = (reason, reported) => { const out = [...close(), usage(reported), { type: 'finish', reason }]; ended = true; endReason = reason; return out }

  return {
    /** @returns {object[]} chunks for one ACP update (possibly none). Never throws. */
    onUpdate(update) {
      if (ended || update === null || typeof update !== 'object') return []
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': return push('text', textOf(update.content))
        case 'agent_thought_chunk': return push('reasoning', textOf(update.content))
        case 'tool_call': {
          toolCalls++
          const title = typeof update.title === 'string' && update.title ? update.title : (update.kind ?? 'tool')
          return push('reasoning', `${open?.kind === 'reasoning' && open.text && !open.text.endsWith('\n') ? '\n' : ''}[CLI tool: ${title}]\n`)
        }
        case 'usage_update': if (hasTokens(update.usage)) streamUsage = update.usage; return []
        default: return []
      }
    },
    /** Terminal chunks for a settled `session/prompt` response. */
    finish(response) {
      if (ended) return []
      const reason = mapStopReason(response?.stopReason)
      if (reason.kind === 'stop' && textChars === 0) {
        if (toolCalls === 0) return end({ kind: 'error', failure: failure('the external CLI agent ended its turn without any output', 'EMPTY_RESPONSE') }, response?.usage)
        const note = push('text', `(The external CLI agent finished after ${toolCalls} tool call(s) of its own without a text reply.)`)
        return [...note, ...end(reason, response?.usage)]
      }
      return end(reason, response?.usage)
    },
    /** Terminal chunks for a cancelled turn. */
    abort(message) { return ended ? [] : end({ kind: 'aborted', failure: failure(message || 'aborted', 'ABORTED') }) },
    /** Terminal chunks for a failed turn. */
    fail(f) { return ended ? [] : end({ kind: 'error', failure: failure(f?.message, f?.code ?? 'ACP_ERROR') }) },
    textLength: () => textChars,
    /** Usage of the terminal chunk ({ inputTokens, outputTokens, …, estimated }), once the turn ended. */
    lastUsage: () => lastUsage,
    /** The finish reason that was emitted ({ kind, failure? }), once the turn ended. */
    lastReason: () => endReason,
    get ended() { return ended },
  }
}
