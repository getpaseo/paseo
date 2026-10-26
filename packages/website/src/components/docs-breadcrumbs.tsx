import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { type BreadcrumbItem, Breadcrumbs } from "~/components/breadcrumbs";
import { type Doc, type DocsNavNode, getDocBreadcrumbGroups } from "~/docs";

interface DocsBreadcrumbsProps {
  doc: Doc;
  tree: DocsNavNode[];
}

export function DocsBreadcrumbs({ doc, tree }: DocsBreadcrumbsProps) {
  const { t } = useTranslation();
  const docsLabel = t("nav.docs");
  const items = useMemo<BreadcrumbItem[]>(
    () => [
      { label: docsLabel, href: "/docs" },
      ...getDocBreadcrumbGroups(doc, tree).map((group) => ({ label: group.label })),
      { label: doc.frontmatter.nav },
    ],
    [doc, docsLabel, tree],
  );
  return <Breadcrumbs items={items} />;
}
