/** Applies a TTL (or removes it, when `undefined`) to a single cache_control block. */
export function applyTtlToBlock(block: unknown, ttl: '1h' | undefined): boolean {
  if (!block || typeof block !== 'object') return false;
  const rec = block as Record<string, unknown>;
  const cacheControl = rec.cache_control;

  if (
    cacheControl &&
    typeof cacheControl === 'object' &&
    (cacheControl as Record<string, unknown>).type === 'ephemeral'
  ) {
    const cc = cacheControl as Record<string, unknown>;
    if (ttl === '1h') {
      if (cc.ttl !== '1h') {
        cc.ttl = '1h';
        return true;
      }
      return false;
    }
    if ('ttl' in cc) {
      delete cc.ttl;
      return true;
    }
  }

  return false;
}

const isOneHour = (block: unknown): boolean => {
  if (!block || typeof block !== 'object') return false;
  const cacheControl = (block as Record<string, unknown>).cache_control;
  return (
    !!cacheControl &&
    typeof cacheControl === 'object' &&
    (cacheControl as Record<string, unknown>).ttl === '1h'
  );
};

/** Returns true when any ephemeral breakpoint in the payload carries a 1h TTL. */
export function hasOneHourCacheControl(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isOneHour(tool)) return true;
      const nested = (tool as Record<string, unknown> | null)?.tools;
      if (Array.isArray(nested) && nested.some(isOneHour)) return true;
    }
  }

  if (Array.isArray(body.system) && body.system.some(isOneHour)) return true;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isOneHour(message)) return true;
      const content = (message as Record<string, unknown> | null)?.content;
      if (Array.isArray(content) && content.some(isOneHour)) return true;
    }
  }

  return false;
}
