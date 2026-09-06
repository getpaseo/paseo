import type { SourceChange } from "./contract";

type LineSeparator = "\n" | "\r\n" | "\r";

export class SourceDocumentMirror {
  private text: string;
  private lineSeparator: LineSeparator;

  constructor(document: string) {
    this.lineSeparator = detectLineSeparator(document);
    this.text = normalizeLineSeparators(document);
  }

  getRuntimeDocument(): string {
    return this.text;
  }

  getDocument(): string {
    return serializeDocument(this.text, this.lineSeparator);
  }

  replace(document: string): boolean {
    if (document === this.getDocument()) return false;
    this.lineSeparator = detectLineSeparator(document);
    this.text = normalizeLineSeparators(document);
    return true;
  }

  apply(changes: readonly SourceChange[]): string {
    validateChanges(changes, this.text.length);
    for (let index = changes.length - 1; index >= 0; index -= 1) {
      const change = changes[index];
      this.text = `${this.text.slice(0, change.from)}${normalizeLineSeparators(change.insert)}${this.text.slice(change.to)}`;
    }
    return this.getDocument();
  }
}

function validateChanges(changes: readonly SourceChange[], documentLength: number): void {
  let previousEnd = 0;
  for (const change of changes) {
    if (
      !Number.isInteger(change.from) ||
      !Number.isInteger(change.to) ||
      change.from < previousEnd ||
      change.from > change.to ||
      change.to > documentLength
    ) {
      throw new Error("Invalid source editor change range");
    }
    previousEnd = change.to;
  }
}

function normalizeLineSeparators(document: string): string {
  return document.replace(/\r\n?|\n/g, "\n");
}

function serializeDocument(document: string, lineSeparator: LineSeparator): string {
  return lineSeparator === "\n" ? document : document.replace(/\n/g, lineSeparator);
}

function detectLineSeparator(document: string): LineSeparator {
  const match = /\r\n|\r|\n/.exec(document);
  return (match?.[0] as LineSeparator | undefined) ?? "\n";
}
