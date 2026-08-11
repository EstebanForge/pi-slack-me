import type { AgentToolResult } from "@earendil-works/pi-coding-agent";

// Structured metadata a write tool can attach so the host (and future
// programmatic callers) can read the exact bytes that reached the Slack Web
// API and whether the human changed the agent's draft. The model itself only
// sees a tool result's `content` text (structured `details` is host metadata),
// so the ground truth is ALSO echoed into the result text via
// postedContentBlock().
export interface WriteDetails {
  /** Exact text transmitted to Slack after the user reviewed/edited. */
  postedContent?: string;
  /** True when the human changed the agent's draft in the review dialog. */
  edited?: boolean;
}

// Write tools attach WriteDetails; read tools attach nothing. The union stays
// open so future tools can add more shapes without touching every caller.
export type SlackDetails = WriteDetails | undefined;

export function toToolResult(
  text: string,
  details?: SlackDetails,
): AgentToolResult<SlackDetails> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

// Block appended to a write-tool success line so the agent's later turns see
// EXACTLY what reached Slack, plus whether the user edited the draft. Without
// this the agent keeps believing its own original draft was posted verbatim,
// even after the user changed it in the review dialog.
export function postedContentBlock(text: string, edited: boolean): string {
  return `\nEdited by user: ${edited ? "yes" : "no"}\nFinal content sent:\n-----\n${text}\n-----`;
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
