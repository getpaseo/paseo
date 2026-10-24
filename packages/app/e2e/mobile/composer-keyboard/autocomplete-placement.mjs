// Shared by the iOS and Android composer keyboard harnesses. Reads an agent-device
// `snapshot --raw --json` result. Accessibility keeps reporting suggestion rows that
// sit behind the keyboard, so existence is not evidence: compare their screen bounds.

const bottomOf = (rect) => rect.y + rect.height;

function findById(nodes, identifier) {
  const node = nodes.find((candidate) => candidate.identifier === identifier && candidate.rect);
  if (!node) throw new Error(`Missing node: ${identifier}`);
  return node;
}

function contains(outer, inner) {
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    bottomOf(inner) <= bottomOf(outer) + 1
  );
}

/**
 * The best match is the list row nearest the composer. Check that the popover sits
 * between the app's header controls and the composer, that the keyboard (when shown)
 * is below both, and that the row nearest the composer is fully drawn and is
 * `expected`. A clipped best match fails: the nearest whole row is then another one.
 * Return where to tap it. Android leaves the composer out of the accessibility tree
 * while suggestions are open, so its callers read the composer from `reference`: a
 * snapshot in the same keyboard state with an empty input.
 */
export function resolveAutocompletePlacement(snapshot, { expected, keyboardTop, reference }) {
  if (!snapshot.success || !snapshot.data?.nodes?.length) throw new Error("Empty device snapshot");
  const nodes = snapshot.data.nodes;
  const popover = findById(nodes, "composer-autocomplete-popover").rect;
  const composer = findById((reference ?? snapshot).data.nodes, "message-input-root").rect;
  // The popover may cover the compact header, never the status bar above it.
  const minimumTop =
    nodes.find((node) => node.identifier === "menu-button" && node.rect)?.rect.y ?? 0;
  // iOS reports the keyboard in the app's tree; Android callers pass the IME frame.
  const keyboardY =
    keyboardTop ?? nodes.find((node) => node.type === "Keyboard" && node.rect)?.rect.y;
  const popoverBottom = bottomOf(popover);
  if (popoverBottom > composer.y + 1) {
    throw new Error(
      `Autocomplete overlaps the composer: popover bottom=${popoverBottom}, composer top=${composer.y}`,
    );
  }
  if (popover.y < minimumTop - 1) {
    throw new Error(
      `Autocomplete extends above the header: top=${popover.y}, minimum=${minimumTop}`,
    );
  }
  if (keyboardY !== undefined && popoverBottom > keyboardY + 1) {
    throw new Error(
      `Autocomplete sits behind the keyboard: popover bottom=${popoverBottom}, keyboard top=${keyboardY}`,
    );
  }
  // Rows are the innermost labelled boxes spanning the popover. The list scrolls to
  // its end, so the lowest row is the best match nearest the composer.
  const candidates = nodes.filter(
    (node) =>
      node.rect &&
      node.label &&
      node.identifier !== "composer-autocomplete-popover" &&
      !/scroll bar/i.test(node.label) &&
      node.rect.height > 0 &&
      // The popover border insets rows by a few pixels; their labels are narrower.
      node.rect.width >= popover.width * 0.97 &&
      contains(popover, node.rect),
  );
  const area = (rect) => rect.width * rect.height;
  const rows = candidates.filter(
    (outer) =>
      !candidates.some(
        (inner) => area(inner.rect) < area(outer.rect) - 1 && contains(outer.rect, inner.rect),
      ),
  );
  if (rows.length === 0) throw new Error("Autocomplete has no visible rows");
  const best = rows.reduce((lowest, row) =>
    bottomOf(row.rect) > bottomOf(lowest.rect) ? row : lowest,
  );
  const label = best.label.split(", ")[0];
  if (label !== expected) {
    throw new Error(`Best visible match is ${label}, expected ${expected}`);
  }
  return {
    label,
    x: Math.round(best.rect.x + best.rect.width / 2),
    y: Math.round(best.rect.y + best.rect.height / 2),
    popover,
    composer,
    keyboardTop: keyboardY ?? null,
  };
}
