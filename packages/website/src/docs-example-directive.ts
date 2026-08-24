import GithubSlugger from "github-slugger";
import type { Root } from "mdast";

// `:::example[Answer a Slack mention]` becomes a <details> block. Authors get a
// collapsible without us enabling rehype-raw, which would turn on raw HTML for
// every documentation page.
const DIRECTIVE_NAME = "example";

interface DirectiveNode {
  type: string;
  name?: string;
  children?: DirectiveNode[];
  data?: {
    hName?: string;
    hProperties?: Record<string, string>;
    directiveLabel?: boolean;
  };
}

function isLabel(node: DirectiveNode): boolean {
  return node.data?.directiveLabel === true;
}

function labelText(node: DirectiveNode): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return (node.children ?? []).map(labelText).join("");
}

export function remarkDocsExample() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree as unknown as DirectiveNode, (node) => {
      if (node.type !== "containerDirective" || node.name !== DIRECTIVE_NAME) return;
      const label = (node.children ?? []).find(isLabel);
      const title = label ? labelText(label) : "";
      node.data = {
        hName: "details",
        hProperties: { className: "docs-example", id: slugger.slug(title) },
      };
      if (label) {
        label.data = {
          ...label.data,
          hName: "summary",
          hProperties: { className: "docs-example-summary" },
        };
      }
    });
  };
}

function visit(node: DirectiveNode, visitor: (node: DirectiveNode) => void): void {
  visitor(node);
  for (const child of node.children ?? []) visit(child, visitor);
}
