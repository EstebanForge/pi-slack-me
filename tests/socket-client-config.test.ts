import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureSocketOptions = vi.hoisted(() => vi.fn());

vi.mock("@slack/socket-mode", () => ({
  LogLevel: { ERROR: "error" },
  SocketModeClient: class {
    constructor(options: unknown) {
      captureSocketOptions(options);
    }

    on(): this {
      return this;
    }

    async start(): Promise<void> {}

    async disconnect(): Promise<void> {}
  },
}));

import slackMe from "../extensions/index";

describe("default Socket Mode client", () => {
  beforeEach(() => {
    process.env.SLACK_USER_TOKEN = "xoxp-test";
    process.env.SLACK_APP_TOKEN = "xapp-test";
  });

  afterEach(() => {
    delete process.env.SLACK_USER_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    vi.restoreAllMocks();
    captureSocketOptions.mockClear();
  });

  it("disables unsafe SDK reconnects and suppresses raw SDK logging", async () => {
    let slackCommand:
      | {
          handler: (
            args: string,
            context: {
              hasUI: boolean;
              ui: {
                notify: ReturnType<typeof vi.fn>;
                setStatus: ReturnType<typeof vi.fn>;
              };
            },
          ) => Promise<void> | void;
        }
      | undefined;
    const pi = {
      registerFlag: vi.fn(),
      registerTool: vi.fn(),
      registerCommand: vi.fn((name: string, command: typeof slackCommand) => {
        if (name === "slack") slackCommand = command;
      }),
      on: vi.fn(),
    } as unknown as ExtensionAPI;
    slackMe(pi);

    await slackCommand?.handler("listen status", {
      hasUI: true,
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    });

    expect(captureSocketOptions).toHaveBeenCalledOnce();
    const options = captureSocketOptions.mock.calls[0]?.[0] as {
      autoReconnectEnabled: boolean;
      clientOptions: { retryConfig: { retries: number }; timeout: number };
      logger: {
        debug: (...args: unknown[]) => void;
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
        error: (...args: unknown[]) => void;
        getLevel: () => string;
      };
    };
    expect(options.autoReconnectEnabled).toBe(false);
    expect(options.clientOptions).toEqual({
      retryConfig: { retries: 0 },
      timeout: 10_000,
    });
    expect(options.logger.getLevel()).toBe("error");

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    options.logger.debug("debug");
    options.logger.info("info");
    options.logger.warn("warning");
    options.logger.error("wss://secret.example/?ticket=secret");
    expect(consoleError).not.toHaveBeenCalled();
  });
});
