import { CLAUDE_AGENT_PROVIDER_ID } from '../constants/anthropic.ts';
import type { CacheReadout } from '../models/keepalive.ts';

interface ModelHolder {
  model?: { providerID: string };
}

interface SessionMessage extends ModelHolder {
  type: string;
  tokens?: { input: number; cache: { read: number; write: number } };
}

interface ClaudeAgentSidebar {
  cache: CacheReadout | null;
}

/**
 * Claude Agent runs through the `claude` CLI, so its requests never reach the HTTP hooks and the
 * engine has no snapshot for it. The host's own session data is all the plugin can read.
 *
 * @returns null when the session isn't on Claude Agent.
 */
function claudeAgentSidebar(
  session: ModelHolder | undefined,
  messages: readonly SessionMessage[]
): ClaudeAgentSidebar | null {
  if (session?.model?.providerID !== CLAUDE_AGENT_PROVIDER_ID) return null;
  const latest = messages.findLast(
    (message) => message.type === 'assistant' && message.tokens !== undefined
  );
  if (latest?.tokens === undefined || latest.model?.providerID !== CLAUDE_AGENT_PROVIDER_ID) {
    return { cache: null };
  }
  const { cache, input } = latest.tokens;
  const total = input + cache.read + cache.write;
  return { cache: total > 0 ? { read: cache.read, total } : null };
}

export type { ClaudeAgentSidebar };
export { claudeAgentSidebar };
