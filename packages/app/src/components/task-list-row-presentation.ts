import type { TodoEntry } from "@/types/stream";

/**
 * Which of the three status marks a task row draws. The mark also picks the text emphasis, so
 * the row makes one decision rather than two that can disagree.
 */
export type TaskRowMark = "pending" | "running" | "done";

export interface TaskRowPresentation {
  mark: TaskRowMark;
  text: string;
}

/**
 * The row's whole decision, kept out of the component so it is testable without a browser.
 *
 * `completed` wins over `status`: providers report the two separately, and a task that carries
 * both is finished, whatever the status field still says.
 */
export function buildTaskRowPresentation(task: TodoEntry): TaskRowPresentation {
  if (task.completed || task.status === "completed") {
    return { mark: "done", text: task.text };
  }
  if (task.status === "in_progress") {
    // The active form is the present-tense phrasing an agent supplies for the task it works on
    // now ("Running checks"). It applies only while that task runs.
    return { mark: "running", text: task.activeForm ?? task.text };
  }
  return { mark: "pending", text: task.text };
}
