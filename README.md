# @estebanforge/pi-slack-me

Slack **read** tools for [pi](https://github.com/earendil-works/pi-coding-agent) that act as **you**, not as a bot.

The extension adds 5 LLM-callable tools that read Slack using a **user token** (`xoxp-`). There is no bot to invite into channels and no visible footprint in the workspace: the Slack app inherits *your* membership and access, so the agent sees exactly what you see - public channels, private channels you're in, your DMs, and group DMs.

Use it when you want an agent to **consume information** from Slack: read feedback, follow issues posted in a channel, search past decisions, or pull a thread's context into a coding session. It is read-only by design; posting, editing, and deleting are intentionally out of scope.

## Why a user token (and not a bot)

A bot token (`xoxb-`) can only read channels the bot has been explicitly invited to, and it can never read your DMs. That forces a visible new member into every channel you care about. A **user token** (`xoxp-`) speaks as your user, so the app reads anything your user can read, with no `/invite` step and no bot appearing anywhere. This is a fully supported Slack auth mode - every `*:history` scope lists `User` as a supported token type.

The tradeoff, per Slack's docs: the app shows an OAuth consent screen the first time you install it to the workspace, and workspaces requiring admin approval need an admin to approve it once. The app has **no bot user**, so it won't appear in member lists or channels - the only visible signal is in the workspace's Apps admin panel.

## Tools

| Tool | Description |
|------|-------------|
| `slack_list_channels` | List conversations you can see (channels, DMs, group DMs) via `users.conversations` |
| `slack_read_messages` | Read message history from a channel or DM (`conversations.history`) |
| `slack_read_thread` | Read all replies in a thread (`conversations.replies`) |
| `slack_search` | Full-text search across the workspace (`search.messages`) |
| `slack_download_file` | Download a shared file/image to a temp dir (`files.info` + download) |

User IDs are resolved to display names (cached), so feedback reads as `**Esteban**: ...` rather than `**U12345**: ...`.

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**. Give it a name (e.g. `pi-slack-me`) and select your workspace.

### 2. Add User Token Scopes

In the left sidebar → **OAuth & Permissions** → scroll to **User Token Scopes** (not Bot Token Scopes).

| Scope | Enables |
|-------|---------|
| `channels:read` | list public channels |
| `groups:read` | list private channels |
| `im:read` | list DMs |
| `mpim:read` | list group DMs |
| `channels:history` | read public channel messages |
| `groups:history` | read private channel messages |
| `im:history` | read your DMs |
| `mpim:history` | read group DMs |
| `users:read` | resolve user IDs to display names |
| `search:read` | `slack_search` (optional but recommended) |
| `files:read` | download shared files (`slack_download_file`) |

No Bot Token Scopes are needed. There is no bot.

### 3. Install to workspace

Still on **OAuth & Permissions** → click **Install to {Workspace-name}** → authorize. (If your workspace requires admin approval, an admin must approve it.) The consent screen reflects the user scopes above.

### 4. Copy the user token

After installing, the same page shows:

- **User OAuth Token** — starts with `xoxp-` → your `SLACK_USER_TOKEN`

```bash
export SLACK_USER_TOKEN=xoxp-...
```

### 5. Done

No `/invite` step. No bot in any channel. The token reads as your user.

## Install

```bash
pi install @estebanforge/pi-slack-me
```

## Commands

| Command | Description |
|---|---|
| `/slack` | Show token status and usage |
| `/slack channels [types]` | List conversations (prefills `slack_list_channels`) |
| `/slack dms` | List your DMs (prefills `slack_list_channels` with `types=im`) |
| `/slack read <channel> [N]` | Read recent messages (prefills `slack_read_messages`) |
| `/slack thread <channel> <ts>` | Read a thread (prefills `slack_read_thread`) |
| `/slack search <query>` | Search messages (prefills `slack_search`) |

## Notes

- **Session scope**: the user token grants workspace-wide read access as you. Treat it like any other credential - `0600` on any file it lands in, never commit it, rotate it if leaked.
- **Token rotation**: if Slack invalidates the token (e.g. you revoke the app or change your password), calls return `invalid_auth`. Re-install the app and update `SLACK_USER_TOKEN`.
- **Rate limits**: Slack returns `429` with a `Retry-After` header on rate limit; this extension surfaces the retry hint in the error text. Bulk reads (hundreds of channels) should page via the returned cursor.
- **DM author names**: DM message payloads carry the other user's ID; the extension resolves it via `users.info`. Your own messages show as your display name.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:watch
```

## License

MIT
