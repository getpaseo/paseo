import { script } from "./script";

/** What the reviewer writes on the line. */
export const REVIEW_COMMENT = "Add “write”. The agent edits files too.";

/**
 * The code review scene: the pointer adds a comment on a line of the diff and the user types it.
 * Then the pointer sends the feedback and picks the agent that gets it.
 */
export const REVIEW = script([
  { kind: "wait", ms: 300 },
  { kind: "click", target: "addComment" },
  { kind: "wait", ms: 250 },
  { kind: "type", text: REVIEW_COMMENT },
  { kind: "mark", name: "saved", ms: 450 },
  { kind: "click", target: "sendFeedback" },
  { kind: "click", target: "recipient" },
]);

/** The click on the add button of the line. It opens the comment editor. */
export const ADD_COMMENT_CLICK = REVIEW.click("addComment");
/** The click on Send feedback. It opens the list of agents. */
export const SEND_FEEDBACK_CLICK = REVIEW.click("sendFeedback");
/** The click on the agent that gets the feedback. */
export const RECIPIENT_CLICK = REVIEW.click("recipient");

/**
 * Where the review stands.
 *
 * - `reading`: no comment yet.
 * - `writing`: the comment editor is open.
 * - `commented`: the comment is saved and waits to be sent.
 * - `choosing`: the list of agents is open.
 * - `sent`: an agent has the feedback, and the saved comment is gone.
 */
export type ReviewPhase = "reading" | "writing" | "commented" | "choosing" | "sent";

export function reviewPhase(ms: number): ReviewPhase {
  if (RECIPIENT_CLICK.done(ms)) return "sent";
  if (SEND_FEEDBACK_CLICK.done(ms)) return "choosing";
  if (REVIEW.reached("saved", ms)) return "commented";
  if (ADD_COMMENT_CLICK.done(ms)) return "writing";
  return "reading";
}

/** Whether the pointer is over the line. A hovered line shows its add button. */
export function lineHovered(ms: number): boolean {
  return ADD_COMMENT_CLICK.approach(ms) > 0.93 && !ADD_COMMENT_CLICK.done(ms);
}

/** Whether the pointer is over the agent it is about to pick. */
export function recipientHovered(ms: number): boolean {
  return RECIPIENT_CLICK.approach(ms) > 0.8;
}
