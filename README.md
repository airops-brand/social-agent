# Edna — AirOps Social Post Agent

Slack bot that drafts LinkedIn posts in multiple brand voices, runs QA against the AirOps brand kit, saves to Notion, queues approved posts in Ordinal, and creates Asana tasks. Built with Claude Code in April 2026.

## What Edna Does

1. Watches `#social-workflow` and `#0-nuggets` for post ideas
2. Accepts structured requests via Slack Workflow Builder form
3. Accepts DMs from anyone (with voice picker and brainstorm mode)
4. Generates LinkedIn post + blog draft using the selected brand voice
5. Runs QA review to catch banned patterns and AI tropes
6. Saves drafts to Notion as toggle headings
7. DMs Jess for review
8. On approval (thumbs-up or "approved" reply):
   - Re-reads Notion to pick up manual edits
   - Queues the LinkedIn post in Ordinal (AirOps brand profile)
   - Uploads attached images to Ordinal
   - Creates an Asana task on Social & Email Board
   - Assigns a blocking approval to Jess in Ordinal
9. Sends daily post ideas at 9am CT informed by Google News RSS
10. Learns from approved posts and QA fixes via long-term memory

---

## Brand Voices

| Voice | Source | Used By |
|-------|--------|---------|
| AirOps Brand | Brand kit content type 23019 | `#social-workflow`, DMs (option 1) |
| Alex Halliday (CEO) | Brand kit content type 23020 | `#0-nuggets`, DMs (option 2) |
| Christy Roach (CMO) | Brand kit content type 26745 | DMs (option 3) |
| Matt Hammel (COO) | Brand kit content type 23015 | DMs (option 4) |

---

## DM Features

- **Draft a post** — pick a voice, give an idea, get a draft
- **Brainstorm** — free-form ideation with Edna using AirOps content pillars
- **Chat** — ask Edna anything (how she was built, trends, AirOps product questions)
- **Thread revisions** — reply to a draft thread with feedback or URLs to iterate
- Commands: `draft`, `brainstorm`, `reset`, `menu`, `help`

---

## Workflow Form Fields

| Field | Required | Description |
|-------|----------|-------------|
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
- Ordinal API key
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
| `WATCH_CHANNELS` | Comma-separated channel names (`0-nuggets,social-workflow`) |
| `CHANNEL_NOTION_MAP` | Channel-to-Notion-page mapping (`social-workflow:33b1f419...`) |
| `CHANNEL_PROMPT_MAP` | Channel-to-voice mapping (`social-workflow:airops`) |
| `ORDINAL_API_KEY` | Ordinal API bearer token |
| `ORDINAL_LINKEDIN_PROFILE_ID` | AirOps LinkedIn profile UUID in Ordinal |
| `ORDINAL_APPROVER_USER_ID` | Jess's Ordinal user UUID for auto-approval |
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
  |-- Thread replies (draft revisions)
  |-- Thumbs-up reactions (approval)
  |
Node.js Agent (Railway)
  |-- Claude API (Sonnet) --> Generate draft --> QA review
  |-- AirOps Docs MCP --> Product context for accuracy
  |-- Google News RSS --> Daily headline scanning (48hr window)
  |-- Notion API --> Save drafts, fetch page context, re-read on approval
  |-- Ordinal MCP --> Queue posts, upload images, create approvals
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
