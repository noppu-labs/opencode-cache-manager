import { Plugin } from '@opencode/plugin';
import type { RpcHandlers, RpcRegistration } from '@opencode/plugin/promise/rpc';

import { pluginOptions, settingsFromOptions } from './config/settings.ts';
import { PING_PROMPT } from './constants/keepalive.ts';
import { MODELS_DEV_FETCH_TIMEOUT_MS } from './constants/savings.ts';
import { createCacheManagerCommand } from './controllers/command.ts';
import { createRpcHandlers } from './controllers/rpc-handlers.ts';
import { createRequestHook } from './middleware/request.ts';
import { createResponseHook } from './middleware/response.ts';
import type { KeepaliveSnapshot } from './models/keepalive.ts';
import { CacheTtlRpc } from './rpc.ts';
import { fetchJson } from './services/fetch-json.ts';
import { KeepaliveEngine } from './services/keepalive-engine.ts';
import { LEDGER_KEY_PREFIX, LedgerStore } from './services/ledger-store.ts';
import { PriceBook, toCatalogModels } from './services/model-prices.ts';
import { ModelsDevPrices } from './services/models-dev.ts';
import { releasesMessages } from './services/ping-alignment.ts';
import { PingTracker } from './services/ping-tracker.ts';
import { ProfileStore } from './services/profile-store.ts';
import { SavingsLedger } from './services/savings-ledger.ts';
import {
  SESSION_KEY_PREFIX,
  SettingsStore,
  sweepDeletedSessions,
} from './services/settings-store.ts';

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
 * per-session state through `getKeepalive` and the `keepalive.updated` event,
 * with what the pings cost and saved (see `services/savings-ledger.ts`).
 */
export default Plugin.define({
  id: 'opencode-cache-manager',
  async setup(ctx) {
    const store = new SettingsStore(ctx.storage, settingsFromOptions(ctx.options));
    await store.load();
    const options = pluginOptions(ctx.options);
    const profiles = new ProfileStore(ctx.storage);
    await profiles.load();

    /*
     * Referenced from inside its own handlers so they can emit the update
     * event; declared before the `await` to avoid a temporal-dead-zone hazard.
     */
    let rpcRegistration: RpcRegistration<typeof CacheTtlRpc> | undefined;
    const pings = new PingTracker();
    const primaryMessages = new Map<string, unknown[]>();

    const modelsDev = options.modelsDevPrices
      ? new ModelsDevPrices({
          fetchJson: async (url) => fetchJson(url, MODELS_DEV_FETCH_TIMEOUT_MS),
          kv: ctx.storage,
          now: () => Date.now(),
        })
      : undefined;
    const prices = new PriceBook({
      listModels: async () => {
        const { data } = await ctx.model.list();
        return toCatalogModels(data);
      },
      ...(modelsDev
        ? { fallback: async (names: readonly string[]) => modelsDev.match(names) }
        : {}),
    });
    void prices.prefetch();
    // Bound once the engine exists: the ledger is built first, since the engine takes it as a dep.
    const ledgerChanged: { refresh?: (sessionID: string) => void } = {};
    const savings = new SavingsLedger({
      onChange: (sessionID) => {
        ledgerChanged.refresh?.(sessionID);
      },
      prices,
      store: new LedgerStore(ctx.storage),
    });

    const engine = new KeepaliveEngine({
      clearTimer: (handle) => {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the engine only passes back handles that setTimer above returned
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      },
      isChild: async (sessionID) => {
        const session = await ctx.session.get({ sessionID });
        return Boolean(session.parentID);
      },
      now: () => Date.now(),
      onChange: (snapshot: KeepaliveSnapshot) => {
        if (releasesMessages(snapshot, Date.now())) primaryMessages.delete(snapshot.sessionID);
        void Promise.resolve(rpcRegistration?.events.emit('keepalive.updated', snapshot)).catch(
          () => {}
        );
      },
      ping: async (sessionID) =>
        pings.send(sessionID, async () => ctx.session.generate({ prompt: PING_PROMPT, sessionID })),
      savings,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      settings: async (sessionID) => store.effective(sessionID),
    });
    ledgerChanged.refresh = (sessionID) => {
      engine.refresh(sessionID);
    };

    /** Applies a settings change to the keepalive schedule and tells the TUI. */
    const settingsChanged = async (sessionID: string | null): Promise<object> => {
      await engine.reevaluate(sessionID ?? undefined);
      await rpcRegistration?.events.emit('settings.updated', { sessionID });
      /*
       * RPC output schemas are `object`; returning undefined would fail host
       * output validation (rpc.invalid_output). Handlers return an empty object.
       */
      return {};
    };

    try {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the host types handler inputs as unknown, while the handlers take the shapes the method schemas validate
      const handlers = createRpcHandlers({ engine, settingsChanged, store }) as RpcHandlers<
        typeof CacheTtlRpc
      >;
      rpcRegistration = await ctx.rpc.register(CacheTtlRpc, handlers);
    } catch {
      // RPC is optional (older hosts / headless runs): keep command + hook.
    }

    await ctx.command.transform((editor) => {
      editor.add(
        createCacheManagerCommand({
          say: async (sessionID, text) => ctx.session.synthetic({ resume: false, sessionID, text }),
          settingsChanged,
          store,
        })
      );
    });

    await ctx.session.hook(
      'http.request',
      createRequestHook({ engine, options, pings, primaryMessages, profiles, store })
    );
    await ctx.session.hook(
      'http.response',
      createResponseHook({ engine, options, pings, profiles })
    );

    const getSession = async (sessionID: string): Promise<unknown> =>
      ctx.session.get({ sessionID });
    void sweepDeletedSessions(ctx.storage, getSession, [
      SESSION_KEY_PREFIX,
      LEDGER_KEY_PREFIX,
    ]).catch(() => {});

    return () => {
      engine.dispose();
      primaryMessages.clear();
    };
  },
});
