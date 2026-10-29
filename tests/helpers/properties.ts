import { expect } from 'bun:test';

import type { CacheTtlMode, CacheUsage } from '../../src/models/cache.ts';
import { isRecord } from '../../src/utils/is-record.ts';

type Rec = Record<string, unknown>;

interface EphemeralBlock {
  prefix: boolean;
  ttl: unknown;
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const isPrefixRole = (message: unknown): boolean =>
  isRecord(message) && (message.role === 'system' || message.role === 'developer');

/**
 * Every ephemeral `cache_control` in wire order, marked with whether it belongs to the cached
 * prefix. Messages wire: tools (and nested tools), then `system`, then messages and their parts;
 * the prefix is tools and `system`. Chat Completions: tools, then messages; the prefix is tools
 * and the leading `system`/`developer` messages.
 */
function ephemeralBlocks(body: Rec, wire: 'anthropic-messages' | 'openai-chat'): EphemeralBlock[] {
  const out: EphemeralBlock[] = [];
  const add = (block: unknown, prefix: boolean): void => {
    if (
      isRecord(block) &&
      isRecord(block.cache_control) &&
      block.cache_control.type === 'ephemeral'
    ) {
      out.push({ prefix, ttl: block.cache_control.ttl });
    }
  };
  for (const tool of list(body.tools)) {
    add(tool, true);
    if (wire === 'anthropic-messages' && isRecord(tool)) {
      for (const child of list(tool.tools)) add(child, true);
    }
  }
  if (wire === 'anthropic-messages') {
    for (const block of list(body.system)) add(block, true);
  }
  const messages = list(body.messages);
  const firstTail = messages.findIndex((message) => !isPrefixRole(message));
  let prefixEnd = 0;
  if (wire === 'openai-chat') prefixEnd = firstTail === -1 ? messages.length : firstTail;
  for (const [index, message] of messages.entries()) {
    add(message, index < prefixEnd);
    if (isRecord(message)) {
      for (const part of list(message.content)) add(part, index < prefixEnd);
    }
  }
  return out;
}

/** The TTL a mode gives a prefix or tail breakpoint; `undefined` is the 5m default. */
function expectedTtl(mode: CacheTtlMode, prefix: boolean): '1h' | undefined {
  if (prefix) return mode === '5m' ? undefined : '1h';
  return mode === '1h' ? '1h' : undefined;
}

/** True when no `1h` TTL comes after a breakpoint without one. */
function oneHourFirst(blocks: EphemeralBlock[]): boolean {
  const firstShort = blocks.findIndex((block) => block.ttl !== '1h');
  return firstShort === -1 || blocks.slice(firstShort).every((block) => block.ttl !== '1h');
}

/** A deep copy with `ttl` removed from every ephemeral `cache_control`. */
function withoutTtls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutTtls(item));
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'cache_control' && isRecord(child) && child.type === 'ephemeral') {
      const { ttl: _ttl, ...rest } = child;
      out[key] = rest;
    } else {
      out[key] = withoutTtls(child);
    }
  }
  return out;
}

/** A deep copy with every `key` property removed. */
function withoutKey(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value.map((item) => withoutKey(item, key));
  if (!isRecord(value)) return value;
  const out: Rec = {};
  for (const [name, child] of Object.entries(value)) {
    if (name !== key) out[name] = withoutKey(child, key);
  }
  return out;
}

/** Every `prompt_cache_breakpoint` where the OpenAI wires carry one: tools, messages and input items and their content or output parts. */
function breakpoints(body: Rec): unknown[] {
  const out: unknown[] = [];
  const add = (node: unknown): void => {
    if (isRecord(node) && 'prompt_cache_breakpoint' in node) out.push(node.prompt_cache_breakpoint);
  };
  for (const key of ['tools', 'messages', 'input']) {
    for (const node of list(body[key])) {
      add(node);
      if (isRecord(node)) {
        for (const part of [...list(node.content), ...list(node.output)]) add(part);
      }
    }
  }
  return out;
}

/** Every field a parser reported is a finite number. */
function expectFiniteUsage(usage: CacheUsage | undefined): void {
  if (!usage) return;
  for (const value of Object.values(usage)) {
    if (value !== undefined) expect(Number.isFinite(value)).toBe(true);
  }
}

export type { EphemeralBlock };
export {
  breakpoints,
  ephemeralBlocks,
  expectFiniteUsage,
  expectedTtl,
  oneHourFirst,
  withoutKey,
  withoutTtls,
};
