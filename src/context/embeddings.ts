// Optional semantic retrieval via ollama embeddings. Off by default; enable with
// VIBE_EMBEDDINGS=1 (and `ollama pull nomic-embed-text`). All callers treat failure
// as "no semantic signal" so a missing model never breaks retrieval.

const EMBED_MODEL = process.env.VIBE_EMBED_MODEL ?? 'nomic-embed-text'

export function embeddingsEnabled(): boolean {
  const v = process.env.VIBE_EMBEDDINGS
  return v === '1' || v === 'true'
}

export async function embed(
  texts: string[],
  baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
): Promise<number[][]> {
  if (texts.length === 0) return []
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  })
  if (!res.ok) throw new Error(`embeddings HTTP ${res.status}`)
  const json = (await res.json()) as { embeddings?: number[][] }
  return json.embeddings ?? []
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Cosine similarity of each item's text to the query. {} on any failure. */
export async function semanticScores(
  query: string,
  items: { key: string; text: string }[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (items.length === 0) return out
  try {
    const vectors = await embed([query, ...items.map(i => i.text)])
    const q = vectors[0]
    if (!q) return out
    items.forEach((item, i) => out.set(item.key, cosine(q, vectors[i + 1] ?? [])))
  } catch {
    // model unavailable / network error → no semantic signal
  }
  return out
}
