import { asksForFilePanel, type FilePanelCandidate, type FilePanelResolution } from "../resolve";

/** What the file tab currently resolves; `resolution` is null until the file has been read. */
export interface FilePanelChoiceSource<Candidate extends FilePanelCandidate> {
  targetKey: string | null;
  resolution: FilePanelResolution<Candidate> | null;
  /** The tab is on screen, so a picker shown now is seen over the panel it chooses for. */
  presentable: boolean;
  /** Identifies the tab's latest request to show a line, or null when it targets no line. */
  lineNavigation: number | null;
}

export interface FilePanelPickerState<Candidate> {
  selectorKey: string;
  candidates: readonly Candidate[];
  selectedPanelId: string;
  remember: boolean;
}

export interface FilePanelOpenWithState<Candidate> {
  selectorKey: string;
  candidates: readonly Candidate[];
  activePanelId: string;
  /** The active panel is the one remembered for `selectorKey`. */
  remembered: boolean;
}

export interface FilePanelChoiceSnapshot<Candidate> {
  targetKey: string | null;
  /** The panel picked for this tab open. Resolution prefers it over the association. */
  chosenPanelId: string | null;
  picker: FilePanelPickerState<Candidate> | null;
  /** Present only when the file has more than one candidate; drives "Open with…". */
  openWith: FilePanelOpenWithState<Candidate> | null;
}

export interface FilePanelChoiceDeps {
  /** Writes (or clears, with null) the device-wide association for a selector key. */
  remember(selectorKey: string, panelId: string | null): void;
}

/** The tab choice that applies to `targetKey`; a choice never outlives its open. */
export function chosenPanelFor(
  snapshot: FilePanelChoiceSnapshot<unknown>,
  targetKey: string | null,
): string | null {
  return snapshot.targetKey === targetKey ? snapshot.chosenPanelId : null;
}

const EMPTY: FilePanelChoiceSnapshot<never> = {
  targetKey: null,
  chosenPanelId: null,
  picker: null,
  openWith: null,
};

/**
 * Which file panel one file tab shows, and whether to ask.
 *
 * A tab open is one target in one tab: the picker is offered at most once per open, the first
 * time the tab is on screen with a plugin panel among several candidates and nothing remembered.
 * Built-in panels alone never ask. A line target opens the file's built-in panel, which shows
 * lines, the way "Open with…" does.
 * Retargeting the tab starts a new open. Choices made here apply to this tab; only "Don't ask me
 * again" and "Always use" write the association every later open reads.
 */
export class FilePanelChoiceModel<Candidate extends FilePanelCandidate> {
  private readonly listeners = new Set<() => void>();
  private snapshot: FilePanelChoiceSnapshot<Candidate> = EMPTY;
  private asked = false;
  private openedLineNavigation: number | null = null;
  /** A line target arrived before the file resolved; it opens the built-in once it does. */
  private lineTargetPending = false;

  constructor(private readonly deps: FilePanelChoiceDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): FilePanelChoiceSnapshot<Candidate> => this.snapshot;

  observe(source: FilePanelChoiceSource<Candidate>): void {
    let current = this.snapshot;
    if (source.targetKey !== current.targetKey) {
      this.asked = false;
      this.openedLineNavigation = null;
      this.lineTargetPending = false;
      current = { ...EMPTY, targetKey: source.targetKey };
    }
    if (source.lineNavigation !== null && source.lineNavigation !== this.openedLineNavigation) {
      this.openedLineNavigation = source.lineNavigation;
      this.lineTargetPending = true;
    }
    if (this.lineTargetPending && source.resolution) {
      this.lineTargetPending = false;
      const builtin = source.resolution.candidates.find((candidate) => candidate.builtin);
      if (builtin) current = { ...current, chosenPanelId: builtin.id, picker: null };
    }
    const openWith = stableOpenWith(current.openWith, openWithState(source.resolution));
    let picker = openWith ? current.picker : null;
    // Decided once per open, the first time there is something to ask about on screen. An
    // association forgotten while the tab stays open is asked about on the next open.
    if (!this.asked && source.presentable && openWith && asksForFilePanel(openWith.candidates)) {
      this.asked = true;
      const remembered = Boolean(source.resolution?.associatedPanelId);
      if (!remembered && current.chosenPanelId === null) {
        picker = {
          selectorKey: openWith.selectorKey,
          candidates: openWith.candidates,
          selectedPanelId: openWith.activePanelId,
          remember: false,
        };
      }
    }
    this.publish({ ...current, openWith, picker });
  }

  selectInPicker(panelId: string): void {
    const picker = this.snapshot.picker;
    if (!picker) return;
    this.publish({ ...this.snapshot, picker: { ...picker, selectedPanelId: panelId } });
  }

  setRemember(remember: boolean): void {
    const picker = this.snapshot.picker;
    if (!picker) return;
    this.publish({ ...this.snapshot, picker: { ...picker, remember } });
  }

  confirmPicker(): void {
    const picker = this.snapshot.picker;
    if (!picker) return;
    if (picker.remember) this.deps.remember(picker.selectorKey, picker.selectedPanelId);
    this.publish({ ...this.snapshot, chosenPanelId: picker.selectedPanelId, picker: null });
  }

  /** Keeps whatever the tab shows now; the next open asks again. */
  dismissPicker(): void {
    if (!this.snapshot.picker) return;
    this.publish({ ...this.snapshot, picker: null });
  }

  openWith(panelId: string): void {
    this.publish({ ...this.snapshot, chosenPanelId: panelId, picker: null });
  }

  /** Remembers the active panel, or forgets it when it already is the remembered one. */
  toggleAlwaysUse(): void {
    const openWith = this.snapshot.openWith;
    if (!openWith) return;
    if (!openWith.remembered) {
      this.deps.remember(openWith.selectorKey, openWith.activePanelId);
      return;
    }
    // Forgetting must not move the tab off the panel it is showing.
    this.publish({ ...this.snapshot, chosenPanelId: openWith.activePanelId });
    this.deps.remember(openWith.selectorKey, null);
  }

  private publish(next: FilePanelChoiceSnapshot<Candidate>): void {
    const current = this.snapshot;
    if (
      current.targetKey === next.targetKey &&
      current.chosenPanelId === next.chosenPanelId &&
      current.picker === next.picker &&
      current.openWith === next.openWith
    ) {
      return;
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function openWithState<Candidate extends FilePanelCandidate>(
  resolution: FilePanelResolution<Candidate> | null,
): FilePanelOpenWithState<Candidate> | null {
  if (!resolution?.panel || resolution.candidates.length < 2) return null;
  return {
    selectorKey: resolution.selectorKey,
    candidates: resolution.candidates,
    activePanelId: resolution.panel.id,
    remembered: resolution.associatedPanelId === resolution.panel.id,
  };
}

/** Keeps the published object when nothing in it changed, so subscribers do not re-render. */
function stableOpenWith<Candidate>(
  current: FilePanelOpenWithState<Candidate> | null,
  next: FilePanelOpenWithState<Candidate> | null,
): FilePanelOpenWithState<Candidate> | null {
  if (!current || !next) return next;
  const same =
    current.selectorKey === next.selectorKey &&
    current.activePanelId === next.activePanelId &&
    current.remembered === next.remembered &&
    current.candidates.length === next.candidates.length &&
    current.candidates.every((candidate, index) => candidate === next.candidates[index]);
  return same ? current : next;
}
