import { describe, expect, test } from 'bun:test';

import { claudeAgentSidebar } from '../../src/ui/claude-agent.ts';

const AGENT = { id: 'haiku', providerID: 'claude-agent' };
const OTHER = { id: 'anthropic/claude-haiku-4.5', providerID: 'openrouter' };

function assistant(read: number, write: number, input = 2, model = AGENT) {
  return { model, tokens: { cache: { read, write }, input }, type: 'assistant' };
}

describe('claudeAgentSidebar', () => {
  test('a session on another provider is not one', () => {
    expect(claudeAgentSidebar({ model: OTHER }, [assistant(10, 0, 2, OTHER)])).toBeNull();
  });

  test('a session with no model yet is not one', () => {
    expect(claudeAgentSidebar({}, [])).toBeNull();
    expect(claudeAgentSidebar(undefined, [])).toBeNull();
  });

  test('before any response there is no cache readout', () => {
    expect(claudeAgentSidebar({ model: AGENT }, [{ type: 'user' }])).toEqual({ cache: null });
  });

  test('the readout counts input, cache read and cache write as the prompt', () => {
    expect(claudeAgentSidebar({ model: AGENT }, [assistant(900, 98)])).toEqual({
      cache: { read: 900, total: 1000 },
    });
  });

  test('the latest response decides, skipping later messages that are not responses', () => {
    const messages = [assistant(1, 1), assistant(500, 498), { type: 'idle' }];
    expect(claudeAgentSidebar({ model: AGENT }, messages)).toEqual({
      cache: { read: 500, total: 1000 },
    });
  });

  test('a response still in progress leaves the previous readout', () => {
    const messages = [assistant(500, 498), { model: AGENT, type: 'assistant' }];
    expect(claudeAgentSidebar({ model: AGENT }, messages)).toEqual({
      cache: { read: 500, total: 1000 },
    });
  });

  test('a latest response from another provider says nothing about this cache', () => {
    const messages = [assistant(500, 498), assistant(10, 0, 2, OTHER)];
    expect(claudeAgentSidebar({ model: AGENT }, messages)).toEqual({ cache: null });
  });

  test('a response with no tokens at all has no readout', () => {
    expect(claudeAgentSidebar({ model: AGENT }, [assistant(0, 0, 0)])).toEqual({ cache: null });
  });
});
