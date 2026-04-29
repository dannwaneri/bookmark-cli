import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleRefresh,
  handleBackup,
  handleRestore,
  handleDraft,
  handleTrending,
  handleAddTarget,
  handleWinners,
} from "../src/commands.js";

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock("../src/vectorize.js", () => ({
  searchCorpus: vi.fn(),
  filterByAuthors: vi.fn(),
  fitScore: vi.fn(() => 50),
  formatResult: vi.fn((r) => ({
    author: r.metadata?.author ?? null,
    text: (r.text ?? "").slice(0, 200),
    likes: r.metadata?.likes ?? null,
    url: "",
    score: r.score ?? 0,
  })),
}));

vi.mock("../src/claude.js", () => ({
  rewriteTweet: vi.fn().mockResolvedValue("Rewritten tweet"),
  suggestReplies: vi.fn().mockResolvedValue("1. A\n2. B\n3. C"),
  summarizePattern: vi.fn().mockResolvedValue("Pattern summary"),
  continueThread: vi.fn().mockResolvedValue("Thread options"),
  learnStanceFromCorpus: vi.fn().mockResolvedValue("Learned stance text"),
  analyzeWinners: vi.fn().mockResolvedValue("• Pattern 1\n• Pattern 2\n• Pattern 3"),
}));

import { searchCorpus, filterByAuthors } from "../src/vectorize.js";
import { analyzeWinners } from "../src/claude.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTweet(author, text, likes = 100) {
  return { score: 0.5, text, metadata: { author, likes } };
}

function makeMockKV(initialData = {}) {
  const store = Object.fromEntries(
    Object.entries(initialData).map(([k, v]) => [k, JSON.stringify(v)])
  );
  return {
    get: vi.fn((key) => Promise.resolve(store[key] ?? null)),
    put: vi.fn((key, value) => {
      store[key] = value;
      return Promise.resolve();
    }),
    _store: store,
  };
}

let messages = [];

function makeEnv(kvData = {}, overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "tok",
    CLAUDE_API_KEY: "ck",
    VECTORIZE_API_KEY: "vk",
    VECTORIZE_WORKER: { fetch: vi.fn() },
    TAVILY_API_KEY: null,
    TARGETS_KV: makeMockKV(kvData),
    ...overrides,
  };
}

beforeEach(() => {
  messages = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts) => {
      if (String(url).includes("api.telegram.org")) {
        messages.push(JSON.parse(opts.body).text);
      }
      return {
        ok: true,
        text: () => Promise.resolve("OK"),
        json: () => Promise.resolve({}),
      };
    })
  );
  vi.clearAllMocks();
});

// ─── handleRefresh ────────────────────────────────────────────────────────────

describe("handleRefresh", () => {
  it("sends error when no targets are set", async () => {
    const env = makeEnv({ targets: [] });
    await handleRefresh("1", env);
    expect(messages[0]).toContain("No target accounts set");
  });

  it("sends error when targets list is missing", async () => {
    const env = makeEnv({});
    await handleRefresh("1", env);
    expect(messages[0]).toContain("No target accounts set");
  });

  it("shows results from targets sorted by likes", async () => {
    const env = makeEnv({ targets: ["alice", "bob"] });
    const tweets = [
      makeTweet("alice", "Low engagement", 200),
      makeTweet("alice", "High engagement", 5000),
      makeTweet("stranger", "Not a target", 9999),
    ];
    searchCorpus.mockResolvedValue(tweets);
    filterByAuthors.mockReturnValue([tweets[0], tweets[1]]);

    await handleRefresh("1", env);

    const result = messages.find((m) => m.includes("@alice"));
    expect(result).toBeDefined();
    // High engagement tweet should appear before low engagement
    expect(result.indexOf("5,000")).toBeLessThan(result.indexOf("200"));
    // Non-target should not appear
    expect(result).not.toContain("@stranger");
  });

  it("deduplicates tweets across multiple queries", async () => {
    const env = makeEnv({ targets: ["alice"] });
    const tweet = makeTweet("alice", "Same tweet text repeated across queries", 1000);
    searchCorpus.mockResolvedValue([tweet]);
    filterByAuthors.mockReturnValue([tweet]);

    await handleRefresh("1", env);

    const result = messages.find((m) => m.includes("@alice"));
    // Should appear exactly once even though searchCorpus is called 4 times
    const occurrences = (result.match(/Same tweet text/g) || []).length;
    expect(occurrences).toBe(1);
  });

  it("sends fallback when no target-matching results found", async () => {
    const env = makeEnv({ targets: ["alice"] });
    searchCorpus.mockResolvedValue([]);
    filterByAuthors.mockReturnValue([]);

    await handleRefresh("1", env);

    const last = messages[messages.length - 1];
    expect(last).toMatch(/no content|sync/i);
  });
});

// ─── handleBackup ─────────────────────────────────────────────────────────────

describe("handleBackup", () => {
  it("saves a backup to KV with correct keys", async () => {
    const env = makeEnv({
      targets: ["alice", "bob"],
      __stances: { liverpool: "Slot is exposed" },
      __winners: ["Great reply"],
      __drafts: [],
    });

    await handleBackup("1", env);

    expect(env.TARGETS_KV.put).toHaveBeenCalledWith(
      "__backup",
      expect.any(String)
    );

    const savedRaw = env.TARGETS_KV.put.mock.calls.find(
      ([k]) => k === "__backup"
    )[1];
    const saved = JSON.parse(savedRaw);
    expect(saved.targets).toEqual(["alice", "bob"]);
    expect(saved.stances.liverpool).toBe("Slot is exposed");
    expect(saved.winners).toEqual(["Great reply"]);
    expect(saved.exported_at).toBeDefined();
  });

  it("reports correct counts in summary message", async () => {
    const env = makeEnv({
      targets: ["a", "b", "c"],
      __stances: { s1: "stance 1", s2: "stance 2" },
      __winners: ["w1", "w2", "w3", "w4"],
      __drafts: ["d1"],
    });

    await handleBackup("1", env);

    const summary = messages[1]; // first message is "⏳ Creating backup..."
    expect(summary).toContain("3");  // targets
    expect(summary).toContain("2");  // stances
    expect(summary).toContain("4");  // winners
  });

  it("sends stances JSON in chunks of 5", async () => {
    const stances = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`topic${i}`, `stance ${i}`])
    );
    const env = makeEnv({ targets: [], __stances: stances, __winners: [], __drafts: [] });

    await handleBackup("1", env);

    // 12 stances → 3 chunks of 5/5/2  (ceil(12/5) = 3)
    const jsonMessages = messages.filter((m) => m.includes("<pre>"));
    expect(jsonMessages.length).toBe(3);
  });
});

// ─── handleRestore ────────────────────────────────────────────────────────────

describe("handleRestore", () => {
  it("sends error when no backup exists", async () => {
    const env = makeEnv({});
    await handleRestore("1", env);
    expect(messages[0]).toMatch(/no backup/i);
  });

  it("restores all data from backup to KV", async () => {
    const backup = {
      exported_at: "2026-01-01T00:00:00.000Z",
      targets: ["alice"],
      stances: { topic: "my stance" },
      winners: ["good reply"],
      drafts: [{ text: "draft text", savedAt: "2026-01-01" }],
    };
    const env = makeEnv({ __backup: backup });

    await handleRestore("1", env);

    const puts = env.TARGETS_KV.put.mock.calls;
    const restored = Object.fromEntries(puts.map(([k, v]) => [k, JSON.parse(v)]));
    expect(restored.targets).toEqual(["alice"]);
    expect(restored.__stances).toEqual({ topic: "my stance" });
    expect(restored.__winners).toEqual(["good reply"]);
    expect(restored.__drafts).toHaveLength(1);
  });

  it("includes item counts in restore confirmation", async () => {
    const backup = {
      exported_at: "2026-01-01T00:00:00.000Z",
      targets: ["a", "b"],
      stances: { x: "y" },
      winners: [],
      drafts: [],
    };
    const env = makeEnv({ __backup: backup });

    await handleRestore("1", env);

    expect(messages[0]).toContain("2"); // 2 targets
    expect(messages[0]).toContain("1"); // 1 stance
  });
});

// ─── handleDraft ──────────────────────────────────────────────────────────────

describe("handleDraft", () => {
  it("shows empty list message when no drafts saved", async () => {
    const env = makeEnv({ __drafts: [] });
    await handleDraft("1", "", env);
    expect(messages[0]).toMatch(/no drafts/i);
  });

  it('"list" keyword also shows drafts list', async () => {
    const env = makeEnv({ __drafts: [] });
    await handleDraft("1", "list", env);
    expect(messages[0]).toMatch(/no drafts/i);
  });

  it("saves a new draft and confirms save", async () => {
    const env = makeEnv({ __drafts: [] });
    await handleDraft("1", "I think the Premier League is rigged", env);

    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "__drafts");
    expect(putCall).toBeDefined();
    const saved = JSON.parse(putCall[1]);
    expect(saved[0].text).toBe("I think the Premier League is rigged");
    expect(saved[0].savedAt).toBeDefined();
    expect(messages[0]).toMatch(/draft saved/i);
  });

  it("prepends new drafts (most recent first)", async () => {
    const existing = [{ text: "old draft", savedAt: "2026-01-01" }];
    const env = makeEnv({ __drafts: existing });
    await handleDraft("1", "new draft", env);

    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "__drafts");
    const saved = JSON.parse(putCall[1]);
    expect(saved[0].text).toBe("new draft");
    expect(saved[1].text).toBe("old draft");
  });

  it("caps drafts at 20 entries", async () => {
    const existing = Array.from({ length: 20 }, (_, i) => ({
      text: `draft ${i}`,
      savedAt: "2026-01-01",
    }));
    const env = makeEnv({ __drafts: existing });
    await handleDraft("1", "the 21st draft", env);

    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "__drafts");
    const saved = JSON.parse(putCall[1]);
    expect(saved).toHaveLength(20);
    expect(saved[0].text).toBe("the 21st draft");
  });

  it("lists drafts with their index and truncated text", async () => {
    const drafts = [
      { text: "First draft idea for a tweet", savedAt: "2026-01-01" },
      { text: "Second draft", savedAt: "2026-01-01" },
    ];
    const env = makeEnv({ __drafts: drafts });
    await handleDraft("1", "list", env);

    expect(messages[0]).toContain("1.");
    expect(messages[0]).toContain("2.");
    expect(messages[0]).toContain("First draft idea");
    expect(messages[0]).toContain("Second draft");
  });

  it("pick <n> delegates to /tweet with the right text", async () => {
    // We can't easily test handleTweet internals here, but we can verify
    // it sends the "⏳ Scoring" message that handleTweet always sends first
    searchCorpus.mockResolvedValue([]);
    filterByAuthors.mockReturnValue([]);

    const drafts = [
      { text: "My draft tweet about AI", savedAt: "2026-01-01" },
      { text: "Second draft", savedAt: "2026-01-01" },
    ];
    const env = makeEnv({ __drafts: drafts, targets: [] });
    await handleDraft("1", "pick 1", env);

    // handleTweet sends a "⏳ Scoring" loading message
    expect(messages[0]).toMatch(/scoring/i);
  });

  it("pick out-of-range sends error", async () => {
    const env = makeEnv({ __drafts: [{ text: "only one", savedAt: "2026-01-01" }] });
    await handleDraft("1", "pick 5", env);
    expect(messages[0]).toMatch(/no draft #5/i);
  });

  it("delete <n> removes the correct draft", async () => {
    const drafts = [
      { text: "keep this", savedAt: "2026-01-01" },
      { text: "delete this", savedAt: "2026-01-01" },
      { text: "keep this too", savedAt: "2026-01-01" },
    ];
    const env = makeEnv({ __drafts: drafts });
    await handleDraft("1", "delete 2", env);

    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "__drafts");
    const saved = JSON.parse(putCall[1]);
    expect(saved).toHaveLength(2);
    expect(saved.map((d) => d.text)).not.toContain("delete this");
  });

  it("delete out-of-range sends error", async () => {
    const env = makeEnv({ __drafts: [{ text: "only one", savedAt: "2026-01-01" }] });
    await handleDraft("1", "delete 9", env);
    expect(messages[0]).toMatch(/no draft #9/i);
  });
});

// ─── handleTrending ───────────────────────────────────────────────────────────

describe("handleTrending", () => {
  it("uses a single query when a topic is given", async () => {
    const env = makeEnv({});
    const tweets = [makeTweet("alice", "Great take on AI", 3000)];
    searchCorpus.mockResolvedValue(tweets);

    await handleTrending("1", "AI", env);

    // With a topic, only 1 searchCorpus call
    expect(searchCorpus).toHaveBeenCalledTimes(1);
    expect(searchCorpus).toHaveBeenCalledWith("AI", expect.any(Object));
  });

  it("uses 4 broad queries when no topic given", async () => {
    const env = makeEnv({});
    searchCorpus.mockResolvedValue([]);

    await handleTrending("1", "", env);

    expect(searchCorpus).toHaveBeenCalledTimes(4);
  });

  it("sorts results by likes descending", async () => {
    const env = makeEnv({});
    const tweets = [
      makeTweet("alice", "Medium tweet", 3333),
      makeTweet("bob", "Top tweet", 99999),
      makeTweet("carol", "Low tweet", 77),
    ];
    searchCorpus.mockResolvedValue(tweets);

    await handleTrending("1", "football", env);

    const result = messages.find((m) => m.includes("@bob"));
    // @bob (99,999 likes) must appear before @alice (3,333) before @carol (77)
    expect(result.indexOf("99,999")).toBeLessThan(result.indexOf("3,333"));
    expect(result.indexOf("3,333")).toBeLessThan(result.indexOf("77"));
  });

  it("deduplicates tweets with identical text across queries", async () => {
    const env = makeEnv({});
    const tweet = makeTweet("alice", "Identical tweet that appears in every query", 500);
    searchCorpus.mockResolvedValue([tweet]);

    await handleTrending("1", "", env);

    const result = messages.find((m) => m.includes("Identical tweet"));
    const count = (result.match(/Identical tweet/g) || []).length;
    expect(count).toBe(1);
  });

  it("sends fallback when no results found", async () => {
    const env = makeEnv({});
    searchCorpus.mockResolvedValue([]);

    await handleTrending("1", "obscure topic", env);

    const last = messages[messages.length - 1];
    expect(last).toMatch(/no results/i);
  });
});

// ─── handleAddTarget (auto-preview) ──────────────────────────────────────────

describe("handleAddTarget auto-preview", () => {
  it("rejects duplicate targets", async () => {
    const env = makeEnv({ targets: ["alice"] });
    await handleAddTarget("1", "alice", env);
    expect(messages[0]).toContain("already in your targets");
    expect(env.TARGETS_KV.put).not.toHaveBeenCalled();
  });

  it("adds target and shows corpus preview if tweets found", async () => {
    const env = makeEnv({ targets: [] });
    const tweet = makeTweet("newguy", "Hot take from newguy", 2000);
    searchCorpus.mockResolvedValue([tweet]);
    filterByAuthors.mockReturnValue([tweet]);

    await handleAddTarget("1", "newguy", env);

    // First message: confirmation
    expect(messages[0]).toContain("✅ Added @newguy");
    // Second message: corpus preview
    expect(messages[1]).toContain("newguy");
    expect(messages[1]).toContain("1 tweets");
  });

  it("shows 'not in corpus yet' when author has no content", async () => {
    const env = makeEnv({ targets: [] });
    searchCorpus.mockResolvedValue([]);
    filterByAuthors.mockReturnValue([]);

    await handleAddTarget("1", "newguy", env);

    expect(messages[0]).toContain("✅ Added @newguy");
    expect(messages[1]).toMatch(/no content|next daily sync/i);
  });

  it("still adds target even if corpus preview throws", async () => {
    const env = makeEnv({ targets: [] });
    searchCorpus.mockRejectedValue(new Error("Vectorize down"));

    await handleAddTarget("1", "newguy", env);

    // Target must still be saved
    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "targets");
    expect(putCall).toBeDefined();
    const saved = JSON.parse(putCall[1]);
    expect(saved).toContain("newguy");

    // Confirmation message sent, no error message from preview failure
    expect(messages[0]).toContain("✅ Added @newguy");
    expect(messages).toHaveLength(1);
  });

  it("strips @ prefix from username", async () => {
    const env = makeEnv({ targets: [] });
    searchCorpus.mockResolvedValue([]);
    filterByAuthors.mockReturnValue([]);

    await handleAddTarget("1", "@Alice", env);

    const putCall = env.TARGETS_KV.put.mock.calls.find(([k]) => k === "targets");
    const saved = JSON.parse(putCall[1]);
    expect(saved).toContain("alice");
  });
});

// ─── handleWinners (analytics) ───────────────────────────────────────────────

describe("handleWinners analytics", () => {
  it("shows empty state message when no winners", async () => {
    const env = makeEnv({ __winners: [] });
    await handleWinners("1", env);
    expect(messages[0]).toMatch(/no winners/i);
    expect(analyzeWinners).not.toHaveBeenCalled();
  });

  it("shows winners list without analytics when fewer than 5", async () => {
    const env = makeEnv({ __winners: ["reply 1", "reply 2", "reply 3"] });
    await handleWinners("1", env);

    expect(messages[0]).toContain("reply 1");
    expect(analyzeWinners).not.toHaveBeenCalled();
  });

  it("calls analyzeWinners and shows analysis when 5+ winners saved", async () => {
    const winners = ["r1", "r2", "r3", "r4", "r5", "r6"];
    const env = makeEnv({ __winners: winners });
    await handleWinners("1", env);

    expect(analyzeWinners).toHaveBeenCalledWith("ck", winners);
    const analysisMsg = messages.find((m) => m.includes("Pattern 1"));
    expect(analysisMsg).toBeDefined();
  });

  it("shows total count alongside top 10 list", async () => {
    const winners = Array.from({ length: 15 }, (_, i) => `reply ${i}`);
    const env = makeEnv({ __winners: winners });
    await handleWinners("1", env);

    expect(messages[0]).toContain("15");
  });

  it("continues gracefully if analyzeWinners throws", async () => {
    analyzeWinners.mockRejectedValueOnce(new Error("Claude down"));
    const winners = ["r1", "r2", "r3", "r4", "r5"];
    const env = makeEnv({ __winners: winners });

    await expect(handleWinners("1", env)).resolves.not.toThrow();
    expect(messages[0]).toContain("r1");
  });
});
