/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectIconToDataUri } from "@/utils/project-icon-presentation";
import { ProjectIconView } from "./project-icon-view";

vi.stubGlobal("React", React);
afterEach(cleanup);

const IMAGE_STYLE = { width: 16, height: 16 } as const;
const FALLBACK_STYLE = { width: 16, height: 16 } as const;
const TEXT_STYLE = { fontSize: 9 } as const;
const EMOJI_STYLE = { fontSize: 13 } as const;

describe("ProjectIconView", () => {
  it("renders an emoji icon instead of the image-compatible fallback", () => {
    const iconDataUri = projectIconToDataUri({
      data: "fallback",
      mimeType: "image/svg+xml",
      source: "custom",
      emoji: "\u{1F4B2}",
    });

    render(
      <ProjectIconView
        iconDataUri={iconDataUri}
        initial="P"
        projectKey="project"
        imageStyle={IMAGE_STYLE}
        fallbackStyle={FALLBACK_STYLE}
        textStyle={TEXT_STYLE}
        emojiStyle={EMOJI_STYLE}
      />,
    );

    expect(screen.getByText("\u{1F4B2}")).toBeTruthy();
    expect(screen.queryByText("P")).toBeNull();
  });
});
