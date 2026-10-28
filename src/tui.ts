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
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host types RPC results as unknown; rpc.ts declares the shapes the server handlers return
      ctx.client.rpc(CacheTtlRpc) as unknown as RawCacheTtlRpcClient,
      (sessionID) =>
        (sessionID === undefined ? undefined : ctx.data.session.get(sessionID)?.location) ??
        ctx.location ??
        ctx.data.location.default()
    );

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route.type === 'session' ? route.sessionID : undefined;
    };
    const toast: Toast = (message, variant) => {
      ctx.ui.toast.show({ message, variant });
    };

    const openPicker = createPicker({ currentSessionID, dialog: ctx.ui.dialog, rpc, toast });
    const runCommand = createCommandRunner({ currentSessionID, openPicker, rpc, toast });

    ctx.keymap.layer(() => ({
      commands: [
        {
          description: 'Manage the prompt cache TTL and keepalive (Claude, GPT-5.6+)',
          group: 'Provider',
          id: 'cache-manager.open',
          palette: true,
          run: (input?: string) => runCommand(input),
          slash: { arguments: true, name: 'cache-manager' },
          title: 'Cache Manager',
        },
      ],
      mode: 'base',
    }));

    const feed = createSnapshotFeed(ctx.storage, rpc);

    /*
     * The sidebar is Solid JSX loaded lazily so a failure there cannot take the
     * command or picker down. The host only runs the Solid transform outside
     * node_modules, so an npm install loads the copy compiled at pack time.
     * Both specifiers stay literal: the host finds imports to rewrite by scanning for them.
     */
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
