import os
import re
import time
import requests
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(Path(__file__).parent / ".env")

VECTORIZE_URL = os.getenv("VECTORIZE_URL", "").rstrip("/")
API_KEY = os.getenv("VECTORIZE_API_KEY", "")

HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}


def _clean(text: str) -> str:
    text = re.sub(r'\s*https://t\.co/\S+', '', text)
    return text.replace("\n", " ").strip()


def ingest_batch(tweets: list[dict]) -> tuple[int, int]:
    """Send up to 100 tweets in one batch. Returns (succeeded, failed)."""
    documents = []
    for tweet in tweets:
        content = _clean(tweet.get("text", ""))
        if not content or len(content) < 10:
            continue
        documents.append({
            "id": f"tweet_{tweet['id']}",
            "content": content,
            "metadata": {
                "author":     tweet.get("author_username", ""),
                "name":       tweet.get("author_name", ""),
                "likes":      int(tweet.get("likes") or 0),
                "retweets":   int(tweet.get("retweets") or 0),
                "views":      int(tweet.get("views") or 0),
                "url":        tweet.get("url", ""),
                "created_at": (tweet.get("created_at") or "")[:10],
                "source":     "bookmark",
            },
        })

    if not documents:
        return 0, len(tweets)

    try:
        r = requests.post(
            f"{VECTORIZE_URL}/ingest/batch",
            json={"documents": documents, "concurrency": 10},
            headers=HEADERS,
            timeout=120,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("succeeded", 0), data.get("failed", 0)
    except Exception as e:
        return 0, len(documents)


def semantic_search(query: str, limit: int = 20) -> list[dict]:
    """Semantic search via the vectorize worker."""
    payload = {
        "query": query,
        "topK": min(limit, 50),
        "includeMetadata": True,
        "rerank": True,
    }
    try:
        r = requests.post(
            f"{VECTORIZE_URL}/search",
            json=payload,
            headers=HEADERS,
            timeout=20,
        )
        r.raise_for_status()
        data = r.json()
        return data.get("results", data.get("matches", []))
    except Exception as e:
        raise RuntimeError(f"Search failed: {e}")
