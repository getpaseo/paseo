import type { FileVersion } from "@getpaseo/protocol/messages";

let nextReadSequence = 0;

export class FileReadRecoveryTracker {
  private latestStartedReadSequence = 0;
  private nonReadyObservedAfterSequence: number | null = null;

  reset(): void {
    this.latestStartedReadSequence = 0;
    this.nonReadyObservedAfterSequence = null;
  }

  observe(status: FileVersion["status"]): void {
    this.nonReadyObservedAfterSequence = status === "ready" ? null : nextReadSequence;
  }

  startRead(): number {
    const sequence = ++nextReadSequence;
    this.latestStartedReadSequence = sequence;
    return sequence;
  }

  needsRecoveryRead(isFetching: boolean): boolean {
    return (
      this.nonReadyObservedAfterSequence !== null &&
      this.latestStartedReadSequence <= this.nonReadyObservedAfterSequence &&
      !isFetching
    );
  }

  canRecoverFrom(readSequence: number): boolean {
    return (
      this.nonReadyObservedAfterSequence !== null &&
      readSequence > this.nonReadyObservedAfterSequence
    );
  }

  markRecovered(): void {
    this.nonReadyObservedAfterSequence = null;
  }
}
