import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { afterEach, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { i18n } from "@/i18n/i18next";
import { useSessionStore } from "@/stores/session-store";
import { ToolCallDetailsContent } from "./tool-call-details";

// A real browser: the preview persists the image in the attachment store and renders it through the
// web Image, so a fake element or a JSDOM stub would not exercise the path under test.
void i18n;

const PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=",
  ),
  (character) => character.charCodeAt(0),
);

function installClient(options: { failRead?: boolean } = {}): void {
  useSessionStore.setState({
    sessions: {
      "host-1": {
        client: {
          readFile: async (cwd: string, path: string) => {
            if (options.failRead) throw new Error("The file could not be read.");
            return {
              bytes: PNG,
              kind: "image",
              mime: "image/png",
              modifiedAt: "2026-11-13T00:00:00.000Z",
              path: `${cwd}/${path}`,
              size: PNG.byteLength,
            };
          },
        },
      },
    },
  } as never);
}

function ReadDetails({ filePath }: { filePath: string }) {
  const detail = useMemo<ToolCallDetail>(() => ({ type: "read", filePath }), [filePath]);
  return <ToolCallDetailsContent cwd="/repo" detail={detail} serverId="host-1" />;
}

function renderRead(filePath: string, options: { failRead?: boolean } = {}): void {
  installClient(options);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ReadDetails filePath={filePath} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  useSessionStore.setState({ sessions: {} } as never);
});

it("shows a read image with its path and opens the preview", async () => {
  renderRead("/repo/shot.png");

  const preview = await screen.findByTestId("tool-call-read-image-content");
  expect(preview.outerHTML).toContain("blob:");
  expect(screen.getByText("/repo/shot.png")).toBeTruthy();

  fireEvent.click(screen.getByTestId("tool-call-read-image"));

  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-title").textContent).toBe("/repo/shot.png");
  });
});

it("reports an image whose read fails instead of leaving the preview blank", async () => {
  renderRead("/repo/broken.png", { failRead: true });

  expect(await screen.findByText("Image unavailable")).toBeTruthy();
  expect(screen.queryByTestId("tool-call-read-image")).toBeNull();
});
