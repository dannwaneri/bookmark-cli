#!/usr/bin/env python3
"""X/Twitter Bookmark CLI"""

import sys
import json
import time
from pathlib import Path
from datetime import datetime, timezone

# Force UTF-8 on Windows so rich's braille spinners don't crash cp1252 terminals
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Load .env relative to this script, not cwd
_ENV_PATH = Path(__file__).parent / ".env"

from dotenv import load_dotenv
load_dotenv(_ENV_PATH)

import os
import click
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TimeElapsedColumn
from rich.text import Text
from rich import box

import db
import sync as sync_module
import vectorize as vec_module

console = Console(width=min(220, max(120, __import__("shutil").get_terminal_size((160, 40)).columns)))


def _get_credentials() -> tuple[str, str]:
    """Returns (ct0, full_cookie_string)."""
    ct0 = os.getenv("CT0") or os.getenv("ct0")
    auth_token = os.getenv("AUTH_TOKEN") or os.getenv("auth_token")
    cookie = os.getenv("COOKIE")

    if not ct0 or not auth_token:
        console.print(
            Panel(
                "[bold red]Missing credentials![/]\n\n"
                "Set [yellow]CT0[/], [yellow]AUTH_TOKEN[/], and [yellow]COOKIE[/] in your [cyan].env[/] file.\n"
                "Copy [cyan].env.example[/] to [cyan].env[/] and fill in your values.",
                title="Auth Error",
                border_style="red",
            )
        )
        sys.exit(1)

    # If full cookie string not provided, build a minimal one
    if not cookie:
        cookie = f"ct0={ct0}; auth_token={auth_token}"

    return ct0, cookie


def _media_badge(media_json: str | None) -> str:
    if not media_json:
        return ""
    try:
        media = json.loads(media_json)
        if not media:
            return ""
        types = [m.get("type", "photo") for m in media]
        badges = []
        if "video" in types:
            badges.append("[yellow][video][/]")
        if "animated_gif" in types:
            badges.append("[yellow][gif][/]")
        photos = types.count("photo")
        if photos == 1:
            badges.append("[blue][photo][/]")
        elif photos > 1:
            badges.append(f"[blue][{photos} photos][/]")
        return " ".join(badges)
    except Exception:
        return ""


def _format_date(raw: str | None) -> str:
    if not raw:
        return "—"
    try:
        dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%d")
    except Exception:
        return raw[:10] if raw else "—"


def _clean_text(text: str) -> str:
    import re
    # strip trailing t.co media placeholder links added by Twitter for photos/videos
    text = re.sub(r'\s*https://t\.co/\S+$', '', text.strip())
    return text.strip()


def _truncate(text: str, length: int = 80) -> str:
    text = _clean_text(text).replace("\n", " ").strip()
    return text[:length] + "..." if len(text) > length else text


@click.group()
def cli():
    """X/Twitter Bookmark CLI — sync, search, and browse your bookmarks."""
    db.init_db()


@cli.command()
def backfill():
    """Extract engagement stats from stored raw JSON (run once after upgrading)."""
    console.print("[cyan]Backfilling engagement stats from stored data...[/]")
    updated = db.backfill_engagement()
    console.print(f"[green]Done![/] Updated [cyan]{updated:,}[/] tweets.")


@cli.command()
@click.option("--debug", is_flag=True, default=False, help="Print raw API responses for debugging.")
@click.option("--max-pages", default=0, help="Stop after N pages (0 = all). One page = 20 tweets.")
def sync(debug: bool, max_pages: int):
    """Sync bookmarks from X to local SQLite database."""
    ct0, cookie = _get_credentials()

    console.print(Panel("[bold cyan]Syncing bookmarks from X...[/]", border_style="cyan"))

    existing_ids = db.get_existing_ids()
    new_count = 0
    skip_count = 0
    page_num = 0

    with Progress(
        SpinnerColumn("line"),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=30),
        TextColumn("[cyan]{task.fields[new]}[/] new  [dim]{task.fields[skip]}[/] skipped"),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        task = progress.add_task(
            "Fetching bookmarks...",
            total=None,
            new=0,
            skip=0,
        )

        try:
            for batch, next_cursor in sync_module.fetch_all_bookmarks(ct0, cookie, debug=debug):
                page_num += 1
                page_new = 0
                for tweet in batch:
                    if tweet["id"] in existing_ids:
                        skip_count += 1
                    else:
                        db.upsert_bookmark(tweet)
                        existing_ids.add(tweet["id"])
                        new_count += 1
                        page_new += 1

                progress.update(
                    task,
                    description=f"Page {page_num}…",
                    new=new_count,
                    skip=skip_count,
                )

                if not next_cursor:
                    break
                if max_pages and page_num >= max_pages:
                    break
                # Stop early once we hit a full page of already-synced tweets
                if batch and page_new == 0:
                    break

        except PermissionError as e:
            progress.stop()
            console.print(
                Panel(
                    f"[bold red]Authentication failed (HTTP 401)[/]\n\n"
                    f"Your X session cookies have expired. To get fresh ones:\n\n"
                    f"  1. Open [cyan]x.com[/] in Chrome/Edge and log in\n"
                    f"  2. Press [bold]F12[/] to open DevTools\n"
                    f"  3. Go to [bold]Application[/] tab -> [bold]Cookies[/] -> [cyan]https://x.com[/]\n"
                    f"  4. Copy [yellow]ct0[/] and [yellow]auth_token[/] values\n"
                    f"  5. Paste them into your [cyan].env[/] file\n\n"
                    f"[dim]{e}[/]",
                    title="Session Expired",
                    border_style="red",
                )
            )
            sys.exit(1)
        except sync_module.RateLimitError as e:
            progress.stop()
            console.print(f"\n[bold yellow]{e}[/]")
            sys.exit(1)
        except sync_module.NetworkError as e:
            progress.stop()
            console.print(f"\n[bold red]{e}[/]")
            sys.exit(1)

        progress.update(task, description="Done!", completed=1, total=1)

    console.print(
        Panel(
            f"[bold green]Sync complete![/]\n\n"
            f"  New bookmarks:     [cyan]{new_count}[/]\n"
            f"  Already synced:    [dim]{skip_count}[/]\n"
            f"  Pages fetched:     {page_num}",
            border_style="green",
        )
    )


@cli.command()
@click.argument("query")
@click.option("--limit", default=50, show_default=True, help="Max results to show.")
def search(query: str, limit: int):
    """Full-text search bookmarks by text and author."""
    try:
        rows = db.search_bookmarks(query, limit=limit)
    except Exception as e:
        console.print(f"[red]Search error:[/] {e}")
        sys.exit(1)

    if not rows:
        console.print(f"[yellow]No results for:[/] {query!r}")
        return

    table = Table(
        title=f"Search: [cyan]{query}[/]  ({len(rows)} result{'s' if len(rows) != 1 else ''})",
        box=box.ROUNDED,
        show_lines=True,
        highlight=True,
    )
    table.add_column("Author", style="bold magenta", no_wrap=True, min_width=16)
    table.add_column("Text Preview", min_width=40, ratio=1)
    table.add_column("Date", style="green", no_wrap=True, min_width=10)
    table.add_column("URL", style="blue dim", no_wrap=True, min_width=20)

    for row in rows:
        badge = _media_badge(row["media_json"])
        preview = _truncate(row["text"], 100)
        text_cell = f"{preview}  {badge}" if badge else preview
        table.add_row(
            f"@{row['author_username']}",
            text_cell,
            _format_date(row["created_at"]),
            row["url"] or "—",
        )

    console.print(table)


@cli.command("list")
@click.option("--author", default=None, help="Filter by author username (partial match).")
@click.option("--since", default=None, metavar="YYYY-MM-DD", help="Show tweets on or after this date.")
@click.option("--limit", default=50, show_default=True, help="Max results to show.")
@click.option("--source", default=None, type=click.Choice(["bookmark", "like"]), help="Filter by source.")
def list_bookmarks(author: str | None, since: str | None, limit: int, source: str | None):
    """List bookmarks with optional filters."""
    rows = db.list_bookmarks(author=author, since=since, limit=limit, source=source)

    if not rows:
        console.print("[yellow]No bookmarks found.[/]")
        return

    title_parts = ["Bookmarks"]
    if source:
        title_parts.append(f"[{'red' if source == 'like' else 'cyan'}]{source}s[/]")
    if author:
        title_parts.append(f"author~[cyan]{author}[/]")
    if since:
        title_parts.append(f"since [cyan]{since}[/]")
    title_parts.append(f"({len(rows)} result{'s' if len(rows) != 1 else ''})")

    table = Table(
        title="  ".join(title_parts),
        box=box.ROUNDED,
        show_lines=True,
        highlight=True,
    )
    table.add_column("Author", style="bold magenta", no_wrap=True, min_width=16)
    table.add_column("Text Preview", min_width=40, ratio=1)
    table.add_column("Date", style="green", no_wrap=True, min_width=10)
    table.add_column("URL", style="blue dim", no_wrap=True, min_width=20)

    for row in rows:
        badge = _media_badge(row["media_json"])
        preview = _truncate(row["text"], 100)
        text_cell = f"{preview}  {badge}" if badge else preview
        table.add_row(
            f"@{row['author_username']}",
            text_cell,
            _format_date(row["created_at"]),
            row["url"] or "—",
        )

    console.print(table)


@cli.command()
def stats():
    """Show bookmark statistics and top authors."""
    data = db.get_stats()

    if data["total"] == 0:
        console.print("[yellow]No bookmarks yet. Run [bold]bookmark.py sync[/] first.[/]")
        return

    min_date = _format_date(data["date_range"][0])
    max_date = _format_date(data["date_range"][1])

    console.print(
        Panel(
            f"[bold]Total bookmarks:[/]  [cyan]{data['total']}[/]\n"
            f"[bold]Date range:[/]       [green]{min_date}[/]  →  [green]{max_date}[/]",
            title="[bold]Bookmark Stats[/]",
            border_style="cyan",
        )
    )

    # Top authors table
    if data["top_authors"]:
        authors_table = Table(
            title="Top 10 Authors",
            box=box.SIMPLE_HEAVY,
            highlight=True,
        )
        authors_table.add_column("Rank", style="dim", width=6)
        authors_table.add_column("Username", style="bold magenta")
        authors_table.add_column("Name", style="white")
        authors_table.add_column("Bookmarks", style="cyan", justify="right")

        for rank, row in enumerate(data["top_authors"], 1):
            authors_table.add_row(
                f"#{rank}",
                f"@{row['author_username']}",
                row["author_name"],
                str(row["cnt"]),
            )
        console.print(authors_table)

    # Per-month chart
    if data["per_month"]:
        console.print()
        console.print("[bold]Bookmarks per month:[/]")
        per_month = data["per_month"]
        max_count = max(row["cnt"] for row in per_month)
        bar_width = 40

        for row in per_month:
            month = row["month"]
            count = row["cnt"]
            filled = int((count / max_count) * bar_width) if max_count else 0
            bar = "█" * filled + "░" * (bar_width - filled)
            console.print(f"  [green]{month}[/]  [cyan]{bar}[/]  [bold]{count}[/]")


@cli.command()
@click.argument("topic")
@click.option("--limit", default=100, show_default=True, help="Bookmarks to scan.")
@click.option("--author", default=None, help="Only from a specific author.")
def hooks(topic: str, limit: int, author: str | None):
    """Extract tweet hooks on a topic to inspire your own content."""
    import re

    rows = db.search_hooks(topic, limit=limit)

    if author:
        rows = [r for r in rows if author.lower() in r["author_username"].lower()]

    if not rows:
        console.print(f"[yellow]No bookmarks found for:[/] {topic!r}")
        return

    def classify_hook(line: str) -> tuple[str, str]:
        l = line.strip()
        if re.match(r"^\d+[\.\):]", l) or re.search(r"\b\d+\s+(ways|things|tips|rules|lessons|reasons|habits|steps|mistakes|secrets|facts)\b", l, re.I):
            return "LIST", "cyan"
        if l.endswith("?") or l.startswith(("Why ", "How ", "What ", "When ", "Who ", "Is ", "Are ", "Do ", "Did ", "Can ")):
            return "QUESTION", "yellow"
        if re.search(r"\bI (did|spent|tried|quit|built|made|lost|gained|went|started|stopped|learned|realized)\b", l, re.I):
            return "PERSONAL STORY", "green"
        if re.search(r"\b(hot take|unpopular opinion|controversial|nobody|most people|everyone|no one)\b", l, re.I):
            return "CONTRARIAN", "red"
        if re.search(r"\b(thread|🧵|a thread)\b", l, re.I):
            return "THREAD", "magenta"
        if re.search(r"\b(breaking|just in|🚨|alert)\b", l, re.I):
            return "BREAKING", "bold red"
        if re.search(r"\b(secret|hack|trick|cheat|shortcut|tool|resource)\b", l, re.I):
            return "HACK/TOOL", "blue"
        return "STATEMENT", "white"

    # Extract hook (first non-empty line) and classify
    hooks_data = []
    for row in rows:
        text = _clean_text(row["text"])
        lines = [l.strip() for l in text.split("\n") if l.strip()]
        if not lines:
            continue
        hook = lines[0]
        if len(hook) < 15:  # skip trivially short openers
            hook = " ".join(lines[:2]) if len(lines) > 1 else hook
        hook_type, color = classify_hook(hook)
        hooks_data.append({
            "hook": hook,
            "type": hook_type,
            "color": color,
            "author": row["author_username"],
            "url": row["url"],
            "likes": row["likes"] or 0,
            "retweets": row["retweets"] or 0,
            "views": row["views"] or 0,
        })

    # Count types
    from collections import Counter
    type_counts = Counter(h["type"] for h in hooks_data)

    console.print()
    console.print(Panel(
        f"[bold]Topic:[/] [cyan]{topic}[/]   [bold]Bookmarks scanned:[/] {len(rows)}   [bold]Hooks extracted:[/] {len(hooks_data)}",
        title="[bold]Content Hook Miner[/]",
        border_style="cyan",
    ))

    # Format breakdown
    console.print("\n[bold]Hook format breakdown:[/]")
    for htype, count in type_counts.most_common():
        pct = int(count / len(hooks_data) * 100)
        bar = "█" * (pct // 3)
        console.print(f"  {htype:<16} {bar:<35} {count} ({pct}%)")

    console.print()
    console.print("[bold]Hooks to adapt (sorted by type):[/]\n")

    # Group by type and show
    from itertools import groupby
    sorted_hooks = sorted(hooks_data, key=lambda h: h["type"])
    for htype, group in groupby(sorted_hooks, key=lambda h: h["type"]):
        group = list(group)
        _, color = classify_hook(group[0]["hook"])
        console.print(f"[bold {color}]── {htype} ({len(group)}) ──[/]")
        for h in sorted(group, key=lambda x: x["likes"], reverse=True)[:5]:
            hook_text = h["hook"][:120]
            likes_str = f"[red]♥ {h['likes']:,}[/]" if h["likes"] else ""
            rt_str = f"[green]↺ {h['retweets']:,}[/]" if h["retweets"] else ""
            eng = f"  {likes_str}  {rt_str}".strip()
            console.print(f"  [dim]@{h['author']:<18}[/] {hook_text}")
            if eng.strip():
                console.print(f"  {eng}")
            console.print(f"  [dim blue]{h['url']}[/]")
            console.print()


@cli.command("sync-likes")
@click.option("--debug", is_flag=True, default=False)
@click.option("--max-pages", default=0, help="Stop after N pages (0 = all).")
def sync_likes(debug: bool, max_pages: int):
    """Sync liked tweets from X to local SQLite database."""
    ct0, cookie = _get_credentials()

    likes_hash = os.getenv("LIKES_HASH", "").strip()
    if not likes_hash:
        console.print(Panel(
            "[bold red]LIKES_HASH not set![/]\n\n"
            "To get it:\n"
            "  1. Go to [cyan]x.com/{yourhandle}/likes[/] in Chrome\n"
            "  2. Open DevTools (F12) → Network tab\n"
            "  3. Find the [yellow]Likes[/] request\n"
            "  4. Copy the hash from the URL (between /graphql/ and /Likes)\n"
            "  5. Add [yellow]LIKES_HASH=<hash>[/] to your [cyan].env[/] file",
            title="Missing Config",
            border_style="red",
        ))
        sys.exit(1)

    user_id = sync_module.extract_user_id(cookie)
    if not user_id:
        console.print("[red]Could not extract user ID from COOKIE. Make sure twid= is present.[/]")
        sys.exit(1)

    console.print(Panel(
        f"[bold cyan]Syncing liked tweets from X...[/]\n"
        f"User ID: [dim]{user_id}[/]",
        border_style="cyan",
    ))

    existing_ids = db.get_existing_ids()
    new_count = 0
    skip_count = 0
    page_num = 0

    with Progress(
        SpinnerColumn("line"),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=30),
        TextColumn("[cyan]{task.fields[new]}[/] new  [dim]{task.fields[skip]}[/] skipped"),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        task = progress.add_task("Fetching likes...", total=None, new=0, skip=0)

        try:
            for batch, next_cursor in sync_module.fetch_all_likes(
                ct0, cookie, user_id, likes_hash, debug=debug
            ):
                page_num += 1
                page_new = 0
                for tweet in batch:
                    if tweet["id"] in existing_ids:
                        skip_count += 1
                    else:
                        db.upsert_bookmark(tweet, source="like")
                        existing_ids.add(tweet["id"])
                        new_count += 1
                        page_new += 1

                progress.update(task, description=f"Page {page_num}...", new=new_count, skip=skip_count)

                if not next_cursor:
                    break
                if max_pages and page_num >= max_pages:
                    break
                # Stop early once we hit a full page of already-synced tweets
                if batch and page_new == 0:
                    break

        except PermissionError as e:
            progress.stop()
            console.print(Panel(f"[bold red]Authentication failed (HTTP 401)[/]\n\n[dim]{e}[/]", border_style="red"))
            sys.exit(1)
        except sync_module.NetworkError as e:
            progress.stop()
            console.print(f"\n[bold red]{e}[/]")
            sys.exit(1)

        progress.update(task, description="Done!", completed=1, total=1)

    console.print(Panel(
        f"[bold green]Sync complete![/]\n\n"
        f"  New likes:      [cyan]{new_count}[/]\n"
        f"  Already synced: [dim]{skip_count}[/]\n"
        f"  Pages fetched:  {page_num}",
        border_style="green",
    ))


@cli.command("ingest-vector")
@click.option("--batch", default=50, show_default=True, help="Tweets per batch.")
@click.option("--limit", default=0, help="Max tweets to ingest (0 = all).")
@click.option("--enrich-images", is_flag=True, default=False, help="Call /analyze-image for tweets with photos.")
def ingest_vector(batch: int, limit: int, enrich_images: bool):
    """Push bookmarks into vectorize-mcp-worker for semantic search."""
    total_count = db.get_stats()["total"]
    total_remaining = total_count - db.vectorized_count()
    if total_remaining <= 0:
        console.print("[green]All bookmarks already ingested![/]")
        return

    cap = limit if limit > 0 else total_remaining
    console.print(Panel(
        f"[cyan]Ingesting bookmarks into vectorize worker...[/]\n"
        f"Remaining: [bold]{total_remaining:,}[/]  |  This run: [bold]{cap:,}[/]",
        border_style="cyan",
    ))

    done = 0
    failed = 0

    with Progress(
        SpinnerColumn("line"),
        TextColumn("[progress.description]{task.description}"),
        BarColumn(bar_width=30),
        TextColumn("[cyan]{task.completed}[/] / {task.total}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Ingesting...", total=cap)

        while done < cap:
            rows = db.get_unvectorized(batch_size=min(batch, cap - done))
            if not rows:
                break

            tweets = [dict(row) for row in rows]
            succeeded, fail_count = vec_module.ingest_batch(tweets, enrich_images=enrich_images)

            # Mark all IDs when the worker responded (succeeded > 0).
            # Filtered/short tweets count as "failed" but won't succeed on retry,
            # so we mark them done to avoid an infinite loop.
            # On total failure (network error), succeeded==0 so we skip and retry next run.
            if succeeded > 0:
                db.mark_vectorized([t["id"] for t in tweets])

            done += succeeded
            failed += fail_count
            progress.advance(task, advance=len(rows))

            time.sleep(0.3)  # be gentle with the worker

    console.print(Panel(
        f"[bold green]Done![/]\n\n"
        f"  Ingested:  [cyan]{done:,}[/]\n"
        f"  Failed:    [dim]{failed:,}[/]\n"
        f"  Total in worker: ~[cyan]{db.vectorized_count():,}[/]",
        border_style="green",
    ))


@cli.command("export")
@click.argument("topic")
@click.option("--vault", envvar="OBSIDIAN_VAULT", required=True, help="Path to Obsidian vault folder (or set OBSIDIAN_VAULT in .env).")
@click.option("--limit", default=15, show_default=True, help="Number of results to include.")
@click.option("--subfolder", default="Research", show_default=True, help="Subfolder inside the vault to write into.")
@click.option("--min-score", default=0.55, show_default=True, help="Drop results below this relevance score.")
def export_to_obsidian(topic: str, vault: str, limit: int, subfolder: str, min_score: float):
    """Export semantic search results as a Markdown note into an Obsidian vault."""
    import re as _re
    from pathlib import Path as _Path

    console.print(f"\n[cyan]Searching:[/] {topic!r}\n")
    try:
        results = vec_module.semantic_search(topic, limit=limit)
    except RuntimeError as e:
        console.print(f"[red]{e}[/]")
        sys.exit(1)

    results = [r for r in results if r.get("score", 0) >= min_score]
    if not results:
        console.print(f"[yellow]No results above min-score {min_score} — try lowering --min-score or changing the query.[/]")
        return

    # Enrich with local DB data
    enriched = []
    for r in results:
        doc_id = r.get("id", "")
        tweet_id = __import__("re").sub(r"-chunk-\d+", "", doc_id.removeprefix("tweet_"))
        row = db.get_bookmark(tweet_id) if tweet_id else None
        meta = r.get("metadata", {})
        enriched.append({
            "author":   (row["author_username"] if row else meta.get("author", "unknown")),
            "name":     (row["author_name"]     if row else meta.get("name", "")),
            "text":     (row["text"]            if row else meta.get("content", r.get("content", ""))),
            "likes":    int(row["likes"]        if row else meta.get("likes", 0) or 0),
            "url":      (row["url"]             if row else meta.get("url", "")),
            "score":    round(r.get("score", 0), 3),
        })

    # Build Markdown
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    safe_topic = _re.sub(r'[\\/:*?"<>|]', "-", topic)
    filename = f"{today} {safe_topic}.md"

    lines = [
        "---",
        f"created: {today}",
        f"query: \"{topic}\"",
        "source: bookmark-cli",
        f"results: {len(enriched)}",
        "tags: [research, bookmark-cli]",
        "---",
        "",
        f"# {topic}",
        f"*{len(enriched)} tweets · exported {today} via bookmark-cli*",
        "",
    ]

    for i, item in enumerate(enriched, 1):
        author = item["author"]
        likes  = f"{item['likes']:,}" if item["likes"] else "—"
        text   = item["text"].replace("\n", " ").strip()
        url    = item["url"] or ""
        score  = item["score"]
        lines += [
            f"## {i}. @{author} · {likes} likes  ·  score {score}",
            f"> {text}",
            "",
            f"[View tweet]({url})" if url else "",
            "",
        ]

    content = "\n".join(lines)

    # Write to vault
    out_dir = _Path(vault) / subfolder
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / filename
    out_path.write_text(content, encoding="utf-8")

    console.print(Panel(
        f"[bold green]Exported![/]\n\n"
        f"  File:    [cyan]{out_path}[/]\n"
        f"  Results: [cyan]{len(enriched)}[/]\n"
        f"  Vault:   [dim]{vault}[/]",
        border_style="green",
    ))


@cli.command("reflect")
@click.option("--batch", default=20, show_default=True, help="Documents to reflect per run (max 100).")
@click.option("--runs", default=1, show_default=True, help="Number of batches to run.")
def reflect(batch: int, runs: int):
    """Generate LLM reflections for un-reflected documents in the vector index."""
    total_reflected = 0
    total_failed = 0

    with Progress(
        SpinnerColumn("line"),
        TextColumn("[progress.description]{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task(f"Reflecting (0/{runs} batches)...", total=runs)

        for i in range(runs):
            progress.update(task, description=f"Reflecting ({i + 1}/{runs} batches)...")
            try:
                result = vec_module.reflect_batch(limit=batch)
                total_reflected += result.get("reflected", 0)
                total_failed += result.get("failed", 0)
                if result.get("reflected", 0) == 0:
                    progress.advance(task, advance=runs - i)
                    break
            except RuntimeError as e:
                console.print(f"[red]{e}[/]")
                break
            progress.advance(task, advance=1)

    console.print(Panel(
        f"[bold green]Done![/]\n\n"
        f"  Reflected: [cyan]{total_reflected:,}[/]\n"
        f"  Failed:    [dim]{total_failed:,}[/]",
        border_style="green",
    ))


@cli.command("semantic-hooks")
@click.argument("topic")
@click.option("--limit", default=15, show_default=True, help="Results to return.")
@click.option("--debug", is_flag=True, default=False, help="Print raw worker response.")
def semantic_hooks(topic: str, limit: int, debug: bool):
    """Semantic search your bookmarks — finds meaning not just keywords."""
    console.print(f"\n[cyan]Searching for:[/] {topic!r}  [dim](semantic)[/]\n")

    try:
        results = vec_module.semantic_search(topic, limit=limit)
    except RuntimeError as e:
        console.print(f"[red]{e}[/]")
        sys.exit(1)

    if not results:
        console.print("[yellow]No results found.[/]")
        return

    if debug:
        console.print("\n[bold yellow]Raw first result:[/]")
        console.print_json(json.dumps(results[0], indent=2, default=str))
        console.print()

    import re

    # Resolve tweet data from local DB using the document ID (tweet_{id}-chunk-N)
    enriched = []
    for r in results:
        doc_id = r.get("id", "")
        # Worker appends -chunk-N; strip it to recover the original tweet ID
        tweet_id = re.sub(r'-chunk-\d+$', '', doc_id.removeprefix("tweet_"))
        row = db.get_bookmark(tweet_id) if tweet_id else None

        text = r.get("text", r.get("content", ""))
        text = re.sub(r'\s*https://t\.co/\S+', '', text).strip()
        hook = text[:100] + "..." if len(text) > 100 else text
        score = r.get("score", r.get("similarity", 0))

        if row:
            author = row["author_username"]
            likes = row["likes"] or 0
            url = row["url"] or ""
        else:
            meta = r.get("metadata", {})
            author = meta.get("author", "unknown")
            likes = int(meta.get("likes", 0))
            url = meta.get("url", "")

        enriched.append({"author": author, "hook": hook, "likes": likes, "url": url, "score": score})

    table = Table(
        title=f"Semantic Hooks: [cyan]{topic}[/]  ({len(enriched)} results)",
        box=box.ROUNDED,
        show_lines=True,
    )
    table.add_column("Author", style="bold magenta", no_wrap=True, min_width=16)
    table.add_column("Hook", min_width=40, ratio=1)
    table.add_column("Likes", style="red", justify="right", min_width=8)
    table.add_column("Score", style="dim", justify="right", min_width=6)

    for h in enriched:
        table.add_row(
            f"@{h['author']}",
            h["hook"],
            f"{h['likes']:,}" if h["likes"] else "—",
            f"{h['score']:.2f}" if h["score"] else "—",
        )

    console.print(table)

    # Show URLs separately so they're easy to visit
    console.print()
    for i, h in enumerate(enriched, 1):
        if h["url"]:
            console.print(f"  [dim]{i}.[/] [blue]{h['url']}[/]")


@cli.command()
@click.argument("tweet_id")
@click.option("--open-media", is_flag=True, default=False, help="Open media in browser.")
def show(tweet_id: str, open_media: bool):
    """Show full detail of a single bookmark. Accepts tweet ID, partial ID, or tweet URL."""
    import re
    # Accept full tweet URL — extract the ID
    url_match = re.search(r'/status/(\d+)', tweet_id)
    if url_match:
        tweet_id = url_match.group(1)

    row = db.get_bookmark(tweet_id) or db.get_bookmark_prefix(tweet_id)
    if not row:
        console.print(f"[red]No bookmark found with ID:[/] {tweet_id}")
        sys.exit(1)

    console.print(
        Panel(
            f"[bold]Tweet ID:[/]   {row['id']}\n"
            f"[bold]Author:[/]     [magenta]@{row['author_username']}[/]  ({row['author_name']})\n"
            f"[bold]Created:[/]    [green]{_format_date(row['created_at'])}[/]\n"
            f"[bold]Bookmarked:[/] [green]{_format_date(row['bookmark_added_at'])}[/]\n"
            f"[bold]URL:[/]        [blue]{row['url']}[/]\n",
            title=f"[bold cyan]Bookmark Detail[/]",
            border_style="cyan",
        )
    )

    console.print(Panel(_clean_text(row["text"]), title="[bold]Full Text[/]", border_style="white"))

    media = []
    if row["media_json"]:
        try:
            media = json.loads(row["media_json"])
        except Exception:
            pass

    if media:
        import webbrowser
        console.print()
        console.print("[bold]Media:[/]")
        icons = {"photo": "🖼 ", "video": "🎬", "animated_gif": "🎥"}
        media_urls = []
        for i, m in enumerate(media, 1):
            icon = icons.get(m.get("type", "photo"), "📎")
            mtype = m.get("type", "photo").replace("_", " ").title()
            url = m.get("url", "")
            thumb = m.get("thumb", "")
            console.print(f"  {icon} [{mtype}] [blue]{url}[/]")
            if thumb and thumb != url:
                console.print(f"     Thumbnail: [dim]{thumb}[/]")
            if url:
                media_urls.append(url)

        if media_urls:
            if open_media or click.confirm("\nOpen media in browser?", default=False):
                for url in media_urls:
                    webbrowser.open(url)
                console.print(f"[green]Opened {len(media_urls)} item(s) in browser.[/]")

    if row["raw_json"]:
        try:
            raw = json.loads(row["raw_json"])
            console.print()
            if click.confirm("Show raw JSON?", default=False):
                console.print_json(json.dumps(raw, indent=2))
        except Exception:
            pass


if __name__ == "__main__":
    cli()
