/** Owns the received text and the word boundary the reader has reached. */
export class WordStream {
  private target: string;
  private visibleEnd: number;
  private scanFrom: number;
  private readyEnds: number[] = [];
  private nextWord = 0;
  private nextInMs = 0;
  private interval = 60;

  constructor(text: string) {
    this.target = text;
    this.visibleEnd = text.length;
    this.scanFrom = text.length;
  }

  get text(): string {
    return this.target.slice(0, this.visibleEnd);
  }

  get pending(): boolean {
    return this.nextWord < this.readyEnds.length;
  }

  /**
   * How long the most recently released word owns the reveal front before the
   * next word follows it. Its characters are spread across this interval so the
   * front never restarts at a word boundary.
   */
  get spanMs(): number {
    return this.interval;
  }

  receive(text: string, streaming: boolean): void {
    if (!text.startsWith(this.target)) {
      this.target = text;
      this.visibleEnd = text.length;
      this.scanFrom = text.length;
      this.readyEnds = [];
      this.nextWord = 0;
      this.nextInMs = 0;
      return;
    }
    this.target = text;
    if (!this.pending) {
      this.readyEnds = [];
      this.nextWord = 0;
      this.nextInMs = 0;
    }
    // Only rescan the unfinished suffix. Network boundaries never finish a word.
    const suffix = text.slice(this.scanFrom);
    const words = /\S+\s+|\s+/gu;
    let end = this.scanFrom;
    for (const word of suffix.matchAll(words)) {
      end = this.scanFrom + word.index + word[0].length;
      this.readyEnds.push(end);
    }
    this.scanFrom = end;
    if (!streaming && end < text.length) {
      this.readyEnds.push(text.length);
      this.scanFrom = text.length;
    }
  }

  advance(elapsedMs: number): string {
    if (!this.pending) return this.text;
    this.nextInMs -= Math.min(250, Math.max(0, elapsedMs));
    if (this.pending && this.nextInMs <= 0) {
      this.visibleEnd = this.readyEnds[this.nextWord++]!;
      const backlog = this.readyEnds.length - this.nextWord;
      // A late frame is not credit to reveal several words at once.
      this.interval = Math.max(33, Math.min(60, 150 / Math.max(1, backlog)));
      this.nextInMs = this.interval;
    }
    if (!this.pending) this.nextInMs = 0;
    return this.text;
  }
}
