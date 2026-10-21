import type { Plugin } from "@opencode/plugin/tui";
import type { KeepaliveSnapshot } from "../models/keepalive.ts";
import type { CacheTtlRpcClient } from "../rpc.ts";

export interface SnapshotFeed {
  snapshots(): ReadonlyMap<string, KeepaliveSnapshot>;
  /** Fetches a session's snapshot once, unless an event already delivered one. */
  load(sessionID: string): void;
  /** Fetches a session's snapshot again and stores it, unless an event arrived meanwhile. */
  refresh(sessionID: string): void;
  dispose(): void;
}

/**
 * Keepalive snapshots per session for the sidebar, from `keepalive.updated`
 * events and from fetches. The sidebar refreshes on a timer because OpenCode
 * does not deliver events emitted from the server's request hooks and timers.
 */
export function createSnapshotFeed(storage: Plugin.Context["storage"], rpc: CacheTtlRpcClient): SnapshotFeed {
  const [sidebar, updateSidebar] = storage.memory("keepalive", {
    initial: { snapshots: {} as Record<string, KeepaliveSnapshot> },
  });

  /** Counts events per session, so a fetch can tell whether one arrived while it ran. */
  const received = new Map<string, number>();
  const inflight = new Set<string>();

  const applySnapshot = (snapshot: KeepaliveSnapshot): void => {
    updateSidebar((draft) => {
      draft.snapshots[snapshot.sessionID] = snapshot;
    });
  };

  const refresh = (sessionID: string): void => {
    if (inflight.has(sessionID)) return;
    inflight.add(sessionID);
    const before = received.get(sessionID) ?? 0;
    rpc.getKeepalive({ sessionID }).then(
      (snapshot) => {
        inflight.delete(sessionID);
        if ((received.get(sessionID) ?? 0) === before) applySnapshot(snapshot);
      },
      () => inflight.delete(sessionID),
    );
  };

  const requested = new Set<string>();
  const load = (sessionID: string): void => {
    if (requested.has(sessionID)) return;
    requested.add(sessionID);
    rpc.getKeepalive({ sessionID }).then(
      (snapshot) => {
        if (sidebar.snapshots[sessionID] === undefined) applySnapshot(snapshot);
      },
      () => requested.delete(sessionID),
    );
  };

  const abort = new AbortController();
  void (async () => {
    try {
      for await (const event of rpc.events.subscribe("keepalive.updated", { signal: abort.signal })) {
        received.set(event.data.sessionID, (received.get(event.data.sessionID) ?? 0) + 1);
        applySnapshot(event.data);
      }
    } catch {
      // Aborted on cleanup, or the stream closed; the sidebar keeps its last snapshots.
    }
  })();

  return {
    snapshots: () => new Map(Object.entries(sidebar.snapshots)),
    load,
    refresh,
    dispose: () => abort.abort(),
  };
}
