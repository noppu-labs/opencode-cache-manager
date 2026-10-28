import { Plugin } from '@opencode/plugin/tui';

import { CacheTtlRpc, type RawCacheTtlRpcClient } from './rpc.ts';
import { createCommandRunner } from './ui/command.ts';
import { withLocation } from './ui/located-rpc.ts';
import { createPicker, type Toast } from './ui/picker.ts';
import { createSnapshotFeed } from './ui/snapshot-feed.ts';
import { isInsideNodeModules } from './utils/node-modules.ts';

/**
 * TUI entrypoint for the prompt-cache plugin.
 *
 * Registers a palette + `/cache-manager` slash command. With no argument it
 * opens a picker with Session and Global sections; a typed argument is applied
 * to the current session directly. All mutations go through the server RPC so
 * the settings stay in one place (`ctx.storage`).
 */
export default Plugin.define({
  id: 'opencode-cache-manager',
  async setup(ctx) {
    const rpc = withLocation(
      ctx.client.rpc(CacheTtlRpc as any) as unknown as RawCacheTtlRpcClient,
      (sessionID) =>
        (sessionID === undefined ? undefined : ctx.data.session.get(sessionID)?.location) ??
        ctx.location ??
        ctx.data.location.default()
    );

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route.type === 'session' ? route.sessionID : undefined;
    };
    const toast: Toast = (message, variant) => ctx.ui.toast.show({ message, variant });

    const openPicker = createPicker({ dialog: ctx.ui.dialog, rpc, toast, currentSessionID });
    const runCommand = createCommandRunner({ rpc, toast, currentSessionID, openPicker });

    ctx.keymap.layer(() => ({
      mode: 'base',
      commands: [
        {
          id: 'cache-manager.open',
          title: 'Cache Manager',
          description: 'Manage the prompt cache TTL and keepalive (Claude, GPT-5.6+)',
          group: 'Provider',
          palette: true,
          slash: { name: 'cache-manager', arguments: true },
          run: (input?: string) => runCommand(input),
        },
      ],
    }));

    const feed = createSnapshotFeed(ctx.storage, rpc);

    // The sidebar is Solid JSX loaded lazily so a failure there cannot take the
    // command or picker down. The host only runs the Solid transform outside
    // node_modules, so an npm install loads the copy compiled at pack time.
    // Both specifiers stay literal: the host finds imports to rewrite by scanning for them.
    let disposeSidebar: (() => void) | undefined;
    try {
      const { registerSidebar } = isInsideNodeModules(import.meta.url)
        ? await import('./ui/sidebar.compiled.js')
        : await import('./ui/sidebar.tsx');
      disposeSidebar = registerSidebar(ctx, feed.snapshots, feed.load, feed.refresh);
    } catch {
      // Sidebar unavailable; the rest of the plugin keeps working.
    }

    return () => {
      feed.dispose();
      disposeSidebar?.();
    };
  },
});
