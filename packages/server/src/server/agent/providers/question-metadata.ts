import { z } from "zod";
import type { AgentMetadata } from "../agent-sdk-types.js";

const TOOL_NAMES = new Set(["ask", "ask_user", "ask_user_question", "question"]);
const Questions = z.object({ questions: z.array(z.record(z.string(), z.unknown())).min(1) });
const SingleQuestion = z
  .object({ question: z.string().min(1), options: z.array(z.unknown()) })
  .passthrough();
const Result = z.object({ details: z.unknown().optional() });

interface QuestionToolInput {
  toolName: string;
  args: unknown;
  result: unknown;
}

/** Keep the source data even when the native tool card is a plain-text summary. */
export function questionToolMetadata(input: QuestionToolInput): AgentMetadata | undefined {
  if (!TOOL_NAMES.has(input.toolName)) return undefined;
  const multiple = Questions.safeParse(input.args);
  const single = SingleQuestion.safeParse(input.args);
  let questions: unknown[];
  if (multiple.success) {
    questions = multiple.data.questions;
  } else if (single.success) {
    questions = [single.data];
  } else {
    return undefined;
  }
  const result = Result.safeParse(input.result);
  const metadata: AgentMetadata = { questions };
  if (result.success && result.data.details !== undefined) {
    metadata.questionResult = result.data.details;
  }
  return metadata;
}
