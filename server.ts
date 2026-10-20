import { Plugin } from "@opencode/plugin";
import { PING_PROMPT, KeepaliveEngine, type KeepaliveSnapshot } from "./keepalive.ts";
import { CacheTtlRpc } from "./rpc.ts";
import {
  SENTINEL_HEADER,
  alignPingMessages,
  parseCommandArg,
  resolveActiveMode,
  transformHttpRequest,
  ttlForMode,
} from "./shared.ts";
import {
  SettingsStore,
  sanitizePatch,
  settingsFromOptions,
  type Settings,
  type SettingsPatch,
} from "./settings.ts";
import { isAnthropicMessagesRequest, observeResponseUsage } from "./usage.ts";

const SESSION_KEY_PREFIX = "session/";

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

function isAnthropicProvider(providerID: string): boolean {
  return providerID === "anthropic" || providerID === "omniroute-anthropic";
}

function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { _tag, name } = error as { _tag?: unknown; name?: unknown };
  return [_tag, name].some((tag) => typeof tag === "string" && /SessionNotFound/.test(tag));
}

/** Parses a request body's `messages` array; undefined when absent or not JSON. */
async function readMessages(request: Request): Promise<{ body: Record<string, unknown>; messages: unknown[] } | undefined> {
  try {
    const body: unknown = JSON.parse(await request.clone().text());
    if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
    const messages = (body as Record<string, unknown>).messages;
    return Array.isArray(messages) ? { body: body as Record<string, unknown>, messages } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Server entrypoint for the Anthropic prompt-cache plugin.
 *
 * Registers a `/cache-manager` command and an `http.request` hook that rewrites
 * `cache_control.ttl` using layered settings (built-in defaults, plugin options,
 * global, per-session). An RPC surface (`getSettings` / `setGlobal` /
 * `setSession` / `resetSession`) with a `settings.updated` event lets the TUI
 * drive the same settings through an interactive modal.
 *
 * It also observes Anthropic responses and keeps each session's prompt cache
 * warm with transient pings (see `keepalive.ts`), publishing per-session state
 * through `getKeepalive` and the `keepalive.updated` event.
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

    const pingInFlight = new Set<string>();
    // Resolves once the ping's response has been reported to the engine; the
    // engine counts a ping as failed if `ping()` settles before that.
    const pingResponse = new Map<string, Promise<void>>();
    // Latest primary request messages per session, in memory only.
    const primaryMessages = new Map<string, unknown[]>();

    const engine = new KeepaliveEngine({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      settings: (sessionID) => store.effective(sessionID),
      isChild: async (sessionID) => Boolean((await ctx.session.get({ sessionID })).parentID),
      onChange: (snapshot: KeepaliveSnapshot) => {
        void Promise.resolve(rpcRegistration?.events.emit("keepalive.updated", snapshot)).catch(() => {});
      },
      ping: async (sessionID) => {
        pingInFlight.add(sessionID);
        try {
          await ctx.session.generate({ sessionID, prompt: PING_PROMPT });
          await pingResponse.get(sessionID);
        } finally {
          pingInFlight.delete(sessionID);
          pingResponse.delete(sessionID);
        }
      },
    });

    /** Applies a settings change to the keepalive schedule and tells the TUI. */
    const settingsChanged = async (sessionID: string | null) => {
      await engine.reevaluate(sessionID ?? undefined);
      return notify(sessionID);
    };

    try {
      rpcRegistration = await (ctx.rpc.register as any)(CacheTtlRpc, {
        getSettings: async (input: { sessionID?: string }) => ({
          global: store.global(),
          session: input?.sessionID ? await store.sessionPatch(input.sessionID) : null,
        }),
        setGlobal: async (input: { patch: unknown }) => {
          await store.setGlobal(validatePatch(input.patch));
          return settingsChanged(null);
        },
        setSession: async (input: { sessionID: string; patch: unknown }) => {
          await store.setSession(input.sessionID, validatePatch(input.patch));
          return settingsChanged(input.sessionID);
        },
        resetSession: async (input: { sessionID: string }) => {
          await store.resetSession(input.sessionID);
          return settingsChanged(input.sessionID);
        },
        getKeepalive: async (input: { sessionID: string }) => engine.snapshot(input.sessionID),
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
              await settingsChanged(sessionID);
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
          await settingsChanged(sessionID);
          await say(`Session cache settings updated: ${describeSettings(await store.effective(sessionID))}.`);
        },
      });
    });

    await ctx.session.hook("http.request", async (evt) => {
      const providerID = evt.model.providerID;
      const rewrites = isAnthropicProvider(providerID) || evt.request.headers.has(SENTINEL_HEADER);
      const observed = isAnthropicProvider(providerID) || isAnthropicMessagesRequest(evt.request);
      if (!rewrites && !observed) return;

      const sessionID: string = evt.sessionID;
      const isPing = evt.kind === "generate" && pingInFlight.has(sessionID);
      const { mode } = await store.effective(sessionID);
      const requestedTtl = ttlForMode(resolveActiveMode(evt.request, mode));

      if (rewrites) evt.request = await transformHttpRequest(evt.request, mode);
      if (!observed) return;

      if (evt.kind === "primary" || isPing) {
        const parsed = await readMessages(evt.request);
        if (parsed && evt.kind === "primary") {
          primaryMessages.set(sessionID, parsed.messages);
        } else if (parsed) {
          const primary = primaryMessages.get(sessionID);
          if (primary) {
            const body = JSON.stringify({ ...parsed.body, messages: alignPingMessages(parsed.messages, primary) });
            const headers = new Headers(evt.request.headers);
            headers.delete("content-length");
            evt.request = new Request(evt.request.url, { method: evt.request.method, headers, body });
          }
        }
      }
      engine.requestSent(sessionID, { requestedTtl, isPing });
    });

    await ctx.session.hook("http.response", async (evt) => {
      if (!isAnthropicProvider(evt.model.providerID) && !isAnthropicMessagesRequest(evt.request)) return;

      const sessionID: string = evt.sessionID;
      const isPing = evt.kind === "generate" && pingInFlight.has(sessionID);
      const observed = observeResponseUsage(evt.response);
      evt.response = observed.response;
      const ok = evt.response.ok;

      const reported = observed.usage
        .then((usage) => engine.responseObserved(sessionID, { usage, ok, isPing }))
        .catch(() => {});
      if (isPing) pingResponse.set(sessionID, reported);
    });

    // Drop stored settings for sessions that were deleted while the plugin was not running.
    const sweep = async () => {
      let after: string | undefined;
      do {
        const page = await ctx.storage.scan({ prefix: SESSION_KEY_PREFIX, ...(after ? { after } : {}) });
        for (const entry of page.entries) {
          const sessionID = entry.key.startsWith(SESSION_KEY_PREFIX)
            ? entry.key.slice(SESSION_KEY_PREFIX.length)
            : entry.key;
          try {
            await ctx.session.get({ sessionID });
          } catch (error) {
            if (isSessionNotFound(error)) await ctx.storage.remove(entry.key);
          }
        }
        after = page.next;
      } while (after);
    };
    void sweep().catch(() => {});

    return () => engine.dispose();
  },
});
