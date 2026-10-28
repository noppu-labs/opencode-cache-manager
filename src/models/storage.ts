/** The plugin storage operations the settings and profile stores need. */
interface KV {
  get: (key: string) => Promise<unknown>;
  // oxlint-disable-next-line typescript/method-signature-style -- a method keeps `value` bivariant, so the host's StorageDomain (value: Json) is a KV
  set(key: string, value: unknown): Promise<void>;
  remove: (key: string) => Promise<void>;
}

/** The plugin storage operations the startup sweep needs. */
interface ScannableKV {
  scan: (input: {
    prefix: string;
    after?: string;
  }) => Promise<{ entries: readonly { key: string }[]; next?: string }>;
  remove: (key: string) => Promise<void>;
}

export type { KV, ScannableKV };
