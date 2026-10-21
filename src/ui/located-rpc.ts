import type { CacheTtlRpcClient, RawCacheTtlRpcClient, RpcCallOptions, RpcLocation } from "../rpc.ts";

/**
 * Wraps the RPC client so every call carries a location. OpenCode runs one
 * server instance of the plugin per directory, and a call without a location
 * reaches the default one, which never sees the session's requests.
 */
export function withLocation(
  rpc: RawCacheTtlRpcClient,
  locate: (sessionID: string | undefined) => RpcLocation | undefined,
): CacheTtlRpcClient {
  const options = (sessionID: string | undefined): RpcCallOptions | undefined => {
    const location = locate(sessionID);
    return location === undefined ? undefined : { location };
  };
  return {
    getSettings: (input) => rpc.getSettings(input, options(input.sessionID)),
    setGlobal: (input) => rpc.setGlobal(input, options(undefined)),
    setSession: (input) => rpc.setSession(input, options(input.sessionID)),
    resetSession: (input) => rpc.resetSession(input, options(input.sessionID)),
    getKeepalive: (input) => rpc.getKeepalive(input, options(input.sessionID)),
    events: rpc.events,
  };
}
