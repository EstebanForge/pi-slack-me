/**
 * pi-slack-me - Slack read tools for pi that act as YOU.
 *
 * Adds 5 LLM-callable tools that read Slack using a USER token (xoxp-). There
 * is no bot to invite: the app inherits the calling user's membership and
 * access, so it can read public channels, private channels the user is in, DMs,
 * and group DMs - exactly what the user sees in the Slack client.
 *
 * The tool surface is intentionally read-only (list, read, thread, search,
 * download). Posting/editing/deleting are out of scope; this extension exists
 * so an agent can consume feedback, issues, and discussions in Slack.
 *
 * Based on: Slack Web API - https://docs.slack.dev/reference/methods
 *           "act as me" user-token model per
 *           https://docs.slack.dev/authentication/tokens
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listChannelsTool } from "../lib/tools/list-channels";
import { readMessagesTool } from "../lib/tools/read-messages";
import { readThreadTool } from "../lib/tools/read-thread";
import { searchTool } from "../lib/tools/search";
import { downloadFileTool } from "../lib/tools/download-file";
import { hasSlackToken } from "../lib/auth";

// Compact tool guidance appended to the system prompt. Intentionally small:
// the tool descriptions themselves carry the detail; this just tells the
// agent when to reach for Slack and reinforces the act-as-me model.
const TOOL_GUIDANCE = [
  "These tools act as the USER, not a bot: they read exactly what the user Slack account can see, including DMs and private channels you are a member of.",
  "Use slack_list_channels FIRST to discover conversation IDs (channels C..., DMs D..., groups). It returns your membership view, including DMs.",
  "Use slack_read_messages to read a channel's recent history; slack_read_thread to read a thread's replies.",
  "Use slack_search for full-text search across the workspace (supports in:#channel, from:@user, after:YYYY-MM-DD). Great for finding feedback or reported issues.",
  "When a message references a file/image (shown with 📎), use slack_download_file with the file ID, then use the `read` tool on the returned path to view images.",
].join(" ");

function slackMe(pi: ExtensionAPI): void {
  pi.registerTool(listChannelsTool);
  pi.registerTool(readMessagesTool);
  pi.registerTool(readThreadTool);
  pi.registerTool(searchTool);
  pi.registerTool(downloadFileTool);

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: [event.systemPrompt, TOOL_GUIDANCE]
        .filter(Boolean)
        .join("\n\n"),
    };
  });

  // /slack <verb> - prefix the editor with an explicit instruction so the
  // agent reaches for the right tool deterministically. Same prefill pattern
  // as pi-asana: the command cannot directly dispatch a tool call, so it sets
  // the editor text and the user hits Enter to run.
  //
  //   /slack channels [types]      -> slack_list_channels
  //   /slack dms                    -> slack_list_channels (types=im)
  //   /slack read <channel> [N]    -> slack_read_messages
  //   /slack thread <channel> <ts> -> slack_read_thread
  //   /slack search <query>        -> slack_search
  //
  // Bare /slack prints token status + usage.
  pi.registerCommand("slack", {
    description:
      'Slack read tools (act as you). Usage: /slack channels [types] | /slack dms | /slack read <channel> [N] | /slack thread <channel> <ts> | /slack search <query>.',
    handler: async (args, ctx) => {
      if (!hasSlackToken()) {
        ctx.ui.notify(
          "Slack: SLACK_USER_TOKEN is not set. Create a Slack app, add the User Token Scopes from the README, install it, and `export SLACK_USER_TOKEN=xoxp-...`.",
          "warning",
        );
        return;
      }

      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify(
          "Slack: authenticated as your user token. Usage: /slack channels | /slack dms | /slack read <channel> [N] | /slack thread <channel> <ts> | /slack search <query>",
          "info",
        );
        return;
      }

      const firstSpace = trimmed.indexOf(" ");
      const verb = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
      const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

      let prompt: string | null = null;

      switch (verb) {
        case "channels":
        case "list":
          prompt = rest
            ? `Call the slack_list_channels tool with types="${rest}" to list the Slack conversations you can see.`
            : `Call the slack_list_channels tool to list the Slack conversations you can see (channels, DMs, groups).`;
          break;
        case "dms":
        case "dm":
          prompt = `Call the slack_list_channels tool with types="im" to list your Slack direct messages.`;
          break;
        case "read":
        case "history": {
          const parts = rest.split(/\s+/).filter(Boolean);
          const channel = parts[0];
          const limit = parts[1];
          if (!channel) {
            ctx.ui.notify(
              "Usage: /slack read <channel> [limit]\nExample: /slack read C0123ABC456   or   /slack read C0123ABC456 20",
              "warning",
            );
            return;
          }
          const limitNote = limit && /^\d+$/.test(limit) ? ` limit=${limit}` : "";
          prompt = `Call the slack_read_messages tool with channel="${channel}"${limitNote} to read recent messages from that Slack conversation.`;
          break;
        }
        case "thread": {
          const parts = rest.split(/\s+/).filter(Boolean);
          if (parts.length < 2) {
            ctx.ui.notify(
              "Usage: /slack thread <channel> <thread_ts>\nExample: /slack thread C0123ABC456 1512085950.000216",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_read_thread tool with channel="${parts[0]}" and thread_ts="${parts[1]}" to read the replies in that Slack thread.`;
          break;
        }
        case "search":
        case "find":
          if (!rest) {
            ctx.ui.notify(
              "Usage: /slack search <query>\nExample: /slack search broken deploy in:#ops",
              "warning",
            );
            return;
          }
          prompt = `Call the slack_search tool with query="${rest}" to search Slack messages across the workspace.`;
          break;
        default:
          prompt = `The user typed "/slack ${trimmed}" with an unknown verb. Show the available verbs (channels, dms, read, thread, search) and ask what they want.`;
          break;
      }

      if (prompt) ctx.ui.setEditorText(prompt);
    },
  });
}

export default slackMe;
