/**
 * Shared RPC contract for the Anthropic prompt-cache plugin.
 *
 * Imported by both the server entrypoint (`server.ts`), which registers the
 * handlers, and the TUI entrypoint (`tui.ts`), which calls them and subscribes
 * to the `settings.updated` and `keepalive.updated` events.
 */
const settingsSchema = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["5m", "1h", "hybrid"] },
    keepalive: { type: "boolean" },
    maxPings: { type: "integer", minimum: 0, maximum: 100 },
    minContextTokens: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
} as const;

const nullableString = (values: readonly string[]) =>
  ({ type: ["string", "null"], enum: [...values, null] }) as const;
const nullableNumber = { type: ["number", "null"] } as const;

const keepaliveSnapshotSchema = {
  type: "object",
  properties: {
    sessionID: { type: "string" },
    ttl: nullableString(["5m", "1h"]),
    ttlSource: nullableString(["detected", "requested"]),
    lastRequestAt: nullableNumber,
    expiresAt: nullableNumber,
    nextPingAt: nullableNumber,
    pingsUsed: { type: "integer", minimum: 0 },
    maxPings: { type: "integer", minimum: 0 },
    minContextTokens: { type: "integer", minimum: 0 },
    lastPing: nullableString(["hit", "miss", "failed"]),
    skipReason: nullableString(["disabled", "small-context", "child", "exhausted", "no-cache-seen", "missed"]),
    contextTokens: nullableNumber,
  },
  required: [
    "sessionID",
    "ttl",
    "ttlSource",
    "lastRequestAt",
    "expiresAt",
    "nextPingAt",
    "pingsUsed",
    "maxPings",
    "minContextTokens",
    "lastPing",
    "skipReason",
    "contextTokens",
  ],
  additionalProperties: false,
} as const;

const emptyOutput = { type: "object", additionalProperties: false } as const;

export const CacheTtlRpc = {
  id: "anthropic-cache-ttl",
  methods: {
    getSettings: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          global: { ...settingsSchema, required: ["mode", "keepalive", "maxPings", "minContextTokens"] },
          session: { oneOf: [settingsSchema, { type: "null" }] },
        },
        required: ["global", "session"],
        additionalProperties: false,
      },
    },
    setGlobal: {
      input: {
        type: "object",
        properties: { patch: settingsSchema },
        required: ["patch"],
        additionalProperties: false,
      },
      output: emptyOutput,
    },
    setSession: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, patch: settingsSchema },
        required: ["sessionID", "patch"],
        additionalProperties: false,
      },
      output: emptyOutput,
    },
    getKeepalive: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: keepaliveSnapshotSchema,
    },
    resetSession: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: emptyOutput,
    },
  },
  events: {
    "keepalive.updated": { schema: keepaliveSnapshotSchema },
    "settings.updated": {
      schema: {
        type: "object",
        properties: { sessionID: { type: ["string", "null"] } },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
} as const;
