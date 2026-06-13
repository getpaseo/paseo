import { Link } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { type Doc, type DocsNavNode, getDocBreadcrumbGroups } from "~/docs";

interface DocsBreadcrumbsProps {
  doc: Doc;
  tree: DocsNavNode[];
}

export function DocsBreadcrumbs({ doc, tree }: DocsBreadcrumbsProps) {
  const groups = getDocBreadcrumbGroups(doc, tree);

  return (
    <nav aria-label="Breadcrumb" className="not-prose mb-6">
      <ol className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <li>
          <Link to="/docs" className="hover:text-foreground transition-colors">
            Docs
          </Link>
        </li>
        {groups.map((group) => (
          <li key={group.label} className="flex items-center gap-2">
            <ChevronRight size={14} className="text-border" />
            <span>{group.label}</span>
          </li>
        ))}
        <li className="flex items-center gap-2">
          <ChevronRight size={14} className="text-border" />
          <span className="text-foreground">{doc.frontmatter.nav}</span>
        </li>
      </ol>
    </nav>
  );
}
