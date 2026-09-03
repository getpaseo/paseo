/**
 * Subtrees find must not match even though they are painted.
 *
 * Deliberately not `data-paseo-markdown-ignore`: assistant-selection-copy deletes the
 * subtrees that attribute marks, so borrowing it to hide something from find would also
 * drop it from copied messages and from selection copy.
 *
 * The one user today is the mermaid fence's source view. find/transcript/plain-text.ts
 * projects a mermaid fence as empty text because whether the source or the rendered
 * diagram is on screen depends on a sandboxed iframe answering, the source policy
 * rejecting the fence, a render error, and the "View source" toggle. Only the DOM knows,
 * so the projection commits to "nothing" and this attribute makes the DOM agree.
 */
export const FIND_IGNORE_ATTRIBUTE = "data-paseo-find-ignore";

/** react-native-web turns `paseoFindIgnore` into `data-paseo-find-ignore`. */
export const findIgnoreDataSet = { paseoFindIgnore: "true" } as const;
