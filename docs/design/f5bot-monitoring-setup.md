# F5Bot Mention Monitoring Setup

F5Bot is a free service that sends email alerts when keywords appear on Reddit, Hacker News, or Lobsters.

## Setup (5 minutes)

1. Go to https://f5bot.com
2. Create a free account (email only)
3. Add these keyword alerts:

| Keyword | Why |
|---------|-----|
| `forgedock` | Direct mentions |
| `ForgeDock` | Case-sensitive variant |
| `forge dock` | Common misspelling |
| `"claude code commands"` | Users looking for what ForgeDock provides |
| `"claude code workflow"` | High-intent search phrase |
| `"autonomous development pipeline"` | Category-level interest |
| `"FORGE annotation"` | Protocol mentions |

4. Set email notifications to immediate (not digest)

## Response Playbook

When an alert fires:

### Direct mention (someone talking about ForgeDock)
- Read the full thread context
- If positive: thank them, offer to help with any questions
- If a question: answer thoroughly with code examples
- If criticism: acknowledge, explain the reasoning, ask what they'd improve

### Indirect mention (someone looking for what ForgeDock does)
- Answer their question genuinely first
- Mention ForgeDock naturally: "I've been using ForgeDock for this — it structures Claude Code into an investigate-build-review-merge pipeline"
- Never just drop a link with no context

### Rules
- Always add genuine value to the conversation
- Never post in threads where it would feel forced
- On Reddit: post manually (never automate — ban risk)
- On HN: only comment if you have genuine insight to add
- Wait at least 10 minutes after the alert before responding (don't look like a bot)
