# Nuggets Agent — Setup Guide

## What it does

1. Watches #0-nuggets in Slack
2. Triggers when any message contains "post idea", "post-idea", "#post-idea", or similar variants
3. Sends the idea to Claude (with Alex Halliday's voice baked in) → generates a LinkedIn post + blog draft
4. Creates a new page in the Nuggets Notion database with both drafts
5. DMs you (Jess) with a link to review
6. When you reply "approved" to that DM → the Notion link gets posted as a reply to the original #0-nuggets message

---

## Prerequisites

- Node.js 18+
- A Slack App with the right permissions (see below)
- A Notion integration token
- An Anthropic API key

---

## Slack App Setup

Go to https://api.slack.com/apps and create a new app.

### Enable Socket Mode
- Settings → Socket Mode → Enable
- Generate an App-Level Token with `connections:write` scope → this is your `SLACK_APP_TOKEN`

### Bot Token Scopes (OAuth & Permissions)
Add these under Bot Token Scopes:
- `channels:history` — read messages in public channels
- `channels:read` — get channel info/name
- `chat:write` — post messages
- `im:history` — read DM history (to detect "approved" replies)
- `im:write` — send DMs

### Event Subscriptions
Enable Events API and subscribe to these bot events:
- `message.channels` — messages in public channels
- `message.im` — DMs to/from the bot

### Install the app to your workspace
After setting scopes → Install to Workspace → copy the Bot User OAuth Token (`xoxb-...`)

---

## Notion Setup

1. Go to https://www.notion.so/my-integrations → New integration
2. Give it a name (e.g. "Nuggets Agent"), associate with your workspace
3. Copy the Internal Integration Token → `NOTION_TOKEN`
4. In Notion, open the **Nuggets** database page → click ••• → Add connections → select your integration

The database ID is already hardcoded in the script: `5ccd6689-e7f3-41d9-9705-e13c02d1435a`

---

## Installation

```bash
# Clone / copy the agent folder, then:
cd nuggets-agent
npm install

# Copy and fill in your env vars
cp .env.example .env
# Edit .env with your actual tokens
```

---

## Running

```bash
npm start
```

For development with auto-restart on file changes:
```bash
npm run dev
```

---

## Deploying (recommended: Railway or Render)

The agent runs as a persistent Node.js process. It uses Socket Mode so no public URL/webhook is needed.

**Railway (easiest):**
1. Push the folder to a GitHub repo
2. New project on railway.app → Deploy from GitHub
3. Add all env vars in Railway's Variables tab
4. Deploy — it runs `npm start` automatically

**Render:**
1. New Web Service → connect repo
2. Build command: `npm install`
3. Start command: `node agent.js`
4. Add env vars → Deploy

---

## How "approved" detection works

When the bot DMs you with a review request, it stores the connection between that DM message and the original Slack message + Notion URL in memory.

When you reply "approved" (anywhere in the DM, in a thread or standalone), it:
- Matches your reply to the pending approval
- Posts the Notion link as a thread reply in #0-nuggets
- Confirms back to you in the DM

**Note:** The pending state lives in memory, so if you restart the agent while a review is pending, that approval state is lost. For a production-grade version, swap `pendingApprovals` (the Map at the top of agent.js) for a small SQLite or Redis store.

---

## Trigger variations caught

The regex `post[\s\-_#]*idea` (case-insensitive) matches:
- `post idea`
- `post-idea`
- `#post-idea`
- `post_idea`
- `POST IDEA`
- `Post Idea`

---

## Files

```
nuggets-agent/
├── agent.js          # Main script
├── package.json
├── .env.example      # Copy to .env and fill in
└── README.md
```
