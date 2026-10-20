import { Plugin } from "@opencode/plugin/tui";
import { CacheTtlRpc, type CacheTtlRpcClient } from "./rpc.ts";
import { createCommandRunner } from "./ui/command.ts";
import { createPicker, type Toast } from "./ui/picker.ts";
import { createSnapshotFeed } from "./ui/snapshot-feed.ts";

/**
 * TUI entrypoint for the Anthropic prompt-cache plugin.
 *
 * Registers a palette + `/cache-manager` slash command. With no argument it
 * opens a picker with Session and Global sections; a typed argument is applied
 * to the current session directly. All mutations go through the server RPC so
 * the settings stay in one place (`ctx.storage`).
 */
export default Plugin.define({
  id: "anthropic-cache-ttl",
  async setup(ctx) {
    const rpc = ctx.client.rpc(CacheTtlRpc as any) as unknown as CacheTtlRpcClient;

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const toast: Toast = (message, variant) => ctx.ui.toast.show({ message, variant });

    const openPicker = createPicker({ dialog: ctx.ui.dialog, rpc, toast, currentSessionID });
    const runCommand = createCommandRunner({ rpc, toast, currentSessionID, openPicker });

    ctx.keymap.layer(() => ({
      mode: "base",
      commands: [
        {
          id: "cache-manager.open",
          title: "Cache Manager",
          description: "Manage the Anthropic prompt cache TTL and keepalive",
          group: "Provider",
          palette: true,
          slash: { name: "cache-manager", arguments: true },
          run: (input?: string) => runCommand(input),
        },
      ],
    }));

    const feed = createSnapshotFeed(ctx.storage, rpc);

    // The sidebar is Solid JSX loaded lazily so a failure there (for example a
    // host without the Solid transform) cannot take the command or picker down.
    let disposeSidebar: (() => void) | undefined;
    try {
      const { registerSidebar } = await import("./ui/sidebar.tsx");
      disposeSidebar = registerSidebar(ctx, feed.snapshots, feed.load);
    } catch {
      // Sidebar unavailable; the rest of the plugin keeps working.
    }

    return () => {
      feed.dispose();
      disposeSidebar?.();
    };
  },
});
