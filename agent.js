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

// ─── AirOps docs search ───────────────────────────────────────────────────

async function searchAirOpsDocs(query) {
  try {
    const res = await fetch('https://docs.airops.com/~gitbook/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: 'searchDocumentation', arguments: { query } },
      }),
    });

    const raw = await res.text();
    for (const line of raw.split('\n')) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        const text = data.result?.content?.[0]?.text;
        if (text) {
          // Cap at 3000 chars to avoid blowing up the prompt
          return text.slice(0, 3000);
        }
      }
    }
  } catch (err) {
    console.error('[nuggets-agent] Docs search failed:', err.message);
  }
  return null;
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

  const publishDate = fields['preferred post date'] || fields['post date'] || fields['date'] || '';
  if (publishDate) prompt += `PREFERRED POST DATE: ${publishDate}\n`;

  const allText = Object.values(fields).join(' ') + ' ' + notionLink;

  prompt += '\nPlease write the LinkedIn post and blog draft based on the above. Return only valid JSON, no markdown fences, no preamble.';
  return { prompt, notionLink, allText, publishDate };
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

// DM conversation state: userId → { mode, voice, history[] }
const dmSessions = new Map();

// Voice options with brand kit content type IDs
const VOICE_OPTIONS = {
  airops: { label: 'AirOps Brand', contentTypeId: 23019 },
  alex: { label: 'Alex Halliday', contentTypeId: 23020 },
  christy: { label: 'Christy Roach', contentTypeId: 26745 },
  matt: { label: 'Matt Hammel', contentTypeId: null }, // coming soon
};

// Cache for fetched voice prompts
const voicePromptCache = {};

async function fetchVoicePrompt(voiceKey) {
  if (voicePromptCache[voiceKey]) return voicePromptCache[voiceKey];

  const voice = VOICE_OPTIONS[voiceKey];
  if (!voice || !voice.contentTypeId) return null;

  // For the AirOps brand, use the hardcoded prompt (it has writing rules too)
  if (voiceKey === 'airops') {
    voicePromptCache[voiceKey] = AIROPS_BRAND_SYSTEM_PROMPT;
    return AIROPS_BRAND_SYSTEM_PROMPT;
  }

  // For personal voices, fetch template_outline from the brand kit API
  try {
    const res = await fetch(`https://app.airops.com/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: Date.now(),
        method: 'tools/call',
        params: {
          name: 'get_brand_kit',
          arguments: {
            id: 26564,
            fields: ['content_types.id', 'content_types.name', 'content_types.template_outline'],
            includes: ['content_types'],
          },
        },
      }),
    });
    // This won't work without auth, so fall back to hardcoded prompts
  } catch {}

  // Fall back to hardcoded prompts based on the template_outlines we already fetched
  if (voiceKey === 'alex') {
    voicePromptCache[voiceKey] = ALEX_SYSTEM_PROMPT;
    return ALEX_SYSTEM_PROMPT;
  }

  if (voiceKey === 'christy') {
    const prompt = buildChristyPrompt();
    voicePromptCache[voiceKey] = prompt;
    return prompt;
  }

  return null;
}

function buildChristyPrompt() {
  return `You are a ghostwriting assistant for Christy Roach, CMO at AirOps.

AirOps is a content operations and precision marketing platform focused on AI search performance, Answer Engine Optimization (AEO), and Content Engineering.

Your job is to write two things given a post idea or nugget of information:
1. A LinkedIn post in Christy's authentic voice
2. A blog post outline or draft expanding on the same idea

Return your response as valid JSON with this exact shape:
{
  "title": "short title summarising the topic (used as Notion page name)",
  "linkedin_post": "the full linkedin post text",
  "blog_draft": "the full blog post content in markdown"
}

CHRISTY'S LINKEDIN VOICE:

TONE: Conversational, confident, and unfiltered. She writes like she's texting a smart friend, not publishing a thought leadership piece. Warmth but zero fluff. Gets to the point and isn't afraid to have an opinion.

SENTENCE STRUCTURE: Short, punchy sentences mixed with longer ones that have a casual, run-on feel. Fragments for emphasis. Rhetorical questions pop up naturally. The rhythm feels spoken, not written.

OPENING HOOKS: Lead with a relatable scenario or a bold claim, never a generic statement. Examples: a cost comparison, a personal habit, or a contrarian take. The first line earns the second line.

SIGNATURE MOVES:
- Personal anecdotes as proof points. She earns credibility through specificity, not titles.
- Numbered lists used sparingly, each item gets a mini-argument.
- Self-aware asides: "Obviously I'm very biased," "Maybe I'm just being grumpy"
- The pivot: relatable moment → opinion → so here's what I'm doing about it.

WHAT SHE AVOIDS:
- No jargon-heavy marketing speak
- No "I'm thrilled to announce"
- No emoji storms
- No AI-polished smoothness. She values typos and real voice over perfection.
- No excessive hedging. When she has a take, she states it.

TOPICS: AI in marketing (practical, not hype), the changing CMO role, in-person connection over remote defaults, doing more with less, authenticity over scale, messy reality of strategy vs. clean frameworks.

CTA STYLE: Soft and genuine. She invites rather than sells. Mentions hiring almost as an afterthought.

VOICE IN ONE LINE: "Smart friend who happens to be a CMO, telling you what's actually working over coffee."

ANTI-PATTERNS:
- No "at scale," "leverage," "robust," "comprehensive," "seamless"
- No corporate preambles
- No emoji as bullet points
- No inspirational closing platitudes
- No hype language ("revolutionary," "groundbreaking," "supercharge")
- No leading with product instead of human experience

BLOG DRAFT RULES:
- Open with a bolded "TL;DR" section, 4-6 bullet points
- Use H2/H3 headings framed as questions. Short paragraphs.
- Lead with business outcomes, not features.
- No em dashes. Active voice throughout.
- Length: 600-1000 words for a full draft, or a detailed outline if the nugget needs more research`;
}

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

// ─── QA review prompt ─────────────────────────────────────────────────────

const QA_SYSTEM_PROMPT = `You are a ruthless copy editor. Review every single sentence for banned patterns. If ANY sentence matches, rewrite it. Be aggressive. When in doubt, rewrite.

SCAN EVERY SENTENCE FOR THESE. If a sentence matches ANY pattern below, rewrite it to state the claim directly.

PATTERN 1 — CONTRAST/PIVOT (most common violation, check hardest):
Any sentence where Group A "isn't/aren't/don't" do X, then Group B does Y. This includes ALL of these shapes:
- "The brands [doing X] aren't [doing Y]. They're [doing Z]."
- "The [group] pulling ahead aren't [X]. They're [Y]."
- "The ones winning are [doing X]."
- "Most teams are [X]. The best teams are [Y]."
- "It's not about [X]. It's about [Y]."
- "This isn't [X]. It's [Y]."
- "[X] isn't [Y]. It's [Z]."
- "[Group] who [X] aren't [Y]. They're [Z]."
- "The winners aren't [X]. They're [Y]."
- "Smart teams don't [X]. They [Y]."
- Any two sentences where the first negates and the second reveals the "real" answer.
FIX: State the positive claim directly. "Content Engineers who understand AEO compound their advantage." Not "They aren't doing X. They're doing Y."

PATTERN 2 — BANNED WORDS (rewrite the sentence to remove the word):
"at scale", "bulk", "governed", "seamless", "robust", "leverage" (as verb), "groundbreaking", "revolutionary", "synergize", "game-changing", "disrupt", "layer" (in any context), "delve into", "it's worth noting", "Furthermore", "Moreover", "Additionally"

PATTERN 3 — EM DASHES:
Any — or -- must be replaced with a period and new sentence.

PATTERN 4 — STACCATO FRAGMENTS:
Three or more short punchy fragments in a row for dramatic effect: "No fluff. No filler. Just results." Rewrite as a normal sentence.

PATTERN 5 — TRICOLON:
Three parallel clauses or phrases that build rhythmically. Rewrite using one or two concrete examples.

PATTERN 6 — CLICHE OPENERS:
"In today's world", "In an era where", "Gone are the days", "The truth is", "The reality is", "Let that sink in", "Now more than ever", "Here's the thing", "Let's be honest", "The best part?", "The secret?"

PATTERN 7 — "AI SEO" or "LLM SEO":
Replace with "AEO"

PATTERN 8 — EXCLAMATION POINTS:
Remove unless genuinely celebratory (rare).

Return valid JSON:
{
  "linkedin_post": "the cleaned post",
  "blog_draft": "the cleaned draft",
  "fixes": ["what you changed"]
}

If nothing needs fixing, return originals with empty fixes array.
Return only valid JSON, no markdown fences, no preamble.`;

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

  // Search AirOps docs for relevant product context
  try {
    const searchQuery = customPrompt
      ? (customPrompt.match(/TOPIC:\s*(.+)/)?.[1] || postIdea).slice(0, 100)
      : postIdea.slice(0, 100);
    const docsContext = await searchAirOpsDocs(searchQuery);
    if (docsContext) {
      console.log(`[nuggets-agent] Found AirOps docs context (${docsContext.length} chars)`);
      userContent += `\n\nRelevant AirOps product documentation for accuracy:\n${docsContext}\n`;
    }
  } catch (err) {
    console.error('[nuggets-agent] Docs search skipped:', err.message);
  }

  if (notionContext && notionContext.length > 0) {
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
  const drafts = JSON.parse(clean);

  // QA review pass - check for banned patterns and rewrite
  try {
    const qaMessage = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      system: QA_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Review this LinkedIn post and blog draft for banned patterns. Fix any violations.\n\nLinkedIn post:\n${drafts.linkedin_post}\n\nBlog draft:\n${drafts.blog_draft}\n\nReturn only valid JSON, no markdown fences, no preamble.`,
        },
      ],
    });

    const qaRaw = qaMessage.content.find((b) => b.type === 'text')?.text || '{}';
    const qaClean = qaRaw.replace(/```json|```/g, '').trim();
    const qa = JSON.parse(qaClean);

    if (qa.fixes && qa.fixes.length > 0) {
      console.log(`[nuggets-agent] QA fixes applied: ${qa.fixes.join('; ')}`);
      drafts.linkedin_post = qa.linkedin_post;
      drafts.blog_draft = qa.blog_draft;
    } else {
      console.log('[nuggets-agent] QA passed, no fixes needed');
    }
  } catch (err) {
    console.error('[nuggets-agent] QA review failed (using original draft):', err.message);
  }

  return drafts;
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

async function uploadToOrdinal(fileId) {
  // Step 1: Get file info
  const fileInfo = await slack.client.files.info({ file: fileId });
  if (!fileInfo.ok) {
    throw new Error(`Failed to get Slack file info: ${fileInfo.error}`);
  }
  const file = fileInfo.file;
  console.log(`[nuggets-agent] Processing file: ${file.name} (${file.mimetype})`);

  // Step 2: Download from Slack using bot token
  const downloadRes = await fetch(file.url_private_download || file.url_private, {
    headers: { 'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}` },
  });
  if (!downloadRes.ok) {
    throw new Error(`Failed to download from Slack: ${downloadRes.status}`);
  }
  const imageBuffer = Buffer.from(await downloadRes.arrayBuffer());

  // Step 3: Upload to Notion as a temporary host (Notion gives us a public S3 URL)
  const tempPage = await notion.pages.create({
    parent: { page_id: DEFAULT_NOTION_PAGE_ID },
    properties: { title: [{ text: { content: `_temp_upload_${Date.now()}` } }] },
  });

  // Upload file as an external block with a data URL won't work, so instead
  // we'll write the file to a temp path and use a different approach.
  // Actually, let's just use Notion's file upload via blocks API.

  // Alternative: upload to tmpfiles.org (free, temporary file hosting)
  const formData = new FormData();
  formData.append('file', new Blob([imageBuffer], { type: file.mimetype }), file.name);

  const tmpRes = await fetch('https://tmpfiles.org/api/v1/upload', {
    method: 'POST',
    body: formData,
  });

  // Clean up temp Notion page
  try { await notion.blocks.delete({ block_id: tempPage.id }); } catch {}

  if (!tmpRes.ok) {
    throw new Error(`Failed to upload to temp host: ${tmpRes.status}`);
  }

  const tmpData = await tmpRes.json();
  // tmpfiles.org returns {"status":"success","data":{"url":"https://tmpfiles.org/12345/image.png"}}
  // Convert to direct download URL
  const tmpUrl = tmpData.data?.url?.replace('tmpfiles.org/', 'tmpfiles.org/dl/') || tmpData.data?.url;
  console.log(`[nuggets-agent] Temp hosted URL: ${tmpUrl}`);

  // Step 4: Upload to Ordinal using the public temp URL
  const upload = await ordinalMcpCall('uploads-create', { url: tmpUrl });
  console.log(`[nuggets-agent] Ordinal upload created: ${JSON.stringify(upload)}`);
  const uploadId = upload.id;

  // Step 5: Poll for completion
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = await ordinalMcpCall('uploads-get', { id: uploadId });
    console.log(`[nuggets-agent] Upload status: ${JSON.stringify(status)}`);
    if (status.assetId) return status.assetId;
    if (status.status === 'ready' && status.assetId) return status.assetId;
    if (status.status === 'failed') throw new Error(`Ordinal upload failed: ${JSON.stringify(status)}`);
  }

  throw new Error('Ordinal upload timed out');
}

// ─── Core: extract Slack file info from message ──────────────────────────

function getSlackFileIds(message) {
  if (!message.files || message.files.length === 0) return [];
  return message.files
    .filter((f) => f.mimetype && f.mimetype.startsWith('image/'))
    .map((f) => f.id);
}

// ─── Core: queue LinkedIn post in Ordinal ─────────────────────────────────

async function queueOrdinalPost(title, linkedinPost, assetIds, publishDate) {
  // Parse the preferred date if provided, default to now
  let publishAt = new Date().toISOString();
  if (publishDate) {
    try {
      const parsed = new Date(publishDate);
      if (!isNaN(parsed.getTime())) {
        // Default to 10am CT if no time specified
        if (!publishDate.includes(':')) {
          parsed.setHours(15, 0, 0, 0); // 10am CT = 15:00 UTC
        }
        publishAt = parsed.toISOString();
      }
    } catch { /* fall back to now */ }
  }

  const args = {
    title,
    publishAt,
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
  const { prompt: formPrompt, allText, publishDate } = buildFormPrompt(fields);
  const imageFiles = getSlackFileIds(message);

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

    // Store image URLs and publish date on the pending approval
    const pending = pendingApprovals.get(dmTs);
    if (pending) {
      if (imageFiles.length > 0) pending.imageFiles = imageFiles;
      if (publishDate) pending.publishDate = publishDate;
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

// ─── Slack event: DM conversations ────────────────────────────────────────

const BRAINSTORM_SYSTEM_PROMPT = `You are Edna, the AirOps social content brainstorming partner. You help marketing teams come up with LinkedIn post ideas for the AirOps brand and its executives.

AirOps is a content operations and precision marketing platform focused on AI search performance, Answer Engine Optimization (AEO), and Content Engineering.

You know the AirOps content pillars for Q2 2026: Customers + Proof Points, Things We Shipped, Product + Use Cases, Space + Industry, Research, Inside AirOps, Event Snippets, Event Promo, Event Recap, Webinar Clips, Webinar Promo, Webinar Recap, Team Interviews, Cohort + Education.

Be conversational, specific, and opinionated. Suggest concrete post ideas with hooks, not vague themes. When the user likes an idea, offer to draft it.

Keep responses concise. 3-5 ideas per round unless asked for more.`;

slack.message(async ({ message, client }) => {
  if (message.bot_id || message.subtype) return;
  if (message.channel_type !== 'im') return;

  const text = (message.text || '').trim();
  if (!text) return;
  const lower = text.toLowerCase();

  // If this is the reviewer saying "approved", handle that
  if (message.user === REVIEWER_SLACK_ID && lower.includes('approved')) {
    return handleApproval(message, client);
  }

  const userId = message.user;
  let session = dmSessions.get(userId);

  // Reset command
  if (lower === 'reset' || lower === 'start over' || lower === 'menu') {
    dmSessions.delete(userId);
    session = null;
  }

  // Help / intro - show menu
  if (!session && (lower === 'help' || lower === 'hi' || lower === 'hello' || lower === 'hey' || lower.includes('what can you do') || lower.includes('who are you') || lower.includes('what do you do') || !session)) {
    // If it's a greeting or no session, show the menu
    if (lower === 'help' || lower === 'hi' || lower === 'hello' || lower === 'hey' || lower.includes('what can you do') || lower.includes('who are you')) {
      dmSessions.delete(userId);
      await client.chat.postMessage({
        channel: message.channel,
        text: `Hey! I'm Edna, the AirOps social post agent. What would you like to do?\n\n*1️⃣ Draft a post* - I'll write a LinkedIn post + blog draft\n*2️⃣ Brainstorm ideas* - Let's ideate on content together\n\nJust reply *1* or *2* (or type "draft" or "brainstorm")`,
      });
      dmSessions.set(userId, { step: 'choose_mode', history: [] });
      return;
    }

    // First message with no session - ask what they want to do
    await client.chat.postMessage({
      channel: message.channel,
      text: `Hey! I'm Edna. What would you like to do?\n\n*1️⃣ Draft a post* - I'll write a LinkedIn post + blog draft\n*2️⃣ Brainstorm ideas* - Let's ideate on content together\n\nReply *1* or *2* (or type "draft" or "brainstorm")`,
    });
    dmSessions.set(userId, { step: 'choose_mode', history: [] });
    return;
  }

  // ─── Step: choose mode ───────────────────────────────────────────
  if (session.step === 'choose_mode') {
    if (lower === '1' || lower.includes('draft')) {
      session.step = 'choose_voice';
      session.mode = 'draft';
      dmSessions.set(userId, session);
      await client.chat.postMessage({
        channel: message.channel,
        text: `Whose voice should I write in?\n\n*1️⃣ AirOps Brand* (@airopshq company page)\n*2️⃣ Alex Halliday* (CEO)\n*3️⃣ Christy Roach* (CMO)\n\nReply *1*, *2*, or *3*`,
      });
      return;
    }

    if (lower === '2' || lower.includes('brainstorm') || lower.includes('ideate')) {
      session.step = 'brainstorming';
      session.mode = 'brainstorm';
      session.history = [];
      dmSessions.set(userId, session);
      await client.chat.postMessage({
        channel: message.channel,
        text: `Let's brainstorm! What area are you thinking about? Give me a theme, topic, upcoming event, product launch, or just tell me what's on your mind and I'll suggest some post ideas.\n\n(Type "draft" anytime to switch to drafting mode, or "reset" to start over)`,
      });
      return;
    }

    // Didn't understand
    await client.chat.postMessage({
      channel: message.channel,
      text: `Reply *1* for drafting or *2* for brainstorming.`,
    });
    return;
  }

  // ─── Step: choose voice ──────────────────────────────────────────
  if (session.step === 'choose_voice') {
    let voiceKey = null;
    if (lower === '1' || lower.includes('airops') || lower.includes('brand')) voiceKey = 'airops';
    else if (lower === '2' || lower.includes('alex')) voiceKey = 'alex';
    else if (lower === '3' || lower.includes('christy')) voiceKey = 'christy';

    if (!voiceKey) {
      await client.chat.postMessage({
        channel: message.channel,
        text: `Reply *1* (AirOps Brand), *2* (Alex), or *3* (Christy)`,
      });
      return;
    }

    session.voice = voiceKey;
    session.step = 'awaiting_idea';
    dmSessions.set(userId, session);

    const voiceLabel = VOICE_OPTIONS[voiceKey].label;
    await client.chat.postMessage({
      channel: message.channel,
      text: `Got it, writing as *${voiceLabel}*. What's the post idea? Give me the topic, context, data points, whatever you've got.\n\n(Paste a Notion link for extra context if you have one)`,
    });
    return;
  }

  // ─── Step: awaiting idea → generate draft ────────────────────────
  if (session.step === 'awaiting_idea') {
    const postIdea = text;
    const voiceKey = session.voice || 'airops';
    const voiceLabel = VOICE_OPTIONS[voiceKey].label;

    console.log(`[nuggets-agent] DM draft request from ${userId} (voice: ${voiceLabel}): "${postIdea.slice(0, 80)}..."`);

    try {
      await client.chat.postMessage({
        channel: message.channel,
        text: `Got it! Drafting in *${voiceLabel}*'s voice now...`,
      });

      const notionPageIds = extractNotionPageIds(postIdea);
      const notionContext = [];
      for (const pid of notionPageIds) {
        const doc = await fetchNotionPageContent(pid);
        if (doc) notionContext.push(doc);
      }

      const systemPrompt = await fetchVoicePrompt(voiceKey);
      const drafts = await generateDrafts(postIdea, systemPrompt || AIROPS_BRAND_SYSTEM_PROMPT, notionContext);
      console.log(`[nuggets-agent] Drafts generated. Title: "${drafts.title}"`);

      const DM_NOTION_PAGE_ID = process.env.DM_NOTION_PAGE_ID || '33b1f419db8a8032aed0f980166410d2';
      const notionUrl = await appendToNotionPage(drafts.title, drafts.linkedin_post, drafts.blog_draft, postIdea, DM_NOTION_PAGE_ID);
      console.log(`[nuggets-agent] Notion page updated: ${notionUrl}`);

      await client.chat.postMessage({
        channel: message.channel,
        text: `Drafts are ready: ${notionUrl}\n\nWant to draft another? Send me another idea, or type "reset" to start over.`,
      });

      // DM reviewer
      const preview = postIdea.slice(0, 120) + (postIdea.length > 120 ? '...' : '');
      const result = await slack.client.chat.postMessage({
        channel: REVIEWER_SLACK_ID,
        text: `*New post idea ready for review* 👀\n\n*Voice:* ${voiceLabel}\n*Submitted via DM by <@${userId}>*\n\n*Original nugget:*\n> ${preview}\n\n*Drafts in Notion:* ${notionUrl}\n\nReply *approved* to this message to queue in Ordinal.`,
      });

      pendingApprovals.set(result.ts, {
        originalChannelId: message.channel,
        originalMessageTs: message.ts,
        notionUrl,
        channelName: null,
        submitterUserId: userId,
        drafts,
        dmChannelId: result.channel,
      });
      saveState();

      // Stay in awaiting_idea so they can draft another with same voice
    } catch (err) {
      console.error('[nuggets-agent] Error processing DM draft:', err);
      await client.chat.postMessage({
        channel: message.channel,
        text: 'Something went wrong generating the draft. Please try again.',
      });
    }
    return;
  }

  // ─── Brainstorm mode ─────────────────────────────────────────────
  if (session.step === 'brainstorming') {
    // Check if they want to switch to drafting
    if (lower === 'draft' || lower.includes('draft that') || lower.includes('write that') || lower.includes('let\'s draft')) {
      session.step = 'choose_voice';
      session.mode = 'draft';
      dmSessions.set(userId, session);
      await client.chat.postMessage({
        channel: message.channel,
        text: `Let's draft it! Whose voice should I write in?\n\n*1️⃣ AirOps Brand* (@airopshq company page)\n*2️⃣ Alex Halliday* (CEO)\n*3️⃣ Christy Roach* (CMO)\n\nReply *1*, *2*, or *3*`,
      });
      return;
    }

    try {
      // Add to conversation history
      session.history.push({ role: 'user', content: text });

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: BRAINSTORM_SYSTEM_PROMPT,
        messages: session.history,
      });

      const reply = response.content.find((b) => b.type === 'text')?.text || 'Hmm, I got stuck. Try again?';
      session.history.push({ role: 'assistant', content: reply });

      // Keep history manageable (last 20 messages)
      if (session.history.length > 20) {
        session.history = session.history.slice(-20);
      }

      dmSessions.set(userId, session);

      await client.chat.postMessage({
        channel: message.channel,
        text: reply + '\n\n_(Type "draft" to write one of these up, or keep brainstorming)_',
      });
    } catch (err) {
      console.error('[nuggets-agent] Brainstorm error:', err);
      await client.chat.postMessage({
        channel: message.channel,
        text: 'Something went wrong. Try again?',
      });
    }
    return;
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
          for (const fileId of approval.imageFiles) {
            try {
              const assetId = await uploadToOrdinal(fileId);
              if (assetId) assetIds.push(assetId);
              console.log(`[nuggets-agent] Uploaded image to Ordinal: ${assetId}`);
            } catch (err) {
              console.error('[nuggets-agent] Image upload error (non-blocking):', err.message);
            }
          }
        }

        const ordinalId = await queueOrdinalPost(approval.drafts.title, approval.drafts.linkedin_post, assetIds, approval.publishDate);
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

// ─── Daily post ideas (9am CT) ────────────────────────────────────────────

const DAILY_IDEAS_PROMPT = `You are Edna, the AirOps social content strategist. Generate 5 LinkedIn post ideas for the AirOps brand account and its executives.

Mix across these categories:
- AI search and AEO trends (what's changing, what brands should know)
- Brand leadership in the age of AI (how brand teams are evolving)
- Content Engineering as a discipline (practical insights)
- AirOps product capabilities (tied to outcomes, not features)
- Marketing leadership hot takes (CMO-level thinking)

For each idea, provide:
1. A one-line hook (the opening line of the post)
2. The angle in one sentence
3. Suggested voice: AirOps Brand, Alex, or Christy

Keep it punchy. These are starting points, not finished posts. Be opinionated and specific. No generic topics.`;

async function sendDailyIdeas() {
  try {
    console.log('[nuggets-agent] Generating daily post ideas...');

    // Search docs for any recent product context
    const docsContext = await searchAirOpsDocs('new features launches updates');

    let prompt = 'Generate 5 LinkedIn post ideas for today.';
    if (docsContext) {
      prompt += `\n\nHere's some recent product context from AirOps docs to inspire ideas:\n${docsContext}`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: DAILY_IDEAS_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const ideas = response.content.find((b) => b.type === 'text')?.text || 'No ideas today.';

    await slack.client.chat.postMessage({
      channel: REVIEWER_SLACK_ID,
      text: `*Good morning! Here are today's post ideas:*\n\n${ideas}\n\n_Reply with a number to draft it, or DM me to brainstorm more._`,
    });

    console.log('[nuggets-agent] Daily ideas sent to Jess.');
  } catch (err) {
    console.error('[nuggets-agent] Failed to send daily ideas:', err.message);
  }
}

function scheduleDailyIdeas() {
  const checkInterval = 60 * 1000; // check every minute
  let lastSentDate = null;

  setInterval(() => {
    const now = new Date();
    // Convert to CT (UTC-5 CDT / UTC-6 CST)
    const ct = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const hour = ct.getHours();
    const minute = ct.getMinutes();
    const dateKey = ct.toISOString().split('T')[0];

    // 9:00 AM CT, only once per day
    if (hour === 9 && minute === 0 && lastSentDate !== dateKey) {
      lastSentDate = dateKey;
      sendDailyIdeas();
    }
  }, checkInterval);

  console.log('[startup] Daily ideas scheduler active (9:00 AM CT)');
}

// ─── Start ──────────────────────────────────────────────────────────────────

(async () => {
  await slack.start();
  scheduleDailyIdeas();
  console.log('⚡ Nuggets agent is running');
})();
