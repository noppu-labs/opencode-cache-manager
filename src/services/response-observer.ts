import type {
  CacheUsage,
  ObservedResponse,
  ResponseIdentity,
  ResponseParsers,
} from '../models/cache.ts';

// oxlint-disable-next-line unicorn/no-useless-undefined -- Promise.resolve() is typed Promise<void>, which does not fit Promise<T | undefined>
const resolvedUndefined = <T>(): Promise<T | undefined> => Promise.resolve(undefined);

/**
 * Tees the response body so usage, the stop reason and, where `parsers`
 * report it, the resolved model and provider can be read in the background
 * while the caller receives an unmodified response. Cancelling the caller's body also stops the
 * observer, so the source is cancelled. The promises never reject.
 */
export function observeResponseUsage(
  response: Response,
  parsers: ResponseParsers
): {
  response: Response;
  usage: Promise<CacheUsage | undefined>;
  stopReason: Promise<string | undefined>;
  identity: Promise<ResponseIdentity | undefined>;
} {
  if (!response.body) {
    return {
      identity: resolvedUndefined<ResponseIdentity>(),
      response,
      stopReason: resolvedUndefined<string>(),
      usage: resolvedUndefined<CacheUsage>(),
    };
  }

  const [callerBranch, observerBranch] = response.body.tee();
  const callerReader = callerBranch.getReader();
  const observerReader = observerBranch.getReader();
  let cancelled = false;
  const forCaller = new ReadableStream<Uint8Array>(
    {
      async cancel(reason) {
        cancelled = true;
        await Promise.all([callerReader.cancel(reason), observerReader.cancel(reason)]);
      },
      async pull(controller) {
        const { done, value } = await callerReader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
    },
    { highWaterMark: 0 }
  );
  const passthrough = new Response(forCaller, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });

  const contentType = response.headers.get('content-type') ?? '';
  const parsed = (async (): Promise<ObservedResponse> => {
    try {
      const decoder = new TextDecoder();
      let text = '';
      for (;;) {
        const { done, value } = await observerReader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
      if (cancelled || !response.ok) return {};
      if (contentType.includes('text/event-stream')) return parsers.fromSse(text);
      return parsers.fromJson(JSON.parse(text));
    } catch {
      return {};
    }
  })();

  return {
    identity: parsed.then((p) => p.identity),
    response: passthrough,
    stopReason: parsed.then((p) => p.stopReason),
    usage: parsed.then((p) => p.usage),
  };
}
