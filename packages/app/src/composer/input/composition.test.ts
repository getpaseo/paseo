// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { installComposerCompositionHandlers } from "./composition";

afterEach(() => {
  vi.useRealTimers();
});

describe("中文输入组合事件", () => {
  // 这条用例防止中文候选字上屏后被受控 textarea 的旧值覆盖。
  it("应在中文候选字提交时同步最终文本并结束组合状态", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    const valueRef = { current: "" };
    const changes: string[] = [];
    const composingStates: boolean[] = [];

    // Arrange：模拟浏览器 textarea，中文输入法提交候选字时会发送 composition 事件。
    const cleanup = installComposerCompositionHandlers(
      textarea,
      valueRef,
      (text) => changes.push(text),
      (isComposing) => composingStates.push(isComposing),
    );

    // Act：输入法开始组合，在 DOM 中写入最终中文，再提交候选字。
    textarea.dispatchEvent(new Event("compositionstart"));
    textarea.value = "你好";
    textarea.dispatchEvent(new Event("compositionend"));
    vi.runAllTimers();

    // Assert：受控状态收到最终中文，且组合状态恢复为结束。
    expect(changes).toEqual(["你好"]);
    expect(valueRef.current).toBe("你好");
    expect(composingStates).toEqual([true, false]);
    cleanup();
  });

  // 这条边界用例防止组合结束事件重复写入相同文本，造成光标或草稿状态抖动。
  it("应避免候选字提交值未变化时重复触发文本更新", () => {
    vi.useFakeTimers();
    const textarea = document.createElement("textarea");
    textarea.value = "你好";
    const changes: string[] = [];

    // Arrange：受控值已经是候选字提交后的文本，防止重复回调覆盖光标状态。
    const cleanup = installComposerCompositionHandlers(
      textarea,
      { current: "你好" },
      (text) => changes.push(text),
      () => undefined,
    );

    // Act：仅触发一次候选字提交。
    textarea.dispatchEvent(new Event("compositionend"));

    // Assert：值未变化时不重复通知上层。
    expect(changes).toEqual([]);
    cleanup();
  });
});
