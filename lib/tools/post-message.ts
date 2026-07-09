import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackPost, SlackApiError } from "../api";
import { confirmWrite, summarizePostMessage } from "../confirm";
import { toToolResult, errorText, type SlackDetails } from "../result";
import {
  POST_MESSAGE_TITLE,
  POST_MESSAGE_DESCRIPTION,
  POST_MESSAGE_CHANNEL_DESCRIPTION,
  POST_MESSAGE_TO_USER_DESCRIPTION,
  POST_MESSAGE_TEXT_DESCRIPTION,
  POST_MESSAGE_THREAD_TS_DESCRIPTION,
} from "../prompts";

// Post a message as the calling user. chat.postMessage with a user token
// posts as YOU natively (no as_user flag - that is bot-token-only and Slack
// ignores it for xoxp tokens). One of channel / to_user is required; when
// to_user is set, the DM channel is resolved first via conversations.open.

const Params = Type.Object({
  channel: Type.Optional(Type.String({ description: POST_MESSAGE_CHANNEL_DESCRIPTION })),
  to_user: Type.Optional(Type.String({ description: POST_MESSAGE_TO_USER_DESCRIPTION })),
  text: Type.String({ description: POST_MESSAGE_TEXT_DESCRIPTION, minLength: 1 }),
  thread_ts: Type.Optional(Type.String({ description: POST_MESSAGE_THREAD_TS_DESCRIPTION })),
});

interface ChatPostResponse {
  ok: boolean;
  channel?: string;
  ts?: string;
  message?: { text?: string };
}

interface OpenConversationResponse {
  ok: boolean;
  channel?: { id?: string };
}

export const postMessageTool: ToolDefinition<typeof Params, undefined> = {
  name: "slack_post_message",
  label: POST_MESSAGE_TITLE,
  description: POST_MESSAGE_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
    _signal,
    _onUpdate,
    ctx,
  ): Promise<AgentToolResult<SlackDetails>> {
    if (params.channel && params.to_user) {
      return toToolResult(
        "Slack: provide channel OR to_user, not both. channel posts to a channel/group/DM; to_user opens a DM with that user. Pick one.",
      );
    }
    if (!params.channel && !params.to_user) {
      return toToolResult(
        "Slack: provide either channel (a channel/DM/group ID) or to_user (a user ID). One is required to know where to post.",
      );
    }

    // Review-before-send gate. The editable path lets the user trim the prose;
    // Esc cancels the whole send.
    const decision = await confirmWrite(ctx, {
      title: `Send message to ${params.to_user ? `@${params.to_user}` : params.channel}?`,
      editableText: params.text,
      summary: summarizePostMessage({
        channel: params.channel,
        toUser: params.to_user,
        threadTs: params.thread_ts,
        text: params.text,
      }),
    });
    if (!decision.proceed) {
      return toToolResult(
        ctx.hasUI
          ? `Slack: message cancelled by user. Nothing was sent.`
          : `Slack: message not sent (headless mode; no UI to review). Use /slack headless on to allow unsupervised writes.`,
      );
    }
    const text = decision.text ?? params.text;

    try {
      let channel = params.channel;

      // to_user: resolve to a DM channel first. conversations.open creates or
      // opens the existing DM with that user and returns the channel id.
      if (params.to_user) {
        const opened = await slackPost<OpenConversationResponse>(
          "conversations.open",
          { body: { users: params.to_user } },
        );
        channel = opened.channel?.id;
        if (!channel) {
          return toToolResult(
            `Slack: could not open a DM with user ${params.to_user}. Verify the user ID via slack_list_channels (a DM) or slack_search.`,
          );
        }
      }

      const body: Record<string, unknown> = { channel, text };
      if (params.thread_ts) body.thread_ts = params.thread_ts;

      const resp = await slackPost<ChatPostResponse>("chat.postMessage", { body });
      const kind = params.thread_ts ? "threaded reply" : "message";
      const where = params.to_user ? `@${params.to_user} (DM ${channel})` : channel;
      return toToolResult(
        `Slack: ${kind} sent to ${where} (ts: ${resp.ts ?? "(unknown)"}).`,
      );
    } catch (err) {
      if (err instanceof SlackApiError && err.isAuthError) {
        return toToolResult(
          `Slack: cannot post - token is invalid or lacks the chat:write scope. Re-install the app with the User Token Scopes from the README. ${err.message}`,
        );
      }
      return toToolResult(errorText(err));
    }
  },
};
