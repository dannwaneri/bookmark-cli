import {
  handleStart,
  handleTweet,
  handleReply,
  handleSearch,
  handleTargets,
  handleAddTarget,
  handleRemoveTarget,
  handlePattern,
  handleThread,
  handleSetStance,
  handleStances,
  handleRemoveStance,
  handleLearnStance,
  handleWorked,
  handleWinners,
  handleStatus,
  handleRefresh,
  handleBackup,
  handleRestore,
  handleDraft,
  handleTrending,
  handleLong,
  handleRefine,
} from "./commands.js";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Bookmark Brain Bot is running.", { status: 200 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    const message = update.message ?? update.edited_message;
    if (!message || !message.text) {
      return new Response("OK", { status: 200 });
    }

    // Deduplicate retried webhook deliveries
    const updateId = String(update.update_id);
    const lastId = await env.TARGETS_KV.get("__last_update_id");
    if (lastId && Number(updateId) <= Number(lastId)) {
      return new Response("OK", { status: 200 });
    }
    await env.TARGETS_KV.put("__last_update_id", updateId);

    const chatId = message.chat.id;
    const text = message.text.trim();

    // Support multi-line messages — each line starting with / is its own command
    const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
    const commandLines = lines.filter(l => l.startsWith("/"));
    const toProcess = commandLines.length > 1 ? commandLines : [text];

    for (const line of toProcess) {
      const [rawCmd, ...argParts] = line.split(/\s+/);
      const cmd = rawCmd.split("@")[0].toLowerCase();
      const arg = argParts.join(" ").trim();
      await dispatch(cmd, arg, chatId, env);
    }

    return new Response("OK", { status: 200 });
  },
};

async function dispatch(cmd, arg, chatId, env) {
  try {
    switch (cmd) {
      case "/start":
      case "/help":
        await handleStart(chatId, env.TELEGRAM_BOT_TOKEN);
        break;
      case "/tweet":
        await handleTweet(chatId, arg, env);
        break;
      case "/reply":
        await handleReply(chatId, arg, env);
        break;
      case "/search":
        await handleSearch(chatId, arg, env);
        break;
      case "/targets":
        await handleTargets(chatId, env);
        break;
      case "/addtarget":
        await handleAddTarget(chatId, arg, env);
        break;
      case "/removetarget":
        await handleRemoveTarget(chatId, arg, env);
        break;
      case "/pattern":
        await handlePattern(chatId, arg, env);
        break;
      case "/thread":
        await handleThread(chatId, arg, env);
        break;
      case "/setstance":
        await handleSetStance(chatId, arg, env);
        break;
      case "/stances":
        await handleStances(chatId, env);
        break;
      case "/removestance":
        await handleRemoveStance(chatId, arg, env);
        break;
      case "/learnstance":
        await handleLearnStance(chatId, arg, env);
        break;
      case "/worked":
        await handleWorked(chatId, arg, env);
        break;
      case "/winners":
        await handleWinners(chatId, env);
        break;
      case "/status":
        await handleStatus(chatId, env);
        break;
      case "/refresh":
        await handleRefresh(chatId, env);
        break;
      case "/backup":
        await handleBackup(chatId, env);
        break;
      case "/restore":
        await handleRestore(chatId, env);
        break;
      case "/draft":
        await handleDraft(chatId, arg, env);
        break;
      case "/trending":
        await handleTrending(chatId, arg, env);
        break;
      case "/long":
        await handleLong(chatId, arg, env);
        break;
      case "/refine":
        await handleRefine(chatId, arg, env);
        break;
      default:
        break;
    }
  } catch (err) {
    console.error("Command error:", err);
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `⚠️ Something went wrong: ${err.message}`,
      }),
    });
  }
}
