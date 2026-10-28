import type { KV, ScannableKV } from '../../src/models/storage.ts';

/** In-memory plugin storage covering both `KV` (settings store) and `ScannableKV` (startup sweep). */
export function memoryKv() {
  const data = new Map<string, unknown>();
  const kv: KV & ScannableKV = {
    get: async (key) => data.get(key),
    set: async (key, value) => {
      data.set(key, value);
    },
    remove: async (key) => {
      data.delete(key);
    },
    scan: async ({ prefix }) => ({
      entries: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
    }),
  };
  return { kv, data };
}
