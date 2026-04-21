import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrPaneData } from "@/utils/pr-pane-data";
import { PrPane } from "./pr-pane";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    colors: {
      surfaceSidebar: "#0b0b0b",
      surfaceSidebarHover: "#151515",
      border: "#222",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      statusSuccess: "#30d158",
      statusDanger: "#ff453a",
      statusWarning: "#f2c945",
      statusMerged: "#a371f7",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
    CircleCheck: createIcon("CircleCheck"),
    CircleDot: createIcon("CircleDot"),
    CircleSlash: createIcon("CircleSlash"),
    CircleX: createIcon("CircleX"),
    ExternalLink: createIcon("ExternalLink"),
    GitMerge: createIcon("GitMerge"),
    GitPullRequest: createIcon("GitPullRequest"),
    GitPullRequestClosed: createIcon("GitPullRequestClosed"),
    GitPullRequestDraft: createIcon("GitPullRequestDraft"),
    MessageSquare: createIcon("MessageSquare"),
  };
});

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(),
}));

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function makeData(overrides: Partial<PrPaneData> = {}): PrPaneData {
  return {
    number: 1284,
    title: "fix(server,app): coalesce tool call stream events",
    state: "open",
    url: "https://github.com/getpaseo/paseo/pull/1284",
    reviewDecision: "changes_requested",
    awaitingReviewers: [],
    checks: [
      { name: "typecheck", workflow: "CI", status: "success", duration: "1m", url: "#" },
      { name: "test", workflow: "CI", status: "failure", duration: "2m", url: "#" },
    ],
    activity: [
      {
        kind: "review",
        author: "alicek",
        avatarColor: "#8b5cf6",
        reviewState: "approved",
        body: "LGTM",
        age: "2h ago",
        url: "#",
      },
      {
        kind: "comment",
        author: "bmartin",
        avatarColor: "#f97316",
        body: "Worth a benchmark before/after.",
        age: "3h ago",
        url: "#",
      },
    ],
    ...overrides,
  };
}

function render(data: PrPaneData) {
  act(() => {
    root?.render(<PrPane data={data} />);
  });
}

describe("PrPane", () => {
  it("renders the PR title and 'Open' state label from the data prop", () => {
    render(makeData());

    expect(container?.textContent).toContain("fix(server,app): coalesce tool call stream events");
    expect(container?.textContent).toContain("Open");
  });

  it("renders the correct state label and icon for each PR state", () => {
    render(makeData({ state: "draft" }));
    expect(container?.textContent).toContain("Draft");
    expect(container?.querySelector('[data-icon="GitPullRequestDraft"]')).not.toBeNull();

    render(makeData({ state: "merged" }));
    expect(container?.textContent).toContain("Merged");
    expect(container?.querySelector('[data-icon="GitMerge"]')).not.toBeNull();

    render(makeData({ state: "closed" }));
    expect(container?.textContent).toContain("Closed");
    expect(container?.querySelector('[data-icon="GitPullRequestClosed"]')).not.toBeNull();
  });

  it("derives check summary counts from the data prop", () => {
    render(makeData());
    const text = container?.textContent ?? "";

    expect(text).toContain("typecheck");
    expect(text).toContain("test");
    // 1 passed, 1 failed, 0 pending — so pending pill is hidden.
    expect(text).toMatch(/1.*1/);
  });

  it("derives review summary counts and renders activity rows", () => {
    render(makeData());
    const text = container?.textContent ?? "";

    expect(text).toContain("alicek");
    expect(text).toContain("Approved");
    expect(text).toContain("bmartin");
    expect(text).toContain("Commented");
  });
});
