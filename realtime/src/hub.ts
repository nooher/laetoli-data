// hub.ts — the subscription registry + fan-out engine.
//
// This is the heart of the realtime service and is PURE / framework-free:
//   * It does not import `ws` or `pg`.
//   * A "client" is any object that exposes a `send(data: string)` method and a
//     stable identity — in production that's a WebSocket, in tests it's a fake
//     with a spy. This keeps the matching/fan-out logic exhaustively unit-test-
//     able without real sockets or a live database.
//
// Given a parsed notification (what Postgres NOTIFY delivered) and the current
// set of subscriptions, the hub computes exactly who receives what and pushes
// a `{ type:'change', ... }` frame to each matching client.

export type ChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';
export type SubscribeEvent = '*' | ChangeEvent;

/** A row-change notification, as published by the Postgres trigger. */
export interface Notification {
  schema: string;
  table: string;
  type: ChangeEvent;
  record: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  /** true when the row was too large for NOTIFY and `record` was dropped. */
  truncated?: boolean;
}

/** Optional equality filter applied server-side against the changed `record`. */
export interface SubscriptionFilter {
  column: string;
  value: unknown;
}

/** Anything the hub can push a frame to. WebSocket satisfies this. */
export interface SendTarget {
  send(data: string): void;
}

interface Subscription {
  channel: string; // the table name the client subscribed to
  event: SubscribeEvent;
  filter?: SubscriptionFilter;
}

interface ClientState {
  target: SendTarget;
  claims: { sub: string; role: string };
  /** keyed by channel name — one subscription per channel per client. */
  subs: Map<string, Subscription>;
}

/** A single presence entry: a connection's announced state + its JWT identity. */
export interface Presence {
  /** Stable per-connection key (unique per socket, even for the same `sub`). */
  ref: string;
  /** The JWT `sub` of the connection that owns this presence. */
  sub: string;
  /** Arbitrary client-supplied JSON state (e.g. { name, cursor }). */
  state: Record<string, unknown>;
}

export type PresenceEvent = 'sync' | 'join' | 'leave';

/** Outbound message shapes (what the server sends to clients). */
export type OutboundMessage =
  | { type: 'change'; channel: string; event: ChangeEvent; record: Record<string, unknown> | null; old: Record<string, unknown> | null; truncated?: boolean }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'broadcast'; channel: string; event: string; payload: unknown; from?: string }
  | { type: 'presence'; channel: string; event: PresenceEvent; presences: Presence[] }
  | { type: 'error'; message: string };

/** Inbound message shapes (what clients send to the server). */
export interface InboundSubscribe {
  type: 'subscribe';
  channel: string;
  event?: SubscribeEvent;
  filter?: SubscriptionFilter;
}
export interface InboundUnsubscribe {
  type: 'unsubscribe';
  channel: string;
}
export interface InboundBroadcast {
  type: 'broadcast';
  channel: string;
  event: string;
  payload: unknown;
}
export interface InboundPresenceTrack {
  type: 'presence_track';
  channel: string;
  state?: Record<string, unknown>;
}
export interface InboundPresenceUntrack {
  type: 'presence_untrack';
  channel: string;
}

const EVENTS: ReadonlySet<string> = new Set(['*', 'INSERT', 'UPDATE', 'DELETE']);

/** Default owner columns when none are configured. */
export const DEFAULT_OWNER_COLUMNS: readonly string[] = ['user_id', 'owner'];

/**
 * Roles that bypass owner-scoped filtering and receive every change on a table
 * they subscribe to (e.g. a trusted backend/service consumer). Mirrors the
 * BYPASSRLS spirit of the admin role at the DB layer.
 */
const ADMIN_ROLES: ReadonlySet<string> = new Set(['service', 'laetoli_admin']);

/** A connection as seen by the owner-filter: just identity + subscription. */
export interface SubscriberView {
  claims: { sub: string; role: string };
  sub: Subscription;
}

/**
 * Decide which of `subscribers` is entitled to see `change`, applying the
 * owner-scoping gate FIRST (before event/equality-filter matching, which the
 * caller still applies). Pure + exhaustively unit-testable.
 *
 * Rules:
 *   1. Find the row's owner: the first `ownerColumns` entry present in `record`
 *      (or `old` for DELETE). "Present" = the key exists on the row object.
 *   2. If the row has NO owner column → table-level broadcast (back-compat):
 *      every subscriber is a candidate. Such tables are UNFILTERED — only
 *      enable realtime on them if their rows are safe for any subscriber.
 *   3. If the row HAS an owner column → deliver ONLY to subscribers whose
 *      claims.sub === the owner value, plus any admin/service-role subscriber.
 *   4. FAIL CLOSED: if the change is `truncated` (the trigger dropped `record`
 *      so the owner cannot be determined), an owner-scoped subscription cannot
 *      be proven entitled → exclude all non-admin subscribers. Admin/service
 *      roles still receive it. We cannot tell whether a truncated row was
 *      owner-scoped, so we treat it as if it MIGHT be and refuse to leak it to
 *      non-owners; the back-compat broadcast does NOT apply to truncated rows.
 */
export function recipientsFor(
  change: Notification,
  subscribers: readonly SubscriberView[],
  ownerColumns: readonly string[] = DEFAULT_OWNER_COLUMNS,
): SubscriberView[] {
  const row = change.record ?? change.old;

  // FAIL CLOSED on truncated payloads: owner is unknowable. Only admins pass.
  if (change.truncated || !row) {
    if (change.truncated) {
      return subscribers.filter((s) => ADMIN_ROLES.has(s.claims.role));
    }
    // Non-truncated but no row body at all (shouldn't happen for INSERT/UPDATE;
    // a DELETE always carries `old`). Treat as unfiltered broadcast.
    return subscribers.slice();
  }

  // Locate an owner column on the row (first match wins).
  let ownerValue: unknown;
  let hasOwnerColumn = false;
  for (const col of ownerColumns) {
    if (col in row) {
      ownerValue = row[col];
      hasOwnerColumn = true;
      break;
    }
  }

  // No recognized owner column → table-level broadcast (back-compat).
  if (!hasOwnerColumn) {
    return subscribers.slice();
  }

  // Owner-scoped: only the owner (by JWT sub) or an admin/service role.
  return subscribers.filter(
    (s) => ADMIN_ROLES.has(s.claims.role) || ownerMatches(s.claims.sub, ownerValue),
  );
}

/** Compare a subscriber's `sub` to a row's owner value (string-loose). */
function ownerMatches(sub: string, ownerValue: unknown): boolean {
  if (ownerValue === null || ownerValue === undefined) return false;
  if (typeof ownerValue === 'string') return sub === ownerValue;
  if (typeof ownerValue === 'number') return sub === String(ownerValue);
  return false;
}

// ---------------------------------------------------------------------------
// Broadcast + Presence — DB-independent, channel-membership-based realtime.
//
// SECURITY NOTE: broadcast and presence are NOT DB rows, so the owner-RLS gate
// in `recipientsFor` does NOT apply to them. Every subscriber of a channel sees
// every broadcast and every presence entry on that channel. Do NOT put secrets
// in broadcast payloads or presence state — treat them as visible to all
// channel subscribers.
// ---------------------------------------------------------------------------

/** A view of a channel subscriber for broadcast routing: identity + send key. */
export interface BroadcastSubscriber<T> {
  /** Stable per-connection key (the SendTarget in production). */
  conn: T;
}

/**
 * Pure broadcast recipient computation. Given the connections subscribed to a
 * channel and the originating connection, returns every connection that should
 * receive the relayed broadcast.
 *
 *   * `echoSelf=false` (default): all subscribers EXCEPT `fromConn`.
 *   * `echoSelf=true`: all subscribers, including the sender.
 *
 * The sender need not be in `subscribers` (a client may broadcast without
 * subscribing); the exclusion is by reference identity.
 */
export function broadcastRecipients<T>(
  subscribers: readonly T[],
  fromConn: T,
  echoSelf = false,
): T[] {
  if (echoSelf) return subscribers.slice();
  return subscribers.filter((c) => c !== fromConn);
}

/**
 * Per-channel presence store keyed by connection. Pure + framework-free: a
 * "connection" is any object used as a stable identity key (a WebSocket in
 * production, a fake in tests). Tracks one presence entry per (channel, conn).
 *
 * The registry only mutates state and reports snapshots; it does NOT send. The
 * Hub decides when to push presence frames to channel subscribers.
 */
export class PresenceRegistry<T> {
  /** channel -> (conn -> Presence). */
  private byChannel = new Map<string, Map<T, Presence>>();
  /** stable ref per connection, assigned lazily on first use. */
  private refs = new Map<T, string>();
  private nextRef = 1;

  /** Get (or assign) the stable presence ref string for a connection. */
  refFor(conn: T): string {
    let r = this.refs.get(conn);
    if (!r) {
      r = `c${this.nextRef++}`;
      this.refs.set(conn, r);
    }
    return r;
  }

  /**
   * Record/replace a connection's presence on a channel. Returns the resulting
   * Presence entry (so the caller can announce a join/update).
   */
  track(channel: string, conn: T, sub: string, state: Record<string, unknown>): Presence {
    let map = this.byChannel.get(channel);
    if (!map) {
      map = new Map();
      this.byChannel.set(channel, map);
    }
    const entry: Presence = { ref: this.refFor(conn), sub, state };
    map.set(conn, entry);
    return entry;
  }

  /**
   * Remove a connection's presence from one channel. Returns true if an entry
   * was actually removed (so the caller knows whether to announce a leave).
   */
  untrack(channel: string, conn: T): boolean {
    const map = this.byChannel.get(channel);
    if (!map) return false;
    const removed = map.delete(conn);
    if (map.size === 0) this.byChannel.delete(channel);
    return removed;
  }

  /**
   * Remove a connection from ALL channels (on socket close). Returns the list
   * of channels it was present on (so the caller can announce a leave on each).
   */
  removeConnection(conn: T): string[] {
    const left: string[] = [];
    for (const [channel, map] of this.byChannel) {
      if (map.delete(conn)) {
        left.push(channel);
        if (map.size === 0) this.byChannel.delete(channel);
      }
    }
    this.refs.delete(conn);
    return left;
  }

  /** Snapshot of all presences currently on a channel (stable order). */
  snapshot(channel: string): Presence[] {
    const map = this.byChannel.get(channel);
    if (!map) return [];
    return [...map.values()].map((p) => ({ ref: p.ref, sub: p.sub, state: p.state }));
  }

  /** Whether a connection currently has presence on a channel. */
  has(channel: string, conn: T): boolean {
    return this.byChannel.get(channel)?.has(conn) ?? false;
  }
}

export class Hub {
  private clients = new Map<SendTarget, ClientState>();
  private presence = new PresenceRegistry<SendTarget>();
  private readonly broadcastSelf: boolean;
  private readonly ownerColumns: readonly string[];

  constructor(
    ownerColumns: readonly string[] = DEFAULT_OWNER_COLUMNS,
    broadcastSelf = false,
  ) {
    this.ownerColumns = ownerColumns.length > 0 ? ownerColumns : DEFAULT_OWNER_COLUMNS;
    this.broadcastSelf = broadcastSelf;
  }

  /** Number of connected clients (test/observability helper). */
  get clientCount(): number {
    return this.clients.size;
  }

  /** Register a freshly-authenticated client. Idempotent per target. */
  add(target: SendTarget, claims: { sub: string; role: string }): void {
    if (!this.clients.has(target)) {
      this.clients.set(target, { target, claims, subs: new Map() });
    }
  }

  /** Drop a client (on socket close). Safe to call for unknown targets. */
  remove(target: SendTarget): void {
    this.clients.delete(target);
    // Clean up presence and announce a leave on every channel it was on.
    const leftChannels = this.presence.removeConnection(target);
    for (const channel of leftChannels) {
      this.announcePresence(channel, 'leave');
    }
  }

  /** Total active subscriptions across all clients (test helper). */
  subscriptionCount(): number {
    let n = 0;
    for (const c of this.clients.values()) n += c.subs.size;
    return n;
  }

  /**
   * Handle a raw inbound text frame from a client. Parses + validates it,
   * applies the subscribe/unsubscribe, and sends the appropriate ack or error.
   * Never throws — protocol errors become `{ type:'error' }` frames.
   */
  handleMessage(target: SendTarget, raw: string): void {
    const state = this.clients.get(target);
    if (!state) return; // unknown/unauthenticated target — ignore.

    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(target, { type: 'error', message: 'Ujumbe si JSON sahihi. (Message is not valid JSON.)' });
      return;
    }

    if (!msg || typeof msg !== 'object') {
      this.send(target, { type: 'error', message: 'Ujumbe si sahihi. (Malformed message.)' });
      return;
    }

    const m = msg as Record<string, unknown>;
    switch (m.type) {
      case 'subscribe':
        this.subscribe(state, m);
        return;
      case 'unsubscribe':
        this.unsubscribe(state, m);
        return;
      case 'broadcast':
        this.broadcast(state, m);
        return;
      case 'presence_track':
        this.presenceTrack(state, m);
        return;
      case 'presence_untrack':
        this.presenceUntrack(state, m);
        return;
      case 'auth':
        // Auth-by-message is handled at the connection layer; ack benignly so a
        // client that authed via ?token= and also sends {type:'auth'} is fine.
        return;
      default:
        this.send(target, {
          type: 'error',
          message: `Aina ya ujumbe haijulikani: ${String(m.type)}. (Unknown message type.)`,
        });
    }
  }

  private subscribe(state: ClientState, m: Record<string, unknown>): void {
    const channel = m.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      this.send(state.target, { type: 'error', message: 'subscribe inahitaji "channel". (subscribe requires a channel.)' });
      return;
    }
    const event = (m.event ?? '*') as unknown;
    if (typeof event !== 'string' || !EVENTS.has(event)) {
      this.send(state.target, {
        type: 'error',
        message: 'event lazima iwe *|INSERT|UPDATE|DELETE. (Invalid event.)',
      });
      return;
    }

    let filter: SubscriptionFilter | undefined;
    if (m.filter !== undefined && m.filter !== null) {
      const f = m.filter as Record<string, unknown>;
      if (typeof f.column !== 'string' || f.column.length === 0 || !('value' in f)) {
        this.send(state.target, {
          type: 'error',
          message: 'filter lazima iwe { column, value }. (Invalid filter.)',
        });
        return;
      }
      filter = { column: f.column, value: f.value };
    }

    state.subs.set(channel, { channel, event: event as SubscribeEvent, filter });
    this.send(state.target, { type: 'subscribed', channel });
    // On subscribe, push the current presence roster so the newcomer sees who
    // is already online on this channel.
    this.send(state.target, {
      type: 'presence',
      channel,
      event: 'sync',
      presences: this.presence.snapshot(channel),
    });
  }

  private unsubscribe(state: ClientState, m: Record<string, unknown>): void {
    const channel = m.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      this.send(state.target, { type: 'error', message: 'unsubscribe inahitaji "channel". (unsubscribe requires a channel.)' });
      return;
    }
    state.subs.delete(channel);
    this.send(state.target, { type: 'unsubscribed', channel });
    // Leaving a channel also drops any presence the client had there.
    if (this.presence.untrack(channel, state.target)) {
      this.announcePresence(channel, 'leave');
    }
  }

  /**
   * Relay an ephemeral broadcast to other subscribers of the channel. No DB, no
   * persistence, no owner-RLS gate — channel membership is the only gate. The
   * sender does NOT need to be subscribed to broadcast. By default the sender is
   * excluded; `broadcastSelf` (config) echoes back to the sender too.
   */
  private broadcast(state: ClientState, m: Record<string, unknown>): void {
    const channel = m.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      this.send(state.target, { type: 'error', message: 'broadcast inahitaji "channel". (broadcast requires a channel.)' });
      return;
    }
    if (typeof m.event !== 'string' || m.event.length === 0) {
      this.send(state.target, { type: 'error', message: 'broadcast inahitaji "event". (broadcast requires an event.)' });
      return;
    }
    const subscribers = this.channelSubscribers(channel);
    const recipients = broadcastRecipients(subscribers, state.target, this.broadcastSelf);
    const frame: OutboundMessage = {
      type: 'broadcast',
      channel,
      event: m.event,
      payload: m.payload,
      from: state.claims.sub,
    };
    const payload = JSON.stringify(frame);
    for (const target of recipients) {
      try {
        target.send(payload);
      } catch {
        /* a dead socket must not abort the relay to others */
      }
    }
  }

  /** Announce/replace this connection's presence on a channel, then broadcast a join. */
  private presenceTrack(state: ClientState, m: Record<string, unknown>): void {
    const channel = m.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      this.send(state.target, { type: 'error', message: 'presence_track inahitaji "channel". (presence_track requires a channel.)' });
      return;
    }
    const rawState = m.state;
    const presenceState: Record<string, unknown> =
      rawState !== null && typeof rawState === 'object' && !Array.isArray(rawState)
        ? (rawState as Record<string, unknown>)
        : {};
    this.presence.track(channel, state.target, state.claims.sub, presenceState);
    this.announcePresence(channel, 'join');
  }

  /** Remove this connection's presence on a channel, then broadcast a leave. */
  private presenceUntrack(state: ClientState, m: Record<string, unknown>): void {
    const channel = m.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      this.send(state.target, { type: 'error', message: 'presence_untrack inahitaji "channel". (presence_untrack requires a channel.)' });
      return;
    }
    if (this.presence.untrack(channel, state.target)) {
      this.announcePresence(channel, 'leave');
    }
  }

  /** All connections currently subscribed to a channel. */
  private channelSubscribers(channel: string): SendTarget[] {
    const out: SendTarget[] = [];
    for (const state of this.clients.values()) {
      if (state.subs.has(channel)) out.push(state.target);
    }
    return out;
  }

  /**
   * Push a presence frame (the FULL current roster) to every subscriber of a
   * channel. We send the complete snapshot on join/leave so clients can simply
   * replace their local presence map — robust against any missed frame.
   */
  private announcePresence(channel: string, event: PresenceEvent): void {
    const presences = this.presence.snapshot(channel);
    const frame: OutboundMessage = { type: 'presence', channel, event, presences };
    const payload = JSON.stringify(frame);
    for (const target of this.channelSubscribers(channel)) {
      try {
        target.send(payload);
      } catch {
        /* ignore dead socket */
      }
    }
  }

  /**
   * Fan a Postgres notification out to every client entitled to see the row.
   *
   * Gating order, all of which must pass:
   *   1. Owner gate (recipientsFor): the row's owner column, if any, must match
   *      the subscriber's JWT `sub` (or the subscriber is an admin/service role).
   *      Tables without an owner column broadcast as before. Truncated rows fail
   *      closed (only admins). This is the per-subscriber RLS approximation.
   *   2. Channel: the client is subscribed to this table.
   *   3. Event: subscription event is '*' or the exact change type.
   *   4. Filter: optional client equality filter on record[column].
   */
  dispatch(note: Notification): void {
    const frame: OutboundMessage = {
      type: 'change',
      channel: note.table,
      event: note.type,
      record: note.record,
      old: note.old,
      ...(note.truncated ? { truncated: true } : {}),
    };
    const payload = JSON.stringify(frame);

    // Build the candidate set per table-subscription, apply the owner gate FIRST.
    const candidates: SubscriberView[] = [];
    const targets = new Map<SubscriberView, SendTarget>();
    for (const state of this.clients.values()) {
      const sub = state.subs.get(note.table);
      if (!sub) continue;
      const view: SubscriberView = { claims: state.claims, sub };
      candidates.push(view);
      targets.set(view, state.target);
    }

    const entitled = recipientsFor(note, candidates, this.ownerColumns);

    for (const view of entitled) {
      const sub = view.sub;
      if (sub.event !== '*' && sub.event !== note.type) continue;
      if (sub.filter && !matchesFilter(sub.filter, note)) continue;
      const target = targets.get(view);
      if (!target) continue;
      // Send the pre-serialized payload directly.
      try {
        target.send(payload);
      } catch {
        // A dead socket should not abort the fan-out to others.
      }
    }
  }

  /** Build the standard error frame string (used by the connection layer). */
  static errorFrame(message: string): string {
    return JSON.stringify({ type: 'error', message } satisfies OutboundMessage);
  }

  private send(target: SendTarget, msg: OutboundMessage): void {
    try {
      target.send(JSON.stringify(msg));
    } catch {
      /* ignore dead socket */
    }
  }
}

/**
 * Apply an equality filter against a notification's record. For DELETE there is
 * no `record`, so we fall back to `old`. Comparison is by JSON value equality
 * (numbers/strings/booleans compare directly; everything else via JSON.stringify)
 * which keeps it dependency-free and predictable across the wire.
 */
export function matchesFilter(filter: SubscriptionFilter, note: Notification): boolean {
  const row = note.record ?? note.old;
  if (!row) return false; // truncated or empty — cannot evaluate, exclude.
  if (!(filter.column in row)) return false;
  return valuesEqual(row[filter.column], filter.value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // Tolerate number/string mismatch from JSON (e.g. id 5 vs "5").
  if (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string')
  ) {
    return String(a) === String(b);
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

/** Parse + validate a raw NOTIFY payload string into a Notification, or null. */
export function parseNotification(raw: string): Notification | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.schema !== 'string' || typeof o.table !== 'string') return null;
  if (o.type !== 'INSERT' && o.type !== 'UPDATE' && o.type !== 'DELETE') return null;
  return {
    schema: o.schema,
    table: o.table,
    type: o.type,
    record: isObj(o.record) ? (o.record as Record<string, unknown>) : null,
    old: isObj(o.old) ? (o.old as Record<string, unknown>) : null,
    truncated: o.truncated === true,
  };
}

function isObj(v: unknown): boolean {
  return v !== null && typeof v === 'object';
}
