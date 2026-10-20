import { Plugin } from "@opencode/plugin/tui";
import { CacheTtlRpc } from "./rpc.ts";
import { parseCommandArg, type CacheTtlMode } from "./shared.ts";
import { mergeSettings, type Settings, type SettingsPatch } from "./settings.ts";

/**
 * Interactive metadata for each cache TTL mode, shown in the picker modal.
 */
const OPTION_INFO: Record<CacheTtlMode, { title: string; description: string }> = {
  "5m": {
    title: "5 minutes (default)",
    description: "Standard ephemeral cache. 1.25x base input write cost, 0.1x read.",
  },
  "1h": {
    title: "1 hour (extended)",
    description: "1h ephemeral on every breakpoint. 2x base input write cost, 0.1x read.",
  },
  hybrid: {
    title: "Hybrid",
    description: "1h on tools + system prompt; 5m on rolling messages.",
  },
};

const USAGE =
  "Usage: /cache-manager [5m | 1h | hybrid | keepalive on|off | pings <n> | min <n|nk> | reset | status]";
const NO_SESSION = "Open a session to change session cache settings.";
const CUSTOM = "custom";

type Field = keyof Settings;
type Scope = "session" | "global";
type Choice<V> = { title: string; value: V; description?: string };

const FIELDS: Field[] = ["mode", "keepalive", "maxPings", "minContextTokens"];

const FIELD_INFO: Record<Field, { row: string; label: string }> = {
  mode: { row: "TTL mode", label: "cache TTL" },
  keepalive: { row: "Keepalive", label: "keepalive" },
  maxPings: { row: "Pings per idle", label: "pings per idle" },
  minContextTokens: { row: "Min context", label: "min context" },
};

const PING_CHOICES = [0, 1, 3, 5, 10];
const MIN_CONTEXT_CHOICES = [0, 20_000, 50_000, 100_000];

/** Loose client shape mirroring the `@opencode/plugin` RPC client for our contract. */
type RpcClient = {
  getSettings(input: { sessionID?: string }): Promise<{
    global: Settings;
    session: SettingsPatch | null;
  }>;
  setGlobal(input: { patch: SettingsPatch }): Promise<unknown>;
  setSession(input: { sessionID: string; patch: SettingsPatch }): Promise<unknown>;
  resetSession(input: { sessionID: string }): Promise<unknown>;
  events: {
    subscribe(
      name: "settings.updated",
      options?: { signal?: AbortSignal },
    ): AsyncIterable<unknown>;
  };
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatTokens(tokens: number): string {
  return tokens > 0 && tokens % 1000 === 0 ? `${tokens / 1000}k` : String(tokens);
}

function formatValue<F extends Field>(field: F, value: Settings[F]): string {
  if (field === "keepalive") return value ? "on" : "off";
  if (field === "minContextTokens") return formatTokens(value as number);
  return String(value);
}

/** Dialog rows for one scope; session rows mark values inherited from global. */
function settingsOptions(
  scope: Scope,
  values: Settings,
  override: SettingsPatch | null,
): { title: string; value: string; category: string }[] {
  const category = scope === "session" ? "Session" : "Global";
  return FIELDS.map((field) => {
    const inherited = scope === "session" && override?.[field] === undefined;
    return {
      title: `${FIELD_INFO[field].row}  ${formatValue(field, values[field])}${inherited ? " · global" : ""}`,
      value: `${scope}:${field}`,
      category,
    };
  });
}

/** The sub-dialog choices for a setting; `custom` is present for numeric ones. */
function fieldChoices(field: Field): Choice<string | number>[] {
  switch (field) {
    case "mode":
      return (["5m", "1h", "hybrid"] as const).map((value) => ({ value, ...OPTION_INFO[value] }));
    case "keepalive":
      return [
        { title: "on", value: "on" },
        { title: "off", value: "off" },
      ];
    case "maxPings":
      return [
        ...PING_CHOICES.map((value) => ({ title: String(value), value })),
        { title: "Custom…", value: CUSTOM },
      ];
    case "minContextTokens":
      return [
        ...MIN_CONTEXT_CHOICES.map((value) => ({ title: formatTokens(value), value })),
        { title: "Custom…", value: CUSTOM },
      ];
  }
}

/**
 * TUI entrypoint for the Anthropic prompt-cache plugin.
 *
 * Registers a palette + `/cache-manager` slash command. With no argument it
 * opens a picker with Session and Global sections; a typed argument is applied
 * to the current session directly. All mutations go through the server RPC so
 * the settings stay in one place (`ctx.storage`).
 */
export default Plugin.define({
  id: "anthropic-cache-ttl",
  async setup(ctx) {
    const rpc = ctx.client.rpc(CacheTtlRpc as any) as unknown as RpcClient;

    const currentSessionID = (): string | undefined => {
      const route = ctx.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };

    const toast = (message: string, variant: "success" | "info" | "warning" | "error") =>
      ctx.ui.toast.show({ message, variant });

    const write = async (scope: Scope, sessionID: string | undefined, patch: SettingsPatch) => {
      if (scope === "session" && sessionID !== undefined) {
        await rpc.setSession({ sessionID, patch });
      } else {
        await rpc.setGlobal({ patch });
      }
    };

    /** Asks for a number via the prompt dialog; `undefined` on cancel or invalid input. */
    const promptNumber = async (field: "maxPings" | "minContextTokens"): Promise<number | undefined> => {
      const input = await ctx.ui.dialog.prompt({
        title: FIELD_INFO[field].row,
        description: field === "maxPings" ? "Number of pings, 0-100." : "Tokens, e.g. 50000 or 50k.",
        placeholder: field === "maxPings" ? "5" : "50k",
      });
      if (input === undefined) return undefined;
      const action = parseCommandArg(`${field === "maxPings" ? "pings" : "min"} ${input}`);
      const value = action.type === "set" ? action.patch[field] : undefined;
      if (value === undefined) {
        toast(`"${input.trim()}" is not a valid value for ${FIELD_INFO[field].label}.`, "warning");
      }
      return value;
    };

    /** Picks a new value for one setting and writes it; cancelling writes nothing. */
    const editField = async (
      scope: Scope,
      field: Field,
      sessionID: string | undefined,
      effective: Settings,
    ): Promise<void> => {
      const current = effective[field];
      const currentChoice = field === "keepalive" ? (current ? "on" : "off") : current;
      const selected = await ctx.ui.dialog.select<string | number>({
        title: `${scope === "session" ? "Session" : "Global"} ${FIELD_INFO[field].label}`,
        current: currentChoice as string | number,
        options: fieldChoices(field),
      });
      if (selected === undefined) return;

      let patch: SettingsPatch;
      if (selected === CUSTOM) {
        const value = await promptNumber(field as "maxPings" | "minContextTokens");
        if (value === undefined) return;
        patch = { [field]: value };
      } else if (field === "keepalive") {
        patch = { keepalive: selected === "on" };
      } else {
        patch = { [field]: selected } as SettingsPatch;
      }

      const next = patch[field] as Settings[Field];
      if (next === current) return;
      await write(scope, sessionID, patch);
      toast(
        `${scope === "session" ? "Session" : "Global"} ${FIELD_INFO[field].label} set to ${formatValue(field, next as never)}.`,
        "success",
      );
    };

    const openPicker = async (): Promise<void> => {
      const sessionID = currentSessionID();
      const { global, session } = await rpc.getSettings(sessionID === undefined ? {} : { sessionID });
      const effective = mergeSettings(global, session ?? {});

      const options = [
        ...(sessionID === undefined
          ? []
          : [
              ...settingsOptions("session", effective, session),
              { title: "Reset session to global", value: "session:reset", category: "Session" },
            ]),
        ...settingsOptions("global", global, null),
      ];
      const choice = await ctx.ui.dialog.select<string>({
        title: "Cache Manager",
        placeholder: "Select a setting",
        options,
      });
      if (choice === undefined) return;

      if (choice === "session:reset") {
        if (sessionID === undefined) return;
        await rpc.resetSession({ sessionID });
        toast("Session cache settings reset to global.", "success");
        return;
      }
      const [scope, field] = choice.split(":") as [Scope, Field];
      await editField(scope, field, sessionID, scope === "session" ? effective : global);
    };

    const runTyped = async (input: string): Promise<void> => {
      const action = parseCommandArg(input);
      if (action.type === "toggle") return openPicker();
      if (action.type === "invalid") {
        toast(USAGE, "warning");
        return;
      }
      const sessionID = currentSessionID();
      if (sessionID === undefined) {
        toast(NO_SESSION, "warning");
        return;
      }

      if (action.type === "status") {
        const { global, session } = await rpc.getSettings({ sessionID });
        const s = mergeSettings(global, session ?? {});
        toast(
          `Session cache: TTL ${s.mode}, keepalive ${formatValue("keepalive", s.keepalive)}, pings ${s.maxPings}, min context ${formatTokens(s.minContextTokens)}.`,
          "info",
        );
        return;
      }
      if (action.type === "reset") {
        await rpc.resetSession({ sessionID });
        toast("Session cache settings reset to global.", "success");
        return;
      }

      await rpc.setSession({ sessionID, patch: action.patch });
      for (const field of FIELDS) {
        const value = action.patch[field];
        if (value === undefined) continue;
        toast(`Session ${FIELD_INFO[field].label} set to ${formatValue(field, value as never)}.`, "success");
      }
    };

    const runCommand = async (input?: string): Promise<void> => {
      try {
        await runTyped(input ?? "");
      } catch (error) {
        toast(`Cache Manager error: ${errorMessage(error)}`, "error");
      }
    };

    ctx.keymap.layer(() => ({
      mode: "base",
      commands: [
        {
          id: "cache-manager.open",
          title: "Cache Manager",
          description: "Manage the Anthropic prompt cache TTL and keepalive",
          group: "Provider",
          palette: true,
          slash: { name: "cache-manager", arguments: true },
          run: (input?: string) => runCommand(input),
        },
      ],
    }));

    return () => {};
  },
});
