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

/** Usage objects captured from OpenAI-compatible endpoints (see the plan's "Usage shapes seen on the wire"). */
export const openaiUsage = {
  omnirouteAutoWrite: {
    prompt_tokens: 1698,
    completion_tokens: 4,
    total_tokens: 1702,
    reasoning_tokens: 0,
    completion_tokens_details: { reasoning_tokens: 0 },
    cache_creation_input_tokens: 14845,
    prompt_tokens_details: { cache_creation_in_prompt: false },
  },
  omnirouteAutoRead: {
    prompt_tokens: 16543,
    completion_tokens: 4,
    total_tokens: 16547,
    reasoning_tokens: 0,
    prompt_tokens_details: { cached_tokens: 14845 },
    completion_tokens_details: { reasoning_tokens: 0 },
    cache_read_input_tokens: 14845,
  },
  lunaWrite: {
    prompt_tokens: 8887,
    completion_tokens: 5,
    total_tokens: 8892,
    cached_tokens: 0,
    reasoning_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
    cache_creation_input_tokens: 8884,
    cost: 0.0011133,
  },
  lunaRead: {
    prompt_tokens: 8906,
    completion_tokens: 61,
    total_tokens: 8967,
    cached_tokens: 8884,
    reasoning_tokens: 53,
    prompt_tokens_details: { cached_tokens: 8884 },
    cache_creation_input_tokens: 19,
    cost: 0.000122015,
  },
  deepseekRead: {
    prompt_tokens: 10195,
    completion_tokens: 3,
    total_tokens: 10198,
    cached_tokens: 10112,
    reasoning_tokens: 0,
    prompt_tokens_details: { cached_tokens: 10112 },
    cache_creation_input_tokens: 0,
  },
};

/** A streamed Chat Completions response: content chunk, finish chunk, usage-only chunk, `[DONE]`. */
export function openaiSse(
  usage: unknown,
  options: { finishReason?: string; model?: string; provider?: string } = {},
): string {
  const { finishReason = "stop", model = "openai/gpt-6-luna", provider = "OpenAI" } = options;
  const chunk = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;
  return (
    chunk({ model, provider, choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] }) +
    chunk({ model, provider, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) +
    chunk({ model, provider, choices: [], usage }) +
    "data: [DONE]\n\n"
  );
}
