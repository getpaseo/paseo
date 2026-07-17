import { GITEA_FAMILY_URL_GRAMMAR, type ClientForgeLogicModule } from "@/git/client-forge-module";

export const codebergForgeLogic = {
  id: "codeberg",
  urlGrammar: GITEA_FAMILY_URL_GRAMMAR,
} satisfies ClientForgeLogicModule;
