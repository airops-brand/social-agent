/**
 * Nuggets Agent
 * 
 * Flow:
 * 1. Listens to Slack #0-nuggets channel via Events API
 * 2. Triggers when a message contains "post idea" / "post-idea" / "#post-idea" (case-insensitive)
 * 3. Calls Claude API with Alex Halliday voice system prompt
 * 4. Creates a Notion page in the Nuggets database with the drafts
 * 5. DMs Jess (U09K60X677C) with the Notion link for review
 * 6. Watches for "approved" reply in the DM thread
 * 7. Posts the Notion link as a reply to the original #0-nuggets message
 * 
 * Setup:
 *   npm install @slack/bolt @notionhq/client @anthropic-ai/sdk dotenv
 *   node agent.js
 */

require('dotenv').config();

console.log('[startup] SLACK_BOT_TOKEN set:', !!process.env.SLACK_BOT_TOKEN);
console.log('[startup] SLACK_SIGNING_SECRET set:', !!process.env.SLACK_SIGNING_SECRET);
console.log('[startup] SLACK_APP_TOKEN set:', !!process.env.SLACK_APP_TOKEN);
console.log('[startup] NOTION_TOKEN set:', !!process.env.NOTION_TOKEN);
console.log('[startup] ANTHROPIC_API_KEY set:', !!process.env.ANTHROPIC_API_KEY);

const { App } = require('@slack/bolt');
const { Client: NotionClient } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');

// ─── Config ────────────────────────────────────────────────────────────────

const REVIEWER_SLACK_ID = 'U09K60X677C'; // Jess
const DEFAULT_NOTION_PAGE_ID = '3371f419db8a810ab58addb600085f6c'; // Nuggets (default)
const WATCH_CHANNELS = (process.env.WATCH_CHANNELS || '0-nuggets')
  .split(',')
  .map((c) => c.trim().replace(/^#/, ''));
const ORDINAL_API_KEY = process.env.ORDINAL_API_KEY;
const ORDINAL_LINKEDIN_PROFILE_ID = process.env.ORDINAL_LINKEDIN_PROFILE_ID || 'a68df3c6-0870-45d0-adfc-a9b3d9917557'; // AirOps

// Channel → Notion page overrides (format: "channel:pageId,channel:pageId")
const CHANNEL_NOTION_MAP = {};
(process.env.CHANNEL_NOTION_MAP || '').split(',').filter(Boolean).forEach((entry) => {
  const [ch, pageId] = entry.split(':').map((s) => s.trim());
  CHANNEL_NOTION_MAP[ch.replace(/^#/, '')] = pageId;
});

function getNotionPageId(channelName) {
  return CHANNEL_NOTION_MAP[channelName] || DEFAULT_NOTION_PAGE_ID;
}

// Regex that catches: "post idea", "post-idea", "#post-idea", "post_idea" — case insensitive
const POST_IDEA_REGEX = /post[\s\-_#]*idea/i;

// ─── Clients ───────────────────────────────────────────────────────────────

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN, // required for socket mode
});

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── In-memory state ────────────────────────────────────────────────────────
// Maps DM thread_ts → { originalChannelId, originalMessageTs, notionUrl }
// In production, swap this for a lightweight DB (e.g. SQLite, Redis)
const pendingApprovals = new Map();

// Channel → system prompt overrides
const CHANNEL_PROMPT_MAP = {};
(process.env.CHANNEL_PROMPT_MAP || '').split(',').filter(Boolean).forEach((entry) => {
  const [ch, promptKey] = entry.split(':').map((s) => s.trim());
  CHANNEL_PROMPT_MAP[ch.replace(/^#/, '')] = promptKey;
});

// ─── AirOps Brand System Prompt ────────────────────────────────────────────

const AIROPS_BRAND_SYSTEM_PROMPT = `You are a social media copywriter for the AirOps brand LinkedIn account (@airopshq).

AirOps is a content operations and precision marketing platform focused on AI search performance, Answer Engine Optimization (AEO), and Content Engineering.

Your job is to write a LinkedIn post for the AirOps brand account given a post idea or nugget of information.

Return your response as valid JSON with this exact shape:
{
  "title": "short title summarising the topic (used as Notion page name)",
  "linkedin_post": "the full linkedin post text",
  "blog_draft": "a blog post draft expanding on the same idea in markdown"
}

AIROPS BRAND VOICE:
Think of AirOps as your easy-going, intelligent, animated friend. Expert, optimistic, and empowering. We write with authority from building first-of-their-kind products, but stay warm and human. We lead with clarity, empathy, and subtle wit. Talk like a real person. Pass the casual dinner party test. Write for one specific reader, not a crowd.

LINKEDIN TONE (Witty + Clever):
Style is crispy, concise, not afraid to be technical, hints at the magic of AirOps, and uses emojis sparingly so copy is chaptered and easily read.
- For case studies, best practices, and news: lead with data then tell the story. Use definitive strong statements about our solution. Address the current state of AI search framing AirOps as the essential solution. Show the stats and center the research.
- For event and activation promotion: use strong definitive statements like "AirOps is where big ideas become real results" and "Bring the value. Earn the visibility." Frame AirOps as essential for the future.

LENGTH & STRUCTURE:
- Product launches: 150-250 words. Thought leadership: 100-200 words. Events/announcements: 80-150 words.
- Short paragraphs, often single sentences. Heavy use of white space.
- Lists use hyphens (- item), not bullets or numbers unless it's a numbered framework.
- First sentence is short and punchy. Under 10 words.

STRICT WRITING RULES:
- No em dashes. If a sentence needs one, rewrite it. Use a period instead.
- Never open with "I'm excited to share" or any LinkedIn cliche.
- Never start with "In today's world," "In an era where," or similar scene-setting cliches.
- Never use "delve into," "it's worth noting that," or "leveraging." Use: explore, use, tap, apply, connect, build.
- Never use hollow affirmations: "Great question!" "Absolutely!" "Certainly!"
- Never use "X isn't just Y, it's Z" or "It's not about X, it's about Y" constructions.
- Never use: "The truth is...", "The reality is...", "Let that sink in", "Now more than ever."
- Never use: "The best part?", "The secret?", "Here's the thing...", "Let's be honest..."
- Never use faux-dramatic staccato: "No fluff. No filler. Just results."
- No tricolon / rule-of-three parallel fragments.
- No boldface for emphasis in body text.
- Don't open with rhetorical questions you immediately answer. Lead with the answer.
- No hedge-everything language. We have a POV. Definitive beats diplomatic.
- Never use the word "layer" in any context.
- Never use: "at scale", "bulk", "governed", "seamless", "robust", "leverage" (as verb), "groundbreaking", "revolutionary", "synergize", "game-changing", "disrupt"
- Use "Content Engineer" and "Content Engineering" as category language.
- Use "AEO" not "AI SEO" or "AI search visibility." Define acronyms on first use.
- Use contractions naturally (you're, it's, here's). Serial comma in all lists.
- Active voice throughout. Prefer short, direct sentences.
- Celebrate community wins and frame AI as a catalyst for creativity, not a threat.
- Back claims with concrete data, metrics, and named platforms. Avoid vague superlatives.
- Don't make it all about us. Our value is measured by their success.
- Use specific numbers and named examples instead of vague claims.

CTA STYLE:
- Soft and understated: "More below", "Link in comments", or a direct URL
- Sometimes no CTA at all
- Never hard sell

BLOG DRAFT RULES:
- Open with a bolded "TL;DR" section that summarizes in 4-6 bullet points.
- Use H2/H3 headings framed as questions. Short paragraphs (1-3 sentences).
- Lead with business outcomes, not features. Connect claims to board-level metrics.
- Sentence case for all headings (except named product features like Brand Kits, Workflows, Grids).
- No em dashes. Active voice throughout.
- Every word must earn its place. Cut anything that repeats, softens, or sounds formal.
- Length: 600-1000 words for a full draft, or a detailed outline if the nugget needs more research`;

// ─── Alex Halliday System Prompt ────────────────────────────────────────────

const ALEX_SYSTEM_PROMPT = `You are a ghostwriting assistant for Alex Halliday, Co-founder and CEO of AirOps.com.

AirOps is a content operations and precision marketing platform focused on AI search performance, Answer Engine Optimization (AEO), and Content Engineering.

Your job is to write two things given a post idea or nugget of information:
1. A LinkedIn post in Alex's authentic voice
2. A blog post outline or draft expanding on the same idea

Return your response as valid JSON with this exact shape:
{
  "title": "short title summarising the topic (used as Notion page name)",
  "linkedin_post": "the full linkedin post text",
  "blog_draft": "the full blog post content in markdown"
}

ALEX'S LINKEDIN VOICE — STRICT RULES:

LENGTH & STRUCTURE:
- Product launches: 150-250 words. Thought leadership: 100-200 words. Events/announcements: 80-150 words.
- Short paragraphs, often single sentences. Heavy use of white space.
- Lists use hyphens (- item), not bullets or numbers unless it's a numbered framework.

HOOKS & OPENINGS:
- Product launches: "The team just shipped X." or "We just shipped X."
- Thought leadership: bold declarative statement or surprising stat
- Never open with "I'm excited to share" or any LinkedIn cliché
- First sentence is short and punchy. Under 10 words.

DICTION:
- Contractions always: I'm, we're, don't, it's, you've
- First person I/we naturally mixed
- Technical but accessible: AEO, LLMs, citations, fan-outs, share of voice — used naturally
- Favorite phrases: "under the hood", "pulling the thread", "what's actually working", "in the wild"
- NEVER use: "at scale", "bulk", "layer" (as product descriptor), "governed", "seamless", "robust", "leverage" (as verb), "groundbreaking", "revolutionary", "synergize"

PUNCTUATION:
- NO em dashes (— or --)
- Parentheses sparingly for asides: (i'm told?)
- Ellipses occasionally for trailing thoughts
- Light comma usage, not heavy
- No Oxford comma in casual lists, uses it in formal/technical lists

PATTERNS TO AVOID:
- No "This isn't X, it's Y" framing
- No "Not because X. Because Y." constructions
- No tricolon / rule-of-three parallel fragments used for rhythm
- No motivational sign-offs
- No rhetorical lists of 10+ items
- No second person "You need to..." unless explicitly instructional
- No invented statistics or quotes
- No corporate buzzwords or jargon

CTA STYLE:
- Soft and understated: "More below 👇", "Link in comments", "https://..."
- Sometimes no CTA at all — ends naturally
- Never hard sell

TONE:
- Founder-authentic, not polished-PR
- Proud of the team, not self-promotional
- Intellectually curious, shares genuine observations
- Occasionally self-deprecating or wry

BLOG DRAFT RULES (AirOps 2026 Brand Kit):

VOICE & PERSONA:
- Think of AirOps as an easy-going, intelligent, animated friend. Expert, optimistic, and empowering.
- Write with authority from building first-of-their-kind products, but stay warm and human.
- Lead with clarity, empathy, and subtle wit. Talk like a real person. Pass the casual dinner party test.
- Write for one specific reader, not a crowd. Know their struggle, goal, and language.
- Every word must earn its place. After drafting, cut anything that repeats, softens, sounds formal, or takes too many words.

TONE:
- For blog posts use Aspirational tone. For LinkedIn/social use Witty + Clever tone.
- We avoid heavy jargon, doomsday AI language, and corporate stiffness.
- Celebrate community wins and frame AI as a catalyst for creativity, not a threat.

STRUCTURE:
- Open with a bolded "TL;DR" section that summarizes in 4-6 bullet points.
- Use H2/H3 headings framed as questions. Short paragraphs (1-3 sentences).
- Use bullet lists for examples, criteria, and definitions.
- Back claims with concrete data, metrics, and named platforms.
- Lead with business outcomes, not features. Connect claims to board-level metrics.

STRICT WRITING RULES:
- No em dashes. If a sentence needs one, rewrite it. Use a period instead.
- Never start with "In today's world," "In an era where," or similar scene-setting cliches.
- Never use "delve into," "it's worth noting that," or "leveraging." Use: explore, use, tap, apply, connect, build.
- Never use hollow affirmations: "Great question!" "Absolutely!" "Certainly!"
- Avoid "Furthermore," "Moreover," "Additionally." Use natural connective tissue.
- Don't end lists with "and beyond." Name the actual things or cut the list.
- No hedge-everything language. We have a POV. Definitive beats diplomatic.
- Don't open with rhetorical questions you immediately answer. Lead with the answer.
- Never use "X isn't just Y, it's Z" or "It's not about X, it's about Y" constructions.
- Never use: "The truth is...", "The reality is...", "Let that sink in", "Now more than ever."
- Never use: "The best part?", "The secret?", "Here's the thing...", "Let's be honest..."
- Never use faux-dramatic staccato: "No fluff. No filler. Just results."
- No tricolon / rule-of-three parallel fragments.
- No boldface for emphasis in body text. Bold is for structural elements only.
- No "In conclusion" or "In summary." End on a strong final point.
- Use specific numbers and named examples instead of vague claims.
- Sentence case for all headings (except named product features like Brand Kits, Workflows, Grids).
- Use contractions naturally (you're, it's, here's). Serial comma in all lists.
- Active voice throughout. Prefer short, direct sentences.
- Use "Content Engineer" and "Content Engineering" as category language.
- Use "AEO" not "AI SEO" or "AI search visibility." Define acronyms on first use.
- Never use the word "layer" in any context.
- Replace vague claims with concrete specifics backed by data or experience.
- Length: 600-1000 words for a full draft, or a detailed outline if the nugget needs more research`;

// ─── Core: generate drafts via Claude ──────────────────────────────────────

const SYSTEM_PROMPTS = {
  alex: ALEX_SYSTEM_PROMPT,
  airops: AIROPS_BRAND_SYSTEM_PROMPT,
};

function getSystemPrompt(channelName) {
  const key = CHANNEL_PROMPT_MAP[channelName] || 'alex';
  return SYSTEM_PROMPTS[key] || ALEX_SYSTEM_PROMPT;
}

async function generateDrafts(postIdea, systemPrompt) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: `Here is the post idea from the team:\n\n"${postIdea}"\n\nPlease write the LinkedIn post and blog draft. Return only valid JSON, no markdown fences, no preamble.`,
      },
    ],
  });

  const raw = message.content.find((b) => b.type === 'text')?.text || '{}';
  // Strip any accidental markdown fences
  const clean = raw.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ─── Helper: split text into Notion paragraph blocks (max 2000 chars each) ──

function textToBlocks(text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: text.slice(i, i + 2000) } }],
      },
    });
  }
  return chunks;
}

// ─── Core: append drafts to Notion page as a toggle heading ─────────────────

async function appendToNotionPage(title, linkedinPost, blogDraft, originalMessage, pageId) {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Create a toggle heading with the date and title, containing the drafts inside
  await notion.blocks.children.append({
    block_id: pageId,
    children: [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          is_toggleable: true,
          rich_text: [{ type: 'text', text: { content: `${today} - ${title}` } }],
          children: [
            {
              object: 'block',
              type: 'heading_3',
              heading_3: {
                rich_text: [{ type: 'text', text: { content: 'Original nugget' } }],
              },
            },
            {
              object: 'block',
              type: 'quote',
              quote: {
                rich_text: [{ type: 'text', text: { content: originalMessage.slice(0, 2000) } }],
              },
            },
            {
              object: 'block',
              type: 'divider',
              divider: {},
            },
            {
              object: 'block',
              type: 'heading_3',
              heading_3: {
                rich_text: [{ type: 'text', text: { content: 'LinkedIn post draft' } }],
              },
            },
            ...textToBlocks(linkedinPost),
            {
              object: 'block',
              type: 'divider',
              divider: {},
            },
            {
              object: 'block',
              type: 'heading_3',
              heading_3: {
                rich_text: [{ type: 'text', text: { content: 'Blog draft' } }],
              },
            },
            ...textToBlocks(blogDraft),
          ],
        },
      },
    ],
  });

  const notionUrl = `https://www.notion.so/${pageId.replace(/-/g, '')}`;
  return notionUrl;
}

// ─── Core: queue LinkedIn post in Ordinal ─────────────────────────────────

async function queueOrdinalPost(title, linkedinPost) {
  const res = await fetch('https://app.tryordinal.com/api/posts', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ORDINAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title,
      publishAt: new Date().toISOString(),
      status: 'Finalized',
      linkedIn: {
        profileId: ORDINAL_LINKEDIN_PROFILE_ID,
        copy: linkedinPost,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ordinal API error ${res.status}: ${body}`);
  }

  const post = await res.json();
  return post.id;
}

// ─── Core: send DM to reviewer ──────────────────────────────────────────────

async function sendReviewDM(notionUrl, originalMessage, originalChannelId, originalMessageTs, channelName, drafts) {
  const preview = originalMessage.slice(0, 120) + (originalMessage.length > 120 ? '...' : '');

  const result = await slack.client.chat.postMessage({
    channel: REVIEWER_SLACK_ID,
    text: `*New post idea ready for review* 👀\n\n*Original nugget:*\n> ${preview}\n\n*Drafts in Notion:* ${notionUrl}\n\nReply *approved* to this message to post the link back in #${channelName}.`,
  });

  // Store state so we can act on the "approved" reply
  pendingApprovals.set(result.ts, {
    originalChannelId,
    originalMessageTs,
    notionUrl,
    channelName,
    drafts,
    dmChannelId: result.channel,
  });

  return result.ts;
}

// ─── Slack event: message in watched channels ────────────────────────────────

slack.message(POST_IDEA_REGEX, async ({ message, say, client }) => {
  if (message.bot_id || message.subtype) return;
  if (message.channel_type === 'im') return; // DMs handled separately

  // Confirm we're in a watched channel
  let channelName = 'unknown';
  try {
    const info = await client.conversations.info({ channel: message.channel });
    channelName = info.channel?.name || 'unknown';
    if (!WATCH_CHANNELS.includes(channelName)) return;
  } catch {
    return;
  }

  const postIdea = message.text;
  console.log(`[nuggets-agent] Post idea detected in #${channelName}: "${postIdea.slice(0, 80)}..."`);

  try {
    // 1. Acknowledge in thread
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Hey <@${message.user}>! Thanks for your nugget. Drafting up a post now, hold tight.`,
    });

    // 2. Generate drafts
    const systemPrompt = getSystemPrompt(channelName);
    const drafts = await generateDrafts(postIdea, systemPrompt);
    console.log(`[nuggets-agent] Drafts generated. Title: "${drafts.title}"`);

    // 3. Append to Notion page
    const pageId = getNotionPageId(channelName);
    const notionUrl = await appendToNotionPage(drafts.title, drafts.linkedin_post, drafts.blog_draft, postIdea, pageId);
    console.log(`[nuggets-agent] Notion page updated: ${notionUrl}`);

    // 4. Follow up in thread with the link
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `<@${message.user}> Your post draft is ready! Take a look and give me a thumbs up when approved: ${notionUrl}`,
    });

    // 5. DM reviewer
    await sendReviewDM(notionUrl, postIdea, message.channel, message.ts, channelName, drafts);
    console.log(`[nuggets-agent] DM sent to reviewer.`);
  } catch (err) {
    console.error('[nuggets-agent] Error processing post idea:', err);
  }
});

// ─── Slack event: DM with a post idea ─────────────────────────────────────

slack.message(async ({ message, client }) => {
  if (message.bot_id || message.subtype) return;
  if (message.channel_type !== 'im') return;

  const text = (message.text || '').trim();

  // If this is the reviewer saying "approved", handle that instead
  if (message.user === REVIEWER_SLACK_ID && text.toLowerCase().includes('approved')) {
    return handleApproval(message, client);
  }

  // Treat any other DM as a post idea
  const postIdea = text;
  if (!postIdea) return;

  console.log(`[nuggets-agent] Post idea via DM from ${message.user}: "${postIdea.slice(0, 80)}..."`);

  try {
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: 'Got it, generating drafts...',
    });

    const drafts = await generateDrafts(postIdea, ALEX_SYSTEM_PROMPT);
    console.log(`[nuggets-agent] Drafts generated. Title: "${drafts.title}"`);

    const notionUrl = await appendToNotionPage(drafts.title, drafts.linkedin_post, drafts.blog_draft, postIdea, DEFAULT_NOTION_PAGE_ID);
    console.log(`[nuggets-agent] Notion page updated: ${notionUrl}`);

    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Drafts are ready: ${notionUrl}`,
    });

    // Also send to reviewer for approval
    const preview = postIdea.slice(0, 120) + (postIdea.length > 120 ? '...' : '');
    const result = await slack.client.chat.postMessage({
      channel: REVIEWER_SLACK_ID,
      text: `*New post idea ready for review* 👀\n\n*Submitted via DM by <@${message.user}>*\n\n*Original nugget:*\n> ${preview}\n\n*Drafts in Notion:* ${notionUrl}\n\nReply *approved* to this message to notify them.`,
    });

    pendingApprovals.set(result.ts, {
      originalChannelId: message.channel,
      originalMessageTs: message.ts,
      notionUrl,
      channelName: null,
      submitterUserId: message.user,
      drafts,
      dmChannelId: result.channel,
    });

    console.log(`[nuggets-agent] DM sent to reviewer.`);
  } catch (err) {
    console.error('[nuggets-agent] Error processing DM post idea:', err);
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: 'Something went wrong generating drafts. Please try again.',
    });
  }
});

// ─── Approval handler ─────────────────────────────────────────────────────

async function handleApproval(message, client) {
  const threadTs = message.thread_ts || null;

  let approval = null;
  let approvalKey = null;

  if (threadTs && pendingApprovals.has(threadTs)) {
    approval = pendingApprovals.get(threadTs);
    approvalKey = threadTs;
  } else {
    for (const [key, val] of pendingApprovals.entries()) {
      if (val.dmChannelId === message.channel) {
        approval = val;
        approvalKey = key;
        break;
      }
    }
  }

  if (!approval) {
    console.log('[nuggets-agent] Received "approved" but no matching pending approval found.');
    return;
  }

  try {
    // Queue the LinkedIn post in Ordinal
    let ordinalNote = '';
    if (ORDINAL_API_KEY && approval.drafts) {
      try {
        const ordinalId = await queueOrdinalPost(approval.drafts.title, approval.drafts.linkedin_post);
        console.log(`[nuggets-agent] Queued in Ordinal: ${ordinalId}`);
        ordinalNote = '\nLinkedIn post queued in Ordinal.';
      } catch (err) {
        console.error('[nuggets-agent] Ordinal error (non-blocking):', err.message);
        ordinalNote = '\n⚠️ Failed to queue in Ordinal.';
      }
    }

    if (approval.channelName) {
      await client.chat.postMessage({
        channel: approval.originalChannelId,
        thread_ts: approval.originalMessageTs,
        text: `Drafts are ready in Notion: ${approval.notionUrl}`,
      });

      await client.chat.postMessage({
        channel: REVIEWER_SLACK_ID,
        thread_ts: threadTs || undefined,
        text: `Done! Link posted to #${approval.channelName} 👍${ordinalNote}`,
      });

      console.log(`[nuggets-agent] Posted Notion link to #${approval.channelName} thread.`);
    } else {
      await client.chat.postMessage({
        channel: approval.originalChannelId,
        thread_ts: approval.originalMessageTs,
        text: `Your post idea has been approved! 🎉 Notion link: ${approval.notionUrl}`,
      });

      await client.chat.postMessage({
        channel: REVIEWER_SLACK_ID,
        thread_ts: threadTs || undefined,
        text: `Done! <@${approval.submitterUserId}> has been notified 👍${ordinalNote}`,
      });

      console.log(`[nuggets-agent] Notified DM submitter ${approval.submitterUserId}.`);
    }

    pendingApprovals.delete(approvalKey);
  } catch (err) {
    console.error('[nuggets-agent] Error posting approved link:', err);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

(async () => {
  await slack.start();
  console.log('⚡ Nuggets agent is running');
})();
