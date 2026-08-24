import type { ClientForgeViewModule } from "@/git/client-forge-module";
import { codebergForgeView } from "./codeberg.view";
import { forgejoForgeView } from "./forgejo.view";
import { giteaForgeView } from "./gitea.view";
import { githubForgeView } from "./github.view";
import { gitlabForgeView } from "./gitlab.view";

/**
 * View registry: brand marks, brand colors, and PR-pane render contributions.
 * Import this only from rendering code (icon lookup, the PR pane); it pulls the
 * client rendering stack, so logic paths must use the logic registry instead.
 */
export const CLIENT_FORGE_VIEW_MODULES: readonly ClientForgeViewModule[] = [
  githubForgeView,
  gitlabForgeView,
  giteaForgeView,
  forgejoForgeView,
  codebergForgeView,
];

export function getClientForgeViewModule(id: string): ClientForgeViewModule | null {
  return CLIENT_FORGE_VIEW_MODULES.find((module) => module.id === id) ?? null;
}
