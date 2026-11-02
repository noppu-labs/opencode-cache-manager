/**
 * Shared RPC contract for the prompt-cache plugin.
 *
 * Imported by both the server entrypoint (`server.ts`), which registers the
 * handlers, and the TUI entrypoint (`tui.ts`), which calls them and subscribes
 * to the `settings.updated` and `keepalive.updated` events.
 */
import type { Settings, SettingsPatch } from './config/settings.ts';
import type { KeepaliveSnapshot } from './models/keepalive.ts';

const settingsSchema = {
  additionalProperties: false,
  properties: {
    keepalive: { type: 'boolean' },
    maxPings: { maximum: 100, minimum: 0, type: 'integer' },
    minContextTokens: { minimum: 0, type: 'integer' },
    mode: { enum: ['5m', '1h', 'hybrid'], type: 'string' },
    savings: { type: 'boolean' },
  },
  type: 'object',
} as const;

const nullableString = (values: readonly string[]) =>
  ({ enum: [...values, null], type: ['string', 'null'] }) as const;
const nullableNumber = { type: ['number', 'null'] } as const;

const savingsReadoutSchema = {
  additionalProperties: false,
  properties: {
    avoidedTokens: { minimum: 0, type: 'number' },
    netUsd: nullableNumber,
    pings: { minimum: 0, type: 'integer' },
    priced: { type: 'boolean' },
    rescues: { minimum: 0, type: 'integer' },
    returnRatio: nullableNumber,
    stretchUsd: nullableNumber,
  },
  required: ['priced', 'pings', 'rescues', 'avoidedTokens', 'netUsd', 'returnRatio', 'stretchUsd'],
  type: 'object',
} as const;

const keepaliveSnapshotSchema = {
  additionalProperties: false,
  properties: {
    contextTokens: nullableNumber,
    expiresAt: nullableNumber,
    lastCache: {
      oneOf: [
        {
          additionalProperties: false,
          properties: { read: { type: 'number' }, total: { type: 'number' } },
          required: ['read', 'total'],
          type: 'object',
        },
        { type: 'null' },
      ],
    },
    lastPing: nullableString(['hit', 'miss', 'failed']),
    lastRequestAt: nullableNumber,
    maxPings: { minimum: 0, type: 'integer' },
    minContextTokens: { minimum: 0, type: 'integer' },
    nextPingAt: nullableNumber,
    pingsUsed: { minimum: 0, type: 'integer' },
    savings: { oneOf: [savingsReadoutSchema, { type: 'null' }] },
    sessionID: { type: 'string' },
    showSavings: { type: 'boolean' },
    skipReason: nullableString([
      'disabled',
      'small-context',
      'child',
      'busy',
      'exhausted',
      'no-cache-seen',
      'missed',
      'implicit',
    ]),
    ttl: nullableString(['5m', '1h', '30m', '12h']),
    ttlSource: nullableString(['detected', 'requested']),
  },
  required: [
    'sessionID',
    'ttl',
    'ttlSource',
    'lastRequestAt',
    'expiresAt',
    'nextPingAt',
    'pingsUsed',
    'maxPings',
    'minContextTokens',
    'lastPing',
    'skipReason',
    'contextTokens',
    'lastCache',
    'showSavings',
    'savings',
  ],
  type: 'object',
} as const;

const emptyOutput = { additionalProperties: false, type: 'object' } as const;

const CacheTtlRpc = {
  events: {
    'keepalive.updated': { schema: keepaliveSnapshotSchema },
    'settings.updated': {
      schema: {
        additionalProperties: false,
        properties: { sessionID: { type: ['string', 'null'] } },
        required: ['sessionID'],
        type: 'object',
      },
    },
  },
  id: 'opencode-cache-manager',
  methods: {
    getKeepalive: {
      input: {
        additionalProperties: false,
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        type: 'object',
      },
      output: keepaliveSnapshotSchema,
    },
    getSettings: {
      input: {
        additionalProperties: false,
        properties: { sessionID: { type: 'string' } },
        type: 'object',
      },
      output: {
        additionalProperties: false,
        properties: {
          global: {
            ...settingsSchema,
            required: ['mode', 'keepalive', 'maxPings', 'minContextTokens', 'savings'],
          },
          session: { oneOf: [settingsSchema, { type: 'null' }] },
        },
        required: ['global', 'session'],
        type: 'object',
      },
    },
    resetSession: {
      input: {
        additionalProperties: false,
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        type: 'object',
      },
      output: emptyOutput,
    },
    setGlobal: {
      input: {
        additionalProperties: false,
        properties: { patch: settingsSchema },
        required: ['patch'],
        type: 'object',
      },
      output: emptyOutput,
    },
    setSession: {
      input: {
        additionalProperties: false,
        properties: { patch: settingsSchema, sessionID: { type: 'string' } },
        required: ['sessionID', 'patch'],
        type: 'object',
      },
      output: emptyOutput,
    },
  },
} as const;

interface RpcLocation {
  directory: string;
}
interface RpcCallOptions {
  location?: RpcLocation;
}

/** Loose client shape mirroring the `@opencode/client` RPC client for this contract. */
type RawCacheTtlRpcClient = {
  [Method in Exclude<keyof CacheTtlRpcClient, 'events'>]: (
    input: Parameters<CacheTtlRpcClient[Method]>[0],
    options?: RpcCallOptions
  ) => ReturnType<CacheTtlRpcClient[Method]>;
} & Pick<CacheTtlRpcClient, 'events'>;

/** The RPC client the TUI uses; each call already targets the right location. */
interface CacheTtlRpcClient {
  getSettings: (input: { sessionID?: string }) => Promise<{
    global: Settings;
    session: SettingsPatch | null;
  }>;
  setGlobal: (input: { patch: SettingsPatch }) => Promise<unknown>;
  setSession: (input: { sessionID: string; patch: SettingsPatch }) => Promise<unknown>;
  resetSession: (input: { sessionID: string }) => Promise<unknown>;
  getKeepalive: (input: { sessionID: string }) => Promise<KeepaliveSnapshot>;
  events: {
    subscribe: (
      name: 'keepalive.updated',
      options?: { signal?: AbortSignal }
    ) => AsyncIterable<{ data: KeepaliveSnapshot }>;
  };
}

export type { RpcLocation, RpcCallOptions, RawCacheTtlRpcClient, CacheTtlRpcClient };
export { CacheTtlRpc };
