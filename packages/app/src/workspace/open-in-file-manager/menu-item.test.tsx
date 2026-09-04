/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { LOCAL_SERVER_ID, REMOTE_SERVER_ID, fileManagerTarget, openTargetMock } = vi.hoisted(() => ({
  LOCAL_SERVER_ID: "local-daemon",
  REMOTE_SERVER_ID: "paired-remote-host",
  fileManagerTarget: {
    id: "file-manager",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
  openTargetMock: vi.fn(async () => {}),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
  getIsElectron: () => true,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    editor: {
      listTargets: async () => [fileManagerTarget],
      openTarget: openTargetMock,
    },
  }),
}));

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  shouldUseDesktopDaemon: () => true,
  getDesktopDaemonStatus: async () => ({ serverId: LOCAL_SERVER_ID }),
}));

function menuItemStub({
  children,
  testID,
  onSelect,
}: {
  children?: React.ReactNode;
  testID?: string;
  onSelect?: () => void;
}) {
  return (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  );
}

vi.mock("@/components/ui/dropdown-menu", () => ({ DropdownMenuItem: menuItemStub }));
vi.mock("@/components/ui/context-menu", () => ({ ContextMenuItem: menuItemStub }));

// The component builds its leading icon at module scope, so React has to be global before the
// module is evaluated. Vitest transforms JSX with the classic runtime.
vi.stubGlobal("React", React);
const { OpenInFileManagerMenuItem } = await import("@/workspace/open-in-file-manager/menu-item");

const TEST_ID = "open-folder";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

async function renderMenuItem(serverId: string | null, path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <OpenInFileManagerMenuItem serverId={serverId} path={path} testID={TEST_ID} />
      </QueryClientProvider>,
    );
  });
  // Two chained queries: resolving the local-daemon identity is what enables the desktop
  // target query, so the render settles over several ticks.
  for (let tick = 0; tick < 10; tick += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container.querySelector<HTMLButtonElement>(`[data-testid="${TEST_ID}"]`);
}

it("offers the action for a workspace owned by the local daemon", async () => {
  const item = await renderMenuItem(LOCAL_SERVER_ID, "/Users/dev/project");

  expect(item).not.toBeNull();

  await act(async () => {
    item?.click();
  });

  expect(openTargetMock).toHaveBeenCalledWith({
    editorId: fileManagerTarget.id,
    workspacePath: "/Users/dev/project",
  });
});

it("hides the action for a workspace owned by a paired remote host", async () => {
  const item = await renderMenuItem(REMOTE_SERVER_ID, "/home/user/project");

  expect(item).toBeNull();
  expect(openTargetMock).not.toHaveBeenCalled();
});

it("hides the action when the owning host is unknown", async () => {
  const item = await renderMenuItem(null, "/home/user/project");

  expect(item).toBeNull();
});
