import { z } from "zod";

// Opted-in question permissions carry these in updatedInput.questionAnswers, keyed by header.
// Display labels are not identities: they may repeat or contain the multi-select separator.
export const QuestionAnswerSchema = z.object({
  selectedOptionIds: z.array(z.string().min(1)),
  otherText: z.string().optional(),
});

export const QuestionAnswersSchema = z.record(z.string(), QuestionAnswerSchema);
export type QuestionAnswers = z.infer<typeof QuestionAnswersSchema>;
