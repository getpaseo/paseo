import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Doc } from "~/docs";

const GITHUB_BASE_URL = "https://github.com/getpaseo/paseo/blob/main";

export function DocsSourceFooter({ doc }: { doc: Doc }) {
  const { t } = useTranslation();
  const sourceUrl = `${GITHUB_BASE_URL}/${doc.sourcePath}`;

  return (
    <footer className="mt-12 border-t border-white/10 py-8 text-sm">
      <a
        href={sourceUrl}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 font-medium text-white/60 underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {t("docs.viewOnGitHub")}
        <ExternalLink aria-hidden="true" className="size-3.5" />
      </a>
    </footer>
  );
}
