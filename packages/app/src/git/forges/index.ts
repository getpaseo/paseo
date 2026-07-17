import type { ClientForgeLogicModule, ForgeSpecificEnvelope } from "@/git/client-forge-module";
import { codebergForgeLogic } from "./codeberg";
import { forgejoForgeLogic } from "./forgejo";
import { giteaForgeLogic } from "./gitea";
import { githubForgeLogic } from "./github";
import { gitlabForgeLogic } from "./gitlab";

/**
 * Pure logic registry. Import this (never the view registry) from URL builders,
 * merge-capability, and native-check derivations so those paths — and the
 * Node-based e2e harness that transitively imports them — stay free of the
 * client rendering stack (react-native, react-native-svg, unistyles).
 */
export const CLIENT_FORGE_LOGIC_MODULES: readonly ClientForgeLogicModule[] = [
  githubForgeLogic,
  gitlabForgeLogic,
  giteaForgeLogic,
  forgejoForgeLogic,
  codebergForgeLogic,
];

export function getClientForgeLogicModule(id: string): ClientForgeLogicModule | null {
  return CLIENT_FORGE_LOGIC_MODULES.find((module) => module.id === id) ?? null;
}

export function parseClientForgeFacts(facts: unknown): ForgeSpecificEnvelope | null {
  for (const module of CLIENT_FORGE_LOGIC_MODULES) {
    const parsed = module.facts?.parse(facts);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}
