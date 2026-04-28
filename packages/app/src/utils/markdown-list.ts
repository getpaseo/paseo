type MarkdownNode = {
  type?: string;
  index?: number;
  markup?: string;
  attributes?: {
    start?: number | string;
  };
  children?: MarkdownNode[];
};

const LIST_BULLET = "•";
const DEFAULT_ORDERED_LIST_MARKUP = ".";

function toParentNodes(parent: unknown): MarkdownNode[] {
  if (Array.isArray(parent)) {
    return parent;
  }

  if (parent && typeof parent === "object") {
    return [parent as MarkdownNode];
  }

  return [];
}

function getNearestListParent(parent: unknown): MarkdownNode | undefined {
  return toParentNodes(parent).find(
    (ancestor) => ancestor?.type === "ordered_list" || ancestor?.type === "bullet_list",
  );
}

function getOrderedListItemIndex(node: MarkdownNode, listParent: MarkdownNode): number {
  if (typeof node.index === "number" && Number.isFinite(node.index) && node.index >= 0) {
    return node.index;
  }

  if (Array.isArray(listParent.children)) {
    const fallbackIndex = listParent.children.indexOf(node);
    if (fallbackIndex >= 0) {
      return fallbackIndex;
    }
  }

  return 0;
}

function parseOrderedListStart(node: MarkdownNode): number {
  const rawStart = node.attributes?.start;
  if (typeof rawStart === "number" && Number.isFinite(rawStart)) {
    return rawStart;
  }

  if (typeof rawStart === "string") {
    const parsed = Number.parseInt(rawStart, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return 1;
}

export function getMarkdownListMarker(
  node: MarkdownNode,
  parent: unknown,
): {
  isOrdered: boolean;
  marker: string;
} {
  const listParent = getNearestListParent(parent);
  if (!listParent || listParent.type !== "ordered_list") {
    return {
      isOrdered: false,
      marker: LIST_BULLET,
    };
  }

  const orderedIndex = getOrderedListItemIndex(node, listParent);
  const orderedStart = parseOrderedListStart(listParent);
  const orderedMarkup =
    typeof node.markup === "string" && node.markup.length > 0
      ? node.markup
      : DEFAULT_ORDERED_LIST_MARKUP;

  return {
    isOrdered: true,
    marker: `${orderedStart + orderedIndex}${orderedMarkup}`,
  };
}
