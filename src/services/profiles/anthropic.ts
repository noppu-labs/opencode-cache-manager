import { BETA_HEADER, EXTENDED_CACHE_BETA } from '../../constants/anthropic.ts';
import type { CacheProfile } from '../../models/profile.ts';
import { hasOneHourCacheControl } from '../cache-control.ts';
import { rewriteAnthropicCacheTtl, ttlForMode } from '../cache-ttl.ts';
import { injectOpenAiBreakpoints, rewriteOpenAiCacheTtl } from '../openai-cache-ttl.ts';

/**
 * Claude-family caching: `cache_control` breakpoints with 5m / 1h TTLs, kept warm by pings.
 * On `anthropic-messages` the boolean from `rewrite` must not gate the request rebuild: the
 * sentinel header strip and the beta header (see `headers`) apply whether or not the body changed.
 */
export const anthropicProfile: CacheProfile = {
  id: 'anthropic',
  wires: ['anthropic-messages', 'openai-chat'],
  ttlForMode,
  rewrite(body, ctx) {
    if (ctx.wire === 'anthropic-messages') return rewriteAnthropicCacheTtl(body, ctx.mode);
    if (ctx.wire !== 'openai-chat') return false;
    const injected = ctx.inject && injectOpenAiBreakpoints(body);
    const rewritten = rewriteOpenAiCacheTtl(body, ctx.mode);
    return injected || rewritten;
  },
  headers(body, { wire, mode }) {
    const extended =
      wire === 'anthropic-messages'
        ? mode === '1h' || mode === 'hybrid'
        : wire === 'openai-chat' && hasOneHourCacheControl(body);
    const headers: Record<string, string> = {};
    if (extended) headers[BETA_HEADER] = EXTENDED_CACHE_BETA;
    return headers;
  },
  pings: true,
};
