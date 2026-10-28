import type { CacheTtlMode } from '../models/cache.ts';
import { isRecord } from '../utils/is-record.ts';
import { applyTtlToBlock, hasOneHourCacheControl } from './cache-control.ts';

type Rec = Record<string, unknown>;

const isPrefixRole = (message: unknown): boolean =>
  isRecord(message) && (message.role === 'system' || message.role === 'developer');

/** Index of the first message that is not `system`/`developer`. */
export function leadingPrefixEnd(messages: unknown[]): number {
  const index = messages.findIndex((message) => !isPrefixRole(message));
  return index === -1 ? messages.length : index;
}

const marked = (node: unknown) => isRecord(node) && node.cache_control != null;

/** Returns true when `cache_control` appears on any tool, message or content part. */
export function hasCacheControl(body: Rec): boolean {
  if (Array.isArray(body.tools) && body.tools.some(marked)) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(
    (message) =>
      marked(message) ||
      (isRecord(message) && Array.isArray(message.content) && message.content.some(marked))
  );
}

/**
 * Rewrites every ephemeral `cache_control` in a Chat Completions body to match
 * `mode`. Wire order is tools, then messages, so hybrid gives 1h to the tools
 * and the leading `system`/`developer` messages and leaves the rest at 5m.
 * Returns true when anything changed or a 1h breakpoint is present.
 */
export function rewriteOpenAiCacheTtl(body: Rec, mode: CacheTtlMode): boolean {
  let changed = false;
  const prefixTtl = mode === '5m' ? undefined : '1h';
  const tailTtl = mode === '1h' ? '1h' : undefined;

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) changed = applyTtlToBlock(tool, prefixTtl) || changed;
  }

  if (Array.isArray(body.messages)) {
    const prefixEnd = leadingPrefixEnd(body.messages);
    body.messages.forEach((message, index) => {
      const ttl = index < prefixEnd ? prefixTtl : tailTtl;
      changed = applyTtlToBlock(message, ttl) || changed;
      const content = isRecord(message) ? message.content : undefined;
      if (Array.isArray(content)) {
        for (const part of content) changed = applyTtlToBlock(part, ttl) || changed;
      }
    });
  }

  return changed || hasOneHourCacheControl(body);
}

const ephemeral = (): Rec => ({ type: 'ephemeral' });

const isText = (part: unknown): part is Rec =>
  isRecord(part) && part.type === 'text' && typeof part.text === 'string' && part.text !== '';

/** The last text part of `message`, turning string content into parts first. */
export function lastTextPart(message: Rec): Rec | undefined {
  const { content } = message;
  if (typeof content === 'string') {
    if (content === '') return undefined;
    const part: Rec = { type: 'text', text: content };
    message.content = [part];
    return part;
  }
  return Array.isArray(content) ? content.findLast(isText) : undefined;
}

/**
 * Adds breakpoints to a Chat Completions body that has none: the last tool, the
 * last text part of the leading `system`/`developer` messages, and the last text
 * part of the final message that has one (at most 3, under Anthropic's limit of
 * 4). Returns true when any were added.
 */
export function injectOpenAiBreakpoints(body: Rec): boolean {
  if (hasCacheControl(body)) return false;

  let injected = false;
  const mark = (target: Rec): void => {
    target.cache_control = ephemeral();
    injected = true;
  };

  const tools: unknown[] = Array.isArray(body.tools) ? body.tools : [];
  const lastTool = tools.at(-1);
  if (isRecord(lastTool)) mark(lastTool);

  const messages: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const prefixEnd = leadingPrefixEnd(messages);

  for (let index = prefixEnd - 1; index >= 0; index--) {
    const message = messages[index];
    const part = isRecord(message) ? lastTextPart(message) : undefined;
    if (part) {
      mark(part);
      break;
    }
  }

  for (let index = messages.length - 1; index >= prefixEnd; index--) {
    const message = messages[index];
    const part = isRecord(message) ? lastTextPart(message) : undefined;
    if (part) {
      mark(part);
      break;
    }
  }

  return injected;
}
