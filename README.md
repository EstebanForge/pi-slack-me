# @estebanforge/pi-slack-me

Slack tools for [pi](https://github.com/earendil-works/pi-coding-agent) that act as **you**, not as a bot.

The extension adds 9 LLM-callable tools that read and write Slack using a **user token** (`xoxp-`). There is no bot to invite into channels and no visible footprint in the workspace: the Slack app inherits *your* membership and access, so the agent sees (and posts as) exactly what you do - public channels, private channels you're in, your DMs, and group DMs.

Use it when you want an agent to **consume information** from Slack (read feedback, follow issues, search past decisions, pull a thread into a coding session), **post on your behalf** (send a message, reply in a thread, DM someone, edit or delete your own messages), or add reactions. Message writes open in a review dialog before they touch Slack; reactions are applied immediately when the reaction tool runs.

An optional [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) listener receives public-channel messages in real time. It is deliberately passive: incoming Slack text never triggers an LLM turn automatically. Messages stay in a bounded, in-memory inbox until you explicitly place them in the editor with `/slack inbox` and submit them yourself.

## Why a user token (and not a bot)

A bot token (`xoxb-`) can only read channels the bot has been explicitly invited to, and it can never read your DMs. That forces a visible new member into every channel you care about. A **user token** (`xoxp-`) speaks as your user, so the app reads anything your user can read, with no `/invite` step and no bot appearing anywhere. This is a fully supported Slack auth mode - every `*:history` scope lists `User` as a supported token type.

The tradeoff, per Slack's docs: the app shows an OAuth consent screen the first time you install it to the workspace, and workspaces requiring admin approval need an admin to approve it once. The app has **no bot user**, so it won't appear in member lists or channels - the only visible signal is in the workspace's Apps admin panel.

## Tools

| Tool | Description |
| ------ | ------------- |
| `slack_list_channels` | List public channels by default; optionally request private channels, DMs, or group DMs via `users.conversations` |
| `slack_read_messages` | Read message history from a channel or DM (`conversations.history`) |
| `slack_read_thread` | Read all replies in a thread (`conversations.replies`) |
| `slack_search` | Full-text search across the workspace (`search.messages`) |
| `slack_download_file` | Download a shared file/image to a temp dir (`files.info` + download) |
| `slack_post_message` | Post a message to a channel, group DM, or existing DM as you; DM by user ID (`chat.postMessage` + `conversations.open`) |
| `slack_update_message` | Edit the text of a message you previously posted (`chat.update`) |
| `slack_delete_message` | Permanently delete one of your messages; always confirmed (`chat.delete`) |
| `slack_add_reaction` | Add an emoji reaction as you (`reactions.add`) |

User IDs are resolved to display names (cached), so feedback reads as `**Esteban**: ...` rather than `**U12345**: ...`.

## Passive Socket Mode inbox

Setting `SLACK_APP_TOKEN` enables a session-scoped connection through Slack's official `@slack/socket-mode` client. Each incoming envelope is acknowledged immediately, then filtered locally. The inbox retains:

- normal public-channel messages that mention your authenticated Slack user;
- normal messages from channel IDs listed in `SLACK_LISTEN_CHANNELS`.

It ignores your own posts, bot and system messages, edits, deletes, private channels, and DMs. Mentions produce a toast containing the author, channel, and a short preview. Non-mention messages from watched channels only update the `Slack: N unread` footer.

Connection loss is retried up to six times with capped exponential backoff, and each connection attempt times out after 10 seconds. After the final failure the footer stays at `Slack: error`; run `/slack listen on` to try again. The footer keeps `reconnecting`, `disconnected`, or `error` visible alongside any unread count, and raw Socket Mode SDK logging is suppressed so temporary WebSocket tickets do not reach the console.

The safety boundary is explicit:

- Slack message text is treated as **untrusted external content**, never as an instruction;
- no event calls `sendUserMessage` or starts an agent turn;
- the inbox holds at most 100 messages and is never written to the pi session or another file;
- `/slack inbox [N]` marks the selected messages read and places structured JSON in the editor, where you can inspect or amend it before pressing Enter;
- `/slack inbox clear` removes all retained messages;
- reload, session replacement, and exit disconnect the socket and discard the inbox.

`SLACK_LISTEN_CHANNELS` accepts comma- or whitespace-separated channel IDs. Leave it unset for mention-only behavior. Use `slack_list_channels` or `/slack channels` to find IDs.

## Write tools & review

The three message-write tools (`slack_post_message`, `slack_update_message`, `slack_delete_message`) post as **you**. A user token posts as your user natively - no `as_user` flag, no bot. You can only edit or delete messages you authored.

Before any message write reaches Slack, the extension shows it for review:

- **post / update** open an **editable** dialog - trim or rewrite the text, then accept or cancel (Esc).
- **delete** asks **yes/no** - it is irreversible, so it is *always* confirmed even when the review flag is off, and it is **refused in headless mode** rather than running blind.

The editable review is on by default and is governed by the `slack-confirm-write` flag. `slack_add_reaction` is not covered by this message-review gate; it applies the requested reaction immediately.

**Headless mode** (no interactive UI, e.g. an unsupervised/automated run): post and update are **refused by default** - the extension will not post on your behalf without a human present. Opt in with the `slack-allow-headless-write` flag if you genuinely want unsupervised writes (e.g. scheduled/automation use). Delete is *always* blocked in headless mode, no opt-in.

- `/slack config` - settings modal (TUI)
- `/slack confirm on` / `/slack confirm off` - toggle the editable review (delete stays guarded regardless)
- `/slack headless on` / `/slack headless off` - opt in/out of unsupervised (no-UI) writes

## Setup

### 1. Create a Slack app

Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**. Give it a name (e.g. `pi-slack-me`) and select your workspace.

### 2. Add User Token Scopes

In the left sidebar → **OAuth & Permissions** → scroll to **User Token Scopes** (not Bot Token Scopes).

For public-channel access with author names resolved, start with:

| Scope | Enables |
| ------- | --------- |
| `channels:read` | list public channels |
| `channels:history` | read public channel messages |
| `users:read` | resolve user IDs to display names |

`slack_list_channels` defaults to `public_channel`, so private-channel and DM scopes are not required for the baseline. Add only the scopes needed for extra capabilities:

| Optional scope | Enables |
| ---------------- | --------- |
| `groups:read` | list private channels |
| `groups:history` | read private channel messages |
| `im:read` | list DMs |
| `im:history` | read DMs |
| `mpim:read` | list group DMs |
| `mpim:history` | read group DMs |
| `search:read` | search workspace messages (`slack_search`) |
| `files:read` | download shared files (`slack_download_file`) |
| `chat:write` | post, update, and delete messages as you |
| `im:write` | open a DM when `slack_post_message` uses `to_user` |
| `reactions:write` | add emoji reactions (`slack_add_reaction`) |

No Bot Token Scopes are needed. There is no bot.

> **Scope at a glance:** public channels need `channels:read` and `channels:history`; `users:read` provides names instead of raw IDs. Everything else is capability-specific.

#### Adding write or reaction capabilities

A token receives newly configured scopes only after the app is reinstalled:

1. [api.slack.com/apps](https://api.slack.com/apps) -> your app -> **OAuth & Permissions** -> **User Token Scopes**.
2. Add `chat:write` for message writes, `im:write` for opening DMs by user ID, and/or `reactions:write` for reactions.
3. Save changes, then click **Reinstall to {Workspace}**.
4. Copy the current **User OAuth Token** (`xoxp-...`); Slack may rotate it during reinstall.
5. Update `SLACK_USER_TOKEN` in the shell that runs pi.

No `/invite` step is needed at any point.

### 3. Install to workspace

Still on **OAuth & Permissions** → click **Install to {Workspace-name}** → authorize. (If your workspace requires admin approval, an admin must approve it.) The consent screen reflects the user scopes above.

### 4. Copy the user token

After installing, the same page shows:

- **User OAuth Token** — starts with `xoxp-` → your `SLACK_USER_TOKEN`

```bash
export SLACK_USER_TOKEN=xoxp-...
```

### 5. Optional: enable the passive Socket Mode inbox

Socket Mode needs a separate **app-level token** (`xapp-`), not another user scope:

1. Open your app at [api.slack.com/apps](https://api.slack.com/apps) → **Socket Mode** and enable it.
2. Open **Event Subscriptions**, enable events, and under **Subscribe to events on behalf of users** add `message.channels`. This event uses the existing `channels:history` user scope.
3. Open **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes**. Give the token a name and add `connections:write`.
4. Copy the generated `xapp-` token and export it before starting pi:

```bash
export SLACK_APP_TOKEN=xapp-...
# Optional: retain every normal message from selected public channels.
export SLACK_LISTEN_CHANNELS=C0123ABC456,C0987XYZ654
```

The equivalent manifest settings are:

```yaml
settings:
  socket_mode_enabled: true
  event_subscriptions:
    user_events:
      - message.channels
```

`SLACK_APP_TOKEN` is the opt-in switch. Without it, the nine Slack tools behave exactly as before and no socket is opened. Restart pi after adding or replacing the token.

### 6. Done

No `/invite` step. No bot in any channel. The Web API tools and Socket Mode events both act on behalf of the authorized user.

## Install

```bash
pi install @estebanforge/pi-slack-me
```

Requires Node.js 20.18.1 or newer (the minimum supported by the Socket Mode transport dependency).

## Commands

| Command | Description |
| --- | --- |
| `/slack` | Show token status and usage |
| `/slack channels [types]` | List public channels by default, or the requested conversation types |
| `/slack dms` | List your DMs (prefills `slack_list_channels` with `types=im`) |
| `/slack read <channel> [N]` | Read recent messages (prefills `slack_read_messages`) |
| `/slack thread <channel> <ts>` | Read a thread (prefills `slack_read_thread`) |
| `/slack search <query>` | Search messages (prefills `slack_search`) |
| `/slack post <channel> <text>` | Post a message (prefills `slack_post_message`) |
| `/slack dm <user> <text>` | DM a user by ID (prefills `slack_post_message` with `to_user`) |
| `/slack reply <channel> <ts> <text>` | Reply in a thread (prefills `slack_post_message` with `thread_ts`) |
| `/slack edit <channel> <ts> <text>` | Edit your message (prefills `slack_update_message`) |
| `/slack delete <channel> <ts>` | Delete your message (prefills `slack_delete_message`) |
| `/slack inbox [N]` | Place the latest 1-100 retained messages in the editor without submitting them |
| `/slack inbox clear` | Empty the in-memory inbox |
| `/slack listen status\|on\|off` | Inspect or control the session's Socket Mode connection |
| `/slack config` | Settings modal (write review gate) |
| `/slack confirm on\|off` | Toggle write review (delete stays guarded) |
| `/slack headless on\|off` | Toggle the headless write opt-in |

## Notes

- **Credential scope**: the user token grants workspace access as you, while the app-level token opens Socket Mode connections. Treat both like credentials - `0600` on any file they land in, never commit them, and rotate either token if leaked.
- **Token rotation**: if Slack invalidates the user token (e.g. you revoke the app or change your password), calls return `invalid_auth`. Re-install the app and update `SLACK_USER_TOKEN`. Replace `SLACK_APP_TOKEN` separately if its app-level token is revoked.
- **Concurrent listeners**: run one active pi listener per Slack app when you need a complete inbox. Slack can distribute envelopes across multiple simultaneous Socket Mode connections rather than sending every envelope to every process.
- **Rate limits**: Slack returns `429` with a `Retry-After` header on rate limit; this extension surfaces the retry hint in the error text. Bulk reads (hundreds of channels) should page via the returned cursor. Writes (`chat.postMessage`) are limited to ~1/sec per channel - avoid tight-loop bulk posting.
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
