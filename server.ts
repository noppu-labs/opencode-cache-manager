import { Plugin } from "@opencode/plugin";
import { CacheTtlRpc } from "./rpc.ts";
import {
  SENTINEL_HEADER,
  parseCommandArg,
  transformHttpRequest,
} from "./shared.ts";
import {
  SettingsStore,
  sanitizePatch,
  settingsFromOptions,
  type Settings,
  type SettingsPatch,
} from "./settings.ts";

const INVALID_ARGUMENT_TEXT =
  "Unknown cache argument. Use `5m`, `1h`, `hybrid`, `keepalive on|off`, " +
  "`pings <0-100>`, `min <tokens|50k>`, `status`, or `reset`, " +
  "or run `/cache-manager` with no argument to toggle this session between 5m and 1h.";

/** Rejects a patch carrying any invalid or unknown field instead of silently dropping it. */
function validatePatch(value: unknown): SettingsPatch {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid settings patch: expected an object");
  }
  const patch = sanitizePatch(value);
  const invalid = Object.keys(value).filter((key) => !(key in patch));
  if (invalid.length > 0) {
    throw new Error(`Invalid settings patch fields: ${invalid.join(", ")}`);
  }
  return patch;
}

function describeSettings(settings: Settings): string {
  return (
    `mode ${settings.mode}, keepalive ${settings.keepalive ? "on" : "off"}, ` +
    `max pings ${settings.maxPings}, min context ${settings.minContextTokens} tokens`
  );
}

/**
 * Server entrypoint for the Anthropic prompt-cache plugin.
 *
 * Registers a `/cache-manager` command and an `http.request` hook that rewrites
 * `cache_control.ttl` using layered settings (built-in defaults, plugin options,
 * global, per-session). An RPC surface (`getSettings` / `setGlobal` /
 * `setSession` / `resetSession`) with a `settings.updated` event lets the TUI
 * drive the same settings through an interactive modal.
 */
export default Plugin.define({
  id: "anthropic-cache-ttl",
  async setup(ctx) {
    const store = new SettingsStore(ctx.storage, settingsFromOptions(ctx.options));
    await store.load();

    // Referenced from inside its own handlers so they can emit the update
    // event; declared before the `await` to avoid a temporal-dead-zone hazard.
    let rpcRegistration: any;
    // RPC output schemas are `object`; returning undefined would fail host
    // output validation (rpc.invalid_output). Handlers return an empty object.
    const notify = async (sessionID: string | null) => {
      await rpcRegistration?.events.emit("settings.updated", { sessionID });
      return {};
    };
    try {
      rpcRegistration = await (ctx.rpc.register as any)(CacheTtlRpc, {
        getSettings: async (input: { sessionID?: string }) => ({
          global: store.global(),
          session: input?.sessionID ? await store.sessionPatch(input.sessionID) : null,
        }),
        setGlobal: async (input: { patch: unknown }) => {
          await store.setGlobal(validatePatch(input.patch));
          return notify(null);
        },
        setSession: async (input: { sessionID: string; patch: unknown }) => {
          await store.setSession(input.sessionID, validatePatch(input.patch));
          return notify(input.sessionID);
        },
        resetSession: async (input: { sessionID: string }) => {
          await store.resetSession(input.sessionID);
          return notify(input.sessionID);
        },
      });
    } catch {
      // RPC is optional (older hosts / headless runs): keep command + hook.
    }

    await ctx.command.transform((editor) => {
      editor.add({
        name: "cache-manager",
        description:
          "Manage this session's prompt cache (5m | 1h | hybrid | keepalive on|off | pings N | min N | status | reset)",
        async execute(input) {
          const sessionID: string = input.sessionID;
          const action = parseCommandArg(input.prompt);
          const say = (text: string) =>
            ctx.session.synthetic({ sessionID, text, resume: false });

          switch (action.type) {
            case "status":
              await say(`Session cache settings: ${describeSettings(await store.effective(sessionID))}.`);
              return;
            case "invalid":
              await say(INVALID_ARGUMENT_TEXT);
              return;
            case "reset":
              await store.resetSession(sessionID);
              await say(
                `Session cache settings reset: ${describeSettings(await store.effective(sessionID))}.`,
              );
              return;
            case "toggle": {
              const { mode } = await store.effective(sessionID);
              await store.setSession(sessionID, { mode: mode === "5m" ? "1h" : "5m" });
              break;
            }
            case "set":
              await store.setSession(sessionID, action.patch);
              break;
          }
          await say(`Session cache settings updated: ${describeSettings(await store.effective(sessionID))}.`);
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
      const { mode } = await store.effective(evt.sessionID);
      evt.request = await transformHttpRequest(evt.request, mode);
    });
  },
});
