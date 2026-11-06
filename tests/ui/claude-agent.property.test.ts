import { describe, expect, test } from 'bun:test';

import fc from 'fast-check';

import { claudeAgentSidebar } from '../../src/ui/claude-agent.ts';

const AGENT = { id: 'haiku', providerID: 'claude-agent' };
const count = fc.nat();
const response = fc.record({
  model: fc.constantFrom(AGENT, { id: 'x', providerID: 'openrouter' }),
  tokens: fc.record({ cache: fc.record({ read: count, write: count }), input: count }),
  type: fc.constant('assistant'),
});
const message = fc.oneof(response, fc.constant({ type: 'user' }), fc.constant({ type: 'idle' }));

describe('claudeAgentSidebar properties', () => {
  test('a readout is never empty and never reads more than its prompt', () => {
    fc.assert(
      fc.property(fc.array(message), (messages) => {
        const cache = claudeAgentSidebar({ model: AGENT }, messages)?.cache ?? null;
        if (cache === null) return;
        expect(cache.total).toBeGreaterThan(0);
        expect(cache.read).toBeLessThanOrEqual(cache.total);
      })
    );
  });
});
