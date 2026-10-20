import { Plugin } from "@opencode/plugin/tui";
import { CacheTtlRpc } from "./rpc.ts";
import { isCacheTtlMode, type CacheTtlMode } from "./shared.ts";
import type { Settings, SettingsPatch } from "./settings.ts";

/**
 * Interactive metadata for each cache TTL mode, shown in the picker modal.
 */
const OPTION_INFO: Record<CacheTtlMode, { title: string; description: string }> = {
  "5m": {
    title: "5 minutes (default)",
    description: "Standard ephemeral cache. 1.25x base input write cost, 0.1x read.",
  },
  "1h": {
    title: "1 hour (extended)",
    description: "1h ephemeral on every breakpoint. 2x base input write cost, 0.1x read.",
  },
  hybrid: {
    title: "Hybrid",
    description: "1h on tools + system prompt; 5m on rolling messages.",
  },
};

const USAGE = "Usage: /cache-ttl [5m | 1h | hybrid | status]";

/** Loose client shape mirroring the `@opencode/plugin` RPC client for our contract. */
type RpcClient = {
  getSettings(input: { sessionID?: string }): Promise<{
    global: Settings;
    session: SettingsPatch | null;
  }>;
  setSession(input: { sessionID: string; patch: SettingsPatch }): Promise<unknown>;
  events: {
    subscribe(
      name: "settings.updated",
      options?: { signal?: AbortSignal },
    ): AsyncIterable<unknown>;
  };
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * TUI entrypoint for the Anthropic prompt-cache TTL plugin.
 *
 * Registers a palette + `/cache-ttl` slash command. With no argument it opens a
 * native picker (`ctx.ui.dialog.select`); an explicit mode is applied directly;
 * `status` reports the current mode. All mutations go through the server RPC so
 * the settings stay in one place (`ctx.storage`).
 */
export default Plugin.define({
  id: "anthropic-cache-ttl",
  async setup(ctx) {
    const rpc = ctx.client.rpc(CacheTtlRpc as any) as unknown as RpcClient;

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };

    const runCommand = async (input?: string): Promise<void> => {
      const argument = (input ?? "").trim().toLowerCase();
      try {
        const sessionID = currentSessionID();
        if (sessionID === undefined) {
          ctx.ui.toast.show({
            message: "Open a session to change its cache TTL.",
            variant: "warning",
          });
          return;
        }
        const readMode = async (): Promise<CacheTtlMode> => {
          const settings = await rpc.getSettings({ sessionID });
          return settings.session?.mode ?? settings.global.mode;
        };

        if (argument === "") {
          const current = await readMode();
          const selected = await ctx.ui.dialog.select<CacheTtlMode>({
            title: "Anthropic Prompt Cache TTL",
            placeholder: "Select a TTL mode",
            current: isCacheTtlMode(current) ? current : undefined,
            options: (["5m", "1h", "hybrid"] as const).map((value) => ({
              value,
              title: OPTION_INFO[value].title,
              description: OPTION_INFO[value].description,
            })),
          });
          if (selected !== undefined && selected !== current) {
            await rpc.setSession({ sessionID, patch: { mode: selected } });
            ctx.ui.toast.show({
              message: `Anthropic cache TTL set to ${selected}.`,
              variant: "success",
            });
          }
          return;
        }

        if (argument === "status") {
          const current = await readMode();
          ctx.ui.toast.show({
            message: `Anthropic cache TTL mode: ${current}.`,
            variant: "info",
          });
          return;
        }

        if (isCacheTtlMode(argument)) {
          await rpc.setSession({ sessionID, patch: { mode: argument } });
          ctx.ui.toast.show({
            message: `Anthropic cache TTL set to ${argument}.`,
            variant: "success",
          });
          return;
        }

        ctx.ui.toast.show({ message: USAGE, variant: "warning" });
      } catch (error) {
        ctx.ui.toast.show({
          message: `Anthropic cache TTL error: ${errorMessage(error)}`,
          variant: "error",
        });
      }
    };

    ctx.keymap.layer(() => ({
      mode: "base",
      commands: [
        {
          id: "anthropic-cache-ttl.open",
          title: "Anthropic Cache TTL",
          description: "Pick the Anthropic prompt cache TTL",
          group: "Provider",
          palette: true,
          slash: { name: "cache-ttl", arguments: true },
          run: (input?: string) => runCommand(input),
        },
      ],
    }));

    const controller = new AbortController();
    let disposed = false;

    // Surface settings changes triggered elsewhere (e.g. a second TUI
    // instance) as an info toast. Fire-and-forget; torn down below.
    void (async () => {
      try {
        for await (const _event of rpc.events.subscribe("settings.updated", {
          signal: controller.signal,
        })) {
          if (disposed) break;
          ctx.ui.toast.show({
            message: "Anthropic cache settings updated.",
            variant: "info",
          });
        }
      } catch {
        // Subscription aborted on cleanup; nothing to report.
      }
    })();

    return () => {
      disposed = true;
      controller.abort();
    };
  },
});
