export function ephemeral(extra: Record<string, unknown> = {}) {
  return { type: "ephemeral", ...extra };
}

/** A representative Anthropic payload with breakpoints on tools, system and messages. */
export function sampleBody() {
  return {
    model: "claude-sonnet-5-5",
    tools: [
      { name: "tool_a", cache_control: ephemeral() },
      { name: "tool_b" },
      {
        name: "namespace",
        tools: [
          { name: "nested_a", cache_control: ephemeral() },
          { name: "nested_b" },
        ],
      },
    ],
    system: [
      { type: "text", text: "You are helpful.", cache_control: ephemeral() },
      { type: "text", text: "Extra system text." },
    ],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "hello", cache_control: ephemeral() },
          { type: "text", text: "world" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
      {
        role: "user",
        cache_control: ephemeral(),
        content: [{ type: "text", text: "tail" }],
      },
    ],
  } as Record<string, unknown>;
}

/** Collects every cache_control object found anywhere in a payload. */
export function collectCacheControls(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) collectCacheControls(item, out);
    return out;
  }
  const rec = node as Record<string, unknown>;
  const cc = rec.cache_control;
  if (cc && typeof cc === "object") out.push(cc as Record<string, unknown>);
  for (const value of Object.values(rec)) collectCacheControls(value, out);
  return out;
}

export function makeRequest(
  body: string | undefined,
  headers: Record<string, string> = {},
  options: { method?: string } = {},
) {
  return new Request("https://api.anthropic.com/v1/messages", {
    method: options.method ?? "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

export function parsedBodyOf(request: Request) {
  return request.clone().json() as Promise<Record<string, unknown>>;
}
