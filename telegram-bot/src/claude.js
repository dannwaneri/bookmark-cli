const MODEL = "claude-sonnet-4-6";
const API_URL = "https://api.anthropic.com/v1/messages";

function currentDate() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// Voice fingerprint derived from the user's own high-performing replies
const VOICE_RULES = `Voice rules (non-negotiable):
- Open with a reframe, inversion, or structural implication — never restate the original point
- One sharp analogy or compressed metaphor does the argumentative work — translate abstract → concrete
- End with a single short declarative sentence. If the last sentence has more than one clause, cut it
- Banned phrases: "At the end of the day", "Let that sink in", "The reality is", "It's worth noting", "That said", "In today's world", "This is why", "Interestingly", "Absolutely", "Exactly"
- No em-dash drama. No rhetorical questions as openers. No passive voice hedging
- 2–4 sentences total. Earn attention by refusing to overstay it`;

async function callClaude(apiKey, systemPrompt, userMessage, maxTokens = 512) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  return data.content[0].text.trim();
}

export async function rewriteTweet(apiKey, draft, examples) {
  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const system = `You are a tweet editor. Rewrite drafts to be punchier and more engaging, inspired by the style of the examples. Today's date is ${currentDate()}.

${VOICE_RULES}

Additional rules:
- One clean idea per tweet
- No hashtags unless they appear naturally in the examples
- Under 280 characters
- ALWAYS produce a different version — even if the draft is already good, make it sharper or more specific

Return only the rewritten tweet. No explanation, no quotes around it.`;

  const user = `Here are high-engagement tweets from accounts the user wants to reach:

${exampleBlock}

Rewrite this draft to match that style while keeping the core idea intact:

"${draft}"`;

  return callClaude(apiKey, system, user);
}

export async function suggestReplies(apiKey, targetTweet, examples, stance = null, winners = [], webContext = null) {
  const winnerBlock = winners.length
    ? `Your proven high-performing replies (prioritise this style):\n${winners.slice(0, 5).map((w, i) => `${i + 1}. "${w}"`).join("\n")}\n\n`
    : "";

  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const stanceLine = stance
    ? `\n- The user's position is: "${stance}" — all 3 replies must argue FROM this angle, not against it`
    : `\n- Challenge an assumption, reframe the claim, or add a contrarian angle`;

  const system = `You are a Twitter reply coach. Generate 3 strong replies to a tweet. Today's date is ${currentDate()}.

${VOICE_RULES}

Additional rules:${stanceLine}
- Write as opinion and perspective — never assert specific facts, benchmarks, or statistics you can't verify
- Under 200 characters each
- No hashtags

Return exactly 3 replies numbered 1. 2. 3. Nothing else.`;

  const webBlock = webContext
    ? `Factual context only (use for dates, names, scores, recent events — do NOT let this shape the opinion or angle of replies, that comes from the stance and examples only):\n${webContext}\n\n`
    : "";

  const user = `${winnerBlock}${webBlock}Style reference — high-engagement tweets from target accounts:

${exampleBlock}

Write 3 replies to this tweet:

"${targetTweet}"`;

  return callClaude(apiKey, system, user);
}

export async function continueThread(apiKey, yourReply, theirReply, examples, webContext = null) {
  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const system = `You are a Twitter conversation coach. Someone replied to your tweet and you need to continue the thread naturally. Today's date is ${currentDate()}.

${VOICE_RULES}

Additional rules:
- Keep the energy going — match their tone (humor, curiosity, pushback)
- Add something new: a detail, a pivot, a question, or a sharper version of the original idea
- Write as opinion and perspective — never assert facts you can't verify
- Under 200 characters each
- No hashtags
- Make at least one option end with a question to invite them to keep talking
- The subject may be a manager, pundit, politician, player, or institution — infer from context, do NOT default to player/transfer framing. Never use signing, transfer, fee, or contract language unless those words appear in the conversation
- Do NOT output any reasoning or subject identification — jump straight to the 3 replies

Return exactly 3 options numbered 1. 2. 3. Nothing else.`;

  const webBlock = webContext
    ? `Factual context about who/what is being discussed (use for names, roles, records — do NOT let this override the opinion angle):\n${webContext}\n\n`
    : "";

  const user = `${webBlock}Style reference:
${exampleBlock}

Your original reply: "${yourReply}"
Their response: "${theirReply}"

Write 3 ways to continue this thread:`;

  return callClaude(apiKey, system, user);
}

export async function learnStanceFromCorpus(apiKey, topic, examples) {
  const exampleBlock = examples
    .slice(0, 15)
    .map((e, i) => `${i + 1}. @${e.author} (${e.likes || 0} likes): "${e.text}"`)
    .join("\n");

  const system = `You are analyzing a person's bookmarked tweets to infer their standing opinion on a topic.

Rules:
- Infer what the person believes based on what they chose to save
- Be specific and direct — no hedging
- Write as a first-person stance the person holds, not a description of the tweets
- 2-3 sentences max
- No phrases like "based on the tweets" or "it appears"

Return only the inferred stance. Nothing else.`;

  const user = `These are tweets this person bookmarked about "${topic}":

${exampleBlock}

What is this person's likely stance on "${topic}"?`;

  return callClaude(apiKey, system, user);
}

export async function analyzeWinners(apiKey, winners) {
  const block = winners.slice(0, 20).map((w, i) => `${i + 1}. "${w}"`).join("\n");
  const system = `You are a content analyst. Identify what makes high-performing Twitter replies work. Be specific and brief.`;
  const user = `These replies all got real engagement. In 3 concise bullet points identify what they share — structure, tone, opening hook, length, rhetorical move:\n\n${block}`;
  return callClaude(apiKey, system, user);
}

export async function generateLongContent(apiKey, topic, examples, stance = null, winners = [], format = "thread", webContext = null) {
  const exampleBlock = examples
    .slice(0, 8)
    .map((e, i) => `${i + 1}. @${e.author} (${e.likes || 0} likes): "${e.text}"`)
    .join("\n");

  const winnerBlock = winners.length
    ? `Your proven high-performing replies (use this voice):\n${winners.slice(0, 5).map((w, i) => `${i + 1}. "${w}"`).join("\n")}\n\n`
    : "";

  const stanceLine = stance
    ? `\n- The author's position: "${stance}" — write from this angle throughout`
    : "";

  const webBlock = webContext
    ? `Factual context (use for names, dates, facts only — do not let this override the argument angle):\n${webContext}\n\n`
    : "";

  if (format === "thread") {
    const system = `You are a Twitter thread writer. Write punchy, argumentative threads. Today's date is ${currentDate()}.

${VOICE_RULES}

Thread rules:${stanceLine}
- Tweet 1 is the hook: a reframe, inversion, or structural implication. Must stop the scroll. Must stand alone as a single tweet.
- Tweets 2–5 build the argument with specifics, analogies, or evidence — each one advances, none restate
- Final tweet lands the weight with one declarative sentence that couldn't close a different thread
- Each tweet under 280 characters
- No hashtags
- Number each tweet: 1/ 2/ 3/ etc.

Return only the numbered tweets. No preamble, no explanation.`;

    const user = `${winnerBlock}${webBlock}Style reference from corpus:
${exampleBlock}

Write a thread on: "${topic}"`;

    return callClaude(apiKey, system, user, 1024);
  }

  // essay mode
  const system = `You are writing a dev.to article. Write a structured, opinionated essay. Today's date is ${currentDate()}.

${VOICE_RULES}

Essay rules:${stanceLine}
- Open with a specific incident, quote, or data point — never a thesis statement
- Invent a structural frame for the piece — a device that runs all the way through
- Each ## section advances the argument, does not just add more examples
- Cite @username from the examples where relevant
- End with a line that could not close a different essay
- 400–600 words
- Return markdown with ## headings

Return only the essay. No preamble.`;

  const user = `${winnerBlock}${webBlock}Style reference and source material from corpus:
${exampleBlock}

Write an essay on: "${topic}"`;

  return callClaude(apiKey, system, user, 2048);
}

export async function refineOutput(apiKey, originalOutput, instruction, type) {
  const typeLabel = type === "essay" ? "essay" : type === "thread" ? "Twitter thread" : type === "tweet" ? "tweet rewrite" : "reply options";
  const maxTokens = type === "essay" ? 2048 : type === "thread" ? 1024 : 512;

  const system = `You are a writing editor. Revise the ${typeLabel} based on a specific instruction while preserving the author's voice.

${VOICE_RULES}

Rules:
- Apply the instruction precisely — don't rewrite everything, just what it targets
- Keep the same structure (numbered tweets stay numbered, essay sections stay sectioned)
- Return only the revised content. No explanation, no preamble.`;

  const user = `Original ${typeLabel}:
${originalOutput}

Instruction: ${instruction}`;

  return callClaude(apiKey, system, user, maxTokens);
}

export async function summarizePattern(apiKey, examples) {
  const exampleBlock = examples
    .slice(0, 10)
    .map((e, i) => `${i + 1}. @${e.author} (${e.likes} likes): "${e.text}"`)
    .join("\n");

  const system = `You are a content strategist. Analyze tweet patterns briefly.`;

  const user = `Analyze what these high-engagement tweets have in common in 3 bullet points. Focus on structure, tone, and what makes them work:

${exampleBlock}`;

  return callClaude(apiKey, system, user);
}
