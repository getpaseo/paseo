import type { Page } from "@playwright/test";

// Poses as the desktop app running the e2e daemon as its own managed daemon, so
// `useIsLocalDaemon` reports the host as this machine. `directory` is where the
// desktop bridge claims dropped files live on disk.
export async function installLocalDesktopHost(
  page: Page,
  directory: string,
  // `fileManager` adds the editor bridge: a file manager of that name, and the default-app opener.
  { fileManager = null }: { fileManager?: string | null } = {},
): Promise<void> {
  const serverId = process.env.E2E_SERVER_ID;
  if (!serverId) {
    throw new Error("E2E_SERVER_ID is not set");
  }
  await page.addInitScript(
    (localHost: { serverId: string; directory: string; fileManager: string | null }) => {
      const editor = localHost.fileManager
        ? {
            listTargets: async () => [
              {
                id: "file-manager",
                label: localHost.fileManager,
                kind: "file-manager",
                icon: { kind: "symbol", name: "folder" },
              },
            ],
            openTarget: async () => undefined,
            openDefaultApp: async () => undefined,
          }
        : undefined;
      (window as unknown as { paseoDesktop: unknown }).paseoDesktop = {
        platform: "linux",
        editor,
        invoke: async (command: string) => {
          if (command === "desktop_daemon_status") {
            return {
              serverId: localHost.serverId,
              status: "running",
              listen: null,
              hostname: null,
              pid: null,
              home: "",
              version: null,
              desktopManaged: true,
              error: null,
            };
          }
          return null;
        },
        getPendingOpenProject: async () => null,
        events: { on: async () => () => undefined },
        webUtils: { getPathForFile: (file: File) => `${localHost.directory}/${file.name}` },
      };
    },
    { serverId, directory, fileManager },
  );
}
