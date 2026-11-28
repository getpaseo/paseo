"use strict";

const OFF = {
  heading: false,
  unorderedList: false,
  orderedList: false
};

// Validated per leaf rather than trusted from the prop type: `getBoolean` on the
// Android side throws on a missing or non-boolean field, and a null root would
// crash JS on property access.
const flag = raw => typeof raw === 'boolean' ? raw : false;
export const normalizeMarkdownShortcuts = raw => {
  if (typeof raw === 'boolean') {
    return {
      heading: raw,
      unorderedList: raw,
      orderedList: raw
    };
  }
  if (typeof raw !== 'object' || raw === null) {
    return OFF;
  }
  const obj = raw;
  return {
    heading: flag(obj.heading),
    unorderedList: flag(obj.unorderedList),
    orderedList: flag(obj.orderedList)
  };
};
//# sourceMappingURL=normalizeMarkdownShortcuts.js.map