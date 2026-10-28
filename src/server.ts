import { Plugin } from '@opencode/plugin';
import type { RpcHandlers, RpcRegistration } from '@opencode/plugin/promise/rpc';

import { pluginOptions, settingsFromOptions } from './config/settings.ts';
import { PING_PROMPT } from './constants/keepalive.ts';
import { createCacheManagerCommand } from './controllers/command.ts';
import { createRpcHandlers } from './controllers/rpc-handlers.ts';
import { createRequestHook } from './middleware/request.ts';
import { createResponseHook } from './middleware/response.ts';
import type { KeepaliveSnapshot } from './models/keepalive.ts';
import { CacheTtlRpc } from './rpc.ts';
import { KeepaliveEngine } from './services/keepalive-engine.ts';
import { releasesMessages } from './services/ping-alignment.ts';
import { PingTracker } from './services/ping-tracker.ts';
import { ProfileStore } from './services/profile-store.ts';
import { SettingsStore, sweepDeletedSessions } from './services/settings-store.ts';

/**
 * Server entrypoint for the prompt-cache plugin.
 *
 * Registers a `/cache-manager` command and an `http.request` hook that rewrites
 * `cache_control.ttl` using layered settings (built-in defaults, plugin options,
 * global, per-session). An RPC surface (`getSettings` / `setGlobal` /
 * `setSession` / `resetSession`) with a `settings.updated` event lets the TUI
 * drive the same settings through an interactive modal.
 *
 * It also observes Anthropic responses and keeps each session's prompt cache
 * warm with transient pings (see `services/keepalive-engine.ts`), publishing
 * per-session state through `getKeepalive` and the `keepalive.updated` event.
 */
export default Plugin.define({
  id: 'opencode-cache-manager',
  async setup(ctx) {
    const store = new SettingsStore(ctx.storage, settingsFromOptions(ctx.options));
    await store.load();
    const options = pluginOptions(ctx.options);
    const profiles = new ProfileStore(ctx.storage);
    await profiles.load();

    // Referenced from inside its own handlers so they can emit the update
    // event; declared before the `await` to avoid a temporal-dead-zone hazard.
    let rpcRegistration: RpcRegistration<typeof CacheTtlRpc> | undefined;
    const pings = new PingTracker();
    const primaryMessages = new Map<string, unknown[]>();

    const engine = new KeepaliveEngine({
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (handle) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine only passes back handles that setTimer above returned
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      settings: (sessionID) => store.effective(sessionID),
      isChild: async (sessionID) => Boolean((await ctx.session.get({ sessionID })).parentID),
      onChange: (snapshot: KeepaliveSnapshot) => {
        if (releasesMessages(snapshot, Date.now())) primaryMessages.delete(snapshot.sessionID);
        void Promise.resolve(rpcRegistration?.events.emit('keepalive.updated', snapshot)).catch(
          () => {}
        );
      },
      ping: (sessionID) =>
        pings.send(sessionID, () => ctx.session.generate({ sessionID, prompt: PING_PROMPT })),
    });

    /** Applies a settings change to the keepalive schedule and tells the TUI. */
    const settingsChanged = async (sessionID: string | null) => {
      await engine.reevaluate(sessionID ?? undefined);
      await rpcRegistration?.events.emit('settings.updated', { sessionID });
      // RPC output schemas are `object`; returning undefined would fail host
      // output validation (rpc.invalid_output). Handlers return an empty object.
      return {};
    };

    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host types handler inputs as unknown, while the handlers take the shapes the method schemas validate
      const handlers = createRpcHandlers({ store, engine, settingsChanged }) as RpcHandlers<
        typeof CacheTtlRpc
      >;
      rpcRegistration = await ctx.rpc.register(CacheTtlRpc, handlers);
    } catch {
      // RPC is optional (older hosts / headless runs): keep command + hook.
    }

    await ctx.command.transform((editor) => {
      editor.add(
        createCacheManagerCommand({
          store,
          settingsChanged,
          say: (sessionID, text) => ctx.session.synthetic({ sessionID, text, resume: false }),
        })
      );
    });

    await ctx.session.hook(
      'http.request',
      createRequestHook({ store, engine, pings, options, profiles, primaryMessages })
    );
    await ctx.session.hook(
      'http.response',
      createResponseHook({ engine, pings, options, profiles })
    );

    void sweepDeletedSessions(ctx.storage, (sessionID) => ctx.session.get({ sessionID })).catch(
      () => {}
    );

    return () => {
      engine.dispose();
      primaryMessages.clear();
    };
  },
});
