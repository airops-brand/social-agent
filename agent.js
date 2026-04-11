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
const fs = require('fs');
const path = require('path');

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
const ORDINAL_APPROVER_USER_ID = process.env.ORDINAL_APPROVER_USER_ID || 'a32a8b1b-7218-4ca6-bd50-f4649694e1bb'; // Jessica Rosenberg

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

// Matches Notion URLs in message text
const NOTION_URL_REGEX = /https?:\/\/(?:www\.)?notion\.(?:so|site)\/(?:[^\/]+\/)?([a-f0-9]{32}|[a-f0-9-]{36})/gi;

// Marker that identifies a Workflow Builder form submission
const FORM_MARKER = 'social post request';

// Valid post types for the form dropdown
const POST_TYPES = ['product launch', 'research / data', 'event / activation', 'thought leadership', 'customer story', 'cultural / team'];

// ─── Clients ───────────────────────────────────────────────────────────────

const slack = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN, // required for socket mode
});

const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Notion content fetching ───────────────────────────────────────────────

function extractNotionPageIds(text) {
  const ids = [];
  let match;
  const regex = new RegExp(NOTION_URL_REGEX.source, 'gi');
  while ((match = regex.exec(text)) !== null) {
    let id = match[1].replace(/-/g, '');
    // Format as UUID
    if (id.length === 32) {
      id = `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
    }
    ids.push(id);
  }
  return ids;
}

function blockToText(block) {
  const richTextFields = ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item', 'quote', 'callout', 'toggle'];
  for (const field of richTextFields) {
    if (block.type === field && block[field]?.rich_text) {
      const text = block[field].rich_text.map((t) => t.plain_text).join('');
      if (field.startsWith('heading')) return `\n## ${text}\n`;
      if (field === 'bulleted_list_item') return `- ${text}`;
      if (field === 'numbered_list_item') return `1. ${text}`;
      if (field === 'quote') return `> ${text}`;
      return text;
    }
  }
  return '';
}

async function fetchNotionPageContent(pageId) {
  try {
    const page = await notion.pages.retrieve({ page_id: pageId });
    const titleProp = Object.values(page.properties).find((p) => p.type === 'title');
    const title = titleProp?.title?.map((t) => t.plain_text).join('') || 'Untitled';

    const blocks = await notion.blocks.children.list({ block_id: pageId, page_size: 100 });
    const content = blocks.results.map(blockToText).filter(Boolean).join('\n');

    return { title, content: content.slice(0, 8000) }; // cap to avoid token overflow
  } catch (err) {
    console.error(`[nuggets-agent] Failed to fetch Notion page ${pageId}:`, err.message);
    return null;
  }
}

// ─── Form submission parsing ──────────────────────────────────────────────

function parseFormSubmission(text) {
  const fields = {};
  const lines = text.split('\n');

  let currentField = null;
  let currentValue = [];

  for (const line of lines) {
    // Match bold field labels: *Field:* or **Field:** or *Field* or **Field**
    const fieldMatch = line.match(/^\*{1,2}([^*]+?):?\*{1,2}\s*(.*)/);
    if (fieldMatch) {
      if (currentField) {
        fields[currentField] = currentValue.join('\n').trim();
      }
      currentField = fieldMatch[1].trim().toLowerCase();
      currentValue = fieldMatch[2] ? [fieldMatch[2]] : [];
    } else if (currentField && line.trim()) {
      currentValue.push(line);
    }
  }

  if (currentField) {
    fields[currentField] = currentValue.join('\n').trim();
  }

  console.log('[nuggets-agent] Parsed form fields:', JSON.stringify(fields));
  return fields;
}

function buildFormPrompt(fields) {
  const topic = fields["what is the post's topic"] || fields.topic || fields['post topic'] || '';
  const postType = fields['post type'] || fields.type || '';
  const context = fields['context / brief'] || fields.context || fields.brief || '';
  const audience = fields['target audience'] || fields.audience || '';
  const imageDesc = fields["if you don't already have a post image"] || fields['image description'] || '';
  const notionLink = fields['notion link'] || fields['notion url'] || '';

  let prompt = 'Write a LinkedIn post based on this request:\n\n';
  if (topic) prompt += `TOPIC: ${topic}\n`;
  if (postType) prompt += `POST TYPE: ${postType}\n`;
  if (context) prompt += `CONTEXT: ${context}\n`;
  if (audience) prompt += `TARGET AUDIENCE: ${audience}\n`;
  if (imageDesc) prompt += `IMAGE NOTES: ${imageDesc}\n`;

  const allText = Object.values(fields).join(' ') + ' ' + notionLink;

  prompt += '\nPlease write the LinkedIn post and blog draft based on the above. Return only valid JSON, no markdown fences, no preamble.';
  return { prompt, notionLink, allText };
}

// ─── Persistent state ──────────────────────────────────────────────────────

const STATE_DIR = process.env.STATE_DIR || '/data';
const STATE_FILE = path.join(STATE_DIR, 'approvals.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      console.log(`[startup] Loaded ${Object.keys(data.approvals || {}).length} pending approval(s) from disk`);
      return data;
    }
  } catch (err) {
    console.error('[startup] Failed to load state, starting fresh:', err.message);
  }
  return { approvals: {}, reactions: {} };
}

function saveState() {
  try {
    // Ensure directory exists
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
    const data = {
      approvals: Object.fromEntries(pendingApprovals),
      reactions: Object.fromEntries(reactionApprovalMap),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[state] Failed to save state:', err.message);
  }
}

const savedState = loadState();
const pendingApprovals = new Map(Object.entries(savedState.approvals || {}));
const reactionApprovalMap = new Map(Object.entries(savedState.reactions || {}));

// Channel → system prompt overrides
const CHANNEL_PROMPT_MAP = {};
(process.env.CHANNEL_PROMPT_MAP || '').split(',').filter(Boolean).forEach((entry) => {
  const [ch, promptKey] = entry.split(':').map((s) => s.trim());
  CHANNEL_PROMPT_MAP[ch.replace(/^#/, '')] = promptKey;
});

// ─── AirOps Brand System Prompt ────────────────────────────────────────────

const AIROPS_BRAND_SYSTEM_PROMPT = `You are writing LinkedIn posts for the AirOps brand company page (@airopshq). Not a personal brand. Institutional but never corporate. The smartest voice in the category, sharing what it actually knows.

AirOps is a content operations and precision marketing platform focused on AI search performance, Answer Engine Optimization (AEO), and Content Engineering.

Return your response as valid JSON with this exact shape:
{
  "title": "short title summarising the topic (used as Notion page name)",
  "linkedin_post": "the full linkedin post text",
  "blog_draft": "a blog post draft expanding on the same idea in markdown"
}

BRAND PERSONA:
AirOps is the easy-going, intelligent friend who shows up early with coffee and immediately starts talking about something interesting. They move fluently between deep technical topics and stories that make you laugh. They don't hoard knowledge. They share what they know so the people around them become more capable. On LinkedIn: a brand that writes from genuine expertise, shares real research, and positions Content Engineers as the smart professionals who win in the new search landscape.

VOICE (constant):
- Expert: Back every claim with data, research, or named platforms. AirOps has done the work. Show it.
- Optimistic: AI search is an opportunity. Content Engineers who understand AEO will win. Never doomsday.
- Empowering: The reader is capable. AirOps makes them more so. Frame the product as the vehicle for their success.
- Direct: First line, first claim. No preamble. No throat-clearing.
- Human: Write like a smart person talking to another smart person. Not a press release.

TONE (flexes by context):
- Functional + Data Driven: for research findings, product announcements, data-backed claims. Lead with the stat. Specific numbers. Short sentences. No hedging.
- Empowering: for thought leadership, event promotion, cultural posts, customer stories. Confident, declarative. Second-person. Outcomes over features.
- Witty + Clever: designated LinkedIn mode. Crisp, confident, with room for a well-placed aside or unexpected word choice. Not jokes for the sake of jokes. The wit surfaces when the moment earns it.

PRIMARY AUDIENCES:
Content Engineers (growth + content marketers, SEO leads, content ops), Content Directors and Heads of Content, VP Marketing / CMO at mid-market to enterprise, agency leads managing content at scale.

POST TYPES:
- Research / Data: lead with the stat.
- Product launch: lead with the outcome, not the feature.
- Event / Activation: strong declarative + urgency, lead with what attendees will leave with.
- Thought leadership: contrarian or bold claim.
- Customer story: lead with the result.
- Cultural / Team: human-first, first-person plural.

HOOK FORMULAS:
- Data hook: lead with a specific finding or stat.
- Outcome hook: [customer/group] who did X saw [specific result].
- Declarative hook: direct strong claim.
- Contrarian hook: [common belief] is wrong. Here's the data.
- Event hook: [Event] is [X days away]. Here's what you'll leave with.

PROVEN FORMATS:
- Tension hook: provocative claim in line 1, confirmed/denied in 1-5 words, then the data. Best for research.
- Bold claim opener: result first, "Here's how [Customer] did it." Best for customer stories.
- Declarative ship: "[Feature] is now live." then the problem it solves. Best for product launches.
BANNED: "BREAKING //", "NEW //", "JUST DROPPED", "TLDR;" openers.

APPROVED POSITIONING PHRASES (adapt, don't repeat verbatim):
"AirOps is where big ideas become real results." / "Bring the value. Earn the visibility." / "If AI can't find you, neither can your customers." / "Quality content is the only durable strategy." / "Content Engineering is the new SEO." / "The brands winning AI search aren't getting lucky. They're engineering it."

WHAT WE SOUND LIKE:
Do: "After 5.5M LLM answers reviewed, the pattern is clear." / "Three traits keep showing up in brands getting cited." / "If AI can't find you, neither can your customers." / "Register below. Spots are limited." / State the claim. Let it stand.
Don't: "We're excited to announce our groundbreaking new research!" / "In today's fast-paced digital landscape, brands must leverage..." / "The brands winning AI search aren't doing X. They're doing Y." / Set up a foil, then knock it down.

LINKEDIN-SPECIFIC WRITING RULES:
1. Hook line must be 1-2 sentences max and stand alone before "see more." Write it first. If it doesn't compel a click without context, rewrite it.
2. Never put the URL in the post body. Always in the first comment. Reference as "Link in comments."
3. Sentence case throughout all post copy and hashtags. Never title case.
4. No em dashes. Use a period or a line break instead.
5. Emojis are chapter markers, not decoration. Max 3-4 per post. Preferred: ↓ → ✦ 📊 🔍 📍 📅. Never: 🙌 💪 🚀 or emoji strings.
6. Hashtags: 3-5 max, placed at the end. Preferred: #ContentEngineering #AEO #AISearch #ContentMarketing #SEO
7. Never use "BREAKING //", "NEW //", "JUST DROPPED", or "TLDR;" as openers.
8. Never use contrast/pivot constructions. Banned: "The [group] pulling ahead are...", "This isn't X. It's Y.", "[Noun] is table stakes. [Other noun] is the advantage.", "Most [group] are doing X. The ones winning are doing Y." State claims directly.
9. Never open posts or comments with affirmation: "Love this", "Great point", "So important", "100%". Start with substance.
10. Category language is non-negotiable: "Content Engineering" always capitalized, "Content Engineer" always capitalized, "AEO" not "AI SEO" or "LLM SEO", "Citations" not "mentions". Product names always capitalized: AirOps, Page360, Brand Kit, Citations360, Offsite.
11. Oxford comma always. "ChatGPT, Gemini, and Perplexity" never "ChatGPT, Gemini and Perplexity".
12. No exclamation points unless genuinely earned (rare).
13. CTAs are short imperatives only. "See how." / "Link in comments." / "Read the research." / "Register below." Never: "Click here to learn more", "Check it out", "Don't miss this".

BLOG DRAFT RULES:
- Open with a bolded "TL;DR" section that summarizes in 4-6 bullet points.
- Use H2/H3 headings framed as questions. Short paragraphs (1-3 sentences).
- Lead with business outcomes, not features. Connect claims to board-level metrics.
- Sentence case for all headings (except named product features like Brand Kits, Workflows, Grids).
- No em dashes. Active voice throughout.
- Back claims with concrete data, metrics, and named platforms.
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

async function generateDrafts(postIdea, systemPrompt, notionContext, customPrompt) {
  let userContent = customPrompt || `Here is the post idea from the team:\n\n"${postIdea}"`;

  if (notionContext && notionContext.length > 0) {
    // Insert Notion context before the final instruction line
    const parts = userContent.split('\nPlease write the LinkedIn post');
    userContent = parts[0];
    userContent += '\n\nThe following Notion pages were shared as additional context:\n';
    for (const doc of notionContext) {
      userContent += `\n--- "${doc.title}" ---\n${doc.content}\n`;
    }
    if (parts[1]) {
      userContent += '\nPlease write the LinkedIn post' + parts[1];
    } else {
      userContent += '\n\nPlease write the LinkedIn post and blog draft. Return only valid JSON, no markdown fences, no preamble.';
    }
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: userContent,
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

// ─── Core: Ordinal MCP helper ─────────────────────────────────────────────

async function ordinalMcpCall(toolName, args) {
  const res = await fetch('https://app.tryordinal.com/api/mcp', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ORDINAL_API_KEY}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  const raw = await res.text();
  // Parse SSE response
  for (const line of raw.split('\n')) {
    if (line.startsWith('data: ')) {
      const data = JSON.parse(line.slice(6));
      if (data.error) throw new Error(`Ordinal MCP error: ${JSON.stringify(data.error)}`);
      const text = data.result?.content?.[0]?.text;
      return text ? JSON.parse(text) : data.result;
    }
  }
  throw new Error('No response from Ordinal MCP');
}

// ─── Core: upload image to Ordinal ────────────────────────────────────────

async function uploadToOrdinal(slackFileUrl) {
  // Make Slack file public so Ordinal can download it
  // Extract file ID from the URL and make it public
  const slackRes = await fetch(slackFileUrl, {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
    redirect: 'follow',
  });

  if (!slackRes.ok) {
    throw new Error(`Failed to access Slack file: ${slackRes.status}`);
  }

  // Ordinal needs a public URL - use Slack's public sharing
  // For now, try passing the private URL with redirect (Ordinal may follow it)
  // If that fails, we'd need to re-host the file
  const upload = await ordinalMcpCall('uploads-create', { url: slackFileUrl });
  const uploadId = upload.id;

  // Poll for completion
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await ordinalMcpCall('uploads-get', { id: uploadId });
    if (status.assetId) return status.assetId;
    if (status.status === 'ready' && status.assetId) return status.assetId;
    if (status.status === 'failed') throw new Error('Ordinal upload failed');
  }

  throw new Error('Ordinal upload timed out');
}

// ─── Core: extract Slack file URLs from message ──────────────────────────

function getSlackFileUrls(message) {
  if (!message.files || message.files.length === 0) return [];
  return message.files
    .filter((f) => f.mimetype && f.mimetype.startsWith('image/'))
    .map((f) => f.url_private);
}

// ─── Core: queue LinkedIn post in Ordinal ─────────────────────────────────

async function queueOrdinalPost(title, linkedinPost, assetIds) {
  const args = {
    title,
    publishAt: new Date().toISOString(),
    status: 'Finalized',
    linkedIn: {
      profileId: ORDINAL_LINKEDIN_PROFILE_ID,
      copy: linkedinPost,
    },
  };

  if (assetIds && assetIds.length > 0) {
    args.linkedIn.assetIds = assetIds;
  }

  const post = await ordinalMcpCall('posts-create', args);

  // Assign approval to Jessica
  try {
    await ordinalMcpCall('approvals-create', {
      postId: post.id,
      approvals: [{
        userId: ORDINAL_APPROVER_USER_ID,
        message: 'Auto-assigned from Slack social agent',
        isBlocking: true,
      }],
    });
    console.log(`[nuggets-agent] Ordinal approval assigned to Jessica for post ${post.id}`);
  } catch (err) {
    console.error('[nuggets-agent] Failed to create Ordinal approval (non-blocking):', err.message);
  }

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
  saveState();

  return result.ts;
}

// ─── Slack event: Workflow Builder form submission ────────────────────────────

slack.event('message', async ({ event, client }) => {
  const message = event;

  // Only handle bot messages (from Workflow Builder) in watched channels
  if (!message.bot_id && !message.subtype) return;
  if (message.channel_type === 'im') return;

  const text = (message.text || '');
  const botName = (message.username || message.bot_profile?.name || '').toLowerCase();
  console.log(`[nuggets-agent] Bot message in channel (bot: "${botName}"): "${text.slice(0, 80)}..."`);
  if (!text.toLowerCase().includes(FORM_MARKER) && !botName.includes(FORM_MARKER)) return;

  // Confirm we're in a watched channel
  let channelName = 'unknown';
  try {
    const info = await client.conversations.info({ channel: message.channel });
    channelName = info.channel?.name || 'unknown';
    if (!WATCH_CHANNELS.includes(channelName)) return;
  } catch {
    return;
  }

  console.log(`[nuggets-agent] Form submission detected in #${channelName}`);

  const fields = parseFormSubmission(message.text);
  const { prompt: formPrompt, allText } = buildFormPrompt(fields);
  const imageFiles = getSlackFileUrls(message);

  try {
    // 1. Acknowledge
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: imageFiles.length > 0
        ? `Got your request and ${imageFiles.length} image(s)! Generating a post draft now, hold tight.`
        : 'Got your request! Generating a post draft now, hold tight.',
    });

    // 2. Fetch any linked Notion pages
    const notionPageIds = extractNotionPageIds(allText);
    const notionContext = [];
    for (const pid of notionPageIds) {
      const doc = await fetchNotionPageContent(pid);
      if (doc) notionContext.push(doc);
    }

    // 3. Generate drafts with structured form data
    const systemPrompt = getSystemPrompt(channelName);
    console.log(`[nuggets-agent] Form prompt:\n${formPrompt}`);
    console.log(`[nuggets-agent] Using system prompt for: ${CHANNEL_PROMPT_MAP[channelName] || 'alex (default)'}`);
    const drafts = await generateDrafts(message.text, systemPrompt, notionContext, formPrompt);
    console.log(`[nuggets-agent] Drafts generated. Title: "${drafts.title}"`);

    // 4. Append to Notion page
    const topic = fields["what is the post's topic"] || fields.topic || fields['post topic'] || 'Untitled';
    const context = fields['context / brief'] || fields.context || '';
    const originalSummary = context ? `${topic}: ${context}` : topic;

    const pageId = getNotionPageId(channelName);
    const notionUrl = await appendToNotionPage(drafts.title, drafts.linkedin_post, drafts.blog_draft, originalSummary, pageId);
    console.log(`[nuggets-agent] Notion page updated: ${notionUrl}`);

    // 5. Follow up in thread
    const followUp = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `Post draft is ready! Take a look and give me a 👍 when approved: ${notionUrl}`,
    });

    // 6. DM reviewer
    const dmTs = await sendReviewDM(notionUrl, originalSummary, message.channel, message.ts, channelName, drafts);
    console.log(`[nuggets-agent] DM sent to reviewer.`);

    // Store image URLs on the pending approval for Ordinal upload on approve
    if (imageFiles.length > 0) {
      const pending = pendingApprovals.get(dmTs);
      if (pending) pending.imageFiles = imageFiles;
    }

    // 7. Map for thumbs-up approval
    reactionApprovalMap.set(`${message.channel}:${followUp.ts}`, dmTs);
    reactionApprovalMap.set(`${message.channel}:${message.ts}`, dmTs);
    saveState();
  } catch (err) {
    console.error('[nuggets-agent] Error processing form submission:', err);
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: 'Something went wrong generating the draft. Please try again.',
    });
  }
});

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

    // 2. Fetch any linked Notion pages for context
    const notionPageIds = extractNotionPageIds(postIdea);
    const notionContext = [];
    for (const pid of notionPageIds) {
      const doc = await fetchNotionPageContent(pid);
      if (doc) notionContext.push(doc);
    }
    if (notionContext.length > 0) {
      console.log(`[nuggets-agent] Fetched ${notionContext.length} Notion page(s) for context`);
    }

    // 3. Generate drafts
    const systemPrompt = getSystemPrompt(channelName);
    const drafts = await generateDrafts(postIdea, systemPrompt, notionContext);
    console.log(`[nuggets-agent] Drafts generated. Title: "${drafts.title}"`);

    // 4. Append to Notion page
    const pageId = getNotionPageId(channelName);
    const notionUrl = await appendToNotionPage(drafts.title, drafts.linkedin_post, drafts.blog_draft, postIdea, pageId);
    console.log(`[nuggets-agent] Notion page updated: ${notionUrl}`);

    // 5. Follow up in thread with the link
    const followUp = await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `<@${message.user}> Your post draft is ready! Take a look and give me a 👍 when approved: ${notionUrl}`,
    });

    // 6. DM reviewer
    const dmTs = await sendReviewDM(notionUrl, postIdea, message.channel, message.ts, channelName, drafts);
    console.log(`[nuggets-agent] DM sent to reviewer.`);

    // 7. Map the follow-up message for thumbs-up reaction matching
    reactionApprovalMap.set(`${message.channel}:${followUp.ts}`, dmTs);
    // Also map the original message in case they react to that
    reactionApprovalMap.set(`${message.channel}:${message.ts}`, dmTs);
    saveState();
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

    const notionPageIds = extractNotionPageIds(postIdea);
    const notionContext = [];
    for (const pid of notionPageIds) {
      const doc = await fetchNotionPageContent(pid);
      if (doc) notionContext.push(doc);
    }

    const drafts = await generateDrafts(postIdea, ALEX_SYSTEM_PROMPT, notionContext);
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
    saveState();

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

// ─── Slack event: thumbs-up reaction from reviewer ────────────────────────

slack.event('reaction_added', async ({ event, client }) => {
  if (event.user !== REVIEWER_SLACK_ID) return;
  if (event.reaction !== '+1' && event.reaction !== 'thumbsup') return;

  const key = `${event.item.channel}:${event.item.ts}`;
  const dmTs = reactionApprovalMap.get(key);
  if (!dmTs || !pendingApprovals.has(dmTs)) return;

  console.log(`[nuggets-agent] Thumbs-up approval from reviewer on ${key}`);

  const approval = pendingApprovals.get(dmTs);
  const fakeMessage = {
    channel: approval.dmChannelId,
    thread_ts: dmTs,
    user: REVIEWER_SLACK_ID,
  };

  await handleApproval(fakeMessage, client);
  reactionApprovalMap.delete(key);
  saveState();
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
    // Upload images to Ordinal (if any), then queue the post
    let ordinalNote = '';
    if (ORDINAL_API_KEY && approval.drafts) {
      try {
        // Upload any attached images first
        const assetIds = [];
        if (approval.imageFiles && approval.imageFiles.length > 0) {
          for (const fileUrl of approval.imageFiles) {
            try {
              const assetId = await uploadToOrdinal(fileUrl);
              if (assetId) assetIds.push(assetId);
              console.log(`[nuggets-agent] Uploaded image to Ordinal: ${assetId}`);
            } catch (err) {
              console.error('[nuggets-agent] Image upload error (non-blocking):', err.message);
            }
          }
        }

        const ordinalId = await queueOrdinalPost(approval.drafts.title, approval.drafts.linkedin_post, assetIds);
        console.log(`[nuggets-agent] Queued in Ordinal: ${ordinalId}`);
        ordinalNote = assetIds.length > 0
          ? `\nLinkedIn post queued in Ordinal with ${assetIds.length} image(s).`
          : '\nLinkedIn post queued in Ordinal.';
      } catch (err) {
        console.error('[nuggets-agent] Ordinal error (non-blocking):', err.message);
        ordinalNote = '\n⚠️ Failed to queue in Ordinal.';
      }
    }

    if (approval.channelName) {
      await client.chat.postMessage({
        channel: approval.originalChannelId,
        thread_ts: approval.originalMessageTs,
        text: `Whoohoo! Getting this queued up in Ordinal.${ordinalNote}`,
      });

      console.log(`[nuggets-agent] Approval confirmed in #${approval.channelName} thread.`);
    } else {
      await client.chat.postMessage({
        channel: approval.originalChannelId,
        thread_ts: approval.originalMessageTs,
        text: `Whoohoo! Getting this queued up in Ordinal.${ordinalNote}`,
      });

      console.log(`[nuggets-agent] Notified DM submitter ${approval.submitterUserId}.`);
    }

    pendingApprovals.delete(approvalKey);

    // Clean up reaction map entries pointing to this approval
    for (const [rKey, rVal] of reactionApprovalMap.entries()) {
      if (rVal === approvalKey) reactionApprovalMap.delete(rKey);
    }
    saveState();
  } catch (err) {
    console.error('[nuggets-agent] Error posting approved link:', err);
  }
}

// ─── Start ──────────────────────────────────────────────────────────────────

(async () => {
  await slack.start();
  console.log('⚡ Nuggets agent is running');
})();
