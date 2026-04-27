# bookmark-cli

A local X/Twitter bookmark manager and content engine. Syncs your bookmarks to a local SQLite database, lets you search them with full-text and semantic search, and mines high-engagement hooks to inspire your own tweets.

Built with Python, SQLite FTS5, and [Cloudflare Vectorize](https://developers.cloudflare.com/vectorize/) for semantic search.

## Features

- Sync all your X bookmarks locally (resumes where it left off)
- Full-text search across tweet text and authors
- Engagement stats: likes, retweets, replies, views
- Hook miner — extracts first lines sorted by engagement to inspire content
- Semantic search via a self-hosted Cloudflare Vectorize worker

## Setup

```bash
pip install -r requirements.txt

copy .env.example .env
# Fill in your credentials (see below)
```

### Getting your X credentials

1. Log in to [x.com](https://x.com) and go to `x.com/i/bookmarks`
2. Open DevTools (`F12`) → **Network** tab → filter by `Bookmarks`
3. Click the request → **Headers** tab
4. Copy `ct0`, `auth_token`, and the full `Cookie` header into your `.env`

### Vectorize worker (optional — for semantic search)

Deploy [vectorize-mcp-worker](https://github.com/dannwaneri/vectorize-mcp-worker) to Cloudflare Workers, then set `VECTORIZE_URL` and `VECTORIZE_API_KEY` in your `.env`.

## Commands

### Sync bookmarks
```bash
python bookmark.py sync
```
Fetches all bookmarks from X and saves them locally. Safe to re-run — already-synced tweets are skipped.

```bash
python bookmark.py sync --max-pages 10   # stop after 10 pages (200 tweets)
python bookmark.py sync --debug          # print raw API responses
```

### Search
```bash
python bookmark.py search "machine learning"
python bookmark.py search "python tips" --limit 20
```
Full-text search across tweet text and author usernames.

### List
```bash
python bookmark.py list
python bookmark.py list --author elonmusk
python bookmark.py list --since 2024-01-01 --limit 20
```

### Show one bookmark
```bash
python bookmark.py show 1234567890123456789
```
Full text, media links, engagement stats, and optional raw JSON.

### Stats
```bash
python bookmark.py stats
```
Total count, date range, top 10 authors, and a per-month bar chart.

### Hook miner
```bash
python bookmark.py hooks "productivity"
python bookmark.py hooks "AI" --limit 200
python bookmark.py hooks "startups" --author naval
```
Extracts tweet opening lines on a topic, classifies them by format (LIST, QUESTION, PERSONAL STORY, CONTRARIAN, etc.), and sorts each group by likes. Use these to inspire your own hooks.

### Backfill engagement stats
```bash
python bookmark.py backfill
```
Re-parses stored raw JSON to fill in likes, retweets, replies, and views. Run once after upgrading from an older version.

### Ingest into Vectorize (semantic search)
```bash
python bookmark.py ingest-vector
python bookmark.py ingest-vector --batch 100          # larger batches (faster)
python bookmark.py ingest-vector --limit 500          # ingest only 500 tweets this run
python bookmark.py ingest-vector --enrich-images      # describe photos with Llama 4 Scout before indexing
```
Pushes bookmarks into your Cloudflare Vectorize worker in batches. Resumes from where it left off — already-ingested tweets are skipped.

`--enrich-images` calls `/analyze-image` on each photo URL before vectorizing, appending an AI-generated description to the content. This makes image-only tweets searchable by what's in the image. Adds ~10s per photo tweet — run as a one-time backfill, not in the daily cron.

### Semantic search
```bash
python bookmark.py semantic-hooks "building in public"
python bookmark.py semantic-hooks "RAG vector search" --limit 20
```
Finds semantically related bookmarks — matches meaning, not just keywords. Returns real engagement data from the local database. Results with reranker scores above 2.0 are automatically filtered as noise.

### Generate knowledge reflections
```bash
python bookmark.py reflect                        # 20 documents, 1 batch
python bookmark.py reflect --batch 50 --runs 10  # 500 documents across 10 batches
```
Samples un-reflected documents from the vector index and asks Llama to synthesise what's new, how it connects to existing knowledge, and what gap remains. Reflections are stored back in the index and surface alongside raw results in semantic search. Runs automatically in the daily cron (60 per day).

## Storage

- Database: `~/.bookmark-cli/bookmarks.db` (SQLite with FTS5)
- Credentials: `.env` in the project directory (never committed)

## Error handling

| Error | Behaviour |
|-------|-----------|
| `401 Unauthorized` | Clear message — update cookies in `.env` |
| `429 Too Many Requests` | Auto-waits 60–180s and retries |
| Network failure | Retries 3× with exponential backoff |
