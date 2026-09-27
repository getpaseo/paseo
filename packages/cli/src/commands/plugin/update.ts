import type {
  PluginUpdatePreview,
  PluginUpdateResult,
  PluginUpdateSelection,
  PluginUpdateProposal,
} from "@getpaseo/protocol/messages";

interface UpdateClient {
  previewPluginUpdates(input: {
    pluginId?: string;
    target?: PluginUpdateSelection;
  }): Promise<PluginUpdatePreview[]>;
  applyPluginUpdates(proposals: PluginUpdateProposal[]): Promise<PluginUpdateResult[]>;
}
export interface UpdateOptions {
  pluginId?: string;
  all?: boolean;
  ref?: string;
  version?: string;
  check?: boolean;
  yes?: boolean;
}
export interface UpdateInteraction {
  interactive: boolean;
  structured: boolean;
  write(text: string): void;
  confirm(message: string): Promise<boolean>;
}
export interface UpdateOutcome {
  id: string;
  outcome: PluginUpdatePreview["outcome"] | PluginUpdateResult["outcome"] | "declined";
  current?: PluginUpdatePreview["current"];
  target?: PluginUpdatePreview["target"];
  links?: string[];
  proposal?: PluginUpdateProposal;
  plugin?: PluginUpdateResult["plugin"];
  error?: string;
  warning?: string;
}

export async function reviewPluginUpdates(
  client: UpdateClient,
  options: UpdateOptions,
  interaction: UpdateInteraction,
): Promise<UpdateOutcome[]> {
  if ((options.pluginId === undefined) === (options.all !== true))
    throw new Error("Choose one plugin ID or pass --all");
  if (options.ref && options.version) throw new Error("Choose --ref or --version, not both");
  let target: PluginUpdateSelection | undefined;
  if (options.ref) target = { kind: "git", ref: options.ref };
  if (options.version) target = { kind: "npm", version: options.version };
  if (target && options.all)
    throw new Error("An explicit target requires one plugin ID, without --all");
  const preview = await client.previewPluginUpdates({ pluginId: options.pluginId, target });
  if (!interaction.structured) interaction.write(formatUpdatePreview(preview));
  if (options.check) return preview;
  const proposals = preview.flatMap((item) => (item.proposal ? [item.proposal] : []));
  if (!proposals.length) return preview;
  if (!options.yes && !target) {
    if (interaction.structured || !interaction.interactive)
      throw new Error("Confirmation required; rerun with --yes.");
    if (
      !(await interaction.confirm(
        options.all ? "Update these plugins? [y/N] " : `Update ${options.pluginId}? [y/N] `,
      ))
    ) {
      return preview.map((item) => (item.proposal ? { id: item.id, outcome: "declined" } : item));
    }
  }
  const applied = new Map(
    (await client.applyPluginUpdates(proposals)).map((item) => [item.id, item]),
  );
  return preview.map((item) => applied.get(item.id) ?? item);
}

export function formatUpdatePreview(items: PluginUpdatePreview[]): string {
  return items
    .map((item) => {
      const current = item.current?.currentRevision ?? "unknown";
      const target = item.target?.kind === "git" ? item.target.commit : item.target?.version;
      let text: string;
      switch (item.outcome) {
        case "update":
          text = `${current} → ${target}`;
          break;
        case "current":
          text = `up to date (${current})`;
          break;
        case "installed-newer":
          text = `installed ${current} is newer than latest ${target}; keeping installed version`;
          break;
        case "local":
          text = "local directory; use Reload after editing";
          break;
        case "error":
          text = item.error ?? "Check failed";
          break;
      }
      return `${item.id}: ${text}\n${item.links.map((link) => `Review: ${link}\n`).join("")}`;
    })
    .join("\n");
}
