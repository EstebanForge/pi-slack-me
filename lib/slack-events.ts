import { slackGet } from "./api";
import type { SlackChannel, SlackUser } from "./types";

const MAX_INBOX_MESSAGES = 100;
const MAX_SEEN_EVENT_IDS = 1_000;

function sanitizeSocketError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:xapp|xox[a-z]?)-[a-z0-9-]+\b/gi, "[REDACTED]")
    .replace(/\bwss:\/\/\S+/gi, "[REDACTED]");
}

export interface SocketModeClientLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface SlackInboxMessage {
  eventId: string;
  channelId: string;
  channelName: string;
  userId: string;
  userName: string;
  text: string;
  timestamp: string;
  threadTimestamp?: string;
  isMention: boolean;
}

export type SlackListenerState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "error";

export interface SlackListenerStatus {
  state: SlackListenerState;
  unread: number;
}

export interface SlackEventListenerOptions {
  socket: SocketModeClientLike;
  watchedChannels?: Iterable<string>;
  onStatusChange?: (status: SlackListenerStatus) => void;
  onMention?: (message: SlackInboxMessage) => void;
  onError?: (message: string) => void;
}

interface SlackAuthTestResponse {
  user_id?: string;
}

interface SlackMessageEvent {
  type?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  subtype?: string;
  bot_id?: string;
}

type OrdinaryPublicMessage = SlackMessageEvent & {
  type: "message";
  channel: string;
  channel_type: "channel";
  user: string;
  text: string;
  ts: string;
};

function isOrdinaryPublicMessage(
  event: SlackMessageEvent | undefined,
): event is OrdinaryPublicMessage {
  if (!event) return false;
  if (event.type !== "message" || event.channel_type !== "channel")
    return false;
  if (!event.channel || !event.user) return false;
  if (!event.text || !event.ts) return false;
  return !event.bot_id && !event.subtype;
}

interface SocketModeMessage {
  ack?: () => Promise<void>;
  body?: {
    event_id?: string;
  };
  event?: SlackMessageEvent;
}

interface StoredInboxMessage extends SlackInboxMessage {
  unread: boolean;
}

export class SlackEventListener {
  private readonly socket: SocketModeClientLike;
  private readonly watchedChannels: Set<string>;
  private readonly seenEventIds = new Set<string>();
  private readonly seenEventOrder: string[] = [];
  private readonly userNames = new Map<string, string>();
  private readonly pendingUserNames = new Map<string, Promise<string>>();
  private readonly channelNames = new Map<string, string>();
  private readonly pendingChannelNames = new Map<string, Promise<string>>();
  private readonly inbox: StoredInboxMessage[] = [];
  private readonly onStatusChange?: (status: SlackListenerStatus) => void;
  private readonly onMention?: (message: SlackInboxMessage) => void;
  private readonly onError?: (message: string) => void;
  private state: SlackListenerState = "stopped";
  private selfUserId?: string;
  private desiredRunning = false;
  private lifecycle = 0;
  private startPromise?: Promise<void>;

  constructor(options: SlackEventListenerOptions) {
    this.socket = options.socket;
    this.watchedChannels = new Set(options.watchedChannels ?? []);
    this.onStatusChange = options.onStatusChange;
    this.onMention = options.onMention;
    this.onError = options.onError;
    this.socket.on("message", (payload) => {
      void this.receive(payload).catch((error) => this.reportError(error));
    });
    this.socket.on("error", (error) => this.reportError(error));
    this.socket.on("reconnecting", () => {
      if (this.desiredRunning) this.setState("reconnecting");
    });
    this.socket.on("connected", () => {
      if (this.desiredRunning) this.setState("connected");
    });
    this.socket.on("disconnected", () => {
      this.setState(this.desiredRunning ? "disconnected" : "stopped");
    });
  }

  start(): Promise<void> {
    if (this.state === "connected") return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.desiredRunning = true;
    const lifecycle = ++this.lifecycle;
    this.setState("connecting");
    const startPromise = this.connect(lifecycle);
    this.startPromise = startPromise;
    const clearStartPromise = () => {
      if (this.startPromise === startPromise) this.startPromise = undefined;
    };
    void startPromise.then(clearStartPromise, clearStartPromise);
    return startPromise;
  }

  async stop(): Promise<void> {
    if (this.state === "stopped") return;
    this.desiredRunning = false;
    this.lifecycle += 1;
    await this.socket.disconnect();
    this.setState("stopped");
  }

  status(): SlackListenerStatus {
    return {
      state: this.state,
      unread: this.inbox.filter((message) => message.unread).length,
    };
  }

  readInbox(limit = 10): SlackInboxMessage[] {
    const messages = this.inbox.slice(-limit);
    for (const message of messages) message.unread = false;
    if (messages.length > 0) this.emitStatus();
    return messages.map(({ unread: _unread, ...message }) => message);
  }

  clearInbox(): number {
    const count = this.inbox.length;
    this.inbox.length = 0;
    if (count > 0) this.emitStatus();
    return count;
  }

  private async connect(lifecycle: number): Promise<void> {
    try {
      const auth = await slackGet<SlackAuthTestResponse>("auth.test");
      if (!auth.user_id)
        throw new Error("Slack auth.test did not return user_id.");
      this.selfUserId = auth.user_id;
      await this.socket.start();
      if (!this.desiredRunning || lifecycle !== this.lifecycle) {
        await this.socket.disconnect();
        return;
      }
      this.setState("connected");
    } catch (error) {
      if (lifecycle === this.lifecycle) {
        this.setState("error");
        this.reportError(error);
      }
      throw error;
    }
  }

  private async receive(payload: unknown): Promise<void> {
    const envelope = payload as SocketModeMessage;
    await this.acknowledge(envelope);

    const event = envelope.event;
    if (!isOrdinaryPublicMessage(event)) return;
    const selfUserId = this.selfUserId;
    if (!selfUserId || event.user === selfUserId) return;

    const isMention = event.text.includes(`<@${selfUserId}>`);
    if (!isMention && !this.watchedChannels.has(event.channel)) return;

    const eventId = envelope.body?.event_id ?? `${event.channel}:${event.ts}`;
    if (!this.rememberEvent(eventId)) return;
    await this.enqueue(event, eventId, isMention);
  }

  private async acknowledge(envelope: SocketModeMessage): Promise<void> {
    try {
      await envelope.ack?.();
    } catch (error) {
      this.reportError(error);
    }
  }

  private rememberEvent(eventId: string): boolean {
    if (this.seenEventIds.has(eventId)) return false;
    this.seenEventIds.add(eventId);
    this.seenEventOrder.push(eventId);
    if (this.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
      const expired = this.seenEventOrder.shift();
      if (expired) this.seenEventIds.delete(expired);
    }
    return true;
  }

  private async enqueue(
    event: OrdinaryPublicMessage,
    eventId: string,
    isMention: boolean,
  ): Promise<void> {
    const [userName, channelName] = await Promise.all([
      this.resolveUserName(event.user),
      this.resolveChannelName(event.channel),
    ]);
    const message: StoredInboxMessage = {
      eventId,
      channelId: event.channel,
      channelName,
      userId: event.user,
      userName,
      text: event.text,
      timestamp: event.ts,
      threadTimestamp: event.thread_ts,
      isMention,
      unread: true,
    };
    this.inbox.push(message);
    this.inbox.sort((left, right) =>
      left.timestamp.localeCompare(right.timestamp),
    );
    if (this.inbox.length > MAX_INBOX_MESSAGES) this.inbox.shift();
    this.emitStatus();
    if (isMention) {
      const { unread: _unread, ...publicMessage } = message;
      this.onMention?.(publicMessage);
    }
  }

  private setState(state: SlackListenerState): void {
    this.state = state;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.onStatusChange?.(this.status());
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(`Slack Socket Mode: ${sanitizeSocketError(error)}`);
    } catch {
      // UI callbacks must not interrupt Socket Mode event processing.
    }
  }

  private resolveUserName(userId: string): Promise<string> {
    return this.resolveName(
      userId,
      this.userNames,
      this.pendingUserNames,
      async () => {
        const response = await slackGet<{ user?: SlackUser }>("users.info", {
          query: { user: userId },
        });
        return (
          response.user?.profile?.display_name ||
          response.user?.profile?.real_name ||
          response.user?.real_name ||
          response.user?.name ||
          userId
        );
      },
    );
  }

  private resolveChannelName(channelId: string): Promise<string> {
    return this.resolveName(
      channelId,
      this.channelNames,
      this.pendingChannelNames,
      async () => {
        const response = await slackGet<{ channel?: SlackChannel }>(
          "conversations.info",
          { query: { channel: channelId } },
        );
        return response.channel?.name || channelId;
      },
    );
  }

  private resolveName(
    id: string,
    cache: Map<string, string>,
    pending: Map<string, Promise<string>>,
    lookup: () => Promise<string>,
  ): Promise<string> {
    const cached = cache.get(id);
    if (cached !== undefined) return Promise.resolve(cached);

    const active = pending.get(id);
    if (active) return active;

    const request = lookup()
      .catch(() => id)
      .then((name) => {
        cache.set(id, name);
        return name;
      })
      .finally(() => pending.delete(id));
    pending.set(id, request);
    return request;
  }
}
