# Changelog

## 1.0.0 — 2026-07-08

Initial release.

Pi-native Slack **read** tools. Calls the Slack Web API directly over plain
HTTP using a **user token** (`xoxp-`), so the app acts as the calling user
rather than a bot: it reads exactly what the user's Slack account can see —
public channels, private channels the user is in, DMs, and group DMs — with
no bot to invite and no visible footprint in the workspace. Read-only by
design; posting, editing, and deleting are intentionally out of scope.

### Added
- `slack_list_channels` — list conversations the calling user can see via
  `users.conversations`. Returns the user's membership view, including DMs
  (`D..`) and group DMs. First step to resolve a name to a conversation ID.
- `slack_read_messages` — read message history from a channel or DM
  (`conversations.history`). Supports `oldest` / `latest` time windows and
  cursor pagination.
- `slack_read_thread` — read all replies in a thread
  (`conversations.replies`). The parent message is included as the first
  entry.
- `slack_search` — full-text search across the workspace
  (`search.messages`). Supports Slack search syntax: `in:#channel`,
  `from:@user`, `has:link`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`,
  `"exact phrase"`. User-token-only; bots cannot search.
- `slack_download_file` — download a shared file or image to a temp dir
  (`files.info` + token-authed download of `url_private_download`). Preserves
  the original extension so the `read` tool picks the right viewer.
- User ID → display name resolution via a cached `users.info`, so messages
  render as `**Esteban**: ...` rather than `**U12345**: ...`.
- `/slack <verb> [args]` slash command (`channels`, `dms`, `read`, `thread`,
  `search`). Registered programmatically via `registerCommand`; prefills the
  editor with an explicit ask.
- Compact tool guidance injected via the `before_agent_start` hook
  (~80 tokens, no skill file).
- Inline Slack client (`lib/api.ts`) handling bearer auth, JSON in / JSON
  out, timeouts, rate-limit (`429` + `Retry-After`) and auth-error
  (`invalid_auth` / `token_revoked` / `token_expired`) flags, and friendly
  status errors (401 / 404 / 429 / 5xx).
- `lib/auth.ts` — reads `SLACK_USER_TOKEN` from the environment. Strictly
  env-only: no file fallback, no config file, no other env vars.

### Notes for integrators

Notable findings from build-time review and live testing, all resolved in
this release:

- **Slack returns snake_case.** Initial type definitions used camelCase
  (`threadTs`, `replyCount`, `isIm`, `numMembers`, `displayName`,
  `urlPrivateDownload`), so every field read as `undefined`: file downloads
  silently "had no URL", names never resolved. `lib/types.ts` now mirrors
  Slack's snake_case **exactly** with no normalization layer
  (`thread_ts`, `reply_count`, `is_im`, `num_members`, `display_name`,
  `url_private_download`). Single-word keys (`id`, `name`, `text`, `ts`,
  `user`, `topic`) are unaffected. **When adding any new Slack endpoint, type
  its response in snake_case from the start.**
- **`conversations.history` boundaries are exclusive by default.** A message
  whose `ts` equals `oldest` or `latest` is omitted, which breaks the
  single-message read pattern ("read this permalink"). `slack_read_messages`
  now sends `inclusive=true` whenever either bound is supplied; Slack ignores
  `inclusive` unless a bound is present, so plain range reads are unaffected.
  The `oldest` / `latest` parameter descriptions state the inclusive behavior.
- **`files:read` is required for `slack_download_file`.** `files.info` lists
  `files:read` as its compatible scope (supported token types: Bot / User /
  Legacy Bot). The user token must carry this scope in addition to the
  `*:history` scopes; without it the call fails with `missing_scope`.
