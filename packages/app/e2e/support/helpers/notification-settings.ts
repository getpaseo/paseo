import { expect, type Page } from "@playwright/test";
import { openSettingsSection } from "./settings";

export interface RecordedBrowserNotification {
  title: string;
  body: string | null;
  data: Record<string, unknown> | null;
}

type NotificationSwitchName =
  | "Enable notifications"
  | "Agent needs permission"
  | "Agent errored"
  | "Agent finished"
  | "Terminal needs input"
  | "Terminal finished"
  | "Plugin notifications";

export async function installBrowserNotificationRecorder(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const recorded: RecordedBrowserNotification[] = [];
    const instances: Array<{ triggerClick: () => void }> = [];
    const win = window as unknown as {
      __paseoRecordedNotifications?: RecordedBrowserNotification[];
      __paseoNotificationInstances?: Array<{ triggerClick: () => void }>;
    };
    win.__paseoRecordedNotifications = recorded;
    win.__paseoNotificationInstances = instances;

    class StubBrowserNotification {
      static permission: NotificationPermission = "granted";
      static async requestPermission(): Promise<NotificationPermission> {
        return "granted";
      }

      title: string;
      body: string | null;
      data: Record<string, unknown> | null;
      private readonly clickListeners: Array<() => void> = [];

      constructor(
        title: string,
        options?: { body?: string; data?: Record<string, unknown>; icon?: string },
      ) {
        this.title = title;
        this.body = options?.body ?? null;
        this.data = options?.data ?? null;
        recorded.push({
          title: this.title,
          body: this.body,
          data: this.data,
        });
        instances.push({
          triggerClick: () => {
            for (const listener of this.clickListeners) {
              listener();
            }
          },
        });
      }

      addEventListener(type: string, listener: () => void): void {
        if (type === "click" && typeof listener === "function") {
          this.clickListeners.push(listener);
        }
      }
      close(): void {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: StubBrowserNotification,
    });
  });
}

export async function readRecordedBrowserNotifications(
  page: Page,
): Promise<RecordedBrowserNotification[]> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __paseoRecordedNotifications?: RecordedBrowserNotification[];
    };
    return [...(win.__paseoRecordedNotifications ?? [])];
  });
}

export async function clearRecordedBrowserNotifications(page: Page): Promise<void> {
  await page.evaluate(() => {
    const win = window as unknown as {
      __paseoRecordedNotifications?: RecordedBrowserNotification[];
      __paseoNotificationInstances?: Array<{ triggerClick: () => void }>;
    };
    if (win.__paseoRecordedNotifications) {
      win.__paseoRecordedNotifications.length = 0;
    }
    if (win.__paseoNotificationInstances) {
      win.__paseoNotificationInstances.length = 0;
    }
  });
}

export async function clickRecordedBrowserNotification(page: Page, index = 0): Promise<void> {
  await page.evaluate((targetIndex) => {
    const win = window as unknown as {
      __paseoNotificationInstances?: Array<{ triggerClick: () => void }>;
    };
    const instance = win.__paseoNotificationInstances?.[targetIndex];
    if (!instance) {
      throw new Error(`No recorded browser notification at index ${targetIndex}`);
    }
    instance.triggerClick();
  }, index);
}

export async function expectRecordedPluginNotifications(
  page: Page,
  expected: ReadonlyArray<{
    pluginId: string;
    title: string;
    body: string;
    notificationId?: string;
  }>,
): Promise<void> {
  await expect
    .poll(async () => (await readRecordedBrowserNotifications(page)).length)
    .toBe(expected.length);

  const notifications = await readRecordedBrowserNotifications(page);
  const includeId = expected.some((item) => item.notificationId !== undefined);
  expect(
    notifications.map((entry) =>
      includeId
        ? {
            pluginId: entry.data?.pluginId,
            title: entry.title,
            body: entry.body,
            notificationId: entry.data?.notificationId,
          }
        : {
            pluginId: entry.data?.pluginId,
            title: entry.title,
            body: entry.body,
          },
    ),
  ).toEqual(expected);
}

export async function setPluginNotificationSwitch(
  page: Page,
  pluginLabel: string,
  checked: boolean,
): Promise<void> {
  const toggle = page.getByRole("switch", { name: pluginLabel, exact: true });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", String(!checked));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(checked));
}

export async function expectRecordedAgentNotifications(
  page: Page,
  expected: ReadonlyArray<{ agentId: string; reason: string }>,
): Promise<void> {
  await expect
    .poll(async () => (await readRecordedBrowserNotifications(page)).length)
    .toBe(expected.length);

  const notifications = await readRecordedBrowserNotifications(page);
  expect(
    notifications.map((entry) => ({
      agentId: entry.data?.agentId,
      reason: entry.data?.reason,
    })),
  ).toEqual(expected);
}

export async function openNotificationSettings(page: Page): Promise<void> {
  await openSettingsSection(page, "notifications");
  await expect(
    page.getByRole("switch", { name: "Enable notifications", exact: true }),
  ).toBeVisible();
}

export function notificationSwitch(page: Page, name: NotificationSwitchName) {
  return page.getByRole("switch", { name, exact: true });
}

export async function expectNotificationSwitchState(
  page: Page,
  name: NotificationSwitchName,
  expected: { checked: boolean; disabled?: boolean },
): Promise<void> {
  const toggle = notificationSwitch(page, name);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-checked", String(expected.checked));
  if (expected.disabled) {
    await expect(toggle).toBeDisabled();
  } else {
    await expect(toggle).toBeEnabled();
  }
}

export async function expectDefaultNotificationSettings(page: Page): Promise<void> {
  await expectNotificationSwitchState(page, "Enable notifications", {
    checked: true,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Agent needs permission", {
    checked: true,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Agent errored", {
    checked: true,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Agent finished", {
    checked: false,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Terminal needs input", {
    checked: true,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Terminal finished", {
    checked: false,
    disabled: false,
  });
  await expectNotificationSwitchState(page, "Plugin notifications", {
    checked: true,
    disabled: false,
  });
}

export async function setNotificationSwitch(
  page: Page,
  name: NotificationSwitchName,
  checked: boolean,
): Promise<void> {
  const toggle = notificationSwitch(page, name);
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute("aria-checked", String(!checked));
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", String(checked));
}

export async function expectNotificationSubControlsDisabled(
  page: Page,
  disabled: boolean,
): Promise<void> {
  const subSwitches: NotificationSwitchName[] = [
    "Agent needs permission",
    "Agent errored",
    "Agent finished",
    "Terminal needs input",
    "Terminal finished",
    "Plugin notifications",
  ];
  for (const name of subSwitches) {
    const toggle = notificationSwitch(page, name);
    if (disabled) {
      await expect(toggle).toBeDisabled();
    } else {
      await expect(toggle).toBeEnabled();
    }
  }
}
