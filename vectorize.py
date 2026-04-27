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


def analyze_image(image_url: str) -> str:
    """Call /analyze-image on the worker and return a description string."""
    try:
        r = requests.post(
            f"{VECTORIZE_URL}/analyze-image",
            json={"url": image_url},
            headers=HEADERS,
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get("description", "")
    except Exception:
        return ""


def _get_image_url(media_json: str | None) -> str | None:
    """Return the first usable image URL from media_json, or None."""
    if not media_json:
        return None
    try:
        items = __import__("json").loads(media_json)
    except Exception:
        return None
    for item in items:
        if item.get("type") == "photo" and item.get("url"):
            return item["url"]
        if item.get("thumb"):  # video thumbnail
            return item["thumb"]
    return None


def ingest_batch(tweets: list[dict], enrich_images: bool = False) -> tuple[int, int]:
    """Send up to 100 tweets in one batch. Returns (succeeded, failed)."""
    documents = []
    for tweet in tweets:
        content = _clean(tweet.get("text", ""))
        if not content or len(content) < 10:
            continue
        if enrich_images:
            img_url = _get_image_url(tweet.get("media_json"))
            if img_url:
                desc = analyze_image(img_url)
                if desc:
                    content = f"{content}\n[Image: {desc}]"
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


def reflect_batch(limit: int = 20) -> dict:
    """Trigger reflection for a random sample of un-reflected documents."""
    try:
        r = requests.post(
            f"{VECTORIZE_URL}/reflect/batch",
            json={"limit": limit},
            headers=HEADERS,
            timeout=300,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        raise RuntimeError(f"Reflect failed: {e}")


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
