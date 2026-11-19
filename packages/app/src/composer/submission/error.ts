export interface ComposerMessageSubmissionErrorInput {
  clientMessageId: string;
  message: string;
  cause: unknown;
}

export class ComposerMessageSubmissionError extends Error {
  readonly clientMessageId: string;

  constructor(input: ComposerMessageSubmissionErrorInput) {
    super(input.message, { cause: input.cause });
    this.name = "ComposerMessageSubmissionError";
    this.clientMessageId = input.clientMessageId;
  }
}
