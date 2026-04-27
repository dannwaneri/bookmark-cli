import sqlite3
import json
from pathlib import Path
from datetime import datetime

DB_DIR = Path.home() / ".bookmark-cli"
DB_PATH = DB_DIR / "bookmarks.db"


def get_connection() -> sqlite3.Connection:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_connection()
    cur = conn.cursor()
    cur.executescript("""
        CREATE TABLE IF NOT EXISTS bookmarks (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            author_username TEXT NOT NULL,
            author_name TEXT NOT NULL,
            created_at TEXT,
            url TEXT,
            bookmark_added_at TEXT,
            media_json TEXT,
            raw_json TEXT
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS bookmarks_fts USING fts5(
            id UNINDEXED,
            text,
            author_username,
            content='bookmarks',
            content_rowid='rowid'
        );

        CREATE TRIGGER IF NOT EXISTS bookmarks_ai AFTER INSERT ON bookmarks BEGIN
            INSERT INTO bookmarks_fts(rowid, id, text, author_username)
            VALUES (new.rowid, new.id, new.text, new.author_username);
        END;

        CREATE TRIGGER IF NOT EXISTS bookmarks_ad AFTER DELETE ON bookmarks BEGIN
            INSERT INTO bookmarks_fts(bookmarks_fts, rowid, id, text, author_username)
            VALUES ('delete', old.rowid, old.id, old.text, old.author_username);
        END;

        CREATE TRIGGER IF NOT EXISTS bookmarks_au AFTER UPDATE ON bookmarks BEGIN
            INSERT INTO bookmarks_fts(bookmarks_fts, rowid, id, text, author_username)
            VALUES ('delete', old.rowid, old.id, old.text, old.author_username);
            INSERT INTO bookmarks_fts(rowid, id, text, author_username)
            VALUES (new.rowid, new.id, new.text, new.author_username);
        END;
    """)
    conn.commit()
    # migrations
    for col, definition in [
        ("media_json",      "TEXT"),
        ("likes",           "INTEGER DEFAULT 0"),
        ("retweets",        "INTEGER DEFAULT 0"),
        ("replies",         "INTEGER DEFAULT 0"),
        ("quotes",          "INTEGER DEFAULT 0"),
        ("bookmarks_count", "INTEGER DEFAULT 0"),
        ("views",           "INTEGER DEFAULT 0"),
        ("vectorized",      "INTEGER DEFAULT 0"),
        ("source",          "TEXT DEFAULT 'bookmark'"),
    ]:
        try:
            conn.execute(f"ALTER TABLE bookmarks ADD COLUMN {col} {definition}")
            conn.commit()
        except Exception:
            pass
    conn.close()


def upsert_bookmark(bookmark: dict, source: str = "bookmark") -> bool:
    """Returns True if this was a new insert, False if it already existed."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM bookmarks WHERE id = ?", (bookmark["id"],))
    exists = cur.fetchone() is not None
    if not exists:
        eng = bookmark.get("engagement", {})
        cur.execute(
            """
            INSERT INTO bookmarks (id, text, author_username, author_name,
                                   created_at, url, bookmark_added_at, media_json,
                                   likes, retweets, replies, quotes, bookmarks_count, views,
                                   raw_json, source)
            VALUES (:id, :text, :author_username, :author_name,
                    :created_at, :url, :bookmark_added_at, :media_json,
                    :likes, :retweets, :replies, :quotes, :bookmarks_count, :views,
                    :raw_json, :source)
            """,
            {
                "id": bookmark["id"],
                "text": bookmark["text"],
                "author_username": bookmark["author_username"],
                "author_name": bookmark["author_name"],
                "created_at": bookmark.get("created_at"),
                "url": bookmark.get("url"),
                "bookmark_added_at": bookmark.get("bookmark_added_at", datetime.utcnow().isoformat()),
                "media_json": json.dumps(bookmark.get("media", [])),
                "likes":           eng.get("likes", 0),
                "retweets":        eng.get("retweets", 0),
                "replies":         eng.get("replies", 0),
                "quotes":          eng.get("quotes", 0),
                "bookmarks_count": eng.get("bookmarks_count", 0),
                "views":           eng.get("views", 0),
                "raw_json": json.dumps(bookmark.get("raw_json", {})),
                "source": source,
            },
        )
        conn.commit()
    conn.close()
    return not exists


def backfill_engagement():
    """Parse raw_json for all rows and fill in engagement columns."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id, raw_json FROM bookmarks WHERE likes = 0 OR likes IS NULL")
    rows = cur.fetchall()
    updated = 0
    for row in rows:
        try:
            data = json.loads(row["raw_json"] or "{}")
            result = data.get("result", {})
            if result.get("__typename") == "TweetWithVisibilityResults":
                result = result.get("tweet", {})
            legacy = result.get("legacy", {})
            views_raw = result.get("views", {}).get("count", "0")
            cur.execute(
                """
                UPDATE bookmarks SET
                    likes           = ?,
                    retweets        = ?,
                    replies         = ?,
                    quotes          = ?,
                    bookmarks_count = ?,
                    views           = ?
                WHERE id = ?
                """,
                (
                    int(legacy.get("favorite_count", 0) or 0),
                    int(legacy.get("retweet_count", 0) or 0),
                    int(legacy.get("reply_count", 0) or 0),
                    int(legacy.get("quote_count", 0) or 0),
                    int(legacy.get("bookmark_count", 0) or 0),
                    int(views_raw) if str(views_raw).isdigit() else 0,
                    row["id"],
                ),
            )
            updated += 1
        except Exception:
            continue
    conn.commit()
    conn.close()
    return updated


def get_unvectorized(batch_size: int = 100) -> list[sqlite3.Row]:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, text, author_username, author_name, url, created_at,
               likes, retweets, views
        FROM bookmarks
        WHERE vectorized = 0 OR vectorized IS NULL
        ORDER BY likes DESC
        LIMIT ?
        """,
        (batch_size,),
    )
    rows = cur.fetchall()
    conn.close()
    return rows


def mark_vectorized(ids: list[str]):
    conn = get_connection()
    conn.executemany(
        "UPDATE bookmarks SET vectorized = 1 WHERE id = ?",
        [(i,) for i in ids],
    )
    conn.commit()
    conn.close()


def vectorized_count() -> int:
    conn = get_connection()
    row = conn.execute("SELECT COUNT(*) FROM bookmarks WHERE vectorized = 1").fetchone()
    conn.close()
    return row[0]


def search_hooks(query: str, limit: int = 200) -> list[sqlite3.Row]:
    """FTS search returning tweets sorted by likes for hook analysis."""
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT b.id, b.text, b.author_username, b.author_name, b.url, b.created_at,
               b.likes, b.retweets, b.replies, b.views
        FROM bookmarks_fts f
        JOIN bookmarks b ON b.rowid = f.rowid
        WHERE bookmarks_fts MATCH ?
        ORDER BY b.likes DESC
        LIMIT ?
        """,
        (query, limit),
    )
    rows = cur.fetchall()
    conn.close()
    return rows


def search_bookmarks(query: str, limit: int = 50) -> list[sqlite3.Row]:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        """
        SELECT b.id, b.text, b.author_username, b.author_name,
               b.created_at, b.url, b.bookmark_added_at, b.media_json
        FROM bookmarks_fts f
        JOIN bookmarks b ON b.rowid = f.rowid
        WHERE bookmarks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
        """,
        (query, limit),
    )
    rows = cur.fetchall()
    conn.close()
    return rows


def list_bookmarks(author: str | None = None, since: str | None = None, limit: int = 50, source: str | None = None) -> list[sqlite3.Row]:
    conn = get_connection()
    cur = conn.cursor()
    clauses = []
    params: list = []
    if author:
        clauses.append("LOWER(author_username) LIKE LOWER(?)")
        params.append(f"%{author}%")
    if since:
        clauses.append("created_at >= ?")
        params.append(since)
    if source:
        clauses.append("source = ?")
        params.append(source)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    params.append(limit)
    cur.execute(
        f"""
        SELECT id, text, author_username, author_name, created_at, url, bookmark_added_at, media_json
        FROM bookmarks
        {where}
        ORDER BY bookmark_added_at DESC
        LIMIT ?
        """,
        params,
    )
    rows = cur.fetchall()
    conn.close()
    return rows


def get_bookmark(tweet_id: str) -> sqlite3.Row | None:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT * FROM bookmarks WHERE id = ?", (tweet_id,))
    row = cur.fetchone()
    conn.close()
    return row


def get_stats() -> dict:
    conn = get_connection()
    cur = conn.cursor()

    cur.execute("SELECT COUNT(*) FROM bookmarks")
    total = cur.fetchone()[0]

    cur.execute("SELECT MIN(created_at), MAX(created_at) FROM bookmarks")
    date_range = cur.fetchone()

    cur.execute(
        """
        SELECT author_username, author_name, COUNT(*) as cnt
        FROM bookmarks
        GROUP BY author_username
        ORDER BY cnt DESC
        LIMIT 10
        """
    )
    top_authors = cur.fetchall()

    cur.execute(
        """
        SELECT SUBSTR(created_at, 1, 7) as month, COUNT(*) as cnt
        FROM bookmarks
        WHERE created_at IS NOT NULL
        GROUP BY month
        ORDER BY month
        """
    )
    per_month = cur.fetchall()

    conn.close()
    return {
        "total": total,
        "date_range": date_range,
        "top_authors": top_authors,
        "per_month": per_month,
    }


def get_existing_ids() -> set[str]:
    conn = get_connection()
    cur = conn.cursor()
    cur.execute("SELECT id FROM bookmarks")
    ids = {row[0] for row in cur.fetchall()}
    conn.close()
    return ids
