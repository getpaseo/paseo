import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";

export interface SourceText {
  text: string;
  offsets: number[];
}
const positions = new WeakMap<Token, number[]>();

/** Preserve the parser's source positions before inline syntax is discarded. */
export function trackMarkdownSource(parser: MarkdownIt): void {
  const originals = new WeakMap<object, number[]>();
  parser.core.ruler.before("normalize", "word_source_original", (state) => {
    const offsets: number[] = [];
    for (let i = 0; i < state.src.length; i++) {
      offsets.push(i);
      if (state.src[i] === "\r" && state.src[i + 1] === "\n") i++;
    }
    originals.set(state, offsets);
  });
  const Base = parser.inline.State;
  parser.inline.State = class extends Base {
    constructor(...args: ConstructorParameters<typeof Base>) {
      super(...args);
      let pending = this.pending;
      let pendingPosition = this.pos;
      let offsets: number[] = [];
      Object.defineProperty(this, "pending", {
        get: () => {
          pendingPosition = this.pos;
          return pending;
        },
        set: (next: string) => {
          if (next.startsWith(pending)) {
            const addition = next.slice(pending.length);
            let start = pendingPosition;
            if (this.src[start] === "\\" && addition !== "\\") start++;
            if (!this.src.startsWith(addition, start) && this.src.startsWith(addition, start - 1))
              start--;
            const literal = this.src.startsWith(addition, start);
            offsets.push(
              ...Array.from({ length: addition.length }, (_, i) => start + (literal ? i : 0)),
            );
          } else offsets = offsets.slice(0, next.length);
          pending = next;
        },
      });
      const pushPending = this.pushPending.bind(this);
      this.pushPending = () => {
        const saved = offsets;
        const token = pushPending();
        positions.set(token, saved);
        offsets = [];
        return token;
      };
    }

    override push(...args: Parameters<InstanceType<typeof Base>["push"]>): Token {
      const token = super.push(...args);
      const start = this.pos;
      let content = token.content;
      Object.defineProperty(token, "content", {
        enumerable: true,
        get: () => content,
        set: (next: string) => {
          if (!positions.has(token) && next) {
            let from = start;
            if (token.type === "code_inline") {
              from += token.markup.length;
              if (this.src[from] === " " && this.src[from + 1] !== " " && next[0] !== " ") from++;
            }
            positions.set(
              token,
              Array.from({ length: next.length }, (_, i) => from + i),
            );
          }
          content = next;
        },
      });
      return token;
    }
  };

  // markdown-it merges text tokens by keeping the right-hand token. Preserve
  // the concatenated mapping through that existing pass, without changing it.
  parser.inline.ruler2.before("text_collapse", "word_source_join", (state) => {
    for (let i = 0; i + 1 < state.tokens.length; i++) {
      const left = state.tokens[i]!;
      const right = state.tokens[i + 1]!;
      if (left.type === "text" && right.type === "text") {
        positions.set(right, [
          ...(positions.get(left) ?? []).slice(0, left.content.length),
          ...(positions.get(right) ?? []).slice(0, right.content.length),
        ]);
      }
    }
    return true;
  });

  const mappedBlocks = new WeakMap<Token, SourceText>();
  parser.core.ruler.after("inline", "word_source", (state) => {
    let cursor = 0;
    const lineStarts = [0];
    for (let i = 0; i < state.src.length; i++) if (state.src[i] === "\n") lineStarts.push(i + 1);
    for (const block of state.tokens) {
      if (block.map) cursor = Math.max(cursor, lineStarts[block.map[0]]!);
      if (block.type !== "inline") {
        if (block.map && block.nesting === 0) cursor = lineStarts[block.map[1]] ?? state.src.length;
        continue;
      }
      if (block.map) cursor = Math.max(cursor, lineStarts[block.map[0]]!);
      const sourceOffsets: number[] = [];
      // Block parsing removes indentation, quote/list markers and table escapes.
      // Inline contents occur in source order, including repeated table cells.
      for (const char of block.content.split("")) {
        const next = state.src.indexOf(char, cursor);
        if (next < 0) throw new Error("Markdown inline content lost its source position");
        sourceOffsets.push(next);
        cursor = next + 1;
      }
      const rendered: SourceText = { text: "", offsets: [] };
      for (const token of block.children ?? []) {
        const local = positions.get(token) ?? [];
        const offsets = local
          .slice(0, token.content.length)
          .map((offset) => originals.get(state)![sourceOffsets[offset]!]!);
        token.meta = { ...token.meta, wordSource: offsets };
        if (
          token.type === "text" ||
          token.type === "streaming_link_text" ||
          token.type === "code_inline"
        ) {
          rendered.text += token.content;
          rendered.offsets.push(...offsets);
        }
      }
      mappedBlocks.set(block, rendered);
    }
  });
  // Linkify replaces text tokens. Transfer the same character positions to its
  // split output; the link wrapper itself never owns a fade.
  parser.core.ruler.after("linkify", "word_source_links", (state) => {
    for (const block of state.tokens) {
      const mapped = mappedBlocks.get(block);
      if (!mapped) continue;
      let cursor = 0;
      for (const token of block.children ?? []) {
        if (!["text", "streaming_link_text", "code_inline"].includes(token.type)) continue;
        const mappedToken = mapLinkifiedText(mapped, token.content, cursor);
        const offsets = mappedToken.offsets;
        cursor = mappedToken.cursor;
        token.meta = { ...token.meta, wordSource: offsets };
      }
    }
  });
}

function mapLinkifiedText(mapped: SourceText, content: string, cursor: number) {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    const encoded = mapped.text.slice(cursor).match(/^(?:%[0-9a-f]{2})+/i)?.[0];
    if (encoded && content[i] !== "%") {
      let decoded: string;
      try {
        decoded = decodeURIComponent(encoded);
      } catch {
        decoded = encoded;
      }
      if (content.startsWith(decoded, i)) {
        offsets.push(...Array.from({ length: decoded.length }, () => mapped.offsets[cursor]!));
        cursor += encoded.length;
        i += decoded.length - 1;
        continue;
      }
    }
    offsets.push(mapped.offsets[cursor++]!);
  }
  return { offsets, cursor };
}
