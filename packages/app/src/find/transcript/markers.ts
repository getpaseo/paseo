/**
 * Marks the parts of a transcript row whose text find is allowed to match.
 *
 * A row carries more text than it shows as message content — attachment titles, the
 * hidden timestamp, the turn footer — and the index projects none of it. Restricting
 * the DOM walk to marked subtrees is what keeps the two counting the same matches.
 *
 * The assistant marker goes on each rendered markdown block rather than the message
 * container, so the blocks line up one-to-one with the blocks the projection splits
 * the message into.
 */
export const FIND_TEXT_ATTRIBUTE = "data-paseo-find-text";

export const FIND_TEXT_SELECTOR = `[${FIND_TEXT_ATTRIBUTE}]`;

/** react-native-web turns `paseoFindText` into `data-paseo-find-text`. */
export const findTextDataSet = { paseoFindText: "true" } as const;
