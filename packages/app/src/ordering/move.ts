export type OrderAnchor = { before: string } | { after: string } | { kind: "end" };
export interface OrderMove {
  moved: string;
  anchor: OrderAnchor;
  alternatives: OrderAnchor[];
}
export interface CreateOrderMoveInput {
  moved: string;
  order: readonly string[];
}
export function createOrderMove({ moved, order }: CreateOrderMoveInput): OrderMove {
  const index = order.indexOf(moved);
  const anchors: OrderAnchor[] = [];
  for (let distance = 1; distance < order.length; distance++) {
    const next = order[index + distance];
    const previous = order[index - distance];
    if (next !== undefined) anchors.push({ before: next });
    if (previous !== undefined) anchors.push({ after: previous });
  }
  return {
    moved,
    anchor: anchors[0] ?? { kind: "end" },
    alternatives: anchors.slice(1),
  };
}
export function applyOrderMove(order: readonly string[], move: OrderMove): string[] {
  const next = order.filter((key) => key !== move.moved);
  for (const anchor of [move.anchor, ...move.alternatives]) {
    if ("kind" in anchor) break;
    const key = "before" in anchor ? anchor.before : anchor.after;
    const index = next.indexOf(key);
    if (index < 0) continue;
    next.splice(index + ("after" in anchor ? 1 : 0), 0, move.moved);
    return next;
  }
  // Establish only the explicit pair in a new scope, never the rest of a cached pane.
  const anchor = move.anchor;
  if ("before" in anchor) next.push(move.moved, anchor.before);
  else if ("after" in anchor) next.push(anchor.after, move.moved);
  else next.push(move.moved);
  return next;
}
