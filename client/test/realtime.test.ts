import { describe, it, expect, vi } from 'vitest';
import { RealtimeClient, deriveWsUrl } from '../src/realtime';

// ---- a minimal mock WebSocket --------------------------------------------
// Matches the slice of the WS API our client uses: readyState/OPEN, send,
// close, and the on* handlers. Each instance records what was sent and lets
// the test drive open/message/close events.
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;

  readonly OPEN = 1;
  readyState = 0;
  url: string;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  // --- test drivers ---
  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }
  message(obj: unknown): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }

  /** Parsed frames this socket sent. */
  get frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

function newClient(token: string | null = 'tok-123') {
  MockWebSocket.instances = [];
  const client = new RealtimeClient('https://data.laetoli.tz', () => token, {
    WebSocketImpl: MockWebSocket as unknown as new (url: string) => WebSocket,
    reconnectMs: 5,
    maxReconnectMs: 20,
  });
  return { client };
}

const sock = () => MockWebSocket.instances[MockWebSocket.instances.length - 1];

describe('deriveWsUrl', () => {
  it('swaps http→ws and appends /realtime', () => {
    expect(deriveWsUrl('https://data.laetoli.tz')).toBe('wss://data.laetoli.tz/realtime');
    expect(deriveWsUrl('http://localhost:8080')).toBe('ws://localhost:8080/realtime');
  });
  it('does not double-append /realtime', () => {
    expect(deriveWsUrl('https://data.laetoli.tz/realtime')).toBe('wss://data.laetoli.tz/realtime');
  });
  it('strips trailing slashes', () => {
    expect(deriveWsUrl('https://x.tz/')).toBe('wss://x.tz/realtime');
  });
});

describe('RealtimeClient — connect + subscribe', () => {
  it('lazily connects on first subscribe with ?token= in the URL', () => {
    const { client } = newClient('abc');
    client.channel('notes').on('*', () => {}).subscribe();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(sock().url).toBe('wss://data.laetoli.tz/realtime?token=abc');
  });

  it('sends a subscribe frame once open (token via URL = pre-authed)', () => {
    const { client } = newClient('abc');
    client.channel('notes').on('INSERT', () => {}).subscribe();
    sock().open();
    expect(sock().frames).toContainEqual({ type: 'subscribe', channel: 'notes', event: 'INSERT' });
  });

  it('includes a filter in the subscribe frame', () => {
    const { client } = newClient('abc');
    client.channel('notes').on('*', () => {}, { column: 'user_id', value: 'u1' }).subscribe();
    sock().open();
    expect(sock().frames).toContainEqual({
      type: 'subscribe',
      channel: 'notes',
      event: '*',
      filter: { column: 'user_id', value: 'u1' },
    });
  });

  it('requests "*" when listeners want multiple concrete events', () => {
    const { client } = newClient('abc');
    client.channel('notes').on('INSERT', () => {}).on('DELETE', () => {}).subscribe();
    sock().open();
    expect(sock().frames).toContainEqual({ type: 'subscribe', channel: 'notes', event: '*' });
  });
});

describe('RealtimeClient — auth-by-message fallback', () => {
  it('sends {type:auth} when no token at connect, then re-subscribes after authenticated', () => {
    // token is null at connect time → no ?token=, auth via message.
    let token: string | null = null;
    MockWebSocket.instances = [];
    const client = new RealtimeClient('https://data.laetoli.tz', () => token, {
      WebSocketImpl: MockWebSocket as unknown as new (url: string) => WebSocket,
    });
    client.channel('notes').on('*', () => {}).subscribe();
    expect(sock().url).toBe('wss://data.laetoli.tz/realtime'); // no ?token= at connect
    token = 'late-token'; // becomes available before the socket opens
    sock().open();
    expect(sock().frames[0]).toEqual({ type: 'auth', token: 'late-token' });
    sock().message({ type: 'authenticated' });
    expect(sock().frames).toContainEqual({ type: 'subscribe', channel: 'notes', event: '*' });
  });
});

describe('RealtimeClient — change dispatch', () => {
  it('delivers a matching change to the listener', () => {
    const { client } = newClient('abc');
    const cb = vi.fn();
    client.channel('notes').on('*', cb).subscribe();
    sock().open();
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { id: '1' }, old: null });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toMatchObject({ channel: 'notes', event: 'INSERT', record: { id: '1' } });
  });

  it('filters by event client-side', () => {
    const { client } = newClient('abc');
    const cb = vi.fn();
    client.channel('notes').on('UPDATE', cb).subscribe();
    sock().open();
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { id: '1' }, old: null });
    sock().message({ type: 'change', channel: 'notes', event: 'UPDATE', record: { id: '1' }, old: { id: '1' } });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('filters by equality client-side', () => {
    const { client } = newClient('abc');
    const cb = vi.fn();
    client.channel('notes').on('*', cb, { column: 'user_id', value: 'u1' }).subscribe();
    sock().open();
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { user_id: 'u1' }, old: null });
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { user_id: 'u2' }, old: null });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('routes changes to the right channel only', () => {
    const { client } = newClient('abc');
    const a = vi.fn();
    const b = vi.fn();
    client.channel('notes').on('*', a).subscribe();
    client.channel('tasks').on('*', b).subscribe();
    sock().open();
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { id: '1' }, old: null });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
  });

  it('passes through the truncated flag', () => {
    const { client } = newClient('abc');
    const cb = vi.fn();
    client.channel('notes').on('*', cb).subscribe();
    sock().open();
    sock().message({ type: 'change', channel: 'notes', event: 'UPDATE', record: { id: '1' }, old: null, truncated: true });
    expect(cb.mock.calls[0][0].truncated).toBe(true);
  });
});

describe('RealtimeClient — unsubscribe + reconnect', () => {
  it('unsubscribe sends a frame and stops delivery', () => {
    const { client } = newClient('abc');
    const cb = vi.fn();
    const ch = client.channel('notes').on('*', cb).subscribe();
    sock().open();
    ch.unsubscribe();
    expect(sock().frames).toContainEqual({ type: 'unsubscribe', channel: 'notes' });
    sock().message({ type: 'change', channel: 'notes', event: 'INSERT', record: { id: '1' }, old: null });
    expect(cb).not.toHaveBeenCalled();
  });

  it('re-subscribes active channels after a reconnect', async () => {
    const { client } = newClient('abc');
    client.channel('notes').on('*', () => {}).subscribe();
    sock().open();
    const first = sock();
    first.close(); // triggers reconnect after backoff
    await new Promise((r) => setTimeout(r, 15));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(2);
    const second = sock();
    second.open();
    expect(second.frames).toContainEqual({ type: 'subscribe', channel: 'notes', event: '*' });
  });

  it('disconnect() stops reconnection', async () => {
    const { client } = newClient('abc');
    client.channel('notes').on('*', () => {}).subscribe();
    sock().open();
    const count = MockWebSocket.instances.length;
    client.disconnect();
    await new Promise((r) => setTimeout(r, 30));
    expect(MockWebSocket.instances.length).toBe(count);
  });
});
