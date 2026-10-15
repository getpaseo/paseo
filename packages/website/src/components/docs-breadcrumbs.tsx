import { useMemo } from "react";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { type Doc, type DocsNavNode, getDocBreadcrumbGroups } from "~/docs";

interface DocsBreadcrumbsProps {
  doc: Doc;
  tree: DocsNavNode[];
}

export function DocsBreadcrumbs({ doc, tree }: DocsBreadcrumbsProps) {
  const items = useMemo<BreadcrumbItem[]>(
    () => [
      { label: "Docs", href: "/docs" },
      ...getDocBreadcrumbGroups(doc, tree).map((group) => ({ label: group.label })),
      { label: doc.frontmatter.nav },
    ],
    [doc, tree],
  );
  return <Breadcrumbs items={items} />;
}
