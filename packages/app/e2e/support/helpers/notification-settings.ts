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
    (
      window as unknown as {
        __paseoRecordedNotifications?: RecordedBrowserNotification[];
      }
    ).__paseoRecordedNotifications = recorded;

    class StubBrowserNotification {
      static permission: NotificationPermission = "granted";
      static async requestPermission(): Promise<NotificationPermission> {
        return "granted";
      }

      title: string;
      body: string | null;
      data: Record<string, unknown> | null;

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
      }

      addEventListener(): void {}
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
    };
    if (win.__paseoRecordedNotifications) {
      win.__paseoRecordedNotifications.length = 0;
    }
  });
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
