# Edna — AirOps Social Post Agent

Slack bot that drafts LinkedIn posts in multiple brand voices, runs QA against the AirOps brand kit, saves to Notion, queues approved posts in Ordinal, and creates Asana tasks. Built with Claude Code in April 2026.

## What Edna Does

Edna works in Slack workflow channels, in DMs, and through scheduled background workflows.

### In Slack workflow channels

Edna watches the channels listed in `WATCH_CHANNELS`. The documented setup uses `#social-workflow` and `#0-nuggets`.

1. **Accepts content requests**
   - Processes the Slack Workflow Builder form marked **Social Post Request**
   - Responds to regular channel messages containing “post idea,” including variants such as `post-idea` and `#post-idea`
2. **Builds the brief**
   - Reads the topic, post type, context, audience, Notion link, image notes, attached images, and preferred publish date from the form
   - Pulls accessible Notion pages and public web URLs into the working context
   - Uses the voice and Notion destination configured for the channel
3. **Creates and reviews the copy**
   - Generates a LinkedIn post and companion blog draft
   - Runs a second QA pass for banned patterns, weak phrasing, and AI writing tropes
   - Saves the result to the channel's configured Notion page
4. **Collaborates in the request thread**
   - Posts the Notion link in the original Slack thread
   - Understands substantive replies using the full thread context
   - Revises the stored draft when asked, or answers questions and performs supported content tasks in the thread
   - Can use accessible Notion links and public web URLs included in the original brief or a reply as context
5. **Routes and approves the draft**
   - Records the original submitter as the sole approver
   - Lets that submitter approve their draft with 👍 or an `approved` reply
   - Does not send a separate reviewer DM or grant anyone else approval access
6. **Hands off approved content**
   - Re-reads Notion so manual edits are included
   - Uploads attached images and queues the LinkedIn post in Ordinal
   - Creates a task on the Social & Email Board in Asana

For Workflow Builder requests, the generated Slack message must include the submitter as a Slack user mention so Edna can identify who owns—and may approve—the draft.

### In DMs

Anyone in the workspace can DM Edna.

- **Draft a post** — Type `draft`, choose AirOps Brand, Alex Halliday, Christy Roach, or Matt Hammel, then send the idea and any relevant Notion link.
- **Approve your draft** — Reply `approved` or add 👍 to Edna's draft-ready message. Only the person who submitted the draft can approve it.
- **Brainstorm** — Type `brainstorm` to develop concrete hooks and angles, then type `draft` when an idea is ready.
- **Chat** — Ask about Edna, platform-specific or B2B social strategy, the AirOps brand kit, or supported AirOps product topics.
- **Start over** — Use `reset`, `start over`, or `menu` to clear the current DM session. Use `help` to see the available modes.

DM drafts are saved to the DM Notion destination and use the same Ordinal handoff as channel drafts. Edna re-reads Notion during approval, so manual edits are included.

### In general

Edna can:

- Write in four defined brand and executive voices
- Turn rough ideas or structured briefs into LinkedIn posts and companion blog drafts
- Use accessible Notion pages, selected public web pages, AirOps docs, and recent news as context
- Apply a dedicated QA pass and remember recurring QA fixes
- Retry truncated or malformed Claude JSON once before reporting a draft-generation failure
- Automatically select the newest Claude Sonnet model available to the configured Anthropic API key, refreshing every six hours
- Advise on organic and paid best practices for LinkedIn, X, Instagram, Facebook, and TikTok
- Adapt B2B strategy by audience, buying role, funnel stage, platform, content format, proof, CTA, and business objective
- Brainstorm cross-platform campaigns and draft platform-native copy or scripts directly in Slack chat
- Learn patterns from approved posts through persistent long-term memory
- Send Jess five daily post ideas at 9:00 a.m. CT, informed by recent Google News headlines and AirOps product context
- Preserve pending approvals across Railway restarts
- Notify Jess in Slack when the service catches an unexpected error

Edna's cross-platform guidance is grounded in durable B2B principles and the platforms' own published guidance, including [LinkedIn's B2B marketing resources](https://business.linkedin.com/advertise/resources/marketing-terms/b2b-marketing), [X organic best practices](https://business.x.com/en/basics/organic-best-practices), [Meta's Instagram and Facebook Reels guidance](https://www.facebook.com/business/ads/facebook-instagram-reels-ads), and [TikTok Creative Codes](https://ads.tiktok.com/business/en/creative-codes). Exact specifications and fast-moving platform behavior still require a current check.

### What Edna cannot do

- **She does not monitor every Slack channel.** Channel behavior is limited to `WATCH_CHANNELS`, and regular channel messages must include “post idea” to trigger drafting.
- **She does not approve content herself.** Edna acts only after the original submitter approves the draft in Slack, then queues the post in Ordinal.
- **She cannot approve someone else's draft on their behalf.** The original submitter is the sole approver; Jess has no reviewer override.
- **Her automated publishing workflow is LinkedIn-only.** Edna can advise on, brainstorm, and draft content for X, Instagram, Facebook, and TikTok in Slack chat, but the Notion-to-Ordinal handoff currently queues LinkedIn posts only.
- **She cannot guarantee that platform rules or trends are current.** Exact limits, specifications, algorithm behavior, and live trends should be checked against current platform guidance.
- **She does not guarantee factual accuracy.** Generated claims, dates, links, and product details still require human review.
- **She cannot access every link.** Notion pages must be shared with the integration, and external pages must be publicly retrievable.
- **She is not a general-purpose workflow bot.** Her connected actions are limited to this social-content workflow across Slack, Notion, Ordinal, and Asana.
- **DMs do not support the full channel form workflow.** Preferred publish dates and attached-image handling belong in the Slack workflow form. Edit a DM draft in Notion or submit a new draft request.
- **Active DM conversation history does not survive a Railway restart.** Pending approvals and long-term memory do persist.

---

## Brand Voices

| Voice | Source | Used By |
|-------|--------|---------|
| AirOps Brand | Brand kit content type 23019 | `#social-workflow`, DMs (option 1) |
| Alex Halliday (CEO) | Brand kit content type 23020 | `#0-nuggets`, DMs (option 2) |
| Christy Roach (CMO) | Brand kit content type 26745 | DMs (option 3) |
| Matt Hammel (COO) | Brand kit content type 23015 | DMs (option 4) |

---

## Workflow Form Fields

| Field | Required | Description |
|-------|----------|-------------|
| Submitted by | Yes for self-approval | Slack user mention used to identify the draft owner |
| What is the post's topic | Yes | Short description |
| Post type | No | Product launch, Research/data, Event, Thought leadership, Customer story, Cultural/team |
| Context / brief | No | Background, talking points, data |
| Target audience | No | CMOs, Content Engineers, agency leads, etc. |
| Notion link | No | Edna fetches the page content for context |
| Image upload | No | Passed to Ordinal on approval |
| Image description | No | Creative brief if no image |
| Desired publish date | No | Sets Ordinal publish time and Asana due date |

---

## Prerequisites

- Node.js 18+
- Slack App with Socket Mode
- Notion integration token
- Anthropic API key
- Ordinal Pro workspace access for the OAuth MCP connection
- Asana personal access token

---

## Slack App Setup

### Bot Token Scopes
`channels:history`, `channels:read`, `chat:write`, `im:history`, `im:write`, `reactions:read`, `files:read`, `files:write`

### Event Subscriptions
`message.channels`, `message.im`, `reaction_added`

### Socket Mode
Enable Socket Mode and generate an App-Level Token with `connections:write` scope.

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_BOT_TOKEN` | Slack bot OAuth token (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | Slack app signing secret |
| `SLACK_APP_TOKEN` | Slack app-level token for Socket Mode (`xapp-...`) |
| `NOTION_TOKEN` | Notion integration token |
| `ANTHROPIC_API_KEY` | Claude API key |
| `ANTHROPIC_MODEL` | Optional model override; leave unset to auto-select the newest available Claude Sonnet model |
| `WATCH_CHANNELS` | Comma-separated channel names (`0-nuggets,social-workflow`) |
| `CHANNEL_NOTION_MAP` | Channel-to-Notion-page mapping (`social-workflow:33b1f419...`) |
| `CHANNEL_PROMPT_MAP` | Channel-to-voice mapping (`social-workflow:airops`) |
| `ORDINAL_OAUTH_BASE_URL` | Public Railway service URL used for the OAuth callback |
| `ORDINAL_OAUTH_ENCRYPTION_KEY` | Base64 32-byte key that encrypts OAuth credentials on the Railway volume |
| `ORDINAL_OAUTH_SETUP_TOKEN` | Secret protecting the one-time OAuth setup route |
| `ORDINAL_OAUTH_STORE` | Credential file path on the Railway volume (defaults to `$STATE_DIR/ordinal-oauth.enc.json`) |
| `ORDINAL_WORKSPACE_SLUG` | AirOps workspace slug returned by `ordinal_get_workspace_context` |
| `ORDINAL_LINKEDIN_PROFILE_ID` | AirOps LinkedIn profile UUID in Ordinal |
| `ASANA_TOKEN` | Asana personal access token |
| `ASANA_PROJECT_ID` | Asana project ID for Social & Email Board |
| `STATE_DIR` | Persistent state directory (`/data` on Railway) |
| `DM_NOTION_PAGE_ID` | Notion page for DM-sourced drafts |

---

## Installation

```bash
git clone https://github.com/airops-brand/social-agent.git
cd social-agent
npm install
cp .env.example .env
# Fill in your tokens
```

---

## Running

```bash
npm start
```

Dev mode with auto-restart:
```bash
npm run dev
```

---

## Deployment (Railway)

Deployed on Railway Pro with a persistent volume at `/data`.

1. Connect GitHub repo `airops-brand/social-agent` to Railway
2. Add all env vars in Railway Variables tab
3. Add a volume mounted at `/data` for persistent state
4. Deploy

The volume stores `approvals.json` (pending approval state) and `MEMORY.md` (long-term memory). Auto-deploy webhook may need manual redeploy after pushes.

---

## Architecture

```
Slack (Socket Mode)
  |-- Channel messages ("post idea" trigger)
  |-- Workflow Builder form submissions
  |-- DM conversations (menu, voice picker, brainstorm, chat)
  |-- Thread replies (intent-routed revisions, questions, and content tasks)
  |-- Thumbs-up reactions (approval)
  |
Node.js Agent (Railway)
  |-- Claude API (Sonnet) --> Generate draft --> QA review
  |-- AirOps Docs MCP --> Product context for accuracy
  |-- Google News RSS --> Daily headline scanning (48hr window)
  |-- Notion API --> Save drafts, fetch page context, re-read on approval
  |-- Ordinal MCP --> Queue approved LinkedIn posts and upload images
  |-- Asana API --> Create tasks on Social & Email Board
  |-- tmpfiles.org --> Image proxy (Slack to Ordinal)
  |-- /data/approvals.json --> Persistent approval state
  |-- /data/MEMORY.md --> Long-term memory
```

---

## Files

```
social-agent/
├── agent.js          # Main script (all logic)
├── soul.md           # Edna's personality definition
├── package.json
├── .env.example      # Template for env vars
├── .gitignore
└── README.md
```
