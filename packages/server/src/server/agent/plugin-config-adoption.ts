import type {
  LegacyAgentConfigCandidate,
  LegacyAgentConfigRecipe,
  LegacyAgentConfigSelector,
  LegacyAgentConfigState,
  PluginConfigAdoption,
  PluginConfigAdoptions,
  LegacyAgentConfigSelection,
  LegacyAgentConfigPreview,
} from "@getpaseo/protocol/plugin-agent-config";
import { PluginConfigAdoptionsSchema } from "@getpaseo/protocol/plugin-agent-config";
import type { AgentSessionConfig } from "./agent-sdk-types.js";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

interface LegacyConfigInspection {
  candidates: LegacyAgentConfigCandidate[];
  state: LegacyAgentConfigState;
  fragments: Map<string, PluginConfigAdoption["fragment"]>;
}

export function configFragmentDigest(value: unknown): string {
  return createHash("sha256").update(canonicalConfig(value)).digest("hex");
}

export function canonicalConfig(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalConfig).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalConfig(Reflect.get(value, key))}`)
    .join(",")}}`;
}

export function inspectLegacyAgentConfig(input: {
  pluginId: string;
  recipe: LegacyAgentConfigRecipe;
  config: AgentSessionConfig;
  env: Record<string, string>;
}): LegacyConfigInspection {
  const candidates: LegacyAgentConfigCandidate[] = [];
  const selectors: Record<string, "present" | "absent" | "ambiguous"> = {};
  const fragments = new Map<string, PluginConfigAdoption["fragment"]>();
  for (const selector of input.recipe.selectors) {
    const match = matchLegacySelector(selector, input.config, input.env);
    if (match === "ambiguous") selectors[selector.id] = "ambiguous";
    else selectors[selector.id] = match ? "present" : "absent";
    if (!match) continue;
    const candidate: LegacyAgentConfigCandidate = {
      id: selector.id,
      pluginId: input.pluginId,
      group: selector.group,
      label: selector.label,
      field: selector.kind,
      consequence: "Keep the original value; exclude the selected saved fragment on the next open",
    };
    if (match === "ambiguous") candidate.blockedReason = "Saved prompt selector is ambiguous";
    else fragments.set(selector.id, match);
    const policyBlockedReason = legacyPolicyBlockedReason(selector, input.config, input.recipe);
    if (policyBlockedReason) candidate.blockedReason = policyBlockedReason;
    if (selector.kind === "option" || selector.kind === "env") {
      candidate.baselines = selector.baselines.map(({ id, label }) => ({ id, label }));
      candidate.consequence =
        "Use an explicitly selected baseline on the next open; original value remains available for reset";
    }
    candidates.push(candidate);
  }
  blockOverlappingPromptCandidates(candidates, fragments);
  return { candidates, state: { selectors }, fragments };
}

function legacyPolicyBlockedReason(
  selector: LegacyAgentConfigSelector,
  config: AgentSessionConfig,
  recipe: LegacyAgentConfigRecipe,
): string | undefined {
  if (selector.kind === "grant" && config.toolPolicySource !== "plugin")
    return "Required or unmarked tool policy cannot be adopted";
  if (selector.kind !== "mcp") return undefined;
  const references =
    config.toolPolicy?.preapproved.filter((grant) => grant.server === selector.name) ?? [];
  if (references.length && config.toolPolicySource !== "plugin")
    return "Required or unmarked tool policy still references this server";
  const unknownReference = references.some(
    (grant) =>
      !recipe.selectors.some(
        (entry) =>
          entry.kind === "grant" && entry.server === grant.server && entry.tool === grant.tool,
      ),
  );
  if (unknownReference)
    return "Saved tool policy contains a grant without an exact legacy selector for this server";
  return undefined;
}

function matchLegacySelector(
  selector: LegacyAgentConfigSelector,
  config: AgentSessionConfig,
  env: Record<string, string>,
): PluginConfigAdoption["fragment"] | "ambiguous" | null {
  if (selector.kind === "mcp")
    return Object.hasOwn(config.mcpServers ?? {}, selector.name)
      ? { kind: "mcp", name: selector.name }
      : null;
  if (selector.kind === "option")
    return Object.hasOwn(config.providerOptions ?? {}, selector.key)
      ? { kind: "option", key: selector.key, baseline: selector.baselines[0]! }
      : null;
  if (selector.kind === "env")
    return Object.hasOwn(env, selector.key)
      ? { kind: "env", key: selector.key, baseline: selector.baselines[0]! }
      : null;
  if (selector.kind === "grant")
    return config.toolPolicy?.preapproved.some(
      (grant) => grant.server === selector.server && grant.tool === selector.tool,
    )
      ? { kind: "grant", server: selector.server, tool: selector.tool }
      : null;
  const prompt = config.systemPrompt ?? "";
  if (selector.kind === "prompt-suffix") return matchPromptSuffix(selector, prompt);
  return matchPromptSection(selector, prompt);
}

function matchPromptSuffix(
  selector: Extract<LegacyAgentConfigSelector, { kind: "prompt-suffix" }>,
  prompt: string,
): PluginConfigAdoption["fragment"] | "ambiguous" | null {
  const following = (selector.followedBySuffix ?? [""]).filter((suffix) =>
    prompt.endsWith(selector.text + suffix),
  );
  if (!following.length) return null;
  if (following.length !== 1) return "ambiguous";
  const end = prompt.length - following[0]!.length;
  return promptFragment(prompt, end - selector.text.length, end);
}

function matchPromptSection(
  selector: Extract<LegacyAgentConfigSelector, { kind: "prompt-section" }>,
  prompt: string,
): PluginConfigAdoption["fragment"] | "ambiguous" | null {
  const start = prompt.indexOf(selector.start);
  const end = prompt.indexOf(selector.end, start + selector.start.length);
  if (start < 0 && prompt.indexOf(selector.end) < 0) return null;
  if (
    start < 0 ||
    end < 0 ||
    prompt.indexOf(selector.start, start + selector.start.length) >= 0 ||
    prompt.indexOf(selector.end, end + selector.end.length) >= 0 ||
    prompt.indexOf(selector.end) < start
  )
    return "ambiguous";
  return promptFragment(prompt, start, end + selector.end.length);
}

function promptFragment(
  prompt: string,
  start: number,
  end: number,
): Extract<PluginConfigAdoption["fragment"], { kind: "prompt" }> {
  return {
    kind: "prompt",
    start: Buffer.byteLength(prompt.slice(0, start)),
    end: Buffer.byteLength(prompt.slice(0, end)),
    promptDigest: configFragmentDigest(prompt),
  };
}

function blockOverlappingPromptCandidates(
  candidates: LegacyAgentConfigCandidate[],
  fragments: Map<string, PluginConfigAdoption["fragment"]>,
): void {
  const prompts = [...fragments].filter(
    (entry): entry is [string, Extract<PluginConfigAdoption["fragment"], { kind: "prompt" }>] =>
      entry[1].kind === "prompt",
  );
  for (const [id, fragment] of prompts) {
    if (
      !prompts.some(
        ([otherId, other]) =>
          otherId !== id && fragment.start < other.end && other.start < fragment.end,
      )
    )
      continue;
    const candidate = candidates.find((entry) => entry.id === id)!;
    candidate.blockedReason = "Saved prompt selections overlap";
  }
}

export function projectAgentRequiredConfig(input: {
  config: AgentSessionConfig;
  env: Record<string, string>;
  receipts?: PluginConfigAdoptions;
}): { config: AgentSessionConfig; env: Record<string, string> } {
  const config = structuredClone(input.config);
  const env = structuredClone(input.env);
  const receipts = input.receipts?.receipts ?? [];
  validateAdoptionReceipts(input.config, input.env, receipts);
  const promptRanges: Extract<PluginConfigAdoption["fragment"], { kind: "prompt" }>[] = [];
  for (const { fragment } of receipts) {
    switch (fragment.kind) {
      case "mcp":
        delete config.mcpServers?.[fragment.name];
        break;
      case "grant":
        if (config.toolPolicy)
          config.toolPolicy.preapproved = config.toolPolicy.preapproved.filter(
            (grant) => grant.server !== fragment.server || grant.tool !== fragment.tool,
          );
        break;
      case "prompt":
        promptRanges.push(fragment);
        break;
      case "option":
        config.providerOptions ??= {};
        applyBaseline(config.providerOptions, fragment.key, fragment.baseline);
        break;
      case "env":
        if (fragment.baseline.kind === "value" && typeof fragment.baseline.value !== "string")
          throw new Error("Environment baseline must be a string");
        applyBaseline(env, fragment.key, fragment.baseline);
        break;
    }
  }
  if (
    config.toolPolicySource === "plugin" &&
    config.toolPolicy?.preapproved.length === 0 &&
    receipts.some(({ fragment }) => fragment.kind === "grant")
  ) {
    delete config.toolPolicy;
    delete config.toolPolicySource;
  }
  if (promptRanges.length)
    config.systemPrompt = projectPromptBytes(config.systemPrompt ?? "", promptRanges);
  return { config, env };
}

function validateAdoptionReceipts(
  config: AgentSessionConfig,
  env: Record<string, string>,
  receipts: PluginConfigAdoption[],
): void {
  for (const receipt of receipts) {
    const { fragment } = receipt;
    const staleFragment =
      configFragmentDigest(readAdoptedFragment(config, env, fragment)) !== receipt.fragmentDigest;
    const stalePrompt =
      fragment.kind === "prompt" &&
      fragment.promptDigest !== configFragmentDigest(config.systemPrompt ?? "");
    if (staleFragment || stalePrompt) {
      throw new Error(
        "Adopted plugin configuration is stale; reset the affected selection before editing it",
      );
    }
    if (fragment.kind === "grant" && config.toolPolicySource !== "plugin") {
      throw new Error("Required tool policy cannot be projected by a plugin receipt");
    }
    if (fragment.kind === "mcp") validateEndpointReceipts(config, receipt, receipts);
  }
}

function validateEndpointReceipts(
  config: AgentSessionConfig,
  endpoint: PluginConfigAdoption,
  receipts: PluginConfigAdoption[],
): void {
  if (endpoint.fragment.kind !== "mcp") return;
  const name = endpoint.fragment.name;
  for (const grant of config.toolPolicy?.preapproved ?? []) {
    if (grant.server !== name) continue;
    if (config.toolPolicySource !== "plugin")
      throw new Error("Required tool policy cannot be projected by a plugin receipt");
    if (!hasEndpointGrantReceipt(endpoint, grant, receipts))
      throw new Error(
        "Adopt every exact plugin-only grant referencing the selected MCP server together",
      );
  }
}

function hasEndpointGrantReceipt(
  endpoint: PluginConfigAdoption,
  grant: { server: string; tool: string },
  receipts: PluginConfigAdoption[],
): boolean {
  return receipts.some(
    (receipt) =>
      receipt.pluginId === endpoint.pluginId &&
      receipt.recipeDigest === endpoint.recipeDigest &&
      receipt.fragment.kind === "grant" &&
      receipt.fragment.server === grant.server &&
      receipt.fragment.tool === grant.tool,
  );
}

function projectPromptBytes(
  original: string,
  promptRanges: Extract<PluginConfigAdoption["fragment"], { kind: "prompt" }>[],
): string {
  promptRanges.sort((left, right) => right.start - left.start);
  let prompt = Buffer.from(original);
  let previousStart = prompt.length;
  for (const range of promptRanges) {
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end > previousStart ||
      range.start >= range.end
    ) {
      throw new Error("Adopted prompt ranges overlap or exceed the original prompt");
    }
    const splitsStart = (prompt[range.start]! & 0xc0) === 0x80;
    const splitsEnd = range.end < prompt.length && (prompt[range.end]! & 0xc0) === 0x80;
    if (splitsStart || splitsEnd)
      throw new Error("Adopted prompt ranges must use exact UTF-8 character boundaries");
    prompt = Buffer.concat([prompt.subarray(0, range.start), prompt.subarray(range.end)]);
    previousStart = range.start;
  }
  return prompt.toString("utf8");
}

function applyBaseline(
  target: Record<string, unknown>,
  key: string,
  baseline: Extract<PluginConfigAdoption["fragment"], { kind: "option" }>["baseline"],
): void {
  if (baseline.kind === "absent") delete target[key];
  else
    Object.defineProperty(target, key, {
      value: structuredClone(baseline.value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

export function readAdoptedFragment(
  config: AgentSessionConfig,
  env: Record<string, string>,
  fragment: PluginConfigAdoption["fragment"],
): unknown {
  switch (fragment.kind) {
    case "mcp":
      return config.mcpServers?.[fragment.name];
    case "option":
      return config.providerOptions?.[fragment.key];
    case "env":
      return env[fragment.key];
    case "grant":
      return config.toolPolicy?.preapproved.filter(
        (grant) => grant.server === fragment.server && grant.tool === fragment.tool,
      );
    case "prompt":
      return Buffer.from(config.systemPrompt ?? "")
        .subarray(fragment.start, fragment.end)
        .toString("utf8");
  }
}

export function selectLegacyAdoptions(input: {
  pluginId: string;
  recipe: LegacyAgentConfigRecipe;
  config: AgentSessionConfig;
  env: Record<string, string>;
  selections: LegacyAgentConfigSelection[];
}): PluginConfigAdoption[] {
  const inspection = inspectLegacyAgentConfig(input);
  const ids = new Set(input.selections.map((selection) => selection.id));
  if (ids.size !== input.selections.length || !ids.size)
    throw new Error("Select one or more unique legacy configuration candidates");
  const receipts = input.selections.map((selection): PluginConfigAdoption => {
    const candidate = inspection.candidates.find((entry) => entry.id === selection.id);
    const selector = input.recipe.selectors.find((entry) => entry.id === selection.id);
    const found = inspection.fragments.get(selection.id);
    if (!candidate || !selector || !found)
      throw new Error(`Legacy configuration candidate is unavailable: ${selection.id}`);
    if (candidate.blockedReason) throw new Error(candidate.blockedReason);
    let fragment = structuredClone(found);
    if (selector.kind === "option" || selector.kind === "env") {
      const baseline = selector.baselines.find((entry) => entry.id === selection.baselineId);
      if (!baseline) throw new Error(`Select an explicit baseline for ${selection.id}`);
      if (
        selector.kind === "env" &&
        baseline.kind === "value" &&
        typeof baseline.value !== "string"
      )
        throw new Error("Environment baseline must be a string");
      fragment = { kind: selector.kind, key: selector.key, baseline };
    }
    validateEndpointSelection(input.config, input.recipe, selector, ids);
    return {
      id: randomUUID(),
      pluginId: input.pluginId,
      recipeDigest: configFragmentDigest(input.recipe),
      selectorId: selector.id,
      fragment,
      fragmentDigest: configFragmentDigest(readAdoptedFragment(input.config, input.env, fragment)),
    };
  });
  if (Buffer.byteLength(JSON.stringify(receipts)) > 131072)
    throw new Error("Plugin adoption receipts exceed 128 KiB");
  return receipts;
}

function validateEndpointSelection(
  config: AgentSessionConfig,
  recipe: LegacyAgentConfigRecipe,
  selector: LegacyAgentConfigSelector,
  selected: ReadonlySet<string>,
): void {
  if (selector.kind !== "mcp") return;
  for (const grant of config.toolPolicy?.preapproved ?? []) {
    if (grant.server !== selector.name) continue;
    const matching = recipe.selectors.find(
      (candidate) =>
        candidate.kind === "grant" &&
        candidate.server === grant.server &&
        candidate.tool === grant.tool,
    );
    if (!matching || !selected.has(matching.id))
      throw new Error(
        "Adopt every exact plugin-only grant referencing the selected MCP server together",
      );
  }
}

export class PluginConfigAdoptionAuthority {
  private readonly key = randomBytes(32);

  preview(input: {
    agentId: string;
    pluginId: string;
    config: AgentSessionConfig;
    env: Record<string, string>;
    receipts?: PluginConfigAdoptions;
    recipe?: LegacyAgentConfigRecipe;
    operation: "adopt" | "reset";
  }): LegacyAgentConfigPreview {
    if (Buffer.byteLength(canonicalConfig({ config: input.config, env: input.env })) > 1048576)
      throw new Error("Agent configuration exceeds the 1 MiB adoption inspection limit");
    const candidates =
      input.operation === "adopt" && input.recipe
        ? inspectLegacyAgentConfig({ ...input, recipe: input.recipe }).candidates.filter(
            (candidate) =>
              !input.receipts?.receipts.some(
                (receipt) =>
                  receipt.pluginId === input.pluginId && receipt.selectorId === candidate.id,
              ),
          )
        : [];
    if (input.operation === "adopt" && !input.recipe)
      throw new Error(`Plugin ${input.pluginId} has no active legacy configuration recipe`);
    return {
      expectedFingerprint: this.fingerprint(input),
      candidates,
      receiptIds:
        input.receipts?.receipts
          .filter((receipt) => receipt.pluginId === input.pluginId)
          .map((receipt) => receipt.id) ?? [],
      warning:
        input.operation === "reset"
          ? "Reset restores original saved additions on the next open, even when the plugin is disabled"
          : undefined,
    };
  }

  apply(input: {
    agentId: string;
    pluginId: string;
    config: AgentSessionConfig;
    env: Record<string, string>;
    receipts?: PluginConfigAdoptions;
    recipe: LegacyAgentConfigRecipe;
    expectedFingerprint: string;
    selections: LegacyAgentConfigSelection[];
  }): PluginConfigAdoptions {
    const preview = this.preview({ ...input, operation: "adopt" });
    if (preview.expectedFingerprint !== input.expectedFingerprint)
      throw new Error("Legacy configuration preview is stale; preview again");
    const allowed = new Set(preview.candidates.map((candidate) => candidate.id));
    if (input.selections.some((selection) => !allowed.has(selection.id)))
      throw new Error("Legacy selection is unavailable or already adopted");
    const receipts = [...(input.receipts?.receipts ?? []), ...selectLegacyAdoptions(input)];
    if (
      new Set(receipts.map((receipt) => receipt.pluginId)).size > 16 ||
      Buffer.byteLength(JSON.stringify(receipts)) > 131072
    )
      throw new Error("Agent adoption receipt limits exceeded");
    const adoptions = PluginConfigAdoptionsSchema.parse({ version: 1, receipts });
    projectAgentRequiredConfig({
      config: input.config,
      env: input.env,
      receipts: adoptions,
    });
    return adoptions;
  }

  reset(input: {
    agentId: string;
    pluginId: string;
    config: AgentSessionConfig;
    env: Record<string, string>;
    receipts?: PluginConfigAdoptions;
    expectedFingerprint: string;
    receiptIds: string[];
  }): PluginConfigAdoptions | undefined {
    const preview = this.preview({ ...input, operation: "reset" });
    if (preview.expectedFingerprint !== input.expectedFingerprint)
      throw new Error("Legacy configuration preview is stale; preview again");
    const ids = new Set(input.receiptIds);
    if (
      !ids.size ||
      ids.size !== input.receiptIds.length ||
      [...ids].some((id) => !preview.receiptIds.includes(id))
    )
      throw new Error("Select unique receipt IDs belonging to this plugin");
    const previousReceipts = input.receipts!.receipts;
    const receipts = previousReceipts.filter((receipt) => !ids.has(receipt.id));
    const dependentEndpoints = receipts.filter((endpoint) => {
      const { fragment } = endpoint;
      return (
        fragment.kind === "mcp" &&
        (input.config.toolPolicy?.preapproved ?? []).some(
          (grant) =>
            grant.server === fragment.name &&
            hasEndpointGrantReceipt(endpoint, grant, previousReceipts) &&
            !hasEndpointGrantReceipt(endpoint, grant, receipts),
        )
      );
    });
    if (dependentEndpoints.length)
      throw new Error(
        `Reset the dependent MCP endpoint receipt(s) together: ${dependentEndpoints.map((receipt) => receipt.id).join(", ")}`,
      );
    return receipts.length ? { version: 1, receipts } : undefined;
  }

  private fingerprint(input: {
    agentId: string;
    pluginId: string;
    config: AgentSessionConfig;
    env: Record<string, string>;
    receipts?: PluginConfigAdoptions;
    recipe?: LegacyAgentConfigRecipe;
    operation: "adopt" | "reset";
  }): string {
    return createHmac("sha256", this.key)
      .update(
        canonicalConfig({
          agentId: input.agentId,
          pluginId: input.pluginId,
          config: { ...input.config, title: undefined },
          env: input.env,
          receipts: input.receipts,
          recipe: input.operation === "adopt" ? input.recipe : undefined,
          operation: input.operation,
        }),
      )
      .digest("hex");
  }
}
