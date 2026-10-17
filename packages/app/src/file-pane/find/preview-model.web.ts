/**
 * Find for rendered file previews. Source views get Find from FileFindModel,
 * which drives CodeMirror's search state field; a rendered preview is plain
 * text DOM with no such state, so this model wraps matches in <mark> elements
 * and re-marks when the preview's DOM changes under it (live file updates,
 * mode switches that keep the same host).
 */

const HIT = "paseo-file-find-hit";
const CURRENT_HIT = "paseo-file-find-hit-current";
const WIDGET_ATTR = "data-paseo-file-find";
const STYLE_ID = "paseo-file-find-style";
const SKIPPED = `script,style,iframe,textarea,select,noscript,input,mark,[${WIDGET_ATTR}]`;
const MATCH_LIMIT = 5000;
const REHIGHLIGHT_DELAY_MS = 150;
// A match may span inline elements (<strong>, <code>, links) but should never
// cross a block boundary, so text nodes are grouped by their nearest block
// ancestor before matching. Mirrors the tags the markdown renderer emits.
const BLOCK_RE =
  /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|H[1-6]|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TBODY|TD|TFOOT|TH|THEAD|TR|UL)$/;

export interface PreviewFindSnapshot {
  open: boolean;
  query: string;
  /** 1-based position of the active hit; 0 when no hit is selected. */
  current: number;
  total: number;
  /** True once the hit cap cut the list; total reads "N+" in the widget. */
  limited: boolean;
}

const CLOSED: PreviewFindSnapshot = {
  open: false,
  query: "",
  current: 0,
  total: 0,
  limited: false,
};

/** One text node's slice of a block's joined text. */
interface TextBlock {
  nodes: Text[];
  starts: number[];
  joined: string;
}

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // Theme-neutral: a translucent amber reads on light and dark surfaces, and the
  // current hit goes opaque so it stays visible over syntax-colored text.
  style.textContent =
    `mark.${HIT}{background:rgba(255,193,7,.45);color:inherit;border-radius:2px}` +
    `mark.${CURRENT_HIT}{background:rgba(255,152,0,.9);color:#000}`;
  document.head.appendChild(style);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PreviewFindModel {
  /** Flat mark list for teardown. */
  private marks: HTMLElement[] = [];
  /** Marks per logical match; a match spanning inline nodes gets one mark each. */
  private matchMarks: HTMLElement[][] = [];
  private observer: MutationObserver | null = null;
  private rehighlightTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private snapshot: PreviewFindSnapshot = CLOSED;

  constructor(
    private host: HTMLElement,
    private options: { matchLimit?: number; rehighlightDelayMs?: number } = {},
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.snapshot;

  private publish() {
    for (const listener of this.listeners) listener();
  }

  readonly open = () => {
    ensureStyle();
    if (!this.snapshot.open) {
      this.snapshot = { ...this.snapshot, open: true };
      this.publish();
      this.observe();
      this.rehighlight();
    }
  };

  readonly close = () => {
    if (!this.snapshot.open) return;
    this.observer?.disconnect();
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer);
    this.rehighlightTimer = null;
    this.clearMarks();
    this.snapshot = { ...this.snapshot, open: false, current: 0, total: 0, limited: false };
    this.publish();
  };

  readonly setSearch = (query: string) => {
    if (query === this.snapshot.query) return;
    this.snapshot = { ...this.snapshot, query };
    this.rehighlight();
  };

  readonly next = () => this.step(1);
  readonly previous = () => this.step(-1);

  readonly dispose = () => {
    this.observer?.disconnect();
    this.observer = null;
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer);
    this.rehighlightTimer = null;
    this.clearMarks();
    this.listeners.clear();
  };

  private step(direction: 1 | -1) {
    const total = this.matchMarks.length;
    if (!total) return;
    let index: number;
    if (this.snapshot.current === 0) {
      index = direction > 0 ? 0 : total - 1;
    } else {
      index = (this.snapshot.current - 1 + direction + total) % total;
    }
    this.select(index);
  }

  private select(index: number) {
    for (const mark of this.matchMarks[this.snapshot.current - 1] ?? []) {
      mark.classList.remove(CURRENT_HIT);
    }
    const group = this.matchMarks[index];
    if (!group?.length) return;
    for (const mark of group) mark.classList.add(CURRENT_HIT);
    group[0].scrollIntoView?.({ block: "nearest" });
    this.snapshot = { ...this.snapshot, current: index + 1 };
    this.publish();
  }

  private observe() {
    if (!this.observer) {
      this.observer = new MutationObserver((mutations) => this.onMutations(mutations));
    }
    this.observer.observe(this.host, { childList: true, characterData: true, subtree: true });
  }

  private onMutations(mutations: MutationRecord[]) {
    if (!this.snapshot.open || !this.snapshot.query) return;
    // Widget status text and mark churn live in our own subtree; real edits are
    // the rest. Own DOM writes are already invisible — the observer is
    // disconnected while they run — so only the widget needs filtering here.
    if (mutations.every((m) => this.inWidget(m.target))) return;
    if (this.rehighlightTimer) clearTimeout(this.rehighlightTimer);
    const delay = this.options.rehighlightDelayMs ?? REHIGHLIGHT_DELAY_MS;
    this.rehighlightTimer = setTimeout(() => {
      this.rehighlightTimer = null;
      if (this.snapshot.open) this.rehighlight();
    }, delay);
  }

  private inWidget(node: Node): boolean {
    // characterData records carry a Text target, so walk to the element first.
    const element = node instanceof Element ? node : node.parentElement;
    if (!element) return true;
    return element.closest(`[${WIDGET_ATTR}]`) !== null;
  }

  private rehighlight() {
    this.observer?.disconnect();
    try {
      this.clearMarks();
      const query = this.snapshot.query;
      if (!query) {
        this.snapshot = { ...this.snapshot, current: 0, total: 0, limited: false };
        this.publish();
        return;
      }
      let limited = false;
      const limit = this.options.matchLimit ?? MATCH_LIMIT;
      // Match on the original text with an `i` flag so reported offsets stay in
      // the original string — `toLowerCase` can change length (e.g. "İ").
      const needle = new RegExp(escapeRegExp(query), "giu");
      for (const block of this.textBlocks()) {
        if (this.matchMarks.length >= limit) {
          limited = true;
          break;
        }
        limited = this.markBlock(block, needle, limit) || limited;
      }
      this.snapshot = {
        ...this.snapshot,
        current: this.matchMarks.length ? 1 : 0,
        total: this.matchMarks.length,
        limited,
      };
      this.publish();
      const first = this.matchMarks[0];
      if (first?.length) {
        for (const mark of first) mark.classList.add(CURRENT_HIT);
        first[0].scrollIntoView?.({ block: "nearest" });
      }
    } finally {
      if (this.snapshot.open) this.observe();
    }
  }

  /**
   * Wraps every regex hit in the block's joined text. A hit can span several
   * inline nodes (`**bold** tail`), so each overlapped node slice gets its own
   * mark and all slices join one logical match group. Returns true when the
   * match limit stopped the scan partway.
   */
  private markBlock(block: TextBlock, needle: RegExp, limit: number): boolean {
    const hits: { start: number; end: number; match: number }[] = [];
    let limited = false;
    needle.lastIndex = 0;
    let found: RegExpExecArray | null;
    while ((found = needle.exec(block.joined))) {
      if (!found[0].length) {
        needle.lastIndex += 1;
        continue;
      }
      const index = this.matchMarks.length;
      if (index >= limit) {
        limited = true;
        break;
      }
      this.matchMarks.push([]);
      hits.push({ start: found.index, end: found.index + found[0].length, match: index });
    }
    // hits are sorted by start and nodes by document order, so a moving
    // cursor skips dead hits once instead of scanning the whole list per node.
    let first = 0;
    for (let i = 0; i < block.nodes.length; i++) {
      const node = block.nodes[i];
      const nodeStart = block.starts[i];
      const nodeEnd = nodeStart + node.data.length;
      while (first < hits.length && hits[first].end <= nodeStart) first++;
      const ranges: { start: number; end: number; match: number }[] = [];
      for (let j = first; j < hits.length && hits[j].start < nodeEnd; j++) {
        const hit = hits[j];
        ranges.push({
          start: Math.max(hit.start, nodeStart) - nodeStart,
          end: Math.min(hit.end, nodeEnd) - nodeStart,
          match: hit.match,
        });
      }
      if (!ranges.length) continue;
      const data = node.data;
      const fragment = document.createDocumentFragment();
      let last = 0;
      for (const range of ranges) {
        fragment.appendChild(document.createTextNode(data.slice(last, range.start)));
        const mark = document.createElement("mark");
        mark.className = HIT;
        mark.textContent = data.slice(range.start, range.end);
        fragment.appendChild(mark);
        this.matchMarks[range.match].push(mark);
        this.marks.push(mark);
        last = range.end;
      }
      fragment.appendChild(document.createTextNode(data.slice(last)));
      node.parentNode?.replaceChild(fragment, node);
    }
    return limited;
  }

  private clearMarks() {
    const parents = new Set<Node>();
    for (const mark of this.marks) {
      const parent = mark.parentNode;
      if (!parent) continue;
      parents.add(parent);
      parent.replaceChild(document.createTextNode(mark.textContent ?? ""), mark);
    }
    for (const parent of parents) parent.normalize();
    this.marks = [];
    this.matchMarks = [];
  }

  /** Nearest block-level ancestor inside the host; the parent for inline text. */
  private blockOf(node: Text): Element {
    let element = node.parentElement;
    const fallback = element ?? this.host;
    while (element && element !== this.host) {
      if (BLOCK_RE.test(element.tagName)) return element;
      element = element.parentElement;
    }
    return fallback;
  }

  /** Text nodes grouped per block so a match may cross inline element edges. */
  private textBlocks(): TextBlock[] {
    const walker = document.createTreeWalker(this.host, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const parent = node.parentElement;
        if (!parent || !(node as Text).data.trim()) return NodeFilter.FILTER_REJECT;
        if (parent.closest(SKIPPED)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const grouped = new Map<Element, Text[]>();
    let current: Node | null;
    while ((current = walker.nextNode())) {
      const node = current as Text;
      const block = this.blockOf(node);
      const list = grouped.get(block);
      if (list) list.push(node);
      else grouped.set(block, [node]);
    }
    const blocks: TextBlock[] = [];
    for (const nodes of grouped.values()) {
      const starts: number[] = [];
      let offset = 0;
      let joined = "";
      for (const node of nodes) {
        starts.push(offset);
        joined += node.data;
        offset += node.data.length;
      }
      blocks.push({ nodes, starts, joined });
    }
    return blocks;
  }
}
