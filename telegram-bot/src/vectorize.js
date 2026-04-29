const MAX_SCORE = 2.0;
const VECTORIZE_INTERNAL_URL = "https://vectorize-mcp-worker.fpl-test.workers.dev/search";

export async function searchCorpus(query, { vectorizeWorker, vectorizeApiKey, limit = 15 }) {
  const res = await vectorizeWorker.fetch(VECTORIZE_INTERNAL_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${vectorizeApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      topK: Math.min(limit, 50),
      includeMetadata: true,
      rerank: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vectorize search failed: ${res.status} — ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const results = data.results ?? data.matches ?? [];
  return results.filter(r => (r.score ?? 0) <= MAX_SCORE);
}

export function filterByAuthors(results, targets) {
  if (!targets || targets.length === 0) return [];
  const normalized = targets.map(t => t.toLowerCase().replace(/^@/, ""));
  return results.filter(r => {
    const author = (r.metadata?.author ?? "").toLowerCase().replace(/^@/, "");
    return normalized.includes(author);
  });
}

export function fitScore(results, targets) {
  if (!results.length) return 0;
  const matches = filterByAuthors(results, targets);
  return Math.round((matches.length / results.length) * 100);
}

export function formatResult(r) {
  const text = (r.text ?? r.content ?? "").replace(/\s*https?:\/\/\S+/g, "").trim();
  const tweetId = (r.id ?? "").replace(/^tweet_/, "").replace(/-chunk-\d+$/, "");
  const url = r.metadata?.url || (tweetId ? `https://x.com/i/web/status/${tweetId}` : "");
  return {
    author: r.metadata?.author ?? null,
    text: text.length > 200 ? text.slice(0, 200) + "…" : text,
    likes: r.metadata?.likes ?? null,
    url,
    score: r.score ?? 0,
  };
}
