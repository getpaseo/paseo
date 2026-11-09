import type { z } from "zod";
import { MspConnection, type Notification } from "./connection.js";
import { pageSchema } from "./wire.js";

// Two minutes accommodates slow model/tool work; polling repairs a lost live view without cancelling it.
const SILENCE_MS = 2 * 60 * 1000;
export class Recovery {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private closed = false;
  private cursor: string;
  constructor(
    private readonly host: MspConnection,
    private readonly sessionId: string,
    cursor: string,
    private readonly apply: (event: Notification) => Promise<void>,
    private readonly onSilent: () => void,
  ) {
    this.cursor = cursor;
  }

  activity(cursor: string | undefined, active: boolean): void {
    if (cursor !== undefined) this.cursor = cursor;
    this.active = active;
    clearTimeout(this.timer);
    if (active && !this.closed) this.timer = setTimeout(this.onSilent, SILENCE_MS);
  }
  async backfill(after = this.cursor): Promise<void> {
    let cursor: string | null = after;
    do {
      const page: z.infer<typeof pageSchema> = await this.host.request(
        "view/page",
        { sessionId: this.sessionId, cursor, direction: "forward", limit: 1000 },
        pageSchema,
      );
      for (const event of page.events) await this.apply(event);
      cursor = page.nextCursor;
    } while (cursor !== null && !this.closed);
    this.activity(undefined, this.active);
  }
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
  }
}
