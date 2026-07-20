/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Assistant } from "@getpaseo/protocol/messages";
import { afterEach, describe, expect, test, vi } from "vitest";
import { AssistantsSection } from "./assistants-section";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    borderWidth: { 1: 1 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontFamily: { mono: "monospace" },
    fontWeight: { normal: "400", medium: "500" },
    opacity: { 50: 0.5 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      accent: "#0a0",
      accentForeground: "#fff",
      destructive: "#a00",
      destructiveForeground: "#fff",
      statusDanger: "#f00",
    },
  },
}));

const assistantsState = vi.hoisted(() => ({
  current: {
    assistants: [] as Assistant[],
    createAssistant: vi.fn(),
    updateAssistant: vi.fn(),
    deleteAssistant: vi.fn(),
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/hooks/use-assistants", () => ({
  useAssistants: () => ({
    assistants: assistantsState.current.assistants,
    isLoading: false,
    isConnected: true,
    error: null,
    createAssistant: assistantsState.current.createAssistant,
    updateAssistant: assistantsState.current.updateAssistant,
    deleteAssistant: assistantsState.current.deleteAssistant,
    isMutating: false,
    mutationError: null,
  }),
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => true,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/form-field", () => ({
  Field: ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
    <label>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  ),
  FormTextInput: ({
    initialValue,
    placeholder,
    onChangeText,
  }: {
    initialValue?: string;
    placeholder?: string;
    onChangeText: (value: string) => void;
  }) =>
    React.createElement("input", {
      defaultValue: initialValue,
      placeholder,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChangeText(event.currentTarget.value),
    }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({ value, onValueChange }: { value: boolean; onValueChange: (value: boolean) => void }) =>
    React.createElement("input", {
      type: "checkbox",
      checked: value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onValueChange(event.currentTarget.checked),
    }),
}));

vi.mock("@/components/settings-textarea", () => ({
  SettingsTextAreaCard: ({
    value,
    onChangeText,
    placeholder,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (value: string) => void;
    placeholder?: string;
    accessibilityLabel: string;
  }) =>
    React.createElement("textarea", {
      "aria-label": accessibilityLabel,
      value,
      placeholder,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChangeText(event.currentTarget.value),
    }),
}));

vi.mock("@/screens/settings/settings-section", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
}));

function makeAssistant(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: "assistant-1",
    name: "Reviewer",
    description: "Reviews code",
    prompt: "Review carefully.",
    memoryEnabled: true,
    memory: "# Existing\nPrefer concise feedback.",
    memorySummary: "old summary",
    memoryFiles: {
      summaryPath: "/tmp/assistant-memory/summary.md",
      detailFiles: [
        {
          id: "detail-001",
          title: "Existing",
          path: "/tmp/assistant-memory/details/detail-001.md",
          charCount: 34,
          content: "# Existing\n\nPrefer concise feedback.",
        },
      ],
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("AssistantsSection", () => {
  afterEach(() => {
    cleanup();
    assistantsState.current.assistants = [];
    assistantsState.current.createAssistant.mockReset();
    assistantsState.current.updateAssistant.mockReset();
    assistantsState.current.deleteAssistant.mockReset();
  });

  test("refreshes memory summary/detail previews after appending source memory", async () => {
    const existingAssistant = makeAssistant();
    const updatedAssistant = makeAssistant({
      memory: "# Existing\nPrefer concise feedback.\n\n# New\nMention risky migrations.",
      memorySummary: "new summary with Mention risky migrations",
      memoryFiles: {
        summaryPath: "/tmp/assistant-memory/summary.md",
        detailFiles: [
          {
            id: "detail-001",
            title: "Existing",
            path: "/tmp/assistant-memory/details/detail-001.md",
            charCount: 67,
            content: "# Existing\n\nPrefer concise feedback.\n\n# New\n\nMention risky migrations.",
          },
        ],
      },
    });
    assistantsState.current.assistants = [existingAssistant];
    assistantsState.current.updateAssistant.mockResolvedValue(updatedAssistant);

    render(<AssistantsSection serverId="server-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByDisplayValue("old summary")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Assistant memory"), {
      target: { value: "# New\nMention risky migrations." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(assistantsState.current.updateAssistant).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "assistant-1",
          memoryAppend: "# New\nMention risky migrations.",
        }),
      ),
    );
    const updateInput = assistantsState.current.updateAssistant.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(updateInput).not.toHaveProperty("memorySummary");
    expect(updateInput).not.toHaveProperty("memoryDetailFileEdits");
    await waitFor(() => {
      expect(screen.getByDisplayValue("new summary with Mention risky migrations")).toBeTruthy();
      expect(screen.getAllByDisplayValue(/Mention risky migrations/).length).toBeGreaterThan(1);
    });
    expect((screen.getByLabelText("Assistant memory") as HTMLTextAreaElement).value).toBe("");
  });

  test("saves edited memory summary and detail file contents", async () => {
    const existingAssistant = makeAssistant();
    const updatedAssistant = makeAssistant({
      memorySummary: "edited summary",
      memoryFiles: {
        summaryPath: "/tmp/assistant-memory/summary.md",
        detailFiles: [
          {
            id: "detail-001",
            title: "Edited",
            path: "/tmp/assistant-memory/details/detail-001.md",
            charCount: 22,
            content: "# Edited\n\nDetail body",
          },
        ],
      },
    });
    assistantsState.current.assistants = [existingAssistant];
    assistantsState.current.updateAssistant.mockResolvedValue(updatedAssistant);

    render(<AssistantsSection serverId="server-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Memory summary file content"), {
      target: { value: "edited summary" },
    });
    fireEvent.change(screen.getByLabelText("Memory detail file detail-001 content"), {
      target: { value: "# Edited\n\nDetail body" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(assistantsState.current.updateAssistant).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "assistant-1",
          memorySummary: "edited summary",
          memoryDetailFileEdits: [
            {
              id: "detail-001",
              content: "# Edited\n\nDetail body",
            },
          ],
        }),
      ),
    );
    await waitFor(() => {
      expect(screen.getByDisplayValue("edited summary")).toBeTruthy();
      expect(screen.getByDisplayValue(/Detail body/)).toBeTruthy();
    });
  });
});
