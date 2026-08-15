import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { SelectedTextComposerAttachment } from "@/attachments/types";
import { getOverlayRoot, WEB_SURFACE_PLANE } from "@/lib/overlay-root";
import { AssistantSelectionCopySurface } from "./surface.web";
import type { AssistantSelectionAnnotation, SelectedTextAnnotationEdit } from "./types";

interface MountedSurface {
  root: Root;
  container: HTMLDivElement;
  rerender: (options: SurfaceOptions) => void;
}

interface SurfaceOptions {
  composerOcclusionTop?: number;
  contentViewportBottom?: number;
  contentViewportTop?: number;
  visible?: boolean;
  onEditComment?: (edit: SelectedTextAnnotationEdit) => void;
  onOpenAnnotation?: (annotation: SelectedTextComposerAttachment) => void;
  selectedTextAnnotations?: readonly SelectedTextComposerAttachment[];
  selectedTextAnnotationToEdit?: {
    id: string;
    text: string;
    sourceMessageId?: string;
    occurrence?: number;
    comment?: string;
  };
}

const mountedSurfaces: MountedSurface[] = [];

function mountSurface(
  onCommentSelection: (annotation: AssistantSelectionAnnotation) => void,
  onDismissEditComment?: () => void,
  options?: SurfaceOptions,
): MountedSurface {
  const container = document.createElement("div");
  if (options?.contentViewportTop == null && options?.contentViewportBottom == null) {
    document.body.appendChild(container);
  } else {
    const contentViewport = document.createElement("div");
    contentViewport.dataset.testid = "agent-chat-scroll";
    const contentTop = options.contentViewportTop ?? 0;
    Object.assign(contentViewport.style, {
      position: "fixed",
      top: `${contentTop}px`,
      right: "0",
      left: "0",
      overflow: "visible",
    });
    if (options.contentViewportBottom == null) {
      contentViewport.style.bottom = "0";
    } else {
      contentViewport.style.height = `${options.contentViewportBottom - contentTop}px`;
    }
    contentViewport.appendChild(container);
    document.body.appendChild(contentViewport);
  }
  const root = createRoot(container);
  if (options?.composerOcclusionTop != null) {
    const composerOcclusion = document.createElement("div");
    composerOcclusion.dataset.testid = "composer-input-area";
    Object.assign(composerOcclusion.style, {
      position: "fixed",
      top: `${options.composerOcclusionTop}px`,
      right: "0",
      bottom: "0",
      left: "0",
    });
    document.body.appendChild(composerOcclusion);
  }
  const renderSurface = (currentOptions?: SurfaceOptions) => {
    root.render(
      <AssistantSelectionCopySurface
        visible={currentOptions?.visible}
        onCommentSelection={onCommentSelection}
        onDismissEditComment={onDismissEditComment}
        onEditComment={currentOptions?.onEditComment}
        onOpenAnnotation={currentOptions?.onOpenAnnotation}
        selectedTextAnnotations={currentOptions?.selectedTextAnnotations}
        selectedTextAnnotationToEdit={currentOptions?.selectedTextAnnotationToEdit}
        addToCommentLabel="Add to comment"
      >
        <div data-testid="assistant-message-item:assistant-1">
          <div data-testid="assistant-message">
            <div data-paseo-markdown-tag="p">
              Keep <strong data-paseo-markdown-tag="strong">this invariant</strong> intact.
            </div>
            <div data-paseo-markdown-tag="p">
              Repeat{" "}
              <strong data-testid="second-invariant" data-paseo-markdown-tag="strong">
                this invariant
              </strong>{" "}
              here.
            </div>
            <div data-testid="overlapping-repeat" data-paseo-markdown-tag="p">
              哈哈哈
            </div>
            <div data-paseo-markdown-tag="p">Review checklist:</div>
            <div data-paseo-markdown-tag="ul">
              <div data-paseo-markdown-tag="li">
                <span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">
                  •
                </span>
                <div>
                  <strong data-paseo-markdown-tag="strong">first item</strong>
                </div>
              </div>
              <div data-paseo-markdown-tag="li">
                <span data-paseo-markdown-ignore="true" data-paseo-markdown-list-marker="true">
                  •
                </span>
                <div>second item</div>
              </div>
            </div>
          </div>
        </div>
      </AssistantSelectionCopySurface>,
    );
  };
  act(() => {
    renderSurface(options);
  });
  const mounted = {
    root,
    container,
    rerender: (nextOptions: SurfaceOptions) => act(() => renderSurface(nextOptions)),
  };
  mountedSurfaces.push(mounted);
  return mounted;
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!valueSetter) {
    throw new Error("HTML input value setter is unavailable");
  }
  valueSetter.call(input, value);
  act(() => input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value })));
}

function selectContents(element: Element): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectTextOffsets(element: Element, start: number, end: number): void {
  const textNode = element.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    throw new Error("Expected a direct text node");
  }
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Expected browser selection");
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function getPointerHitTarget(element: HTMLElement): Element | null {
  const rect = element.getBoundingClientRect();
  return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  for (const mounted of mountedSurfaces.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  document.body.replaceChildren();
});

describe("assistant selection comment action", () => {
  it("offers a comment action and returns the Markdown selection", () => {
    const selections: AssistantSelectionAnnotation[] = [];
    const mounted = mountSurface((annotation) => selections.push(annotation));
    const selected = mounted.container.querySelector("strong");
    if (!selected) {
      throw new Error("Expected selectable assistant text");
    }

    selectContents(selected);
    act(() => {
      selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });

    const action = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-button"]',
    );
    expect(action).not.toBeNull();

    expect(action?.textContent).toContain("Add to comment");
    expect(document.querySelector('[data-testid="assistant-selection-comment-editor"]')).toBeNull();

    act(() => action?.click());

    const editor = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-editor"]',
    );
    expect(editor).not.toBeNull();
    if (!editor) {
      throw new Error("Expected comment editor");
    }
    expect(editor.dataset.editorMode).toBe("create");
    const compactPanel = editor.firstElementChild;
    if (!(compactPanel instanceof HTMLElement)) {
      throw new Error("Expected compact editor panel");
    }
    expect(Number.parseFloat(window.getComputedStyle(compactPanel).borderRadius)).toBe(24);
    const selectionRect = selected.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    const verticalGap = Math.min(
      Math.abs(editorRect.top - selectionRect.bottom),
      Math.abs(selectionRect.top - editorRect.bottom),
    );
    expect(editorRect.top).toBeGreaterThanOrEqual(0);
    expect(editorRect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(verticalGap).toBeLessThanOrEqual(16);
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="assistant-selection-comment-input"]',
    );
    if (!input) {
      throw new Error("Expected comment input");
    }
    expect(input.tagName).toBe("TEXTAREA");
    setInputValue(input, "Please explain this");

    const save = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-save"]',
    );
    expect(save?.textContent).not.toContain("Save");
    if (!save) {
      throw new Error("Expected compact save button");
    }
    const compactPanelRect = compactPanel.getBoundingClientRect();
    const saveRect = save.getBoundingClientRect();
    expect(Math.abs(compactPanelRect.right - saveRect.right)).toBeLessThanOrEqual(8);
    expect(Math.abs(compactPanelRect.bottom - saveRect.bottom)).toBeLessThanOrEqual(8);
    act(() => save?.click());

    expect(selections).toEqual([
      {
        text: "**this invariant**",
        sourceMessageId: "assistant-1",
        occurrence: 0,
        comment: "Please explain this",
      },
    ]);
    expect(window.getSelection()?.toString()).toBe("");
    expect(document.querySelector('[data-testid="assistant-selection-comment-button"]')).toBeNull();
  });

  it("does not offer the action for text outside an assistant response", () => {
    const mounted = mountSurface(() => undefined);
    const outside = document.createElement("span");
    outside.textContent = "outside";
    document.body.appendChild(outside);
    selectContents(outside);

    act(() => {
      mounted.container.firstElementChild?.dispatchEvent(
        new PointerEvent("pointerup", { bubbles: true }),
      );
    });

    expect(document.querySelector('[data-testid="assistant-selection-comment-button"]')).toBeNull();
  });

  it("preserves which repeated text occurrence the user selected", async () => {
    const selections: AssistantSelectionAnnotation[] = [];
    const mounted = mountSurface((annotation) => selections.push(annotation));
    const selected = mounted.container.querySelector('[data-testid="second-invariant"]');
    if (!selected) throw new Error("Expected the second repeated selection");

    selectContents(selected);
    act(() => selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-button"]')
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-save"]')
        ?.click(),
    );

    expect(selections[0]?.occurrence).toBe(1);
    mounted.rerender({
      selectedTextAnnotationToEdit: {
        id: "selected-text-second-occurrence",
        ...selections[0],
      },
      onEditComment: () => undefined,
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    const highlight = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-annotation-highlight"]',
    );
    expect(highlight?.getBoundingClientRect().top).toBe(selected.getBoundingClientRect().top);
  });

  it("preserves an overlapping repeated text occurrence", () => {
    const selections: AssistantSelectionAnnotation[] = [];
    const mounted = mountSurface((annotation) => selections.push(annotation));
    const selected = mounted.container.querySelector('[data-testid="overlapping-repeat"]');
    if (!selected) throw new Error("Expected the overlapping repeated selection");

    selectTextOffsets(selected, 1, 3);
    act(() => selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-button"]')
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-save"]')
        ?.click(),
    );

    expect(selections[0]).toMatchObject({ text: "哈哈", occurrence: 1 });
  });

  it("dismisses the action when the browser selection is cleared elsewhere", () => {
    const mounted = mountSurface(() => undefined);
    const selected = mounted.container.querySelector("strong");
    if (!selected) {
      throw new Error("Expected selectable assistant text");
    }
    selectContents(selected);
    act(() => {
      selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="assistant-selection-comment-button"]'),
    ).not.toBeNull();

    act(() => {
      window.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });

    expect(document.querySelector('[data-testid="assistant-selection-comment-button"]')).toBeNull();
  });

  it("temporarily hides the editor when its input loses focus", async () => {
    let dismissCount = 0;
    const mounted = mountSurface(
      () => undefined,
      () => {
        dismissCount += 1;
      },
    );
    const selected = mounted.container.querySelector("strong");
    if (!selected) {
      throw new Error("Expected selectable assistant text");
    }
    selectContents(selected);
    act(() => {
      selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-button"]')
        ?.click(),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="assistant-selection-comment-input"]',
    );
    if (!input) {
      throw new Error("Expected comment input");
    }
    const outsideButton = document.createElement("button");
    outsideButton.textContent = "Outside editor";
    document.body.appendChild(outsideButton);

    act(() => {
      input.focus();
      outsideButton.focus();
    });
    await act(() => new Promise((resolve) => window.setTimeout(resolve, 0)));

    expect(document.querySelector('[data-testid="assistant-selection-comment-editor"]')).toBeNull();
    expect(dismissCount).toBe(1);
  });

  it("keeps the compact create editor open when its growing input scrolls", () => {
    const mounted = mountSurface(() => undefined);
    const selected = mounted.container.querySelector("strong");
    if (!selected) {
      throw new Error("Expected selectable assistant text");
    }
    selectContents(selected);
    act(() => {
      selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
    });
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-button"]')
        ?.click(),
    );
    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="assistant-selection-comment-input"]',
    );
    if (!input) {
      throw new Error("Expected compact comment input");
    }
    setInputValue(input, "A growing multiline comment ".repeat(20));
    act(() => input.dispatchEvent(new Event("scroll")));

    expect(
      document
        .querySelector('[data-testid="assistant-selection-comment-editor"]')
        ?.getAttribute("data-editor-mode"),
    ).toBe("create");
    const compactPanel = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-editor"] > div',
    );
    if (!compactPanel) {
      throw new Error("Expected growing compact editor panel");
    }
    expect(Number.parseFloat(window.getComputedStyle(compactPanel).borderRadius)).toBe(24);
  });

  it("centers the create editor when its selected text scrolls out of view", async () => {
    const mounted = mountSurface(() => undefined);
    const selected = mounted.container.querySelector("strong");
    if (!selected) throw new Error("Expected selectable assistant text");

    selectContents(selected);
    act(() => selected.dispatchEvent(new PointerEvent("pointerup", { bubbles: true })));
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-button"]')
        ?.click(),
    );
    const selectedLine = selected.parentElement;
    if (!selectedLine) throw new Error("Expected selected text line");
    selectedLine.style.transform = "translateY(1000px)";
    act(() => document.dispatchEvent(new Event("scroll", { bubbles: true })));
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const editor = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-editor"]',
    );
    expect(editor).not.toBeNull();
    expect(editor?.dataset.editorPlacement).toBe("centered");
  });

  it("keeps numbered annotation markers beside saved selections", async () => {
    const openedAnnotations: SelectedTextComposerAttachment[] = [];
    mountSurface(() => undefined, undefined, {
      onOpenAnnotation: (annotation) => openedAnnotations.push(annotation),
      selectedTextAnnotations: [
        {
          kind: "selected_text",
          id: "selected-text-1",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "First comment",
        },
        {
          kind: "selected_text",
          id: "selected-text-2",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "Second comment",
        },
      ],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const markers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="assistant-selection-annotation-marker-"]',
      ),
    );
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.textContent)).toEqual(["1", "2"]);

    const secondMarker = markers[1];
    if (!secondMarker) throw new Error("Expected second annotation marker");
    const hitTarget = getPointerHitTarget(secondMarker);
    expect(secondMarker.contains(hitTarget)).toBe(true);
    await act(async () => (hitTarget as HTMLElement | null)?.click());
    expect(openedAnnotations.map((annotation) => annotation.id)).toEqual(["selected-text-2"]);
  });

  it("refreshes a marker's annotation payload after editing its comment", async () => {
    const openedAnnotations: SelectedTextComposerAttachment[] = [];
    const initial: SelectedTextComposerAttachment = {
      kind: "selected_text",
      id: "selected-text-edited-marker",
      text: "**this invariant**",
      sourceMessageId: "assistant-1",
      comment: "Original comment",
    };
    const mounted = mountSurface(() => undefined, undefined, {
      onOpenAnnotation: (annotation) => openedAnnotations.push(annotation),
      selectedTextAnnotations: [initial],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    mounted.rerender({
      onOpenAnnotation: (annotation) => openedAnnotations.push(annotation),
      selectedTextAnnotations: [{ ...initial, comment: "Edited comment" }],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));
    act(() =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="assistant-selection-annotation-marker-selected-text-edited-marker"]',
        )
        ?.click(),
    );

    expect(openedAnnotations.at(-1)?.comment).toBe("Edited comment");
  });

  it("locates more than six markers and highlights a multiline Markdown annotation", async () => {
    const openedAnnotations: SelectedTextComposerAttachment[] = [];
    const repeatedAnnotations: SelectedTextComposerAttachment[] = Array.from(
      { length: 6 },
      (_, index) => ({
        kind: "selected_text",
        id: `selected-text-${index + 1}`,
        text: "**this invariant**",
        sourceMessageId: "assistant-1",
      }),
    );
    mountSurface(() => undefined, undefined, {
      onOpenAnnotation: (annotation) => openedAnnotations.push(annotation),
      selectedTextAnnotations: [
        ...repeatedAnnotations,
        {
          kind: "selected_text",
          id: "selected-text-7",
          text: "Review checklist:\n\n- **first item**",
          sourceMessageId: "assistant-1",
        },
        {
          kind: "selected_text",
          id: "selected-text-8",
          text: "**first item**\n\n- second item",
          sourceMessageId: "assistant-1",
        },
      ],
      selectedTextAnnotationToEdit: {
        id: "selected-text-8",
        text: "**first item**\n\n- second item",
        sourceMessageId: "assistant-1",
      },
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const markers = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid^="assistant-selection-annotation-marker-"]',
      ),
    );
    expect(markers).toHaveLength(8);
    expect(markers.map((marker) => marker.textContent)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    await act(async () => markers[7]?.click());
    expect(openedAnnotations.map((annotation) => annotation.id)).toEqual(["selected-text-8"]);
    expect(
      document.querySelectorAll('[data-testid="assistant-selection-annotation-highlight"]'),
    ).toHaveLength(2);
  });

  it("does not render annotation portals while its pane is hidden", async () => {
    mountSurface(() => undefined, undefined, {
      visible: false,
      selectedTextAnnotations: [
        {
          kind: "selected_text",
          id: "selected-text-hidden",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "Hidden comment",
        },
      ],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    expect(
      document.querySelectorAll('[data-testid^="assistant-selection-annotation-marker-"]'),
    ).toHaveLength(0);
    expect(document.querySelector('[data-testid="assistant-selection-comment-editor"]')).toBeNull();
  });

  it("keeps annotation markers in the content plane below every global overlay", async () => {
    mountSurface(() => undefined, undefined, {
      selectedTextAnnotations: [
        {
          kind: "selected_text",
          id: "selected-text-layered",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "Layered comment",
        },
      ],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const adornmentRoot = document.getElementById("content-adornment-root");
    const marker = document.querySelector(
      '[data-testid^="assistant-selection-annotation-marker-"]',
    );
    expect(adornmentRoot?.contains(marker)).toBe(true);
    expect(Number(adornmentRoot?.style.zIndex)).toBe(WEB_SURFACE_PLANE.contentAdornment);
    expect(WEB_SURFACE_PLANE.contentAdornment).toBeLessThan(Number(getOverlayRoot().style.zIndex));
  });

  it("hides annotation markers behind the main composer", async () => {
    mountSurface(() => undefined, undefined, {
      composerOcclusionTop: 0,
      selectedTextAnnotations: [
        {
          kind: "selected_text",
          id: "selected-text-occluded",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "Occluded comment",
        },
      ],
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    expect(
      document.querySelectorAll('[data-testid^="assistant-selection-annotation-marker-"]'),
    ).toHaveLength(0);
  });

  it("keeps markers and highlights within the chat viewport top boundary", async () => {
    const annotation: SelectedTextComposerAttachment = {
      kind: "selected_text",
      id: "selected-text-top-boundary",
      text: "**this invariant**",
      sourceMessageId: "assistant-1",
      comment: "Top boundary",
    };
    mountSurface(() => undefined, undefined, {
      contentViewportTop: 100,
      selectedTextAnnotations: [annotation],
      selectedTextAnnotationToEdit: annotation,
      onOpenAnnotation: () => undefined,
      onEditComment: () => undefined,
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    expect(
      document.querySelectorAll('[data-testid^="assistant-selection-annotation-marker-"]'),
    ).toHaveLength(0);
    const highlights = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="assistant-selection-annotation-highlight"]',
      ),
    );
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.every((highlight) => highlight.getBoundingClientRect().top >= 100)).toBe(
      true,
    );
  });

  it("clips annotation highlights to the chat viewport before the composer", async () => {
    mountSurface(() => undefined, undefined, {
      contentViewportBottom: 10,
      selectedTextAnnotationToEdit: {
        id: "selected-text-highlight-before-composer",
        text: "**this invariant**",
        sourceMessageId: "assistant-1",
        comment: "Clipped highlight",
      },
      onEditComment: () => undefined,
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const highlights = Array.from(
      document.querySelectorAll<HTMLElement>(
        '[data-testid="assistant-selection-annotation-highlight"]',
      ),
    );
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights.every((highlight) => highlight.getBoundingClientRect().bottom <= 10)).toBe(
      true,
    );
  });

  it("centers the edit dialog in the content area when its anchor cannot fit", async () => {
    mountSurface(() => undefined, undefined, {
      composerOcclusionTop: 180,
      selectedTextAnnotationToEdit: {
        id: "selected-text-centered-editor",
        text: "**this invariant**",
        sourceMessageId: "assistant-1",
        comment: "Centered editor",
      },
      onEditComment: () => undefined,
    });
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const editor = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-editor"]',
    );
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-input-area"]');
    expect(editor?.dataset.editorPlacement).toBe("centered");
    expect(editor?.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(editor?.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      composer?.getBoundingClientRect().top ?? 0,
    );
  });

  it("highlights an existing annotation and keeps its full editor open during input scroll", async () => {
    const edits: SelectedTextAnnotationEdit[] = [];
    let dismissCount = 0;
    mountSurface(
      () => undefined,
      () => {
        dismissCount += 1;
      },
      {
        selectedTextAnnotationToEdit: {
          id: "selected-text-1",
          text: "**this invariant**",
          sourceMessageId: "assistant-1",
          comment: "Original comment",
        },
        onEditComment: (edit) => edits.push(edit),
      },
    );
    await act(() => new Promise((resolve) => window.requestAnimationFrame(resolve)));

    const editor = document.querySelector<HTMLElement>(
      '[data-testid="assistant-selection-comment-editor"]',
    );
    expect(editor?.dataset.editorMode).toBe("edit");
    expect(
      document.querySelector('[data-testid="assistant-selection-annotation-highlight"]'),
    ).not.toBeNull();
    expect(window.getSelection()?.toString()).toBe("");

    const input = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="assistant-selection-comment-input"]',
    );
    if (!input) {
      throw new Error("Expected edit comment input");
    }
    expect(input.tagName).toBe("TEXTAREA");
    expect(input.value).toBe("Original comment");
    act(() => {
      input.blur();
      document.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    expect(
      document.querySelector('[data-testid="assistant-selection-comment-editor"]'),
    ).not.toBeNull();
    setInputValue(input, "A much longer revised comment ".repeat(20));
    act(() => input.dispatchEvent(new Event("scroll")));

    expect(
      document.querySelector('[data-testid="assistant-selection-comment-editor"]'),
    ).not.toBeNull();
    expect(dismissCount).toBe(0);
    act(() =>
      document
        .querySelector<HTMLElement>('[data-testid="assistant-selection-comment-save"]')
        ?.click(),
    );
    expect(edits).toEqual([
      {
        attachmentId: "selected-text-1",
        comment: "A much longer revised comment ".repeat(20).trim(),
      },
    ]);
    expect(document.querySelector('[data-testid="assistant-selection-comment-editor"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="assistant-selection-annotation-highlight"]'),
    ).toBeNull();
  });
});
