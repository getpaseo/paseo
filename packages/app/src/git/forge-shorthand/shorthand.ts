import type { ForgeReferenceSigil } from "@/git/client-forge-module";
import { forgeFromRemoteUrl } from "@/git/forge";
import { getClientForgeLogicModule } from "@/git/forges";
import { buildForgeReferenceUrl } from "@/git/forge-url";

/**
 * Shorthand references in prose, such as `#12`, `!12` or `owner/repo#12`,
 * resolved against one workspace remote.
 */
export interface ForgeShorthand {
  /** Regex source for recognizing references in Markdown text. */
  pattern: string;
  /** Web URL for a recognized reference, or null. */
  resolve(text: string): string | null;
}

// Keep these in the syntax shared by JavaScript, ICU and java.util.regex: the
// pattern runs in the native Markdown engines too.
const REPO = String.raw`[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+`;
const NUMBER = String.raw`[1-9][0-9]{0,8}`;
// A reference never continues a word, path, URL fragment or entity.
const BEFORE = String.raw`(?<![A-Za-z0-9_./@#!&-])`;
const AFTER = String.raw`(?![A-Za-z0-9_])`;
const REFERENCE = new RegExp(String.raw`^(?:(${REPO}))?([#!])(${NUMBER})$`);

export function createForgeShorthand(input: {
  forge: string | null | undefined;
  remoteUrl: string | null | undefined;
}): ForgeShorthand | null {
  const remoteUrl = input.remoteUrl;
  const forge = input.forge || forgeFromRemoteUrl(remoteUrl);
  if (!forge || !remoteUrl) return null;
  const sigils = forgeSigils(forge).filter(
    (sigil) => buildForgeReferenceUrl(forge, { remoteUrl, sigil, number: 1 }) !== null,
  );
  if (sigils.length === 0) return null;
  return {
    pattern: `${BEFORE}(?:${REPO})?[${sigils.join("")}]${NUMBER}${AFTER}`,
    resolve(text) {
      const match = REFERENCE.exec(text);
      if (!match) return null;
      return buildForgeReferenceUrl(forge, {
        remoteUrl,
        repo: match[1] ?? null,
        sigil: match[2] as ForgeReferenceSigil,
        number: Number(match[3]),
      });
    },
  };
}

function forgeSigils(forge: string): ForgeReferenceSigil[] {
  const paths = getClientForgeLogicModule(forge)?.urlGrammar?.referencePaths ?? [];
  return paths.flatMap((path) => (path.sigil ? [path.sigil] : []));
}
