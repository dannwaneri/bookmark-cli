const MODEL = "claude-sonnet-4-6";
const MODEL_FAST = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

function currentDate() {
  return new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

// Voice fingerprint derived from the user's own high-performing replies
const VOICE_RULES = `Voice rules (non-negotiable):
- Open with a reframe, inversion, or structural implication — never restate the original point
- One sharp analogy or compressed metaphor does the argumentative work — translate abstract → concrete
- End with a single short declarative sentence. If the last sentence has more than one clause, cut it
- Banned words and phrases: "At the end of the day", "Let that sink in", "The reality is", "It's worth noting", "That said", "In today's world", "This is why", "Interestingly", "Absolutely", "Exactly", "pivotal moment", "broader landscape", "game-changer", "transformative", "speaks to", "testament", "showcasing", "Additionally", "landscape"
- Banned frames: "The real question is", "What this really means", "What this tells us", "It's not just X, it's Y", "Not X. Not Y. Just Z.", "X wasn't paid for Y, they were paid for Z" — these are AI reveal and occupational substitution constructions, not arguments
- Never use an em-dash (—). Use a period instead
- No rhetorical questions as openers. No passive voice hedging
- No copula avoidance — write "is" not "serves as", "acts as", "functions as"
- No vague attribution — never write "many people", "experts say", "most would agree" without a name or specific source
- No rule of three — don't list three parallel items when two will do
- No novel two-part metaphors or extended analogies assembled for effect — compress something real, don't construct something literary. "Ran out of mirror", "Truckers weren't paid to turn a steering wheel" are the exact pattern to avoid
- 2–4 sentences total. Earn attention by refusing to overstay it`;

async function callClaude(apiKey, systemPrompt, userMessage, maxTokens = 512, model = MODEL) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (body.includes("credit balance is too low")) {
      const err = new Error("Claude API credits exhausted");
      err.code = "CREDITS_EXHAUSTED";
      throw err;
    }
    throw new Error(`Claude API error: ${res.status} — ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.content[0].text.trim();
}

export async function rewriteTweet(apiKey, draft, examples, voiceInsights = []) {
  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const insightsBlock = voiceInsights.length
    ? `\nLearned from your edits:\n${voiceInsights.slice(0, 5).map(ins => `- ${ins}`).join("\n")}`
    : "";

  const system = `You are a tweet editor. Rewrite drafts to make the argument clearer and more direct, inspired by the style of the examples. Today's date is ${currentDate()}.

${VOICE_RULES}${insightsBlock}

Additional rules:
- Find the underlying argument, not the surface content. If the draft uses an analogy, story, or example to make a point, drop the scaffolding and state the argument directly
- Only rewrite if you can make the argument sharper or more specific. If the draft is already direct, tighten rather than transform
- One clean idea per tweet
- No hashtags unless they appear naturally in the examples
- Under 280 characters
- Never include reasoning, self-corrections, or working notes in your response

Return only the rewritten tweet. No explanation, no quotes around it.`;

  const user = `Here are high-engagement tweets from accounts the user wants to reach:

${exampleBlock}

Rewrite this draft to match that style while preserving the underlying argument — not the surface framing or any analogy used to illustrate it:

"${draft}"`;

  return callClaude(apiKey, system, user);
}

export async function suggestReplies(apiKey, targetTweet, examples, stance = null, winners = [], webContext = null, voiceInsights = [], sentiment = "observation", register = "standard") {
  const winnerBlock = winners.length
    ? `Past replies that landed well — they worked because the argument arrived first and the compression followed. Don't replicate the structure. Find the thought that would naturally produce something like this:\n${winners.slice(0, 5).map((w, i) => `${i + 1}. "${w}"`).join("\n")}\n\n`
    : "";

  const exampleBlock = examples
    .slice(0, 5)
    .map((e, i) => `${i + 1}. @${e.author}: "${e.text}"`)
    .join("\n");

  const stanceLine = stance
    ? `\n- The user's position is: "${stance}" — all 3 replies must argue FROM this angle, not against it`
    : sentiment === "vulnerability"
    ? `\n- Acknowledge the feeling or experience first — the person came before the argument. Then, if insight follows, earn it. Never lead with a reframe that skips the human moment`
    : (sentiment === "venting" || sentiment === "frustration")
    ? `\n- Match and validate the emotion — do NOT contradict, debate, or reframe against what they're feeling`
    : sentiment === "enthusiasm"
    ? `\n- Match the energy or sharpen it with a compressed insight`
    : sentiment === "provocation"
    ? `\n- Push back, extend the provocation, or flip it on its head`
    : `\n- Challenge an assumption, reframe the claim, or add a contrarian angle`;

  const registerLine = register === "pidgin"
    ? `\n- The tweet is written in Nigerian Pidgin — write all replies in Nigerian Pidgin to match the register`
    : register === "casual"
    ? `\n- Match the casual informal register — no formal or academic language`
    : "";

  const insightsBlock = voiceInsights.length
    ? `\nLearned from your edits:\n${voiceInsights.slice(0, 5).map(ins => `- ${ins}`).join("\n")}`
    : "";

  const system = `You are a Twitter reply coach. Generate 3 strong replies to a tweet. Today's date is ${currentDate()}.

${VOICE_RULES}${insightsBlock}

Additional rules:${stanceLine}${registerLine}
- Write as opinion and perspective — never assert specific facts, benchmarks, or statistics you can't verify
- Under 200 characters each
- No hashtags

Before finalizing each option: mentally remove any metaphor or extended analogy. If the point still stands without it, rewrite without it. Only keep a metaphor or analogy if removing it breaks the argument.

Return exactly 3 replies numbered 1. 2. 3.
Make option 3 deliberately flat — blunt, reactive, unresolved. No metaphor, no compression, no quotable landing line. It should sound like a person reacting, not a writer performing.
Never include reasoning, self-corrections, working notes, or restarts in your response. Return only the final numbered replies.`;

  const webBlock = webContext
    ? `Factual context (recent news only — use verbatim for dates, names, scores. Do NOT paraphrase, combine, or inflate numbers from this context. If a score appears here, use it exactly or omit it):\n${webContext}\n\n`
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

export async function generateLongContent(apiKey, topic, examples, stance = null, winners = [], format = "thread", webContext = null, voiceInsights = []) {
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

  const insightsBlock = voiceInsights.length
    ? `\nLearned from your edits:\n${voiceInsights.slice(0, 5).map(ins => `- ${ins}`).join("\n")}`
    : "";

  if (format === "thread") {
    const system = `You are a Twitter thread writer. Write punchy, argumentative threads. Today's date is ${currentDate()}.

${VOICE_RULES}${insightsBlock}

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

${VOICE_RULES}${insightsBlock}

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

export async function analyzeTweet(apiKey, tweet) {
  const result = await callClaude(
    apiKey,
    `Analyze a tweet and return exactly two lines. No other text.

sentiment: one of — vulnerability, venting, frustration, enthusiasm, provocation, agreement, observation
register: one of — pidgin, casual, formal, standard

Definitions:
- vulnerability: sharing fear, self-doubt, personal pain, or emotional exposure — the person is opening up, not arguing
- venting: expressing frustration or anger directed outward at a system, person, or situation
- frustration: milder irritation, still emotionally charged
- enthusiasm: excitement, celebration, hype
- provocation: deliberately edgy or confrontational, inviting pushback
- agreement: affirming or building on someone else's point
- observation: neutral analysis or statement of fact
- pidgin: Nigerian Pidgin or creole / code-switching with non-standard grammar
- casual: informal standard English
- formal: academic or professional register
- standard: everyday standard English`,
    `Tweet: "${tweet.slice(0, 400)}"\n\nReturn:\nsentiment: <value>\nregister: <value>`,
    60,
    MODEL_FAST
  );
  const sentiment = result.match(/sentiment:\s*(\w+)/i)?.[1]?.toLowerCase() ?? "observation";
  const register = result.match(/register:\s*(\w+)/i)?.[1]?.toLowerCase() ?? "standard";
  return { sentiment, register };
}

export async function validateStance(apiKey, tweet, stance) {
  const answer = await callClaude(
    apiKey,
    `You decide whether a saved opinion stance is relevant enough to inject as the user's viewpoint when replying to a tweet.

Rule: answer 'yes' if the stance directly engages with the tweet's specific topic and argument — whether it agrees, disagrees, or counters it. Answer 'no' only if the stance is about a completely different event, policy, or subject that merely shares surface keywords.`,
    `Tweet: "${tweet.slice(0, 600)}"\n\nSaved stance: "${stance}"\n\nIs this stance directly relevant to the tweet's specific topic and argument (even if it takes the opposite position)? Answer only 'yes' or 'no'.`,
    10,
    MODEL_FAST
  );
  return answer.toLowerCase().startsWith("yes") ? stance : null;
}

export async function extractVoiceDelta(apiKey, original, edited) {
  const system = `You are analyzing how someone edited AI-generated writing to better match their voice.
In one short sentence (max 15 words), describe what the edit improved — be specific about the writing technique, not the content.
Good examples: "Replaced abstract claim with concrete consequence." / "Cut the setup, kept only the landing." / "Swapped passive hedge for direct accusation."
Return only the sentence. No quotes, no preamble.`;
  const user = `Original: "${original}"\nEdited to: "${edited}"`;
  return callClaude(apiKey, system, user, 60);
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
