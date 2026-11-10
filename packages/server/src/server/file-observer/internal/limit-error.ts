/** A tree is too large for recursive observation, and no retry will make it smaller. */
export class FileObservationLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileObservationLimitError";
  }
}
