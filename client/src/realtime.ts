// realtime.ts — sovereign realtime client (Supabase Realtime-compatible subset).
//
// Connects to the @laetoli/realtime WebSocket service (behind Caddy at
// /realtime). Zero dependencies — uses the global `WebSocket`. A single shared
// socket is multiplexed across all channels, lazily opened on the first
// .subscribe(), authenticated via ?token=, and auto-reconnected with backoff.
//
// Usage mirrors supabase-js:
//   const ch = client.realtime
//     .channel('notes')
//     .on('INSERT', (p) => console.log(p.record), { column: 'user_id', value: me })
//     .subscribe();
//   // ...later
//   ch.unsubscribe();

/** DB-change events. */
export type RealtimeChangeEvent = '*' | 'INSERT' | 'UPDATE' | 'DELETE';
/**
 * The full event union a listener can register for: DB-change events plus the
 * two ephemeral, DB-independent realtime channels — 'broadcast' and 'presence'.
 */
export type RealtimeEvent = RealtimeChangeEvent | 'broadcast' | 'presence';

export interface RealtimeFilter {
  column: string;
  value: unknown;
}

/** A relayed broadcast message delivered to a 'broadcast' listener. */
export interface RealtimeBroadcast {
  channel: string;
  event: string;
  payload: unknown;
  /** JWT `sub` of the sender, when the server includes it. */
  from?: string;
}

/** A single presence entry as reported by the server. */
export interface RealtimePresence {
  ref: string;
  sub: string;
  state: Record<string, unknown>;
}

/** A presence frame delivered to a 'presence' listener. */
export interface RealtimePresenceEvent {
  channel: string;
  event: 'sync' | 'join' | 'leave';
  presences: RealtimePresence[];
}

/** Payload delivered to a channel listener. */
export interface RealtimeChange {
  channel: string;
  event: 'INSERT' | 'UPDATE' | 'DELETE';
  record: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  truncated?: boolean;
}

export type RealtimeCallback = (payload: RealtimeChange) => void;
export type BroadcastCallback = (payload: RealtimeBroadcast) => void;
export type PresenceCallback = (payload: RealtimePresenceEvent) => void;

type WsCtor = new (url: string) => WebSocket;

export interface RealtimeOptions {
  /** Inject a WebSocket implementation (defaults to global WebSocket). */
  WebSocketImpl?: WsCtor;
  /** Base reconnect delay in ms (doubles up to maxReconnectMs). Default 1000. */
  reconnectMs?: number;
  /** Max reconnect delay in ms. Default 15000. */
  maxReconnectMs?: number;
}

interface Listener {
  event: RealtimeChangeEvent;
  cb: RealtimeCallback;
  filter?: RealtimeFilter;
}

/**
 * Derive the ws(s) realtime URL from an http(s) base URL by swapping the scheme
 * and appending /realtime. Accepts a base that already ends in /realtime.
 */
export function deriveWsUrl(httpBase: string): string {
  const base = httpBase.replace(/\/+$/, '');
  const swapped = base.replace(/^http(s?):\/\//i, (_m, s) => `ws${s}://`);
  return /\/realtime$/.test(swapped) ? swapped : `${swapped}/realtime`;
}

export class RealtimeChannel {
  private listeners: Listener[] = [];
  private broadcastListeners: BroadcastCallback[] = [];
  private presenceListeners: PresenceCallback[] = [];
  private lastPresences: RealtimePresence[] = [];
  private subscribed = false;

  constructor(
    public readonly name: string,
    private readonly client: RealtimeClient,
  ) {}

  /**
   * Register a listener. Chainable, supabase-style.
   *
   *   .on('INSERT'|'UPDATE'|'DELETE'|'*', cb, filter?)  → DB-change rows
   *   .on('broadcast', cb)                              → relayed broadcasts
   *   .on('presence', cb)                               → presence sync/join/leave
   */
  on(event: 'broadcast', cb: BroadcastCallback): this;
  on(event: 'presence', cb: PresenceCallback): this;
  on(event: RealtimeChangeEvent, cb: RealtimeCallback, filter?: RealtimeFilter): this;
  on(
    event: RealtimeEvent,
    cb: RealtimeCallback | BroadcastCallback | PresenceCallback,
    filter?: RealtimeFilter,
  ): this {
    if (event === 'broadcast') {
      this.broadcastListeners.push(cb as BroadcastCallback);
      return this;
    }
    if (event === 'presence') {
      this.presenceListeners.push(cb as PresenceCallback);
      return this;
    }
    this.listeners.push({ event, cb: cb as RealtimeCallback, filter });
    // If already subscribed, (re)send subscribe so a newly-added filter applies.
    if (this.subscribed) this.client._sendSubscribe(this);
    return this;
  }

  /** Send an ephemeral broadcast on this channel (relayed to other subscribers). */
  send(message: { event: string; payload?: unknown }): this {
    this.client._sendBroadcast(this.name, message.event, message.payload);
    return this;
  }

  /** Announce/replace this client's presence on the channel. Chainable. */
  track(state: Record<string, unknown> = {}): this {
    this.client._sendPresenceTrack(this.name, state);
    return this;
  }

  /** Stop announcing presence on this channel. Chainable. */
  untrack(): this {
    this.client._sendPresenceUntrack(this.name);
    return this;
  }

  /** The last presence roster the server pushed for this channel. */
  presenceState(): RealtimePresence[] {
    return this.lastPresences.slice();
  }

  /** Open the socket (if needed) and subscribe this channel. Chainable. */
  subscribe(): this {
    this.subscribed = true;
    this.client._register(this);
    this.client._sendSubscribe(this);
    return this;
  }

  unsubscribe(): void {
    this.subscribed = false;
    this.client._sendUnsubscribe(this.name);
    this.client._unregister(this.name);
  }

  /** @internal — the server-side filter to request (first listener with one). */
  get _filter(): RealtimeFilter | undefined {
    return this.listeners.find((l) => l.filter)?.filter;
  }

  /** @internal — the broadest event to request (* if any listener wants *). */
  get _requestEvent(): RealtimeEvent {
    if (this.listeners.some((l) => l.event === '*')) return '*';
    const set = new Set(this.listeners.map((l) => l.event));
    // If multiple distinct concrete events, request '*' and filter client-side.
    return set.size === 1 ? ([...set][0] as RealtimeEvent) : '*';
  }

  get _isSubscribed(): boolean {
    return this.subscribed;
  }

  /** @internal — dispatch an incoming change to matching listeners. */
  _emit(change: RealtimeChange): void {
    for (const l of this.listeners) {
      if (l.event !== '*' && l.event !== change.event) continue;
      if (l.filter && !clientMatchesFilter(l.filter, change)) continue;
      try {
        l.cb(change);
      } catch {
        /* a listener throwing must not break the others */
      }
    }
  }

  /** @internal — dispatch an incoming broadcast to broadcast listeners. */
  _emitBroadcast(b: RealtimeBroadcast): void {
    for (const cb of this.broadcastListeners) {
      try {
        cb(b);
      } catch {
        /* isolate listener errors */
      }
    }
  }

  /** @internal — record the roster + dispatch a presence event. */
  _emitPresence(p: RealtimePresenceEvent): void {
    this.lastPresences = p.presences;
    for (const cb of this.presenceListeners) {
      try {
        cb(p);
      } catch {
        /* isolate listener errors */
      }
    }
  }
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private channels = new Map<string, RealtimeChannel>();
  private outbox: string[] = [];
  private authed = false;
  private connecting = false;
  private closedByUser = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly WebSocketImpl?: WsCtor;
  private readonly reconnectMs: number;
  private readonly maxReconnectMs: number;

  /**
   * @param wsUrl   Either an http(s) base URL (scheme is swapped + /realtime
   *                appended) or a ready ws(s) URL.
   * @param getToken Returns the current bearer token (or null when signed out).
   *
   * Note: a missing global WebSocket is NOT fatal here — `createClient` always
   * constructs a RealtimeClient, and storage/query must keep working in Node /
   * SSR. The WebSocket requirement is enforced lazily, only when you actually
   * connect (first `.subscribe()`).
   */
  constructor(
    private readonly wsUrl: string,
    private readonly getToken: () => string | null,
    opts: RealtimeOptions = {},
  ) {
    const G = globalThis as { WebSocket?: WsCtor };
    this.WebSocketImpl = opts.WebSocketImpl ?? G.WebSocket;
    this.reconnectMs = opts.reconnectMs ?? 1000;
    this.maxReconnectMs = opts.maxReconnectMs ?? 15000;
  }

  /** Get (or create) a channel for a table. */
  channel(name: string): RealtimeChannel {
    const existing = this.channels.get(name);
    if (existing) return existing;
    const ch = new RealtimeChannel(name, this);
    this.channels.set(name, ch);
    return ch;
  }

  /** Close the shared socket and forget all channels. */
  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.channels.clear();
    this.teardownSocket();
  }

  // ---- internals used by RealtimeChannel -----------------------------------

  /** @internal */
  _register(ch: RealtimeChannel): void {
    this.channels.set(ch.name, ch);
    this.ensureConnected();
  }

  /** @internal */
  _unregister(name: string): void {
    this.channels.delete(name);
  }

  /** @internal — send (or queue) a subscribe frame for a channel. */
  _sendSubscribe(ch: RealtimeChannel): void {
    this.ensureConnected();
    const frame: Record<string, unknown> = {
      type: 'subscribe',
      channel: ch.name,
      event: ch._requestEvent,
    };
    if (ch._filter) frame.filter = ch._filter;
    this.send(JSON.stringify(frame));
  }

  /** @internal */
  _sendUnsubscribe(name: string): void {
    this.send(JSON.stringify({ type: 'unsubscribe', channel: name }));
  }

  /** @internal — send (or queue) an ephemeral broadcast frame. */
  _sendBroadcast(channel: string, event: string, payload: unknown): void {
    this.ensureConnected();
    this.send(JSON.stringify({ type: 'broadcast', channel, event, payload }));
  }

  /** @internal — announce presence on a channel. */
  _sendPresenceTrack(channel: string, state: Record<string, unknown>): void {
    this.ensureConnected();
    this.send(JSON.stringify({ type: 'presence_track', channel, state }));
  }

  /** @internal — drop presence on a channel. */
  _sendPresenceUntrack(channel: string): void {
    this.send(JSON.stringify({ type: 'presence_untrack', channel }));
  }

  // ---- socket lifecycle ----------------------------------------------------

  private ensureConnected(): void {
    this.closedByUser = false;
    if (this.ws || this.connecting) return;
    this.connect();
  }

  private connect(): void {
    const WS = this.WebSocketImpl;
    if (!WS) {
      this.connecting = false;
      throw new Error(
        '@laetoli/data realtime: no global WebSocket — pass opts.WebSocketImpl (Node without ws / non-standard runtime).',
      );
    }
    this.connecting = true;
    this.authed = false;
    const token = this.getToken();
    const base = deriveWsUrl(this.wsUrl);
    const url = token ? `${base}?token=${encodeURIComponent(token)}` : base;

    let ws: WebSocket;
    try {
      ws = new WS(url);
    } catch {
      this.connecting = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connecting = false;
      this.reconnectAttempt = 0;
      // If we had no token in the URL, authenticate by message.
      if (!token) {
        const t = this.getToken();
        if (t) ws.send(JSON.stringify({ type: 'auth', token: t }));
      } else {
        // ?token= already authenticated us at the upgrade.
        this.authed = true;
      }
      this.flushAfterAuth();
    };

    ws.onmessage = (ev: MessageEvent) => {
      this.handleFrame(typeof ev.data === 'string' ? ev.data : String(ev.data));
    };

    ws.onclose = () => {
      this.teardownSocket();
      if (!this.closedByUser) this.scheduleReconnect();
    };

    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    };
  }

  private handleFrame(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'authenticated':
        this.authed = true;
        this.flushAfterAuth();
        return;
      case 'change': {
        const change: RealtimeChange = {
          channel: String(msg.channel),
          event: msg.event as RealtimeChange['event'],
          record: (msg.record as Record<string, unknown> | null) ?? null,
          old: (msg.old as Record<string, unknown> | null) ?? null,
          truncated: msg.truncated === true ? true : undefined,
        };
        this.channels.get(change.channel)?._emit(change);
        return;
      }
      case 'broadcast': {
        const b: RealtimeBroadcast = {
          channel: String(msg.channel),
          event: String(msg.event),
          payload: msg.payload,
          from: typeof msg.from === 'string' ? msg.from : undefined,
        };
        this.channels.get(b.channel)?._emitBroadcast(b);
        return;
      }
      case 'presence': {
        const ev = msg.event;
        const p: RealtimePresenceEvent = {
          channel: String(msg.channel),
          event: ev === 'join' || ev === 'leave' ? ev : 'sync',
          presences: Array.isArray(msg.presences)
            ? (msg.presences as RealtimePresence[])
            : [],
        };
        this.channels.get(p.channel)?._emitPresence(p);
        return;
      }
      case 'subscribed':
      case 'unsubscribed':
      case 'error':
      default:
        // Acks/errors are advisory; nothing else to do for the v1 subset.
        return;
    }
  }

  /** Re-subscribe all channels after (re)connect + auth, and drain outbox. */
  private flushAfterAuth(): void {
    if (!this.authed || !this.ws || this.ws.readyState !== this.ws.OPEN) return;
    // Re-subscribe every active channel (covers reconnects).
    for (const ch of this.channels.values()) {
      if (ch._isSubscribed) {
        const frame: Record<string, unknown> = {
          type: 'subscribe',
          channel: ch.name,
          event: ch._requestEvent,
        };
        if (ch._filter) frame.filter = ch._filter;
        this.ws.send(JSON.stringify(frame));
      }
    }
    // Drain anything queued before auth.
    const queued = this.outbox;
    this.outbox = [];
    for (const f of queued) this.ws.send(f);
  }

  private send(frame: string): void {
    if (this.ws && this.authed && this.ws.readyState === this.ws.OPEN) {
      this.ws.send(frame);
    } else {
      // Queue until the socket is open + authenticated. Avoid duplicating the
      // re-subscribe frames that flushAfterAuth already sends.
      if (!frame.includes('"type":"subscribe"')) this.outbox.push(frame);
    }
  }

  private scheduleReconnect(): void {
    if (this.closedByUser) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMs * 2 ** this.reconnectAttempt,
      this.maxReconnectMs,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // Only reconnect if there is still something to listen to.
      if (this.channels.size > 0) this.connect();
    }, delay);
    // Don't keep a Node process alive solely for reconnect.
    (this.reconnectTimer as { unref?: () => void })?.unref?.();
  }

  private teardownSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    this.connecting = false;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Client-side equality filter, mirroring the server's loose comparison. */
function clientMatchesFilter(filter: RealtimeFilter, change: RealtimeChange): boolean {
  const row = change.record ?? change.old;
  if (!row || !(filter.column in row)) return false;
  const a = row[filter.column];
  const b = filter.value;
  if (a === b) return true;
  if (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string')
  ) {
    return String(a) === String(b);
  }
  return false;
}
