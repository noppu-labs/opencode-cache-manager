import type { Plugin } from "@opencode/plugin/tui";
import type { KeepaliveSnapshot } from "../models/keepalive.ts";
import type { CacheTtlRpcClient } from "../rpc.ts";

export interface SnapshotFeed {
  snapshots(): ReadonlyMap<string, KeepaliveSnapshot>;
  /** Fetches a session's snapshot once, unless an event already delivered one. */
  load(sessionID: string): void;
  dispose(): void;
}

/** Keepalive snapshots per session for the sidebar, kept current from `keepalive.updated` events. */
export function createSnapshotFeed(storage: Plugin.Context["storage"], rpc: CacheTtlRpcClient): SnapshotFeed {
  const [sidebar, updateSidebar] = storage.memory("keepalive", {
    initial: { snapshots: {} as Record<string, KeepaliveSnapshot> },
  });

  const applySnapshot = (snapshot: KeepaliveSnapshot): void => {
    updateSidebar((draft) => {
      draft.snapshots[snapshot.sessionID] = snapshot;
    });
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
        applySnapshot(event.data);
      }
    } catch {
      // Aborted on cleanup, or the stream closed; the sidebar keeps its last snapshots.
    }
  })();

  return {
    snapshots: () => new Map(Object.entries(sidebar.snapshots)),
    load,
    dispose: () => abort.abort(),
  };
}
