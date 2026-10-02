// List prices per million tokens (SPEC Appendix A, platform.claude.com,
// 2026-10). Dollar figures built from them are labelled "est." (R8): they
// ignore an admin's `modelPricing`.

export type Family = 'haiku' | 'sonnet' | 'opus' | 'fable'
export type Price = { input: number; write5m: number; write1h: number; read: number; output: number }

export const PRICES: Record<Family, Price> = {
  haiku: { input: 1, write5m: 1.25, write1h: 2, read: 0.1, output: 5 },
  sonnet: { input: 2, write5m: 2.5, write1h: 4, read: 0.2, output: 10 },
  opus: { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  fable: { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
}

/** The model family from an id or alias (`claude-sonnet-5-5`, `opus`); undefined when unknown. */
export function familyOf(model: string): Family | undefined {
  const m = /haiku|sonnet|opus|fable/i.exec(model)
  return m === null ? undefined : (m[0].toLowerCase() as Family)
}

/** What re-caching `tokens` costs at the TTL's write rate; undefined for an unknown model. */
export function rebuildUsd(tokens: number, model: string, ttl: '5m' | '1h'): number | undefined {
  const family = familyOf(model)
  if (family === undefined) return undefined
  const price = PRICES[family]
  return (tokens / 1e6) * (ttl === '1h' ? price.write1h : price.write5m)
}
