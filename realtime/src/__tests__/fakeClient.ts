import { vi } from 'vitest';
import type { SendTarget } from '../hub.js';

/** A fake WS client: a `send` spy plus a parsed-message accessor for asserts. */
export class FakeClient implements SendTarget {
  send = vi.fn((_data: string) => {});

  /** All frames sent to this client, parsed from JSON. */
  get messages(): Record<string, unknown>[] {
    return this.send.mock.calls.map((c) => JSON.parse(c[0] as string));
  }

  /** The most recent frame sent, parsed. */
  get last(): Record<string, unknown> | undefined {
    return this.messages.at(-1);
  }

  /** Only `change` frames received. */
  get changes(): Record<string, unknown>[] {
    return this.messages.filter((m) => m.type === 'change');
  }
}
