// Turns a token stream into speakable chunks for TTS. The first chunk of a reply flushes early
// (clause end, dash, or FIRST_CHUNK_WORDS words) because time to first audio beats prosody;
// later chunks are sentence-sized.

const ABBREVIATIONS = [
  "mr.",
  "mrs.",
  "ms.",
  "dr.",
  "st.",
  "vs.",
  "e.g.",
  "i.e.",
  "etc.",
  "approx.",
  "no.",
];
// `*` and `_` inside a word (snake_case, 2*3) are kept; emphasis marks at word edges go.
const MARKDOWN_MARKS = /(?<![A-Za-z0-9])[*_]+|[*_]+(?![A-Za-z0-9])|[`#>]+/g;
const SENTENCE_END = ".!?";
const CLAUSE_END = ",;:";
const DASHES = "—–";
const WHITESPACE = /\s/;

export const FIRST_CHUNK_WORDS = 6;

export function cleanMarkdown(text: string): string {
  return text.replace(MARKDOWN_MARKS, "");
}

function endsWithAbbreviation(text: string): boolean {
  const lower = text.toLowerCase();
  return ABBREVIATIONS.some((a) => lower.endsWith(a));
}

// First-chunk breaks: a clause end, a dash, or a spaced hyphen after some text.
function isEarlyBreak(buf: string, i: number, nextIsSpace: boolean): boolean {
  if (buf.slice(0, i).trim() === "") return false;
  const ch = buf[i];
  if (CLAUSE_END.includes(ch) && nextIsSpace) return true;
  if (DASHES.includes(ch)) return true;
  return ch === "-" && nextIsSpace && i > 0 && WHITESPACE.test(buf[i - 1]);
}

export class SentenceChunker {
  private buffer = "";
  private emitted = 0;

  constructor(
    private readonly firstChunkWords = FIRST_CHUNK_WORDS,
    private readonly maxChars = 220,
  ) {}

  reset(): void {
    this.buffer = "";
    this.emitted = 0;
  }

  feed(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const index = this.findBoundary();
      if (index === null) break;
      const chunk = cleanMarkdown(this.buffer.slice(0, index)).trim();
      this.buffer = this.buffer.slice(index);
      if (chunk) {
        out.push(chunk);
        this.emitted += 1;
      }
    }
    return out;
  }

  flush(): string[] {
    const chunk = cleanMarkdown(this.buffer).trim();
    this.buffer = "";
    if (!chunk) return [];
    this.emitted += 1;
    return [chunk];
  }

  // A terminator only counts when followed by whitespace, so "3.5" and "U.S.A" are not split.
  private findBoundary(): number | null {
    const buf = this.buffer;
    const first = this.emitted === 0;
    let words = 0;
    let inWord = false;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i];
      const nextIsSpace = i + 1 < buf.length && WHITESPACE.test(buf[i + 1]);
      if (SENTENCE_END.includes(ch) && nextIsSpace) {
        if (ch === "." && endsWithAbbreviation(buf.slice(0, i + 1))) continue;
        return i + 1;
      }
      if (!first) continue;
      if (isEarlyBreak(buf, i, nextIsSpace)) return i + 1;
      if (!WHITESPACE.test(ch)) {
        inWord = true;
        continue;
      }
      if (inWord) words += 1;
      inWord = false;
      if (words >= this.firstChunkWords) return i + 1;
    }
    if (buf.length >= this.maxChars) {
      const cut = buf.lastIndexOf(" ", this.maxChars - 1);
      return cut > 0 ? cut : this.maxChars;
    }
    return null;
  }
}
