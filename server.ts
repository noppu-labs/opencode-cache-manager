import { Plugin } from "@opencode/plugin";
import { CacheTtlRpc } from "./rpc.ts";
import {
  SENTINEL_HEADER,
  isCacheTtlMode,
  parseModeArg,
  transformHttpRequest,
  type CacheTtlMode,
} from "./shared.ts";

/**
 * Server entrypoint for the Anthropic prompt-cache TTL plugin.
 *
 * Preserves the original single-file behavior — a `/cache-ttl` command plus an
 * `http.request` hook that rewrites `cache_control.ttl` — and additionally
 * registers an RPC surface (`getMode` / `setMode`) with a `mode.updated` event
 * so the TUI can drive the mode through an interactive modal.
 */
export default Plugin.define({
  id: "anthropic-cache-ttl",
  async setup(ctx) {
    const stored = await ctx.storage.get("mode");
    const defaultMode = ctx.options?.defaultMode;
    let mode: CacheTtlMode = isCacheTtlMode(stored)
      ? stored
      : isCacheTtlMode(defaultMode)
        ? defaultMode
        : "5m";

    // Referenced from inside its own handlers so `setMode` can emit the update
    // event; declared before the `await` to avoid a temporal-dead-zone hazard.
    let rpcRegistration: any;
    try {
      rpcRegistration = await (ctx.rpc.register as any)(CacheTtlRpc, {
        getMode: async () => mode,
        setMode: async (input: { mode: unknown }) => {
          if (!isCacheTtlMode(input.mode)) {
            throw new Error(`Invalid cache TTL mode: ${String(input.mode)}`);
          }
          mode = input.mode;
          await ctx.storage.set("mode", mode);
          await rpcRegistration?.events.emit("mode.updated", { mode });
          // RPC output schema is `object`; returning undefined would fail host
          // output validation (rpc.invalid_output). Return an empty object.
          return {};
        },
      });
    } catch {
      // RPC is optional (older hosts / headless runs): keep command + hook.
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "cache-ttl",
        description: "Toggle Anthropic prompt cache TTL (5m | 1h | hybrid | status)",
        async execute(input) {
          const action = parseModeArg(input.prompt);

          if (action === "status") {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text: `Anthropic cache TTL mode: ${mode}.`,
              resume: false,
            });
            return;
          }

          if (action === "invalid") {
            await ctx.session.synthetic({
              sessionID: input.sessionID,
              text:
                "Unknown cache TTL argument. Use `5m`, `1h`, `hybrid`, or `status`, " +
                "or run `/cache-ttl` with no argument to toggle between 5m and 1h.",
              resume: false,
            });
            return;
          }

          mode = action === "toggle" ? (mode === "5m" ? "1h" : "5m") : action;
          await ctx.storage.set("mode", mode);
          await ctx.session.synthetic({
            sessionID: input.sessionID,
            text: `Anthropic cache TTL mode set to ${mode}.`,
            resume: false,
          });
        },
      });
    });

    await ctx.session.hook("http.request", async (evt) => {
      const providerID = evt.model.providerID;
      const hasSentinel = evt.request.headers.has(SENTINEL_HEADER);
      if (
        providerID !== "omniroute-anthropic" &&
        providerID !== "anthropic" &&
        !hasSentinel
      ) {
        return;
      }
      evt.request = await transformHttpRequest(evt.request, mode);
    });
  },
});
