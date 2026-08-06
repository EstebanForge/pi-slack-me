import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSlackMe as createSlackExtension } from "../extensions/index";

class FakeSocketClient {
  readonly start = vi.fn().mockResolvedValue({ ok: true });
  readonly disconnect = vi.fn().mockResolvedValue(undefined);
  private readonly listeners = new Map<
    string,
    Array<(payload: unknown) => void>
  >();

  on(event: string, listener: (payload: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

interface TestContext {
  hasUI: boolean;
  mode: "tui";
  ui: {
    notify: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    setEditorText: ReturnType<typeof vi.fn>;
  };
}

type Hook = (
  event: Record<string, unknown>,
  context: TestContext,
) => Promise<unknown> | unknown;

interface TestCommand {
  handler: (args: string, context: TestContext) => Promise<void> | void;
}

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Socket Mode extension lifecycle", () => {
  beforeEach(() => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
    process.env.SLACK_LISTEN_CHANNELS = "CWATCHED";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_LISTEN_CHANNELS;
  });

  it("starts with the session, fills the passive inbox, and stops on shutdown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({
            ok: true,
            user: { id: "UOTHER", profile: { display_name: "Alice" } },
          });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "CWATCHED", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const hooks = new Map<string, Hook[]>();
    const commands = new Map<string, TestCommand>();
    const sendUserMessage = vi.fn();
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: TestCommand) => {
        commands.set(name, command);
      }),
      on: vi.fn((event: string, hook: Hook) => {
        const registered = hooks.get(event) ?? [];
        registered.push(hook);
        hooks.set(event, registered);
      }),
      sendUserMessage,
    } as unknown as ExtensionAPI;
    const context: TestContext = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        setEditorText: vi.fn(),
      },
    };
    const socket = new FakeSocketClient();
    createSlackExtension({ createSocketClient: () => socket })(pi);

    const startHook = hooks.get("session_start")?.[0];
    expect(startHook).toBeDefined();
    await startHook?.({ reason: "startup" }, context);
    await vi.waitFor(() => expect(socket.start).toHaveBeenCalledOnce());

    const event = {
      type: "message",
      channel: "CWATCHED",
      channel_type: "channel",
      user: "UOTHER",
      text: "<@USELF> hello from Slack",
      ts: "1786020000.001000",
    };
    socket.emit("message", {
      ack: vi.fn().mockResolvedValue(undefined),
      body: { event_id: "EvExtension", event },
      event,
    });

    await vi.waitFor(() =>
      expect(context.ui.setStatus).toHaveBeenCalledWith(
        "slack-listener",
        "Slack: 1 unread",
      ),
    );

    const command = commands.get("slack");
    expect(command).toBeDefined();
    await command?.handler("inbox 1", context);

    const editorText = String(context.ui.setEditorText.mock.calls.at(-1)?.[0]);
    expect(editorText).toContain("untrusted external content");
    expect(editorText).toContain('"text": "<@USELF> hello from Slack"');
    expect(sendUserMessage).not.toHaveBeenCalled();

    const shutdownHook = hooks.get("session_shutdown")?.[0];
    expect(shutdownHook).toBeDefined();
    await shutdownHook?.({ reason: "quit" }, context);
    expect(socket.disconnect).toHaveBeenCalled();
    expect(context.ui.setStatus).toHaveBeenLastCalledWith(
      "slack-listener",
      undefined,
    );
  });
});
