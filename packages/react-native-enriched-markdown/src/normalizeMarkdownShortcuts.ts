export type NormalizedMarkdownShortcuts = {
  heading: boolean;
  unorderedList: boolean;
  orderedList: boolean;
};

const OFF: NormalizedMarkdownShortcuts = {
  heading: false,
  unorderedList: false,
  orderedList: false,
};

// Validated per leaf rather than trusted from the prop type: `getBoolean` on the
// Android side throws on a missing or non-boolean field, and a null root would
// crash JS on property access.
const flag = (raw: unknown): boolean =>
  typeof raw === 'boolean' ? raw : false;

export const normalizeMarkdownShortcuts = (
  raw: unknown
): NormalizedMarkdownShortcuts => {
  if (typeof raw === 'boolean') {
    return { heading: raw, unorderedList: raw, orderedList: raw };
  }
  if (typeof raw !== 'object' || raw === null) {
    return OFF;
  }
  const obj = raw as {
    heading?: unknown;
    unorderedList?: unknown;
    orderedList?: unknown;
  };
  return {
    heading: flag(obj.heading),
    unorderedList: flag(obj.unorderedList),
    orderedList: flag(obj.orderedList),
  };
};
