import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { ToastApi, ToastShowOptions } from "@/components/toast-host";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import { REMOTE_HOST_SETUP_TOAST_MS, startRemoteHostEditorSetup } from "./setup";

interface ShownToast {
  content: unknown;
  options: ToastShowOptions | undefined;
}

function createToast(): { api: Pick<ToastApi, "show">; shown: ShownToast[] } {
  const shown: ShownToast[] = [];
  return {
    api: {
      show: (content, options) => {
        shown.push({ content, options });
      },
    },
    shown,
  };
}

const t = ((key: string, values?: Record<string, unknown>) =>
  `${key}:${JSON.stringify(values ?? {})}`) as unknown as TFunction;

describe("startRemoteHostEditorSetup", () => {
  it("navigates first, then names the host and the setting", () => {
    const { api, shown } = createToast();
    const order: string[] = [];

    startRemoteHostEditorSetup({
      serverId: "srv-1",
      hostLabel: "build-box",
      toast: {
        show: (content, options) => {
          order.push("toast");
          api.show(content, options);
        },
      },
      t,
      navigate: (serverId) => order.push(`navigate:${serverId}`),
    });

    expect(order).toEqual(["navigate:srv-1", "toast"]);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.content).toBe('workspace.git.openInEditor.setUpToast:{"host":"build-box"}');
  });

  it("reads as information rather than a failure", () => {
    const { api, shown } = createToast();

    startRemoteHostEditorSetup({
      serverId: "srv-1",
      hostLabel: "build-box",
      toast: api,
      t,
      navigate: () => undefined,
    });

    expect(shown[0]?.options?.variant).toBe("info");
  });

  it("stays up long enough to act on, and still dismisses itself", () => {
    const { api, shown } = createToast();

    startRemoteHostEditorSetup({
      serverId: "srv-1",
      hostLabel: "build-box",
      toast: api,
      t,
      navigate: () => undefined,
    });

    // `durationMs: null` schedules no timer and the toast has no dismiss control, so a
    // pinned toast would never go away. It also has to outlast the 2200ms default.
    expect(shown[0]?.options?.durationMs).toBe(REMOTE_HOST_SETUP_TOAST_MS);
    expect(REMOTE_HOST_SETUP_TOAST_MS).toBeGreaterThan(2200);
    expect(Number.isFinite(REMOTE_HOST_SETUP_TOAST_MS)).toBe(true);
  });

  it("names whatever label the caller resolved for the host", () => {
    const { api, shown } = createToast();

    startRemoteHostEditorSetup({
      serverId: "srv-1",
      hostLabel: "srv-1",
      toast: api,
      t,
      navigate: () => undefined,
    });

    expect(shown[0]?.content).toBe('workspace.git.openInEditor.setUpToast:{"host":"srv-1"}');
  });
});

describe("the route the setup entry lands on", () => {
  it("is the host section that owns the Open in editor settings, not the settings root", () => {
    // openHostOverview pushes this route; the setting lives on the "host" section page.
    expect(buildSettingsHostSectionRoute("srv-1", "host")).toBe("/settings/hosts/srv-1/host");
  });
});
