/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectEmojiIconPicker } from "./project-emoji-icon-picker";

vi.stubGlobal("React", React);

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 6: 24 },
    borderRadius: { md: 6 },
    fontSize: { sm: 13 },
    colors: {
      accent: "#09f",
      border: "#444",
      foregroundMuted: "#aaa",
      surface1: "#111",
      surface2: "#222",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (value: typeof theme) => unknown)(theme)
        : factory,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings.project.icon.emojiPickerTitle": "Choose an emoji",
        "settings.project.icon.emojiSearchPlaceholder": "Search emojis",
        "settings.project.icon.emojiNoResults": "No matching emojis",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    header,
    children,
    testID,
  }: {
    visible: boolean;
    header: { search?: { onChange: (value: string) => void; testID?: string } };
    children: React.ReactNode;
    testID?: string;
  }) => {
    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        header.search?.onChange(event.target.value);
      },
      [header.search],
    );
    return visible ? (
      <section data-testid={testID}>
        <input data-testid={header.search?.testID} onChange={handleChange} />
        {children}
      </section>
    ) : null;
  },
}));

afterEach(cleanup);

describe("ProjectEmojiIconPicker", () => {
  it("searches the full library and selects an emoji", () => {
    const onSelect = vi.fn();
    render(<ProjectEmojiIconPicker selectedEmoji={null} onSelect={onSelect} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId("project-emoji-search"), {
      target: { value: "dollar" },
    });
    fireEvent.click(screen.getByTestId("project-emoji-option-1f4b2"));

    expect(onSelect).toHaveBeenCalledWith("\u{1F4B2}");
  });

  it("shows an empty state for an unmatched search", () => {
    render(<ProjectEmojiIconPicker selectedEmoji={null} onSelect={vi.fn()} onClose={vi.fn()} />);

    fireEvent.change(screen.getByTestId("project-emoji-search"), {
      target: { value: "definitely-not-an-emoji-keyword" },
    });

    expect(screen.getByText("No matching emojis")).toBeTruthy();
  });
});
