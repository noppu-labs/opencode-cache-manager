import type {
  CacheTtlRpcClient,
  RawCacheTtlRpcClient,
  RpcCallOptions,
  RpcLocation,
} from '../rpc.ts';

/**
 * Wraps the RPC client so every call carries a location. OpenCode runs one
 * server instance of the plugin per directory, and a call without a location
 * reaches the default one, which never sees the session's requests.
 */
export function withLocation(
  rpc: RawCacheTtlRpcClient,
  locate: (sessionID: string | undefined) => RpcLocation | undefined
): CacheTtlRpcClient {
  const options = (sessionID?: string): RpcCallOptions | undefined => {
    const location = locate(sessionID);
    return location === undefined ? undefined : { location };
  };
  return {
    events: rpc.events,
    getKeepalive: async (input) => rpc.getKeepalive(input, options(input.sessionID)),
    getSettings: async (input) => rpc.getSettings(input, options(input.sessionID)),
    resetSession: async (input) => rpc.resetSession(input, options(input.sessionID)),
    setGlobal: async (input) => rpc.setGlobal(input, options()),
    setSession: async (input) => rpc.setSession(input, options(input.sessionID)),
  };
}
