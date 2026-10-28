/** The plugin storage operations the settings and profile stores need. */
export interface KV {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

/** The plugin storage operations the startup sweep needs. */
export interface ScannableKV {
  scan(input: {
    prefix: string;
    after?: string;
  }): Promise<{ entries: readonly { key: string }[]; next?: string }>;
  remove(key: string): Promise<void>;
}
