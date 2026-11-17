// lib/flatten.js — turn the host conversation into ONE prompt text for a fresh ACP session.
//
// ⚠️ Inherent loss (documented in README): an ACP session takes one prompt per turn and we open
// a fresh session per call, so the CLI sees a transcript, not a real multi-turn conversation.
// Assistant reasoning is not replayed; past host tool calls/results become plain text.

export const PREAMBLE = [
  '[Context from DeepSeek Harness]',
  'You are acting as one member (role/model) inside DeepSeek Harness. The conversation so far is',
  'replayed below as a transcript. The tools mentioned in it belong to the harness, NOT to you:',
  'do not try to call them. Use only your own built-in tools, in the current working directory.',
  'Reply to the LAST User message. Your final text reply is what the harness receives.',
  '[End of context]',
].join('\n')

/**
 * Short header for a WARM session: the CLI already holds the transcript and the full preamble from
 * its first turn, so only the new messages follow. Repeating the long preamble every turn would
 * pile copies of it into the CLI's own context and misdescribe the payload as a full replay.
 */
export const WARM_PREAMBLE = '[DeepSeek Harness: new messages since your last reply. Reply to the LAST User message.]'

const HEADING = /^(\s{0,3})(#{1,6})(?=\s|$)/gm

/** Neutralise markdown headings inside content so content cannot forge a role boundary. */
const escapeHeadings = (s) => s.replace(HEADING, '$1\\$2')

function blockText(block, role, opts = {}) {
  switch (block?.type) {
    case 'text': return typeof block.text === 'string' ? block.text : ''
    case 'reasoning': return '' // never replay hidden reasoning
    case 'tool-call': {
      let args = block.arguments ?? ''
      if (typeof args !== 'string') { try { args = JSON.stringify(args) } catch { args = '' } }
      if (args.length > 2000) args = args.slice(0, 2000) + '…'
      return `[called harness tool \`${block.name ?? '?'}\` with ${args || '{}'}]`
    }
    case 'image': {
      const name = block.attachment?.name ?? block.name ?? 'image'
      // The caller may attach the image itself as an ACP image block; then say so, not "not visible".
      const own = opts.imageText?.(block, name)
      if (typeof own === 'string') return own
      return `[image attachment "${name}" — not visible to this CLI agent]`
    }
    case 'file': return `[file attachment "${block.attachment?.name ?? block.name ?? 'file'}"]`
    case 'tool-addition': case 'tool-removal': return ''
    default: return role === 'developer' ? '' : (typeof block?.text === 'string' ? block.text : '')
  }
}

function roleHeading(m) {
  switch (m.role) {
    case 'system': return 'System instructions'
    case 'developer': return 'Harness note'
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool': return `Tool result${m.isError ? ' (error)' : ''}`
    default: return String(m.role ?? 'Message')
  }
}

/** One message → `### Heading\n\nbody`, or '' when it has no visible content. */
function renderMessage(m, opts) {
  const parts = (Array.isArray(m?.content) ? m.content : []).map((b) => blockText(b, m.role, opts)).filter((s) => s.trim() !== '')
  if (parts.length === 0) return ''
  return `### ${roleHeading(m)}\n\n${escapeHeadings(parts.join('\n\n'))}`
}

/**
 * @param {ReadonlyArray<object>} messages host Message[] (system/developer/user/assistant/tool)
 * @param {{maxChars?: number, preamble?: string, imageText?: (block: object, name: string) => string|undefined}} [opts]
 * @returns {string}
 */
export function flattenMessages(messages, opts = {}) {
  const maxChars = opts.maxChars ?? 400_000
  const preamble = opts.preamble ?? PREAMBLE
  const rendered = (messages ?? []).map((m) => ({ role: m?.role, text: renderMessage(m, opts) })).filter((r) => r.text !== '')

  // Pinned head: every system message plus the first user message (usually the task itself).
  const head = []
  const rest = []
  let firstUserTaken = false
  for (const r of rendered) {
    if (r.role === 'system') head.push(r)
    else if (r.role === 'user' && !firstUserTaken && rest.length === 0) { head.push(r); firstUserTaken = true }
    else rest.push(r)
  }
  // The first user message that is also the newest belongs to the tail (tail-truncation keeps its end).
  if (rest.length === 0 && head.at(-1)?.role === 'user') rest.push(head.pop())
  const join = (list) => list.map((r) => r.text).join('\n\n')
  const full = `${preamble}\n\n${join([...head, ...rest])}`
  if (full.length <= maxChars) return full

  // Over budget: keep the head, then as many of the newest messages as fit.
  let budget = maxChars - preamble.length - 200
  const headText = join(head)
  const keptHead = headText.length <= budget * 0.4 ? headText : headText.slice(0, Math.floor(budget * 0.4)) + '\n[… truncated …]'
  budget -= keptHead.length
  const tail = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = rest[i].text
    if (t.length + 2 <= budget) { tail.unshift(t); budget -= t.length + 2; continue }
    if (tail.length === 0) { tail.unshift('[… start of this message truncated …]\n' + t.slice(t.length - Math.max(0, budget - 60))); budget = 0 }
    break
  }
  const omitted = rest.length - tail.length
  const notice = omitted > 0 ? [`[… ${omitted} earlier message(s) omitted to fit the prompt limit …]`] : []
  return [preamble, keptHead, ...notice, ...tail].filter(Boolean).join('\n\n')
}
