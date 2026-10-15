/**
 * Shared RPC contract for the Anthropic prompt-cache TTL plugin.
 *
 * Imported by both the server entrypoint (`index.ts`), which registers the
 * handlers, and the TUI entrypoint (`tui.ts`), which calls them and subscribes
 * to the `mode.updated` event.
 */
export const CacheTtlRpc = {
  id: "anthropic-cache-ttl",
  methods: {
    getMode: {
      input: { type: "object", additionalProperties: false },
      output: { type: "string" },
    },
    setMode: {
      input: {
        type: "object",
        properties: { mode: { type: "string", enum: ["5m", "1h", "hybrid"] } },
        required: ["mode"],
        additionalProperties: false,
      },
      output: { type: "object", additionalProperties: false },
    },
  },
  events: {
    "mode.updated": {
      schema: {
        type: "object",
        properties: { mode: { type: "string" } },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  },
} as const;
