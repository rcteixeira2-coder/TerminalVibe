// Preços de API (US$ por milhão de tokens) para o "equivalente em API" das sessões e o custo estimado do agente.
// Claude: referência da skill claude-api (out/2026). Escrita de cache: 1,25× a entrada (5 min) e 2× (1 h).
// Modelos sem preço oficial confirmado ficam de fora: o painel mostra "—" em vez de chutar.
export interface Price {
  input: number
  output: number
  cacheRead: number
}

const CLAUDE: [RegExp, Price][] = [
  [/^claude-(fable|mythos)-5-1/, { input: 10, output: 50, cacheRead: 0.25 }],
  [/^claude-(fable|mythos)-5(?!-\d)/, { input: 10, output: 50, cacheRead: 1 }],
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-opus-5(?!-\d)/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-opus-4-[5-9]/, { input: 5, output: 25, cacheRead: 0.5 }],
  [/^claude-sonnet-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-sonnet-4/, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
  [/^claude-haiku-4-5/, { input: 1, output: 5, cacheRead: 0.1 }],
]

export function priceOf(model: string): Price | null {
  for (const [re, p] of CLAUDE) if (re.test(model)) return p
  return null
}

export interface TokenCounts {
  input: number
  // Escrita de cache: 5 min e 1 h têm preços diferentes.
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
  output: number
}

// Custo em US$ de um conjunto de tokens de um modelo; null se o preço não é conhecido.
export function costOf(model: string, t: TokenCounts): number | null {
  const p = priceOf(model)
  if (!p) return null
  const m = 1e6
  return (t.input * p.input + t.cacheWrite5m * p.input * 1.25 + t.cacheWrite1h * p.input * 2 + t.cacheRead * p.cacheRead + t.output * p.output) / m
}
