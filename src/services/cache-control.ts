import { isRecord } from '../utils/is-record.ts';

/** Applies a TTL (or removes it, when `undefined`) to a single cache_control block. */
function applyTtlToBlock(block: unknown, ttl: '1h' | undefined): boolean {
  if (!isRecord(block)) return false;
  const cc = block.cache_control;

  if (isRecord(cc) && cc.type === 'ephemeral') {
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

const isOneHour = (block: unknown): boolean =>
  isRecord(block) && isRecord(block.cache_control) && block.cache_control.ttl === '1h';

/** Returns true when any ephemeral breakpoint in the payload carries a 1h TTL. */
function hasOneHourCacheControl(body: Record<string, unknown>): boolean {
  const tools = body.tools;
  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (isOneHour(tool)) return true;
      const nested = isRecord(tool) ? tool.tools : undefined;
      if (Array.isArray(nested) && nested.some((block) => isOneHour(block))) return true;
    }
  }

  if (Array.isArray(body.system) && body.system.some((block) => isOneHour(block))) return true;

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isOneHour(message)) return true;
      const content = isRecord(message) ? message.content : undefined;
      if (Array.isArray(content) && content.some((block) => isOneHour(block))) return true;
    }
  }

  return false;
}

export { applyTtlToBlock, hasOneHourCacheControl };
