import type { CacheProfile } from '../../models/profile.ts';

/** Provider-managed caching: nothing to rewrite, nothing to keep warm. */
export const implicitProfile: CacheProfile = {
  id: 'implicit',
  pings: false,
  rewrite: () => false,
  ttlForMode: () => null,
  wires: ['anthropic-messages', 'openai-chat', 'openai-responses'],
};
