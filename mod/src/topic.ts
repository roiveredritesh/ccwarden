import { fmtTokens } from './status'

// F13 unrelated-prompt hint: a typed prompt whose keywords share almost
// nothing with the session's goal, recent asks and last answer is likely new
// work, which is cheaper after /clear. Zero model tokens. Pure: the
// prompt.submit hook in hooks/register.tsx asks.

/** Below this context a /clear saves too little to ask about (SPEC §3). */
export const TOPIC_MIN_TOKENS = 40_000
/** Fewer keywords than this and the prompt says too little to judge ("yes", "ship it"). 2 catches "what is the capital of india?". */
export const TOPIC_MIN_KEYWORDS = 2
/** "Near zero": at most this share of the prompt's keywords seen before. */
export const TOPIC_MAX_OVERLAP = 0.1
/** "Send" mutes the hint until the context grows this much (SPEC §3 "Keep going"). */
export const TOPIC_MUTE_GROWTH = 1.2

export const TOPIC_SEND = 'Send'
export const TOPIC_CLEAR = 'Clear'
export const TOPIC_HANDOFF_CLEAR = 'Handoff + clear'

// English and Hinglish filler: words that say nothing about the topic.
const STOP = new Set((
  'the and for are but not you all any can had has have her his how its may new now our out see she too use was way who why ' +
  'did get got let one two yes this that with from they them then than there their what when where which while will would ' +
  'could should about after again also been before being both each just like make more most much only other over same some ' +
  'such into very want need here please thanks okay done still next lets look check ' +
  'hai hain kar karo karna kardo kiya kya nahi nhi aur bhi yeh woh abhi phir isko usko iska uska mujhe hum tum aap apna ' +
  'wala wali wale raha rahi rahe gaya gayi diya liya dena lena chahiye sab kuch koi kaise kyun kahan jab tab toh hoga hona'
).split(' '))

/**
 * A text's topic words: lowercased alphanumeric runs of 3+ characters, minus
 * filler, cut to 6 characters.
 */
// ponytail: a 6-character prefix stands in for stemming ("compaction" ~ "compact");
// a collision only raises overlap, so it errs towards no hint. A real stemmer if tuning asks.
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? []
  return new Set(words.filter(w => w.length >= 3 && !STOP.has(w)).map(w => w.slice(0, 6)))
}

/** The share of the prompt's keywords found in the history (0–1), and how many it has. */
export function topicOverlap(prompt: string, history: readonly string[]): { overlap: number; count: number } {
  const words = keywords(prompt)
  const seen = keywords(history.join('\n'))
  const hits = [...words].filter(w => seen.has(w)).length
  return { overlap: words.size === 0 ? 1 : hits / words.size, count: words.size }
}

/** Worth comparing at all: checked before the history is read. */
export function isTopicCandidate(f: { text: string; tokens: number | undefined; mutedAt?: number }): boolean {
  const tokens = f.tokens ?? 0
  if (tokens < TOPIC_MIN_TOKENS || f.text.trimStart().startsWith('/')) return false
  if (f.mutedAt !== undefined && tokens < f.mutedAt * TOPIC_MUTE_GROWTH) return false
  return keywords(f.text).size >= TOPIC_MIN_KEYWORDS
}

export function isTopicShift(text: string, history: readonly string[]): boolean {
  if (history.every(h => h.trim() === '')) return false
  return topicOverlap(text, history).overlap <= TOPIC_MAX_OVERLAP
}

export type TopicChoice = 'send' | 'clear' | 'handoff' | 'keep'

/** What an answer means. Only Send sends; a dismissal keeps the prompt, like F2's Cancel. */
export function topicChoice(answer: string | undefined): TopicChoice {
  const a = (answer ?? '').trim()
  if (a === TOPIC_SEND) return 'send'
  if (a === TOPIC_CLEAR || /^\/clear\b/i.test(a)) return 'clear'
  if (a === TOPIC_HANDOFF_CLEAR || /^\/handoff\b/i.test(a)) return 'handoff'
  return 'keep'
}

export function topicQuestion(tokens: number): string {
  return (
    `ccwarden: this prompt shares almost no words with this session's goal or recent asks, and every turn here re-reads ~${fmtTokens(tokens)} tokens. ` +
    'New work? Clear starts fresh and puts your prompt back in the box. Send it here anyway?'
  )
}

export function topicDropReason(f: { isCleared: boolean; handoffPath?: string }): string {
  const note = f.handoffPath === undefined ? '' : ` Handoff written to ${f.handoffPath}.`
  return f.isCleared
    ? `ccwarden: not sent; clearing the conversation, then your prompt goes back in the box.${note}`
    : `ccwarden: not sent; your prompt is back in the box. Type /clear first for new work, or send it again to go ahead.${note}`
}

/** One answered hint, kept in $.store for tuning (SPEC §3 "Learning"). */
export type TopicEvent = { at: number; overlap: number; keywords: number; tokens: number; choice: TopicChoice }

export function appendTopic(log: readonly TopicEvent[] | undefined, ev: TopicEvent): TopicEvent[] {
  return [...(log ?? []), ev].slice(-200)
}
