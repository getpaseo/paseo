import type { InteractiveState } from "@getpaseo/protocol/interactive-response-schema";

export class InteractiveStateWriter {
  private next: InteractiveState | null = null;
  private saving = false;
  private pending: Promise<void> = Promise.resolve();
  private error: Error | null = null;
  constructor(
    public revision: number,
    private readonly save: (revision: number, state: InteractiveState) => Promise<number>,
    private readonly failed: (error: Error) => void,
  ) {}
  write(state: InteractiveState): void {
    if (this.error) return;
    this.next = state;
    if (this.saving) return;
    this.saving = true;
    this.pending = this.drain()
      .catch((error) => {
        this.error = error instanceof Error ? error : new Error(String(error));
        this.failed(this.error);
        return undefined;
      })
      .finally(() => {
        this.saving = false;
        if (this.next && !this.error) this.write(this.next);
      });
  }
  async flush(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.pending;
      await pending;
    } while (pending !== this.pending);
    if (this.error) throw this.error;
  }
  private async drain(): Promise<void> {
    while (this.next) {
      const state = this.next;
      this.next = null;
      this.revision = await this.save(this.revision, state);
    }
  }
}
