import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Slack tools return plain text; structured details are not used today but the
// union is left open so future tools can attach metadata without touching every
// caller.
export type SlackDetails = undefined;

export function toToolResult(
  text: string,
  details?: SlackDetails,
): AgentToolResult<SlackDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// Single error formatter shared across every tool. All Slack errors (auth,
// network, HTTP, logical {ok:false}) are caught at the tool boundary and
// converted to readable text rather than thrown - the agent sees a single,
// actionable message instead of a stack trace.
export function errorText(err: unknown): string {
  if (err instanceof Error) {
    return `Slack error: ${err.message}`;
  }
  return "Slack error: unknown failure.";
}
