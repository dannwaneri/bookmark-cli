#!/usr/bin/env python3
"""
Analyze the main topics in your bookmark corpus from the local SQLite DB.
Outputs ranked topic clusters + top authors per cluster.
Run: python analyze_topics.py
"""

import re
import sqlite3
from collections import Counter
from pathlib import Path

DB_PATH = Path.home() / ".bookmark-cli" / "bookmarks.db"

STOPWORDS = {
    "the","a","an","and","or","but","in","on","at","to","for","of","with",
    "is","it","its","this","that","are","was","were","be","been","being",
    "have","has","had","do","does","did","will","would","could","should",
    "may","might","can","not","no","so","if","as","by","from","up","out",
    "about","just","also","more","like","when","what","who","which","how",
    "all","we","i","you","he","she","they","my","your","our","their","his",
    "her","me","him","us","them","into","than","then","now","even","very",
    "get","got","make","made","going","go","come","came","know","think",
    "want","need","use","new","one","two","time","way","good","great",
    "really","still","already","only","after","before","never","always",
    "every","some","any","much","many","over","most","other","too","here",
    "there","where","why","https","t","co","rt","amp","via","re","let",
    "see","say","said","says","per","been","don","didn","doesn","can't",
    "won't","it's","i'm","i've","that's","don't","isn't","aren't","wasn't",
    "weren't","hasn't","haven't","hadn't","wouldn't","couldn't","shouldn't",
    "people","year","years","day","days","week","weeks","month","months",
    "thing","things","something","someone","everyone","everything","nothing",
    "today","take","put","give","back","same","first","last","next","old",
    "big","little","long","right","left","away","again","around","between",
    "through","down","off","while","both","each","few","own","such","these",
    "those","s","t","m","ll","ve","d","re","e","n",
}

# Topic seeds — keywords that strongly signal a topic area
TOPIC_SEEDS = {
    "Nigeria / Politics":     ["nigeria","nigerian","tinubu","obi","atiku","senate","abuja","lagos","naira","cbdc","nnpc","efcc","nass","inec","pdp","apc","obidient","lekki","portharcourt","buhari","fct"],
    "Liverpool FC":           ["liverpool","reds","anfield","slot","salah","klopp","lfc","premier","champions","epl","diogo","virgil","alisson","trent","robertson","firmino","nunez","mane"],
    "AI / Tech":              ["ai","llm","gpt","claude","openai","anthropic","model","agent","prompt","rag","vector","embedding","ml","neural","chatgpt","gemini","llama","training","inference","fine-tune","cursor","copilot"],
    "Startups / Founder":     ["startup","founder","fundraise","seed","series","vc","investor","saas","product","mrr","arr","churn","pmf","pivot","launch","ship","build","bootstrapped","yc","techcrunch"],
    "Money / Finance":        ["money","wealth","income","salary","investing","stocks","crypto","bitcoin","eth","defi","dollar","naira","inflation","revenue","profit","passive","savings","budget","debt","bank"],
    "Productivity / Work":    ["productivity","focus","deep work","habit","routine","morning","procrastination","distraction","flow","system","note","notion","obsidian","pkm","secondbrain","writing"],
    "Career / Jobs":          ["job","career","hiring","layoff","remote","wfh","interview","resume","linkedin","salary","promotion","manager","engineer","developer","design","coding"],
    "Relationships / Life":   ["relationship","marriage","dating","love","family","friend","mental health","therapy","loneliness","community","social","anxiety","happiness","growth","mindset"],
    "Media / Culture":        ["netflix","spotify","movie","music","book","podcast","twitter","x","instagram","tiktok","youtube","content","creator","influencer","viral","meme"],
    "Football (General)":     ["football","soccer","ballon","messi","ronaldo","barcelona","madrid","arsenal","chelsea","manchester","united","city","transfer","goal","assist","ucl","world cup","efl","championship"],
}

def load_sample(limit=5000):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.execute(
        """
        SELECT text, author_username, likes
        FROM bookmarks
        ORDER BY likes DESC
        LIMIT ?
        """,
        (limit,),
    )
    rows = cur.fetchall()
    conn.close()
    return rows

def tokenize(text):
    text = re.sub(r"http\S+", "", text.lower())
    text = re.sub(r"@\w+", "", text)
    text = re.sub(r"[^a-z\s'-]", " ", text)
    tokens = re.findall(r"[a-z][a-z'-]{2,}", text)
    return [t for t in tokens if t not in STOPWORDS and len(t) > 2]

def score_tweet(tokens, seed_keywords):
    token_set = set(tokens)
    return sum(1 for k in seed_keywords if k in token_set or any(k in t for t in token_set))

def main():
    print(f"\nLoading corpus from {DB_PATH}...")
    rows = load_sample(limit=5000)
    print(f"Analysing {len(rows):,} tweets (top by likes)\n")

    topic_counts = Counter()
    topic_authors = {t: Counter() for t in TOPIC_SEEDS}
    topic_likes   = {t: 0 for t in TOPIC_SEEDS}

    for row in rows:
        tokens = tokenize(row["text"])
        for topic, seeds in TOPIC_SEEDS.items():
            s = score_tweet(tokens, seeds)
            if s > 0:
                topic_counts[topic] += s
                topic_authors[topic][row["author_username"]] += 1
                topic_likes[topic] += (row["likes"] or 0)

    # Rank by weighted score (count × avg likes proxy)
    ranked = sorted(
        topic_counts.keys(),
        key=lambda t: topic_likes[t],
        reverse=True
    )

    print("=" * 60)
    print("  YOUR CORPUS: MAIN TOPICS (ranked by engagement)")
    print("=" * 60)
    for i, topic in enumerate(ranked, 1):
        top_authors = [f"@{a}" for a, _ in topic_authors[topic].most_common(4)]
        print(f"\n{i:>2}. {topic}")
        print(f"    Mentions : {topic_counts[topic]:,}")
        print(f"    Total likes: {topic_likes[topic]:,}")
        print(f"    Top voices : {', '.join(top_authors)}")

    print("\n" + "=" * 60)
    print("SUGGESTED /learnstance commands:")
    print("=" * 60)
    suggestions = {
        "Nigeria / Politics":   ["nigeria governance tinubu",  "nigerian economy naira",  "nigeria politics"],
        "Liverpool FC":         ["liverpool slot premier league", "liverpool transfers signings", "liverpool anfield"],
        "AI / Tech":            ["ai jobs future work",          "llm agents tools",             "openai anthropic models"],
        "Startups / Founder":   ["startup founder advice",       "saas growth mrr",              "vc funding raising"],
        "Money / Finance":      ["investing wealth building",    "crypto bitcoin future",        "personal finance saving"],
        "Productivity / Work":  ["deep work focus system",       "note taking pkm",              "writing habit routine"],
        "Career / Jobs":        ["software engineer career",     "remote work hiring",           "career growth advice"],
        "Relationships / Life": ["relationships dating advice",  "mental health therapy",        "life philosophy happiness"],
        "Media / Culture":      ["content creator economy",      "twitter x social media",       "netflix streaming culture"],
        "Football (General)":   ["premier league football",      "champions league ucl",         "football transfers"],
    }
    for topic in ranked[:6]:
        cmds = suggestions.get(topic, [])
        for cmd in cmds[:2]:
            print(f"  /learnstance {cmd}")

    print()

if __name__ == "__main__":
    main()
