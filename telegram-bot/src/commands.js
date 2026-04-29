import { searchCorpus, filterByAuthors, fitScore, formatResult } from "./vectorize.js";
import { rewriteTweet, suggestReplies, summarizePattern, continueThread, learnStanceFromCorpus, analyzeWinners } from "./claude.js";

async function getTargets(kv) {
  const raw = await kv.get("targets");
  return raw ? JSON.parse(raw) : [];
}

async function getStances(kv) {
  const raw = await kv.get("__stances");
  return raw ? JSON.parse(raw) : {};
}

async function getWinners(kv) {
  const raw = await kv.get("__winners");
  return raw ? JSON.parse(raw) : [];
}

async function getDrafts(kv) {
  const raw = await kv.get("__drafts");
  return raw ? JSON.parse(raw) : [];
}

async function searchWeb(query, apiKey) {
  if (!apiKey) return null;
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        max_results: 3,
        include_answer: true,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parts = [];
    if (data.answer) parts.push(data.answer);
    if (data.results?.length) {
      parts.push(data.results.slice(0, 2).map(r => `• ${r.title}: ${(r.content || "").slice(0, 200)}`).join("\n"));
    }
    return parts.join("\n\n") || null;
  } catch {
    return null;
  }
}

function detectStance(tweet, stances) {
  const text = tweet.toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [topic, stance] of Object.entries(stances)) {
    const keywords = topic.toLowerCase().split(/[\s,]+/).filter(Boolean);
    const score = keywords.filter(k => text.includes(k)).length;
    // Require at least 2 keyword matches to avoid single generic-word false positives
    if (score >= 2 && score > bestScore) { bestScore = score; best = stance; }
  }
  return best;
}

async function sendMessage(token, chatId, text, parseMode = "HTML") {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: parseMode,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendMessage failed: ${err}`);
  }
}

function b(text) { return `<b>${text}</b>`; }
function i(text) { return `<i>${text}</i>`; }
function code(text) { return `<code>${text}</code>`; }

export async function handleStart(chatId, token) {
  const msg = `${b("Bookmark Brain")} 🧠

Your personal tweet coach, powered by your own bookmark corpus.

${b("Commands:")}
/tweet <code>&lt;your draft&gt;</code> — score + rewrite to fit your target accounts
/reply <code>&lt;tweet&gt;</code> — get 3 reply options (add <code>--web</code> for live news context)
/search <code>&lt;topic&gt;</code> — search your bookmark corpus
/targets — see your target accounts
/addtarget <code>&lt;username&gt;</code> — add a target account
/removetarget <code>&lt;username&gt;</code> — remove a target account
/pattern <code>&lt;topic&gt;</code> — what makes high-engagement tweets on this topic work
/thread — continue a conversation after someone replies to you
/worked <code>&lt;reply&gt;</code> — save a reply that got engagement as a training example
/winners — view your saved high-performing replies
/learnstance <code>&lt;topic&gt;</code> — auto-learn your stance from your bookmarks
/setstance <code>&lt;topic: opinion&gt;</code> — manually save a standing opinion
/stances — view all saved stances
/removestance <code>&lt;topic&gt;</code> — delete a saved stance
/status — check last cron run and bot health
/refresh — top content from your target accounts
/trending — most-liked tweets across your corpus
/trending <code>&lt;topic&gt;</code> — most-liked on a specific topic
/draft <code>&lt;text&gt;</code> — save a draft · /draft list · /draft pick &lt;n&gt;
/backup — export all stances, targets, and winners to KV`;

  await sendMessage(token, chatId, msg);
}

export async function handleTweet(chatId, draft, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, CLAUDE_API_KEY, TARGETS_KV } = env;

  if (!draft.trim()) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Usage: /tweet ${code("your draft tweet here")}`);
  }

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, "⏳ Scoring your tweet...");

  const targets = await getTargets(TARGETS_KV);
  const results = await searchCorpus(draft, { vectorizeWorker: env.VECTORIZE_WORKER, vectorizeApiKey: VECTORIZE_API_KEY });
  const formatted = results.map(formatResult);
  const score = fitScore(results, targets);
  const targetMatches = filterByAuthors(results, targets).map(formatResult);
  const examples = targetMatches.length >= 3 ? targetMatches : formatted;

  const rewritten = await rewriteTweet(CLAUDE_API_KEY, draft, examples);

  const scoreBar = score >= 70 ? "🟢" : score >= 40 ? "🟡" : "🔴";
  const targetNote = targets.length
    ? `Matched ${targetMatches.length}/${results.length} results from your ${targets.length} target account(s)`
    : `No target accounts set — use /addtarget to add some`;

  const examplesBlock = targetMatches.length
    ? `\n${b("Best matching examples from your corpus:")}\n${targetMatches.slice(0, 3).map(e => `• @${e.author}: "${e.text}"`).join("\n")}`
    : "";

  const msg = `${scoreBar} ${b(`Fit score: ${score}/100`)}
${i(targetNote)}

${b("Your draft:")}
${draft}

${b("Rewritten:")}
${rewritten}
${examplesBlock}`;

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, msg);
}

export async function handleReply(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, CLAUDE_API_KEY, TARGETS_KV } = env;

  if (!arg.trim()) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `Usage: /reply ${code("tweet text")}\nAdd ${code("--web")} for live news context\nAdd ${code("-- your stance")} to override opinion\nExample: /reply Slot should stay ${code("--web")}`
    );
  }

  // Extract --web flag before any other parsing
  const useWeb = /--web\b/i.test(arg);
  const cleanArg = arg.replace(/\s*--web\b/i, "").trim();

  // Parse optional stance after "--" or "—" (spaces optional)
  const stanceSplit = cleanArg.split(/\s*--\s*|\s+—\s+/);
  const targetTweet = stanceSplit[0].trim();
  const explicitStance = stanceSplit.length > 1 ? stanceSplit.slice(1).join(" ").trim() : null;

  // Fall back to saved stances if no explicit stance given
  const stances = await getStances(TARGETS_KV);
  const stance = explicitStance || detectStance(targetTweet, stances);

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, useWeb ? "⏳ Searching web + drafting replies..." : "⏳ Drafting replies...");

  const targets = await getTargets(TARGETS_KV);
  const results = await searchCorpus(targetTweet, { vectorizeWorker: env.VECTORIZE_WORKER, vectorizeApiKey: VECTORIZE_API_KEY });
  const formatted = results.map(formatResult);
  const targetMatches = filterByAuthors(results, targets).map(formatResult);
  const examples = targetMatches.length >= 3 ? targetMatches : formatted;

  const winners = await getWinners(TARGETS_KV);
  const webContext = useWeb ? await searchWeb(targetTweet, env.TAVILY_API_KEY) : null;
  const replies = await suggestReplies(CLAUDE_API_KEY, targetTweet, examples, stance, winners, webContext);

  const stanceNote = stance ? `\n${i(`Arguing from: "${stance}"`)}` : "";
  const webNote = useWeb && webContext ? `\n${i("🌐 Live web context included")}` : "";
  const msg = `${b("3 reply options:")}

${replies}

${i("Based on style patterns from your bookmark corpus")}${stanceNote}${webNote}`;

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, msg);
}

export async function handleSearch(chatId, query, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY } = env;

  if (!query.trim()) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Usage: /search ${code("topic or idea")}`);
  }

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, "⏳ Searching your corpus...");

  const results = await searchCorpus(query, { vectorizeWorker: env.VECTORIZE_WORKER, vectorizeApiKey: VECTORIZE_API_KEY, limit: 8 });
  const formatted = results.map(formatResult);

  if (!formatted.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, "No results found. Try a different query.");
  }

  const lines = formatted.map((r, i) => {
    const meta = r.author ? b(`@${r.author}`) : i("unknown");
    const likesStr = r.likes ? ` · ${r.likes.toLocaleString()} likes` : "";
    return `${i + 1}. ${meta}${likesStr}\n"${r.text}"${r.url ? `\n${r.url}` : ""}`;
  });

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `${b(`Search: ${query}`)}\n\n${lines.join("\n\n")}`);
}

export async function handleTargets(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const targets = await getTargets(TARGETS_KV);

  if (!targets.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No target accounts set yet.\n\nUse /addtarget ${code("username")} to add accounts whose style you want to match.`
    );
  }

  const list = targets.map(t => `• @${t}`).join("\n");
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `${b("Your target accounts:")}\n\n${list}`);
}

export async function handleAddTarget(chatId, username, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV, VECTORIZE_API_KEY } = env;
  const clean = username.trim().replace(/^@/, "").toLowerCase();

  if (!clean) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Usage: /addtarget ${code("username")}`);
  }

  const targets = await getTargets(TARGETS_KV);
  if (targets.includes(clean)) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `@${clean} is already in your targets.`);
  }

  targets.push(clean);
  await TARGETS_KV.put("targets", JSON.stringify(targets));
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ Added @${clean} to your target accounts. You now have ${targets.length} targets.`);

  // Immediately show what we already have from this author in the corpus
  try {
    const results = await searchCorpus(clean, {
      vectorizeWorker: env.VECTORIZE_WORKER,
      vectorizeApiKey: VECTORIZE_API_KEY,
      limit: 15,
    });
    const authorContent = filterByAuthors(results, [clean]).map(formatResult);
    if (authorContent.length) {
      authorContent.sort((a, b) => (b.likes || 0) - (a.likes || 0));
      const preview = authorContent.slice(0, 3)
        .map(r => `• "${r.text.slice(0, 100)}${r.text.length > 100 ? "…" : ""}"${r.likes ? ` (${r.likes.toLocaleString()} likes)` : ""}`)
        .join("\n");
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
        `${b(`Already have ${authorContent.length} tweets from @${clean} in your corpus:`)}\n\n${preview}`
      );
    } else {
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
        `No content from @${clean} in the corpus yet — they'll appear after the next daily sync.`
      );
    }
  } catch {
    // non-fatal — target was added successfully
  }
}

export async function handleRemoveTarget(chatId, username, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const clean = username.trim().replace(/^@/, "").toLowerCase();

  const targets = await getTargets(TARGETS_KV);
  const updated = targets.filter(t => t !== clean);

  if (updated.length === targets.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `@${clean} wasn't in your targets.`);
  }

  await TARGETS_KV.put("targets", JSON.stringify(updated));
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ Removed @${clean}. You now have ${updated.length} targets.`);
}

export async function handleSetStance(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;

  // Format: "topic: stance text"
  const colonIdx = arg.indexOf(":");
  if (colonIdx === -1) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `Usage: /setstance ${code("topic: your standing opinion")}\nExample: /setstance ${code("liverpool: Slot is exposed in year 2. Won title on Klopp's squad.")}`
    );
  }

  const topic = arg.slice(0, colonIdx).trim().toLowerCase();
  const stance = arg.slice(colonIdx + 1).trim();

  if (!topic || !stance) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, "Both topic and stance are required.");
  }

  const stances = await getStances(TARGETS_KV);
  stances[topic] = stance;
  await TARGETS_KV.put("__stances", JSON.stringify(stances));

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `✅ Stance saved for ${b(topic)}:\n\n${i(stance)}`
  );
}

export async function handleStances(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const stances = await getStances(TARGETS_KV);
  const entries = Object.entries(stances);

  if (!entries.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No stances saved yet.\n\nUse /setstance ${code("topic: your opinion")} to add one.`
    );
  }

  // Send in chunks to stay under Telegram's 4096 char limit
  const CHUNK_SIZE = 8;
  const chunks = [];
  for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
    chunks.push(entries.slice(i, i + CHUNK_SIZE));
  }

  for (let idx = 0; idx < chunks.length; idx++) {
    const header = idx === 0
      ? b(`Your saved stances (${entries.length} total):`) + "\n\n"
      : b(`(continued ${idx + 1}/${chunks.length})`) + "\n\n";
    const list = chunks[idx]
      .map(([topic, stance]) => {
        const preview = stance.length > 120 ? stance.slice(0, 120) + "…" : stance;
        return `${b(topic)}\n${i(preview)}`;
      })
      .join("\n\n");
    await sendMessage(TELEGRAM_BOT_TOKEN, chatId, header + list);
  }
}

export async function handleWorked(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const reply = arg.trim();

  if (!reply) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `Usage: /worked ${code("the reply that got engagement")}`
    );
  }

  const winners = await getWinners(TARGETS_KV);
  if (winners.includes(reply)) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, "Already saved as a winner.");
  }

  winners.unshift(reply); // most recent first
  // Keep last 50 winners
  if (winners.length > 50) winners.splice(50);
  await TARGETS_KV.put("__winners", JSON.stringify(winners));

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `✅ Saved as a winner. You now have ${winners.length} high-performing repl${winners.length === 1 ? "y" : "ies"} in your training pool.`
  );
}

export async function handleWinners(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV, CLAUDE_API_KEY } = env;
  const winners = await getWinners(TARGETS_KV);

  if (!winners.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No winners saved yet.\n\nUse /worked ${code("your reply")} after a reply gets engagement.`
    );
  }

  const list = winners.slice(0, 10).map((w, idx) => `${idx + 1}. "${w}"`).join("\n\n");

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b(`Your top ${Math.min(winners.length, 10)} winners`)} (${winners.length} total):\n\n${list}`
  );

  // Analytics: show pattern analysis if we have enough winners
  if (winners.length >= 5 && CLAUDE_API_KEY) {
    try {
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId, "⏳ Analysing what makes them work...");
      const analysis = await analyzeWinners(CLAUDE_API_KEY, winners);
      await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
        `${b("What your winning replies have in common:")}\n\n${analysis}`
      );
    } catch {
      // analytics failure is non-fatal
    }
  }
}

export async function handleLearnStance(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, CLAUDE_API_KEY, TARGETS_KV } = env;
  const topic = arg.trim().toLowerCase();

  if (!topic) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `Usage: /learnstance ${code("topic")}\nExample: /learnstance ${code("liverpool")}`
    );
  }

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `⏳ Reading your corpus on "${topic}"...`);

  const results = await searchCorpus(topic, {
    vectorizeWorker: env.VECTORIZE_WORKER,
    vectorizeApiKey: VECTORIZE_API_KEY,
    limit: 20,
  });
  const examples = results.map(formatResult);

  if (!examples.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No bookmarks found on "${topic}". Try a broader keyword.`
    );
  }

  const stance = await learnStanceFromCorpus(CLAUDE_API_KEY, topic, examples);

  // Save it
  const stances = await getStances(TARGETS_KV);
  stances[topic] = stance;
  await TARGETS_KV.put("__stances", JSON.stringify(stances));

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b(`Learned stance on "${topic}":`)}

${i(stance)}

✅ Saved. Use /setstance ${code(`${topic}: new text`)} to override anytime.`
  );
}

export async function handleRemoveStance(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const topic = arg.trim().toLowerCase();

  if (!topic) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Usage: /removestance ${code("topic")}`);
  }

  const stances = await getStances(TARGETS_KV);
  if (!stances[topic]) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `No stance found for "${topic}".`);
  }

  delete stances[topic];
  await TARGETS_KV.put("__stances", JSON.stringify(stances));
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `✅ Removed stance for ${b(topic)}.`);
}

export async function handleThread(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, CLAUDE_API_KEY, TARGETS_KV } = env;

  // Extract --web flag
  const useWeb = /--web\b/i.test(arg);
  const cleanArg = arg.replace(/\s*--web\b/i, "").trim();

  // Parse: "Your reply: ...\nTheir reply: ..."
  const yourMatch = cleanArg.match(/your\s*reply\s*:\s*(.+?)(?=their\s*reply\s*:|$)/is);
  const theirMatch = cleanArg.match(/their\s*reply\s*:\s*(.+?)$/is);

  if (!yourMatch || !theirMatch) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `Usage:\n/thread\nYour reply: what you said\nTheir reply: what they responded\n\nAdd ${code("--web")} for live context on the subject`
    );
  }

  const yourReply = yourMatch[1].trim();
  const theirReply = theirMatch[1].trim();

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, useWeb ? "⏳ Searching web + drafting continuations..." : "⏳ Drafting thread continuations...");

  const targets = await getTargets(TARGETS_KV);
  // Search on both sides of the conversation combined for richer, more accurate context
  const combinedQuery = `${yourReply} ${theirReply}`.slice(0, 300);
  const results = await searchCorpus(combinedQuery, { vectorizeWorker: env.VECTORIZE_WORKER, vectorizeApiKey: VECTORIZE_API_KEY });
  const targetMatches = filterByAuthors(results, targets).map(formatResult);
  const examples = targetMatches.length >= 2 ? targetMatches : results.map(formatResult);

  const webContext = useWeb ? await searchWeb(theirReply, env.TAVILY_API_KEY) : null;
  const options = await continueThread(CLAUDE_API_KEY, yourReply, theirReply, examples, webContext);

  const webNote = useWeb && webContext ? `\n${i("🌐 Live web context included")}` : "";
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b("Continue the thread:")}\n\n${options}\n\n${i("Based on your corpus style")}${webNote}`
  );
}

export async function handleStatus(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;

  const raw = await TARGETS_KV.get("__cron_status");
  if (!raw) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `${b("📊 Bot Status")}\n\n🟢 Bot is running\n⚠️ No cron run recorded yet — cron will write status after next run.`
    );
  }

  const status = JSON.parse(raw);
  const lastRun = new Date(status.last_run);
  const now = new Date();
  const diffMs = now - lastRun;
  const hoursAgo = Math.floor(diffMs / (1000 * 60 * 60));
  const minsAgo = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  const ago = hoursAgo > 0
    ? `${hoursAgo}h ${minsAgo}m ago`
    : `${minsAgo}m ago`;

  const dateStr = lastRun.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const timeStr = lastRun.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const stances = await TARGETS_KV.get("__stances");
  const stanceCount = stances ? Object.keys(JSON.parse(stances)).length : 0;
  const winners = await TARGETS_KV.get("__winners");
  const winnerCount = winners ? JSON.parse(winners).length : 0;
  const targets = await TARGETS_KV.get("targets");
  const targetCount = targets ? JSON.parse(targets).length : 0;

  const msg = `${b("📊 Bot Status")}

🟢 Bot is running
📅 ${b("Last cron:")} ${dateStr} at ${timeStr} UTC
⏱ ${b("Ran:")} ${ago}
✅ ${b("Status:")} ${status.status}

${b("Knowledge:")}
• ${targetCount} target accounts
• ${stanceCount} saved stances
• ${winnerCount} winning replies`;

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, msg);
}

export async function handleRefresh(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, TARGETS_KV } = env;
  const targets = await getTargets(TARGETS_KV);

  if (!targets.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `No target accounts set. Use /addtarget first.`);
  }

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `⏳ Scanning corpus from ${targets.length} target accounts...`);

  const queries = [
    "opinions technology AI startup founders",
    "football soccer premier league match",
    "Nigeria politics economy president",
    "investing finance markets money",
  ];

  const allSearches = await Promise.all(
    queries.map(q => searchCorpus(q, {
      vectorizeWorker: env.VECTORIZE_WORKER,
      vectorizeApiKey: VECTORIZE_API_KEY,
      limit: 50,
    }))
  );

  const seen = new Set();
  const allResults = [];
  for (const results of allSearches) {
    for (const r of filterByAuthors(results, targets).map(formatResult)) {
      const key = r.text.slice(0, 60);
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }

  allResults.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  const top = allResults.slice(0, 8);

  if (!top.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No content from your targets in the corpus yet. Run the daily sync first.`
    );
  }

  const lines = top.map((r, idx) => {
    const likesStr = r.likes ? ` · ${r.likes.toLocaleString()} likes` : "";
    return `${idx + 1}. ${b(`@${r.author}`)}${likesStr}\n"${r.text}"`;
  });

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b("Top content from your target accounts:")}\n\n${lines.join("\n\n")}\n\n${i("Sorted by engagement · From your bookmark corpus")}`
  );
}

export async function handleBackup(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, "⏳ Creating backup...");

  const [targets, stances, winners, drafts] = await Promise.all([
    getTargets(TARGETS_KV),
    getStances(TARGETS_KV),
    getWinners(TARGETS_KV),
    getDrafts(TARGETS_KV),
  ]);

  const backup = {
    exported_at: new Date().toISOString(),
    targets,
    stances,
    winners,
    drafts,
  };

  await TARGETS_KV.put("__backup", JSON.stringify(backup));

  const stanceCount = Object.keys(stances).length;
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b("✅ Backup saved to KV")}

• ${targets.length} target accounts
• ${stanceCount} stances
• ${winners.length} winning replies
• ${drafts.length} saved drafts

Use /restore to recover this backup if needed.`
  );

  // Send stances JSON in chunks of 5 so user can save externally
  const stanceEntries = Object.entries(stances);
  const CHUNK = 5;
  for (let idx = 0; idx < stanceEntries.length; idx += CHUNK) {
    const slice = Object.fromEntries(stanceEntries.slice(idx, idx + CHUNK));
    const json = JSON.stringify(slice, null, 2);
    const label = idx === 0
      ? `${b("Stances JSON (save this somewhere safe):")} ${i(`${idx + 1}–${Math.min(idx + CHUNK, stanceEntries.length)} of ${stanceEntries.length}`)}`
      : `${i(`Stances ${idx + 1}–${Math.min(idx + CHUNK, stanceEntries.length)} of ${stanceEntries.length}`)}`;
    await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `${label}\n\n<pre>${json}</pre>`);
  }
}

export async function handleRestore(chatId, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;

  const raw = await TARGETS_KV.get("__backup");
  if (!raw) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `No backup found. Run /backup first to create one.`
    );
  }

  const backup = JSON.parse(raw);
  const stanceCount = Object.keys(backup.stances || {}).length;

  await Promise.all([
    TARGETS_KV.put("targets", JSON.stringify(backup.targets || [])),
    TARGETS_KV.put("__stances", JSON.stringify(backup.stances || {})),
    TARGETS_KV.put("__winners", JSON.stringify(backup.winners || [])),
    TARGETS_KV.put("__drafts", JSON.stringify(backup.drafts || [])),
  ]);

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b("✅ Restored from backup")} (${i(backup.exported_at)})

• ${(backup.targets || []).length} target accounts
• ${stanceCount} stances
• ${(backup.winners || []).length} winning replies
• ${(backup.drafts || []).length} saved drafts`
  );
}

export async function handleDraft(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, TARGETS_KV } = env;
  const trimmed = arg.trim();

  // /draft list  or  /draft (no arg)
  if (!trimmed || trimmed.toLowerCase() === "list") {
    const drafts = await getDrafts(TARGETS_KV);
    if (!drafts.length) {
      return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
        `No drafts saved yet.\n\nUse /draft ${code("your tweet idea")} to save one.`
      );
    }
    const list = drafts
      .map((d, idx) => `${idx + 1}. "${d.text.slice(0, 120)}${d.text.length > 120 ? "…" : ""}"`)
      .join("\n\n");
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `${b(`Your saved drafts (${drafts.length}):`)}\n\n${list}\n\n${i("Use /draft pick <n> to polish · /draft delete <n> to remove")}`
    );
  }

  // /draft pick <n>
  const pickMatch = trimmed.match(/^pick\s+(\d+)$/i);
  if (pickMatch) {
    const n = parseInt(pickMatch[1], 10) - 1;
    const drafts = await getDrafts(TARGETS_KV);
    if (n < 0 || n >= drafts.length) {
      return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `No draft #${n + 1}. Use /draft list to see your drafts.`);
    }
    return handleTweet(chatId, drafts[n].text, env);
  }

  // /draft delete <n>
  const deleteMatch = trimmed.match(/^delete\s+(\d+)$/i);
  if (deleteMatch) {
    const n = parseInt(deleteMatch[1], 10) - 1;
    const drafts = await getDrafts(TARGETS_KV);
    if (n < 0 || n >= drafts.length) {
      return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `No draft #${n + 1}.`);
    }
    const [removed] = drafts.splice(n, 1);
    await TARGETS_KV.put("__drafts", JSON.stringify(drafts));
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId,
      `✅ Deleted: "${removed.text.slice(0, 80)}${removed.text.length > 80 ? "…" : ""}"`
    );
  }

  // Otherwise save as new draft
  const drafts = await getDrafts(TARGETS_KV);
  drafts.unshift({ text: trimmed, savedAt: new Date().toISOString() });
  if (drafts.length > 20) drafts.splice(20);
  await TARGETS_KV.put("__drafts", JSON.stringify(drafts));

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `✅ Draft saved (${drafts.length} total).\n\n"${trimmed.slice(0, 150)}${trimmed.length > 150 ? "…" : ""}"\n\n${i("Use /draft list to view · /draft pick 1 to polish")}`
  );
}

export async function handleTrending(chatId, arg, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY } = env;
  const topic = arg.trim() || null;

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    topic ? `⏳ Finding top content on "${topic}"...` : "⏳ Finding most-liked content across your corpus..."
  );

  const queries = topic
    ? [topic]
    : [
        "best insights opinions technology AI",
        "Nigeria government politics economy",
        "football premier league champions league",
        "investing finance markets entrepreneurship",
      ];

  const allSearches = await Promise.all(
    queries.map(q => searchCorpus(q, {
      vectorizeWorker: env.VECTORIZE_WORKER,
      vectorizeApiKey: VECTORIZE_API_KEY,
      limit: 50,
    }))
  );

  const seen = new Set();
  const allResults = [];
  for (const results of allSearches) {
    for (const r of results.map(formatResult)) {
      const key = r.text.slice(0, 60);
      if (!seen.has(key)) { seen.add(key); allResults.push(r); }
    }
  }

  allResults.sort((a, b) => (b.likes || 0) - (a.likes || 0));
  const top = allResults.slice(0, 10);

  if (!top.length) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `No results found.`);
  }

  const lines = top.map((r, idx) => {
    const meta = r.author ? b(`@${r.author}`) : "unknown";
    const likesStr = r.likes ? ` · ${r.likes.toLocaleString()} likes` : "";
    return `${idx + 1}. ${meta}${likesStr}\n"${r.text}"`;
  });

  const header = topic ? `Top on "${topic}":` : "Most-liked in your corpus:";
  await sendMessage(TELEGRAM_BOT_TOKEN, chatId,
    `${b(header)}\n\n${lines.join("\n\n")}\n\n${i("Sorted by likes · From your 45k+ bookmark corpus")}`
  );
}

export async function handlePattern(chatId, topic, env) {
  const { TELEGRAM_BOT_TOKEN, VECTORIZE_API_KEY, CLAUDE_API_KEY, TARGETS_KV } = env;

  if (!topic.trim()) {
    return sendMessage(TELEGRAM_BOT_TOKEN, chatId, `Usage: /pattern ${code("topic")}`);
  }

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, "⏳ Analysing patterns...");

  const targets = await getTargets(TARGETS_KV);
  const results = await searchCorpus(topic, { vectorizeWorker: env.VECTORIZE_WORKER, vectorizeApiKey: VECTORIZE_API_KEY, limit: 20 });
  const formatted = results.map(formatResult);
  const targetMatches = filterByAuthors(results, targets).map(formatResult);
  const examples = targetMatches.length >= 5 ? targetMatches : formatted;

  const pattern = await summarizePattern(CLAUDE_API_KEY, examples);

  await sendMessage(TELEGRAM_BOT_TOKEN, chatId, `${b(`What works on "${topic}":`)}\n\n${pattern}`);
}
