import type { Doc } from "~/docs";

const GITHUB_BASE_URL = "https://github.com/getpaseo/paseo/blob/main";

export function DocsSourceFooter({ doc }: { doc: Doc }) {
  const sourceUrl = `${GITHUB_BASE_URL}/${doc.sourcePath}`;

  return (
    <footer className="docs-source-footer">
      <a href={sourceUrl} target="_blank" rel="noreferrer">
        View this page on GitHub
      </a>
    </footer>
  );
}
