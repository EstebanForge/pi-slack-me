# Changelog

## 1.1.0 — 2026-07-09

Write support, ported and hardened from pi-asana. The extension grows from 5
read tools to 8 with three write tools that post as the calling user. Every
write passes through a two-stage human-in-the-loop gate (a headless guard,
then a review) modeled on pi-asana's `lib/confirm.ts`. The extension is no
longer read-only.

### Added
- `slack_post_message` — post a message as the user to a channel, group DM,
  or existing DM (`chat.postMessage`). Accepts `channel` OR `to_user` (a
  `U..` user ID resolved to a DM via `conversations.open`); `thread_ts` posts
  a threaded reply. Passing both `channel` and `to_user` is an error.
  Opens an editable review dialog before sending.
- `slack_update_message` — edit the text of a message you previously posted
  (`chat.update`). Opens an editable review dialog before applying.
- `slack_delete_message` — permanently delete one of your messages
  (`chat.delete`). Always asks yes/no; **refused in headless mode** because
  the write is irreversible and cannot be confirmed blind.
- `lib/confirm.ts` — two-stage human-in-the-loop gate, file-backed at
  `<piDir>/pi-slack-me.json` (pi extension flags are in-memory-only with no
  setter, so a settings file is required for durable state). Stage 1 is a
  HEADLESS guard (see Safety below); stage 2 is the REVIEW gate, on by
  default. `requireInteractive` path for destructive writes: confirmed
  regardless of the flag, blocked when no UI is present.
- `slackPost` in `lib/api.ts` — POST + JSON body, sharing the `{ok,error}`
  unwrap and `SlackApiError` mapping with `slackGet`. Shared `readSlackJson`
  helper de-duplicates the response parsing across GET/POST/download.
- `slack-confirm-write` flag (editable review on/off) + `slack-allow-headless-write`
  flag (opt in to unsupervised writes, default off) + `/slack config` (TUI
  settings modal, both rows) + `/slack confirm on|off` + `/slack headless on|off`.
- `/slack post`, `/slack dm`, `/slack reply`, `/slack edit`, `/slack delete`
  command verbs.
- New User Token Scopes: `chat:write` (post/update/delete) and `im:write`
  (DM via `to_user` → `conversations.open`). README documents the upgrade
  path for existing v1.0.x installs (add scopes, reinstall, rotate token).
- Tests: gate unit tests (review, headless matrix, persistence), three
  write-tool suites, direct `slackPost` unit tests, `requiredScopeFor`
  pinning, `isAuthError` coverage on all three write tools, the
  `channel`+`to_user` guard, and a DM `conversations.open` failure test.

### Safety

Two independent gates, evaluated in order, governing every write before any
Slack call:

1. **HEADLESS guard (default-deny).** Without an interactive UI, post and
   update are **refused by default** — an unsupervised run cannot post on
   your behalf. Opt in with the `slack-allow-headless-write` flag for genuine
   automation/scheduled use. Destructive deletes are **always** blocked
   headless, no opt-in. This guard is independent of the review flag: even
   with `slack-confirm-write` off, an unsupervised run cannot write unless
   you allow it.
2. **REVIEW gate.** With a UI present, post/update open an editable preview
   (skipped when `slack-confirm-write` is off); delete always asks yes/no.

### Fixed
- **DM scope gap.** DM-ing via `to_user` calls `conversations.open`, which
  requires the `im:write` scope (confirmed against Slack docs), not just
  `chat:write`. README scope table, the migration note, `auth.ts` error
  message, and the `slack_post_message` description all list both scopes.
- **`missing_scope` error now names the right scope.** It previously
  hardcoded "chat:write is required" regardless of method; `conversations.open`
  failing would have told you to add a scope you already have. Now method-aware
  (`chat.*` → `chat:write`, `conversations.open` → `im:write`) via a small
  `requiredScopeFor(method)` map in `lib/api.ts`.
- **`channel` + `to_user` mutual exclusion.** Passing both previously let
  `to_user` win silently. Now an explicit error tells the caller to pick one.
- **`lib/confirm.ts` persistence** generalized to read-merge-write so toggling
  one flag never clobbers the other.

### Changed
- Extension now ships 8 tools (was 5); no longer read-only.
- `TOOL_GUIDANCE` extended to describe the write tools, that they gate
  themselves, and the headless default.
- `lib/api.ts` `friendlyError` handles write-specific codes (method-aware
  `missing_scope`; `cant_update_message` notes user-token edit limits).
- `lib/auth.ts` error message lists `chat:write` and `im:write`.
- Cancelled/not-sent messages in post/update are UI-aware (distinguish
  user-cancelled from headless-refused).

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
