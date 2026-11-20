/** Counts bytes until the socket's send callback, shared by all links owned by a daemon. */
export class HostTransportBudget {
  private used = 0;
  constructor(readonly limit = 256 * 1024 * 1024) {}
  get bufferedBytes(): number {
    return this.used;
  }
  assertCapacity(bytes: number): void {
    if (bytes > this.limit - this.used)
      throw Object.assign(new Error("Connected host buffer limit reached"), {
        code: "resource_limit",
      });
  }
  reserve(bytes: number): () => void {
    this.assertCapacity(bytes);
    this.used += bytes;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.used -= bytes;
      }
    };
  }
}
