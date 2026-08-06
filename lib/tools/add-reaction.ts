import { Type, type Static } from "typebox";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { slackPost } from "../api";
import { errorText, toToolResult, type SlackDetails } from "../result";
import {
  ADD_REACTION_CHANNEL_DESCRIPTION,
  ADD_REACTION_DESCRIPTION,
  ADD_REACTION_NAME_DESCRIPTION,
  ADD_REACTION_TIMESTAMP_DESCRIPTION,
  ADD_REACTION_TITLE,
} from "../prompts";

const Params = Type.Object({
  channel: Type.String({ description: ADD_REACTION_CHANNEL_DESCRIPTION, minLength: 1 }),
  name: Type.String({ description: ADD_REACTION_NAME_DESCRIPTION, minLength: 1 }),
  timestamp: Type.String({ description: ADD_REACTION_TIMESTAMP_DESCRIPTION, minLength: 1 }),
});

interface ReactionAddResponse {
  ok: boolean;
}

export const addReactionTool: ToolDefinition<typeof Params, undefined> = {
  name: "slack_add_reaction",
  label: ADD_REACTION_TITLE,
  description: ADD_REACTION_DESCRIPTION,
  parameters: Params,
  async execute(
    _toolCallId: string,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SlackDetails>> {
    try {
      await slackPost<ReactionAddResponse>("reactions.add", {
        body: {
          channel: params.channel,
          name: params.name,
          timestamp: params.timestamp,
        },
      });
      return toToolResult(
        `Slack: added :${params.name}: reaction to message ${params.timestamp} in ${params.channel}.`,
      );
    } catch (err) {
      return toToolResult(errorText(err));
    }
  },
};
