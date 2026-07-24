import type { WorkspaceLinkPayload } from "@getpaseo/protocol/messages";
import type { PaseoConfig } from "@getpaseo/protocol/paseo-config-schema";
import { getWorkspaceLinkConfigs } from "../utils/worktree.js";

export const WORKSPACE_PATH_TEMPLATE = "{workspacePath}";

export function buildWorkspaceLinkPayloads(options: {
  paseoConfig: PaseoConfig | null;
  workspacePath: string;
}): WorkspaceLinkPayload[] {
  const encodedWorkspacePath = encodeURIComponent(options.workspacePath);
  const links: WorkspaceLinkPayload[] = [];
  for (const [name, config] of getWorkspaceLinkConfigs(options.paseoConfig)) {
    const url = config.url.replaceAll(WORKSPACE_PATH_TEMPLATE, encodedWorkspacePath);
    try {
      const protocol = new URL(url).protocol;
      if (protocol === "http:" || protocol === "https:") {
        links.push({ name, url });
      }
    } catch {
      continue;
    }
  }
  return links.sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }),
  );
}
