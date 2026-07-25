import { GITEA_FAMILY_URL_GRAMMAR, type ClientForgeLogicModule } from "@/git/client-forge-module";

export const forgejoForgeLogic = {
  id: "forgejo",
  urlGrammar: GITEA_FAMILY_URL_GRAMMAR,
} satisfies ClientForgeLogicModule;
