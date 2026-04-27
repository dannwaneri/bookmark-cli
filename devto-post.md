# I built my own bookmark CLI after looking at birdclaw

I was going to use birdclaw. It's a polished local-first Twitter workspace — syncs your DMs, mentions, bookmarks, and blocks into SQLite. Solid tool.

Then I looked at what I actually needed.

My problem wasn't triage. It was that I had 11,000+ bookmarks and every time I sat down to write, I had no way to pull from them. I'd remember saving something useful on RAG failure modes six months ago. No idea where. So I'd start from scratch.

I tried searching X's native bookmarks. Got nothing useful. Closed the tab.

So I built bookmark-cli instead.

## What I dropped from birdclaw's scope

DM sync. Mentions triage. The web UI.

I live in the terminal. I don't need my DMs searchable. The features birdclaw has that I didn't build aren't missing — they're out of scope. Different problem.

## What I kept

The same core approach: cookie-based sync, local SQLite with FTS5, resumable pagination. birdclaw figured out the hard part of getting around X's broken bookmark API. I didn't need to reinvent that.

## What I added that doesn't exist anywhere else

**Hook miner with engagement sorting.**

```
python bookmark.py hooks "AI agents" --limit 200
```

This pulls every opening line on a topic from your saved tweets, classifies them by format — LIST, QUESTION, PERSONAL STORY, CONTRARIAN — and sorts each group by likes. You see what actually worked at scale, not what you think worked.

The highest-liked PERSONAL STORY hook on "building in public" from my archive got 10,634 likes. I didn't write that hook. I found it. That's the difference.

**Semantic search via Cloudflare Vectorize.**

```
python bookmark.py semantic-hooks "RAG failure modes" --limit 15
```

45,000 tweets indexed as vectors on my own Cloudflare worker. Finds meaning, not keywords. Returns real engagement data from local SQLite.

Last week's thread started with a hook I found this way. I searched "Nigerian developer building AI tools," found a tweet from @theshalvah — "Always love seeing Nigerians in Nigeria building excellent software" — 58 likes, but the framing was exactly right. I adapted it. Wrote the hook in ten minutes instead of an hour.

**Likes sync.**

Bookmarks are intentional. Likes are instinctive. 33,000 liked tweets in the same database as 11,835 bookmarks. Two signals, one archive.

```
python bookmark.py sync-likes
```

The daily cron runs both automatically.

**Image enrichment.**

Most tools skip tweets that are just screenshots. Yours gets every tweet with a photo described by Llama 4 Scout before it's indexed.

```
python bookmark.py ingest-vector --enrich-images
```

Now when I search "indie hacker revenue dashboard screenshot," I get back tweets that had no text at all — just a photo. The AI description is what matched. 7,000+ photo tweets in my archive are now fully searchable by what's in the image.

**Obsidian export.**

The missing link between mining and writing. One command turns a semantic search into a dated Markdown note in your vault:

```
python bookmark.py export "RAG failure modes" --subfolder "Research"
```

YAML frontmatter, blockquoted tweets, engagement stats, direct links. Set `OBSIDIAN_VAULT` in `.env` once and forget the flag. The three layers — sync, read, query — are now actually connected rather than just theoretically compatible.

## The numbers

- 11,835 bookmarks + 33,218 likes = 45,053 tweets
- 7,155 photo tweets enriched with AI vision descriptions
- 580 cross-document reflections synthesised by Llama
- All local, all private, zero ongoing cost beyond Cloudflare's $5/month Workers plan
- Daily cron syncs new bookmarks and likes, ingests new tweets to the vector store, and generates 60 new reflections automatically

## The comparison

birdclaw is for people who want to manage their Twitter presence. I needed to think with mine. That turned out to be a different tool entirely.

If you want DMs, mentions, and a web UI — use birdclaw. It's genuinely good.

If you want a content engine that turns your saved tweets into hooks, research, and writing fuel — the code is here:

[github.com/dannwaneri/bookmark-cli](https://github.com/dannwaneri/bookmark-cli)
