import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackEventListener } from "../lib/slack-events";

const TEST_APP_TOKEN = ["xapp", "secret", "token"].join("-");

interface SocketEvent {
  ack: () => Promise<void>;
  body: {
    event_id: string;
    event: {
      type: "message";
      channel: string;
      channel_type: "channel";
      user: string;
      text: string;
      ts: string;
      subtype?: string;
      bot_id?: string;
    };
  };
  event: SocketEvent["body"]["event"];
}

class FakeSocketClient {
  readonly start = vi.fn().mockResolvedValue({ ok: true });
  readonly disconnect = vi.fn().mockResolvedValue(undefined);
  private readonly listeners = new Map<
    string,
    Array<(event: unknown) => void>
  >();

  on(event: string, listener: (event: unknown) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

function slackResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("SlackEventListener", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.SLACK_USER_TOKEN = "xoxp-test";
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete process.env.SLACK_USER_TOKEN;
  });

  it("acknowledges a mention and makes it available in the inbox", async () => {
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
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event: SocketEvent = {
      ack,
      body: {
        event_id: "Ev123",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "Can you review this, <@USELF>?",
          ts: "1786020000.000100",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(ack).toHaveBeenCalledOnce();
    expect(listener.readInbox(1)).toEqual([
      expect.objectContaining({
        eventId: "Ev123",
        channelId: "C123",
        channelName: "engineering",
        userId: "UOTHER",
        userName: "Alice",
        text: "Can you review this, <@USELF>?",
        isMention: true,
      }),
    ]);
  });

  it("retains non-mention messages only from explicitly watched channels", async () => {
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

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({
      socket,
      watchedChannels: ["CWATCHED"],
    });
    await listener.start();

    const watchedAck = vi.fn().mockResolvedValue(undefined);
    const watched: SocketEvent = {
      ack: watchedAck,
      body: {
        event_id: "EvWatched",
        event: {
          type: "message",
          channel: "CWATCHED",
          channel_type: "channel",
          user: "UOTHER",
          text: "A watched-channel update",
          ts: "1786020000.000200",
        },
      },
      event: undefined as never,
    };
    watched.event = watched.body.event;

    const otherAck = vi.fn().mockResolvedValue(undefined);
    const other: SocketEvent = {
      ack: otherAck,
      body: {
        event_id: "EvOther",
        event: {
          type: "message",
          channel: "COTHER",
          channel_type: "channel",
          user: "UOTHER",
          text: "An unrelated update",
          ts: "1786020000.000300",
        },
      },
      event: undefined as never,
    };
    other.event = other.body.event;

    socket.emit("message", watched);
    socket.emit("message", other);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(watchedAck).toHaveBeenCalledOnce();
    expect(otherAck).toHaveBeenCalledOnce();
    expect(listener.readInbox(10)).toEqual([
      expect.objectContaining({
        eventId: "EvWatched",
        channelId: "CWATCHED",
        text: "A watched-channel update",
        isMention: false,
      }),
    ]);
  });

  it("acknowledges but ignores own, bot, and message-subtype events", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (
      eventId: string,
      overrides: Partial<SocketEvent["body"]["event"]>,
    ): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: "<@USELF> please run this",
        ts: `1786020000.${eventId}`,
        ...overrides,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    const events = [
      makeEvent("000401", { user: "USELF" }),
      makeEvent("000402", { bot_id: "B123" }),
      makeEvent("000403", { subtype: "message_changed" }),
    ];
    for (const event of events) socket.emit("message", event);

    await vi.waitFor(() => {
      for (const event of events) expect(event.ack).toHaveBeenCalledOnce();
    });
    expect(listener.status().unread).toBe(0);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("retains user-authored thread broadcasts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const event: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvThreadBroadcast",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> this reply was also sent to the channel",
          ts: "1786020000.000450",
          subtype: "thread_broadcast",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(1)).toEqual([
      expect.objectContaining({
        eventId: "EvThreadBroadcast",
        isMention: true,
      }),
    ]);
  });

  it("acknowledges Slack retries without duplicating the inbox message", async () => {
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
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event: SocketEvent = {
      ack,
      body: {
        event_id: "EvRetry",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> retry-safe message",
          ts: "1786020000.000500",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;

    socket.emit("message", event);
    socket.emit("message", event);

    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(10)).toHaveLength(1);
  });

  it("caches concurrent user and channel name lookups", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
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
          channel: { id: "C123", name: "engineering" },
        });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (eventId: string): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: `<@USELF> message ${eventId}`,
        ts: `1786020000.${eventId}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("000601"));
    socket.emit("message", makeEvent("000602"));

    await vi.waitFor(() => expect(listener.status().unread).toBe(2));
    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls.filter((url) => url.includes("users.info"))).toHaveLength(1);
    expect(
      urls.filter((url) => url.includes("conversations.info")),
    ).toHaveLength(1);
  });

  it("keeps only the latest 100 inbox messages", async () => {
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
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (index: number): SocketEvent => {
      const suffix = String(index).padStart(6, "0");
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user: "UOTHER",
        text: `<@USELF> message ${index}`,
        ts: `1786020000.${suffix}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: `Ev${suffix}`, event },
        event,
      };
    };

    socket.emit("message", makeEvent(1));
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    for (let index = 2; index <= 101; index += 1) {
      socket.emit("message", makeEvent(index));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(listener.status().unread).toBe(100);
    const messages = listener.readInbox(100);
    expect(messages).toHaveLength(100);
    expect(messages[0]?.eventId).toBe("Ev000002");
    expect(messages.at(-1)?.eventId).toBe("Ev000101");
  });

  it("marks displayed messages read and clears retained messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({
            ok: true,
            channel: { id: "C123", name: "engineering" },
          });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const event: SocketEvent = {
      ack: vi.fn().mockResolvedValue(undefined),
      body: {
        event_id: "EvClear",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> clearable message",
          ts: "1786020000.000700",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(listener.readInbox(1)).toHaveLength(1);
    expect(listener.status().unread).toBe(0);
    expect(listener.clearInbox()).toBe(1);
    expect(listener.readInbox(10)).toEqual([]);
  });

  it("reports unread changes and notifies only for mentions", async () => {
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

    const socket = new FakeSocketClient();
    const onStatusChange = vi.fn();
    const onMention = vi.fn();
    const listener = new SlackEventListener({
      socket,
      watchedChannels: ["CWATCHED"],
      onStatusChange,
      onMention,
    });
    await listener.start();
    onStatusChange.mockClear();

    const makeEvent = (eventId: string, text: string): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "CWATCHED",
        channel_type: "channel" as const,
        user: "UOTHER",
        text,
        ts: `1786020000.${eventId}`,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("000801", "watched update"));
    socket.emit("message", makeEvent("000802", "<@USELF> direct mention"));

    await vi.waitFor(() => expect(listener.status().unread).toBe(2));
    expect(onMention).toHaveBeenCalledOnce();
    expect(onMention).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "000802", isMention: true }),
    );
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 2,
    });

    listener.readInbox(1);
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 1,
    });
    listener.clearInbox();
    expect(onStatusChange).toHaveBeenLastCalledWith({
      state: "connected",
      unread: 0,
    });
  });

  it("tracks reconnection and disconnects cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();
    expect(listener.status().state).toBe("connected");

    socket.emit("reconnecting");
    expect(listener.status().state).toBe("reconnecting");
    socket.emit("connected");
    expect(listener.status().state).toBe("connected");

    await listener.stop();
    expect(socket.disconnect).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("stopped");

    await listener.stop();
    expect(socket.disconnect).toHaveBeenCalledOnce();
  });

  it("force-closes a socket whose first disconnect does not settle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let finishFirstDisconnect: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.disconnect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstDisconnect = () => resolve(undefined);
          }),
      )
      .mockImplementationOnce(async () => finishFirstDisconnect?.());
    const listener = new SlackEventListener({ socket });
    await listener.start();

    vi.useFakeTimers();
    const stopping = listener.stop();
    await vi.advanceTimersByTimeAsync(999);
    expect(socket.disconnect).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("stopped");
  });

  it("retries dropped connections without leaking rejected reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const reconnectError = new Error("network still unavailable");
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(async () => {
        socket.emit("error", reconnectError);
        throw reconnectError;
      })
      .mockResolvedValueOnce({ ok: true });
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Slack Socket Mode: network still unavailable",
    );
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.start).toHaveBeenCalledTimes(3);
    expect(listener.status().state).toBe("connected");

    await listener.stop();
  });

  it("stops retrying and warning after six failed reconnect attempts", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockRejectedValue(new Error("permanent outage"));
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }

    expect(socket.start).toHaveBeenCalledTimes(7);
    expect(onError).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("error");

    socket.emit("disconnected");
    expect(listener.status().state).toBe("error");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.start).toHaveBeenCalledTimes(7);
    await listener.stop();
  });

  it("times out stalled socket reconnects before continuing backoff", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let rejectStalledStart: ((error: Error) => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start
      .mockResolvedValueOnce({ ok: true })
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectStalledStart = reject;
          }),
      )
      .mockResolvedValueOnce({ ok: true });
    socket.disconnect.mockImplementation(async () => {
      rejectStalledStart?.(new Error("disconnected"));
      rejectStalledStart = undefined;
    });
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    socket.emit("disconnected");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(socket.start).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      "Slack Socket Mode: connection timed out.",
    );
    expect(listener.status().state).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(socket.start).toHaveBeenCalledTimes(3);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("continues after acknowledgement errors without exposing connection secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("users.info")) {
          return slackResponse({ ok: true, user: { id: "UOTHER" } });
        }
        if (url.includes("conversations.info")) {
          return slackResponse({ ok: true, channel: { id: "C123" } });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });
    await listener.start();

    const event: SocketEvent = {
      ack: vi
        .fn()
        .mockRejectedValue(
          new Error(
            `failed ${TEST_APP_TOKEN} at wss://wss-primary.slack.com/link/?ticket=secret`,
          ),
        ),
      body: {
        event_id: "EvAckFailure",
        event: {
          type: "message",
          channel: "C123",
          channel_type: "channel",
          user: "UOTHER",
          text: "<@USELF> still retain this",
          ts: "1786020000.000900",
        },
      },
      event: undefined as never,
    };
    event.event = event.body.event;
    socket.emit("message", event);

    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    expect(onError).toHaveBeenCalledOnce();
    const message = String(onError.mock.calls[0]?.[0]);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(TEST_APP_TOKEN);
    expect(message).not.toContain("wss://");
  });

  it("coalesces concurrent start requests", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });

    await Promise.all([listener.start(), listener.start()]);

    expect(socket.start).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(listener.status().state).toBe("connected");
  });

  it("waits for in-flight socket startup before shutdown completes", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      if (url.includes("users.info")) {
        return slackResponse({ ok: true, user: { id: "UOTHER" } });
      }
      if (url.includes("conversations.info")) {
        return slackResponse({ ok: true, channel: { id: "C123" } });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    let finishStart: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishStart = () => resolve({ ok: true });
        }),
    );
    const onMention = vi.fn();
    const listener = new SlackEventListener({ socket, onMention });

    const starting = listener.start();
    await vi.waitFor(() => expect(socket.start).toHaveBeenCalledOnce());
    let stopSettled = false;
    const stopping = listener.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    const ack = vi.fn().mockResolvedValue(undefined);
    const event = {
      type: "message",
      channel: "C123",
      channel_type: "channel",
      user: "UOTHER",
      text: "<@USELF> arrived during shutdown",
      ts: "1786020000.000950",
    };
    socket.emit("message", {
      ack,
      body: { event_id: "EvDuringShutdown", event },
      event,
    });
    await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stopSettled).toBe(false);
    expect(listener.status().unread).toBe(0);
    expect(onMention).not.toHaveBeenCalled();
    finishStart?.();
    await Promise.all([starting, stopping]);

    expect(listener.status().state).toBe("stopped");
    expect(socket.disconnect).toHaveBeenCalledTimes(2);
  });

  it("bounds shutdown when socket startup and disconnect never settle", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    let finishStart: (() => void) | undefined;
    let finishDisconnect: (() => void) | undefined;
    const socket = new FakeSocketClient();
    socket.start
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishStart = () => resolve({ ok: true });
          }),
      )
      .mockResolvedValue({ ok: true });
    socket.disconnect
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDisconnect = () => resolve(undefined);
          }),
      )
      .mockResolvedValue(undefined);
    const listener = new SlackEventListener({ socket });

    const starting = listener.start();
    await vi.waitFor(() => expect(socket.start).toHaveBeenCalledOnce());
    vi.useFakeTimers();
    const stopping = listener.stop();
    const rejection = expect(stopping).rejects.toThrow(
      "Slack Socket Mode shutdown timed out.",
    );

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(listener.status().state).toBe("stopped");
    await expect(listener.start()).rejects.toThrow(
      "Slack Socket Mode is still shutting down.",
    );
    expect(socket.start).toHaveBeenCalledOnce();

    finishStart?.();
    finishDisconnect?.();
    await starting;

    await listener.start();
    expect(socket.start).toHaveBeenCalledTimes(2);
    expect(listener.status().state).toBe("connected");
    await listener.stop();
  });

  it("does not open a socket when shutdown happens during authentication", async () => {
    let finishAuth: (() => void) | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("auth.test")) {
        await new Promise<void>((resolve) => {
          finishAuth = resolve;
        });
        return slackResponse({ ok: true, user_id: "USELF" });
      }
      throw new Error(`Unexpected Slack request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });

    const starting = listener.start();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await listener.stop();
    finishAuth?.();
    await starting;

    expect(socket.start).not.toHaveBeenCalled();
    expect(listener.status().state).toBe("stopped");
  });

  it("reports startup failures without exposing connection secrets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    socket.start.mockRejectedValue(
      new Error(
        `invalid ${TEST_APP_TOKEN} for wss://wss-primary.slack.com/link/?ticket=secret`,
      ),
    );
    const onError = vi.fn();
    const listener = new SlackEventListener({ socket, onError });

    await expect(listener.start()).rejects.toThrow();

    expect(listener.status().state).toBe("error");
    expect(onError).toHaveBeenCalledOnce();
    const message = String(onError.mock.calls[0]?.[0]);
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain(TEST_APP_TOKEN);
    expect(message).not.toContain("wss://");
  });

  it("keeps inbox order stable when name lookups finish out of order", async () => {
    let finishFirstUser: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/auth.test")) {
          return slackResponse({ ok: true, user_id: "USELF" });
        }
        if (url.includes("/users.info")) {
          const query = url.split("?", 2)[1] ?? "";
          const userId = new URLSearchParams(query).get("user");
          if (userId === "UFIRST") {
            await new Promise<void>((resolve) => {
              finishFirstUser = resolve;
            });
          }
          return slackResponse({ ok: true, user: { id: userId } });
        }
        if (url.includes("/conversations.info")) {
          return slackResponse({ ok: true, channel: { id: "C123" } });
        }
        throw new Error(`Unexpected Slack request: ${url}`);
      }),
    );

    const socket = new FakeSocketClient();
    const listener = new SlackEventListener({ socket });
    await listener.start();

    const makeEvent = (
      eventId: string,
      user: string,
      timestamp: string,
    ): SocketEvent => {
      const event = {
        type: "message" as const,
        channel: "C123",
        channel_type: "channel" as const,
        user,
        text: `<@USELF> ${eventId}`,
        ts: timestamp,
      };
      return {
        ack: vi.fn().mockResolvedValue(undefined),
        body: { event_id: eventId, event },
        event,
      };
    };

    socket.emit("message", makeEvent("EvFirst", "UFIRST", "1786020000.001100"));
    await vi.waitFor(() => expect(finishFirstUser).toBeDefined());
    socket.emit(
      "message",
      makeEvent("EvSecond", "USECOND", "1786020000.001200"),
    );
    await vi.waitFor(() => expect(listener.status().unread).toBe(1));
    finishFirstUser?.();
    await vi.waitFor(() => expect(listener.status().unread).toBe(2));

    expect(listener.readInbox(10).map((message) => message.eventId)).toEqual([
      "EvFirst",
      "EvSecond",
    ]);
  });
});
