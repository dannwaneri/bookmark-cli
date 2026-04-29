const MODEL = "claude-sonnet-4-6";
const API_URL = "https://api.anthropic.com/v1/messages";

function currentDate() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

async function callClaude(apiKey, systemPrompt, userMessage) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
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

Style rules:
- Short and declarative — cut filler, no hedging
- Personal observation or direct opinion
- One clean idea per tweet
- Plain language
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

Rules:${stanceLine}
- Write as opinion and perspective — never assert specific facts, benchmarks, or statistics you can't verify
- Replies match the direct, declarative style of the examples
- Under 200 characters each
- No sycophancy ("great point!", "love this!")
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

export async function continueThread(apiKey, yourReply, theirReply, examples) {
  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const system = `You are a Twitter conversation coach. Someone replied to your tweet and you need to continue the thread naturally. Today's date is ${currentDate()}.

Rules:
- Keep the energy going — match their tone (humor, curiosity, pushback)
- Add something new: a detail, a pivot, a question, or a sharper version of the original idea
- Write as opinion and perspective — never assert facts you can't verify
- Under 200 characters each
- No sycophancy
- No hashtags
- Make at least one option end with a question to invite them to keep talking

Return exactly 3 options numbered 1. 2. 3. Nothing else.`;

  const user = `Style reference:
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
