import React, { act, createRef, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n as testI18n } from "@/i18n/i18next";
import { ToolCallDetailsContent } from "@/components/tool-call-details";
import { ExpandableBadge } from "@/components/message";
import { page, userEvent } from "vitest/browser";
import { PlanCard } from "@/components/plan-card";
import { MessagePreview } from "@/components/user-message";
import { createUserMessageExpansion } from "@/components/user-message/expansion";
import { UserMessageExpansionContext } from "@/components/user-message/expansion-context";
import { DisclosureRow } from "./disclosure";
import type { DisclosureTriggerEdge, StreamViewportHandle } from "./strategy";

// Load translations so the toggles expose their real accessible names.
void testI18n;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

let root: Root;
let container: HTMLDivElement;
// The plan body renders through the app's Markdown renderer, which reads through React Query.
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient();
});

afterEach(() => {
  act(() => root.unmount());
  queryClient.clear();
  container.remove();
});

interface Hold {
  rowId: string;
  triggerEdge: DisclosureTriggerEdge;
  /** Whether the expanded content was already on screen when the strategy received the hold. */
  appliedBefore: boolean;
}

/**
 * A timeline row whose viewport records each hold. Like the strategies, it runs `apply` itself, so
 * a toggle that skips the hold still changes state but leaves no record.
 */
function mountRow(rowId: string, isApplied: () => boolean, children: ReactNode) {
  const holds: Hold[] = [];
  const viewport: StreamViewportHandle = {
    scrollToBottom: vi.fn(),
    prepareForViewportChange: vi.fn(),
    holdRow: (heldRowId, apply, triggerEdge) => {
      holds.push({ rowId: heldRowId, triggerEdge, appliedBefore: isApplied() });
      apply();
    },
  };
  const viewportRef = createRef<StreamViewportHandle>();
  viewportRef.current = viewport;
  act(() =>
    root.render(
      <QueryClientProvider client={queryClient}>
        <DisclosureRow rowId={rowId} viewportRef={viewportRef}>
          {children}
        </DisclosureRow>
      </QueryClientProvider>,
    ),
  );
  return holds;
}

const view = () => within(container);

const preLine = { whiteSpace: "pre-line" } as const;

describe("timeline disclosures hold their row", () => {
  it("routes user message show more and show less through the row's hold", () => {
    const longText = Array.from({ length: 60 }, (_, line) => `Line ${line + 1}`).join("\n");
    const expansion = createUserMessageExpansion();
    const holds = mountRow(
      "message-1",
      () => view().queryByRole("button", { name: "Show less" }) !== null,
      <UserMessageExpansionContext.Provider value={expansion}>
        <MessagePreview itemId="message-1">
          <span style={preLine}>{longText}</span>
        </MessagePreview>
      </UserMessageExpansionContext.Provider>,
    );

    act(() => view().getByRole("button", { name: "Show more" }).click());
    expect(view().getByRole("button", { name: "Show less" })).toBeTruthy();

    act(() => view().getByRole("button", { name: "Show less" }).click());
    expect(view().getByRole("button", { name: "Show more" })).toBeTruthy();

    expect(holds).toEqual([
      // Show more sits under the text it opens.
      { rowId: "message-1", triggerEdge: "bottom", appliedBefore: false },
      { rowId: "message-1", triggerEdge: "bottom", appliedBefore: true },
    ]);
  });

  it("routes plan card collapse and expand through the row's hold", () => {
    const header = () => view().getByRole("button", { name: "Approved plan" });
    const isExpanded = () => header().getAttribute("aria-expanded") === "true";
    const holds = mountRow(
      "plan-1",
      isExpanded,
      <PlanCard title="Plan" text="Step one" outcome="approved" />,
    );

    act(() => header().click());
    expect(isExpanded()).toBe(false);

    act(() => header().click());
    expect(isExpanded()).toBe(true);

    expect(holds).toEqual([
      { rowId: "plan-1", triggerEdge: "top", appliedBefore: true },
      { rowId: "plan-1", triggerEdge: "top", appliedBefore: false },
    ]);
  });

  it("toggles a plan card outside a timeline row, as the pending permission card renders", () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <PlanCard title="Plan" text="Step one" outcome="pending" />
        </QueryClientProvider>,
      ),
    );
    const header = () => view().getByRole("button", { name: "Plan" });
    const isExpanded = () => header().getAttribute("aria-expanded") === "true";

    act(() => header().click());
    expect(isExpanded()).toBe(false);

    act(() => header().click());
    expect(isExpanded()).toBe(true);
  });
});

function renderFileDetails() {
  return <div>File contents</div>;
}

describe("tool badge file action", () => {
  it("keeps file opening separate from the accessible disclosure button", async () => {
    let opened = 0;
    function Badge({ hasFile }: { hasFile: boolean }) {
      const [expanded, setExpanded] = React.useState(false);
      const toggle = React.useCallback(() => setExpanded(!expanded), [expanded]);
      const openFile = React.useCallback(() => {
        opened += 1;
      }, []);
      return (
        <ExpandableBadge
          label="Read"
          secondaryLabel="src/index.ts"
          isExpanded={expanded}
          onToggle={toggle}
          onOpenFile={hasFile ? openFile : undefined}
          renderDetails={renderFileDetails}
        />
      );
    }
    container.style.width = "300px";
    container.style.marginLeft = "20px";
    act(() => root.render(<Badge hasFile={false} />));
    const header = page.getByRole("button", { name: "Read src/index.ts", exact: true });
    const headerElement = view().getByRole("button", { name: /^Read src\/index\.ts$/ });
    expect(headerElement.getBoundingClientRect().width).toBeGreaterThan(260);
    await header.click({ position: { x: 220, y: 10 } });
    await expect.element(page.getByText("File contents")).toBeVisible();
    await header.click({ position: { x: 2, y: 2 } });
    await expect.element(page.getByText("File contents")).not.toBeInTheDocument();
    await header.click({ position: { x: 2, y: 2 } });
    await expect.element(page.getByText("File contents")).toBeVisible();
    await header.click({ position: { x: 220, y: 10 } });
    await expect.element(page.getByText("File contents")).not.toBeInTheDocument();
    act(() => root.render(<Badge hasFile />));
    await page.getByRole("button", { name: "Read src/index.ts", exact: true }).hover();
    const file = view().getByRole("button", { name: /^Open file$/ });
    expect(file.parentElement?.closest("button")).toBeNull();
    await page.getByRole("button", { name: "Open file", exact: true }).click();
    expect(opened).toBe(1);
    const disclosure = view().getByRole("button", { name: /^Read src\/index\.ts$/ });
    expect(view().queryByText("File contents")).toBeNull();
    await header.click({ position: { x: 220, y: 10 } });

    await expect.element(page.getByText("File contents")).toBeVisible();
    expect(opened).toBe(1);
    act(() => file.focus());
    await userEvent.keyboard("{Enter}");
    expect(opened).toBe(2);
    expect(view().getByText("File contents")).toBeTruthy();
    act(() => disclosure.focus());
    await userEvent.keyboard("{Enter}");
    expect(view().queryByText("File contents")).toBeNull();
  });
});

const longDetail = {
  type: "unknown" as const,
  input: { text: "input\n".repeat(80) },
  output: { text: "output\n".repeat(80) },
};

describe("inline tool detail height", () => {
  it("caps the complete detail, including input, output and error, to its allowance", () => {
    act(() =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToolCallDetailsContent
            detail={longDetail}
            errorText={"error\n".repeat(80)}
            maxHeight={200}
          />
        </QueryClientProvider>,
      ),
    );
    expect(container.getBoundingClientRect().height).toBeLessThanOrEqual(200);
    expect(container.textContent).toContain("output");
    expect(container.textContent).toContain("error");
  });
});

const longShellDetail = {
  type: "shell" as const,
  command: "echo command\n".repeat(80),
  output: "output\n".repeat(80),
};

const longEditDetail = {
  type: "edit" as const,
  filePath: "example.txt",
  oldString: "old line\n".repeat(80),
  newString: "new line\n".repeat(80),
};

describe("capped tool scrolling", () => {
  it.each([longShellDetail, longEditDetail])(
    "gives a capped $type detail one vertical scroll owner",
    (detail) => {
      act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <ToolCallDetailsContent detail={detail} maxHeight={200} />
          </QueryClientProvider>,
        ),
      );
      const verticalScrollers = Array.from(container.querySelectorAll("*")).filter((node) =>
        ["auto", "scroll"].includes(getComputedStyle(node).overflowY),
      );
      expect(verticalScrollers).toHaveLength(1);
      expect(container.getBoundingClientRect().height).toBeLessThanOrEqual(200);
    },
  );
});

function renderCopyOutput() {
  return <button type="button">Copy output</button>;
}

const searchQuery = "IANA example domains";
const queryOnlySearch = { type: "search", query: searchQuery, toolName: "web_search" } as const;

function renderSearchDetails() {
  return <ToolCallDetailsContent detail={queryOnlySearch} />;
}

function SearchBadge() {
  const [expanded, setExpanded] = React.useState(false);
  const toggle = React.useCallback(() => setExpanded((current) => !current), []);
  return (
    <ExpandableBadge
      label="Search"
      isExpanded={expanded}
      onToggle={toggle}
      renderDetails={renderSearchDetails}
    />
  );
}

describe("tool detail interaction", () => {
  it("shows the query when an expanded search has no results", async () => {
    act(() => root.render(<SearchBadge />));
    await page.getByRole("button", { name: "Search" }).click();
    await expect.element(page.getByText(searchQuery, { exact: true })).toBeVisible();
  });

  it("keeps detail controls in the tab order", async () => {
    function Badge() {
      const [expanded, setExpanded] = React.useState(true);
      const toggle = React.useCallback(() => setExpanded(!expanded), [expanded]);
      return (
        <ExpandableBadge
          label="Probe"
          isExpanded={expanded}
          onToggle={toggle}
          renderDetails={renderCopyOutput}
        />
      );
    }
    act(() => root.render(<Badge />));
    const header = view().getByRole("button", { name: "Probe" });
    act(() => header.focus());
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(view().getByRole("button", { name: "Copy output" }));
  });
});
