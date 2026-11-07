import { afterEach, describe, expect, it } from "vitest";
import { readChatSelectionToCopy } from "./chat-copy-on-select.web";

function mount(html: string): HTMLElement {
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  return container;
}

function selectContents(node: Node): Selection {
  const selection = window.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.innerHTML = "";
});

describe("readChatSelectionToCopy", () => {
  it("returns the selected chat text", () => {
    const container = mount("<p>hello chat</p>");
    const selection = selectContents(container.querySelector("p")!);
    expect(readChatSelectionToCopy(selection, container)).toBe("hello chat");
  });

  it("ignores a collapsed selection", () => {
    const container = mount("<p>hello chat</p>");
    const selection = window.getSelection()!;
    selection.collapse(container.querySelector("p")!.firstChild!, 2);
    expect(readChatSelectionToCopy(selection, container)).toBeNull();
  });

  it("ignores a selection that leaves the chat", () => {
    const container = mount("<p>inside</p>");
    const outside = mount("<p>outside</p>");
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(container.querySelector("p")!.firstChild!, 0);
    range.setEnd(outside.querySelector("p")!.firstChild!, 3);
    selection.removeAllRanges();
    selection.addRange(range);
    expect(readChatSelectionToCopy(selection, container)).toBeNull();
  });

  it("ignores selections inside editable fields", () => {
    const container = mount('<div contenteditable="true"><p>draft</p></div>');
    const selection = selectContents(container.querySelector("p")!);
    expect(readChatSelectionToCopy(selection, container)).toBeNull();
  });

  it("ignores whitespace-only selections", () => {
    const container = mount("<p>   </p>");
    const selection = selectContents(container.querySelector("p")!);
    expect(readChatSelectionToCopy(selection, container)).toBeNull();
  });
});
