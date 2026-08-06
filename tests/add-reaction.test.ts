import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstText, invoke } from "./_helpers";

beforeEach(() => {
  process.env.SLACK_USER_TOKEN = "xoxp-test";
  vi.resetModules();
});

afterEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  vi.unstubAllGlobals();
});

describe("slack_add_reaction", () => {
  it("adds the requested emoji reaction to a Slack message", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ ok: true }),
    } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);

    const { addReactionTool } = await import("../lib/tools/add-reaction");
    const text = firstText(
      await invoke(addReactionTool, {
        channel: "C123",
        name: "robot_face",
        timestamp: "1786019860.190939",
      }),
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("reactions.add");
    expect(init.body).toBe(
      JSON.stringify({
        channel: "C123",
        name: "robot_face",
        timestamp: "1786019860.190939",
      }),
    );
    expect(text).toContain(":robot_face:");
  });

  it("names reactions:write when the user token lacks the reaction scope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: false, error: "missing_scope" }),
      } as unknown as Response),
    );

    const { addReactionTool } = await import("../lib/tools/add-reaction");
    const text = firstText(
      await invoke(addReactionTool, {
        channel: "C123",
        name: "eyes",
        timestamp: "1786019860.190939",
      }),
    );

    expect(text).toContain("reactions:write");
  });
});
