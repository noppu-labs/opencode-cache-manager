import { describe, expect, test } from 'bun:test';

import type { CacheTtlMode } from '../../../src/models/cache.ts';
import { implicitProfile } from '../../../src/services/profiles/implicit.ts';

describe('implicit profile', () => {
  test('has no TTL, no pings, and every wire', () => {
    expect(implicitProfile.id).toBe('implicit');
    expect(implicitProfile.pings).toBe(false);
    expect(implicitProfile.wires).toEqual([
      'anthropic-messages',
      'openai-chat',
      'openai-responses',
    ]);
    for (const mode of ['5m', '1h', 'hybrid'] as CacheTtlMode[]) {
      expect(implicitProfile.ttlForMode(mode)).toBeNull();
    }
  });

  test('never rewrites a body', () => {
    const body = { model: 'x', messages: [{ role: 'user', content: 'hi' }], prompt_cache_key: 's' };
    const before = structuredClone(body);
    for (const wire of ['anthropic-messages', 'openai-chat', 'openai-responses'] as const) {
      for (const mode of ['5m', '1h', 'hybrid'] as const) {
        for (const kind of ['primary', 'compaction', 'title', 'generate'] as const) {
          expect(
            implicitProfile.rewrite(body, { wire, mode, kind, isPing: false, inject: true })
          ).toBe(false);
        }
      }
    }
    expect(body).toEqual(before);
    expect(implicitProfile.headers).toBeUndefined();
  });
});
