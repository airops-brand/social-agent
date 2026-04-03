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
const NOTION_PAGE_ID = '3371f419db8a810ab58addb600085f6c';
const NUGGETS_CHANNEL_NAME = '0-nuggets'; // channel to watch (without #)

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

BLOG DRAFT RULES:
- Write in AirOps brand voice: Direct, Sharp, Expert, Human
- Lead with outcomes, not features
- Use "AEO" not "AI SEO" or "AI search visibility"
- Sentence case for all headlines
- No em dashes
- Active voice throughout
- Structure: strong intro hook, problem framing, solution/insight, concrete examples or data, clear close
- Length: 600-1000 words for a full draft, or a detailed outline if the nugget needs more research`;

// ─── Core: generate drafts via Claude ──────────────────────────────────────

async function generateDrafts(postIdea) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: ALEX_SYSTEM_PROMPT,
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

async function appendToNotionPage(title, linkedinPost, blogDraft, originalMessage) {
  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  // Create a toggle heading with the date and title, containing the drafts inside
  await notion.blocks.children.append({
    block_id: NOTION_PAGE_ID,
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

  const notionUrl = `https://www.notion.so/${NOTION_PAGE_ID.replace(/-/g, '')}`;
  return notionUrl;
}

// ─── Core: send DM to reviewer ──────────────────────────────────────────────

async function sendReviewDM(notionUrl, originalMessage, originalChannelId, originalMessageTs) {
  const preview = originalMessage.slice(0, 120) + (originalMessage.length > 120 ? '...' : '');

  const result = await slack.client.chat.postMessage({
    channel: REVIEWER_SLACK_ID,
    text: `*New post idea ready for review* 👀\n\n*Original nugget:*\n> ${preview}\n\n*Drafts in Notion:* ${notionUrl}\n\nReply *approved* to this message to post the link back in #0-nuggets.`,
  });

  // Store state so we can act on the "approved" reply
  pendingApprovals.set(result.ts, {
    originalChannelId,
    originalMessageTs,
    notionUrl,
    dmChannelId: result.channel,
  });

  return result.ts;
}

// ─── Slack event: message in #0-nuggets ────────────────────────────────────

slack.message(POST_IDEA_REGEX, async ({ message, say, client }) => {
  // Ignore bot messages and messages already in threads
  if (message.bot_id || message.subtype) return;

  // Confirm we're in the right channel
  try {
    const info = await client.conversations.info({ channel: message.channel });
    if (info.channel?.name !== NUGGETS_CHANNEL_NAME) return;
  } catch {
    // If we can't verify channel name, proceed anyway
  }

  const postIdea = message.text;
  console.log(`[nuggets-agent] Post idea detected: "${postIdea.slice(0, 80)}..."`);

  try {
    // 1. Acknowledge in thread
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Hey <@${message.user}>! Thanks for your nugget. Drafting up a post now, hold tight.`,
    });

    // 2. Generate drafts
    const { title, linkedin_post, blog_draft } = await generateDrafts(postIdea);
    console.log(`[nuggets-agent] Drafts generated. Title: "${title}"`);

    // 3. Create Notion page
    const notionUrl = await appendToNotionPage(title, linkedin_post, blog_draft, postIdea);
    console.log(`[nuggets-agent] Notion page created: ${notionUrl}`);

    // 4. Follow up in thread with the link
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `<@${message.user}> Your post draft is ready! Take a look and give me a thumbs up when approved: ${notionUrl}`,
    });

    // 5. DM reviewer
    await sendReviewDM(notionUrl, postIdea, message.channel, message.ts);
    console.log(`[nuggets-agent] DM sent to reviewer.`);

  } catch (err) {
    console.error('[nuggets-agent] Error processing post idea:', err);
  }
});

// ─── Slack event: DM reply — check for "approved" ──────────────────────────

slack.message(async ({ message, client }) => {
  // Only care about DMs from the reviewer
  if (message.bot_id || message.subtype) return;
  if (message.channel_type !== 'im') return;
  if (message.user !== REVIEWER_SLACK_ID) return;

  const text = (message.text || '').trim().toLowerCase();
  if (!text.includes('approved')) return;

  // Find the pending approval this reply belongs to
  // The DM reply will be in a thread off our bot message, or a standalone message
  const threadTs = message.thread_ts || null;
  
  let approval = null;
  let approvalKey = null;

  if (threadTs && pendingApprovals.has(threadTs)) {
    approval = pendingApprovals.get(threadTs);
    approvalKey = threadTs;
  } else {
    // Fall back: find most recent pending approval in this DM channel
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
    // Post Notion link as a thread reply to the original #0-nuggets message
    await client.chat.postMessage({
      channel: approval.originalChannelId,
      thread_ts: approval.originalMessageTs,
      text: `Drafts are ready in Notion: ${approval.notionUrl}`,
    });

    // Clean up
    pendingApprovals.delete(approvalKey);
    console.log(`[nuggets-agent] Posted Notion link to #0-nuggets thread.`);

    // Confirm to reviewer
    await client.chat.postMessage({
      channel: REVIEWER_SLACK_ID,
      thread_ts: threadTs || undefined,
      text: `Done! Link posted to #${NUGGETS_CHANNEL_NAME} 👍`,
    });

  } catch (err) {
    console.error('[nuggets-agent] Error posting approved link:', err);
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

(async () => {
  await slack.start();
  console.log('⚡ Nuggets agent is running');
})();
