/**
 * @vitest-environment jsdom
 */
import React, { useCallback, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallItem } from "@/types/stream";
import type { OverviewToolCallGroup } from "./model";
import { OverviewToolCallGroupView } from "./view";

const layout = vi.hoisted(() => ({ isCompact: true }));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => layout.isCompact,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => {
      if (key === "toolCallGroup.and") return "and";
      if (key.startsWith("toolCallGroup.commands")) return `ran ${options?.count} commands`;
      if (key.startsWith("toolCallGroup.readFiles")) return `read ${options?.count} files`;
      return key;
    },
  }),
}));

vi.mock("@/components/message", () => ({
  ExpandableBadge: ({
    label,
    isExpanded,
    onToggle,
    renderDetails,
  }: {
    label: string;
    isExpanded: boolean;
    onToggle: () => void;
    renderDetails?: () => ReactNode;
  }) => (
    <section data-testid="overview-badge" data-expanded={isExpanded}>
      <button type="button" onClick={onToggle}>
        {label}
      </button>
      {isExpanded ? renderDetails?.() : null}
    </section>
  ),
}));

vi.mock("./sheet", () => ({
  OverviewToolCallGroupSheet: ({
    visible,
    summary,
    children,
    onClose,
  }: {
    visible: boolean;
    summary: string;
    children: ReactNode;
    onClose: () => void;
  }) =>
    visible ? (
      <section data-testid="tool-call-group-sheet">
        <h1>{summary}</h1>
        {children}
        <button type="button" onClick={onClose}>
          Close group
        </button>
      </section>
    ) : null,
}));

function toolCall(id: string): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: id },
      },
    },
  };
}

function group(calls: ToolCallItem[], readFileCount = 0): OverviewToolCallGroup {
  const latest = calls.at(-1);
  if (!latest) {
    throw new Error("Expected at least one tool call");
  }
  return {
    mode: "overview",
    run: { id: calls[0]?.id ?? latest.id, calls, latest, isSealed: false },
    summary: {
      editedFileCount: 0,
      commandCount: calls.length,
      readFileCount,
      searchCount: 0,
      otherToolCount: 0,
      paseoCallCount: 0,
    },
    isLoading: false,
  };
}

function Harness({ value }: { value: OverviewToolCallGroup }) {
  const [expanded, setExpanded] = useState(false);
  const handleExpandedChange = useCallback(
    (_groupId: string, nextExpanded: boolean) => setExpanded(nextExpanded),
    [],
  );
  return (
    <OverviewToolCallGroupView
      group={value}
      expanded={expanded}
      isLastInSequence
      onExpandedChange={handleExpandedChange}
    >
      {value.run.calls.map((call) => (
        <div key={call.id}>{call.id}</div>
      ))}
    </OverviewToolCallGroupView>
  );
}

describe("OverviewToolCallGroupView", () => {
  afterEach(cleanup);

  beforeEach(() => {
    layout.isCompact = true;
  });

  it("keeps an open mobile group sheet current as the run grows", () => {
    const first = toolCall("first-call");
    const second = toolCall("second-call");
    const view = render(<Harness value={group([first])} />);

    fireEvent.click(screen.getByRole("button", { name: "Ran 1 commands" }));
    expect(screen.getByTestId("tool-call-group-sheet").textContent).toContain("first-call");

    view.rerender(<Harness value={group([first, second], 1)} />);
    expect(screen.getByTestId("tool-call-group-sheet").textContent).toContain(
      "Ran 2 commands and read 1 files",
    );
    expect(screen.getByTestId("tool-call-group-sheet").textContent).toContain("second-call");

    fireEvent.click(screen.getByRole("button", { name: "Close group" }));
    expect(screen.queryByTestId("tool-call-group-sheet")).toBeNull();
  });

  it("preserves inline expansion on non-compact layouts", () => {
    layout.isCompact = false;
    render(<Harness value={group([toolCall("desktop-call")])} />);

    expect(screen.queryByTestId("tool-call-group-sheet")).toBeNull();
    expect(screen.queryByText("desktop-call")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Ran 1 commands" }));
    expect(screen.getByTestId("overview-badge").getAttribute("data-expanded")).toBe("true");
    expect(screen.getByText("desktop-call")).not.toBeNull();
  });
});
