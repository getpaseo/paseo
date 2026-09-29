import React, { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  PluginResponseActionContext,
  PluginResponseActionContribution,
} from "@getpaseo/plugin/client";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import type { ToastApi } from "@/components/toast-host";
import { ResponseActionMenu } from "./response-action-menu";

// Same real-browser surface as the existing composer/menu tests. No module mocks.
beforeEach(() => {
  Object.assign(globalThis, { React });
});
const errors: string[] = [];
const toast: ToastApi = {
  show() {},
  copied() {},
  error(message) {
    errors.push(message);
  },
};
const mounts: Array<{ root: Root; container: HTMLDivElement }> = [];
function mount(node: ReactNode) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (content: ReactNode) =>
    act(() => root.render(<ToastApiProvider api={toast}>{content}</ToastApiProvider>));
  render(node);
  mounts.push({ root, container });
  return render;
}
afterEach(() => {
  errors.length = 0;
  for (const { root, container } of mounts.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const action: PluginResponseActionContribution = {
  id: "speak",
  title: "Read response aloud",
  icon: "Volume2",
  activity: ({ speech, agentId, responseId }) => {
    if (speech.key !== `${agentId}/${responseId}` || speech.status === "idle") return null;
    return speech.status === "preparing"
      ? { status: "loading", label: "Preparing…" }
      : { status: "active", label: "Speaking" };
  },
  items: (context) => [
    ...(["summary", "full"] as const).map((mode) => ({
      id: mode,
      title: mode === "summary" ? "Speak summary" : "Speak full response",
      onSelect: ({ speech, agentId, responseId, getContent }: PluginResponseActionContext) =>
        speech.speak({ agentId, key: `${agentId}/${responseId}`, text: getContent(), mode }),
    })),
    ...(context.speech.status !== "idle"
      ? [
          {
            id: "stop",
            title: "Stop",
            onSelect: ({ speech }: PluginResponseActionContext) => speech.stop(),
          },
        ]
      : []),
  ],
};
function menu(context: PluginResponseActionContext) {
  return <ResponseActionMenu action={action} context={context} />;
}

function fixture() {
  const requests: unknown[] = [];
  const context: PluginResponseActionContext = {
    agentId: "agent",
    responseId: "older-reply",
    getContent: () => "The older selected response, with all its text.",
    speech: {
      status: "idle",
      key: null,
      error: null,
      speak: async (input) => {
        requests.push(input);
      },
      stop: () => {},
    },
  };
  return { context, requests };
}

it.each(["summary", "full"] as const)(
  "selects %s for the clicked historical response and dismisses the menu",
  async (mode) => {
    const { context, requests } = fixture();
    mount(menu(context));
    const trigger = page.getByRole("button", { name: "Read response aloud", exact: true });
    await trigger.click();
    await page
      .getByText(mode === "summary" ? "Speak summary" : "Speak full response", { exact: true })
      .click();
    expect(requests).toEqual([
      { agentId: "agent", key: "agent/older-reply", text: context.getContent(), mode },
    ]);
    expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
  },
);

it("shows loading/speaking only on the active response and keeps Stop accessible", async () => {
  const { context } = fixture();
  let stopped = 0;
  const speech = {
    ...context.speech,
    status: "preparing" as const,
    key: "agent/older-reply",
    stop: () => {
      stopped++;
    },
  };
  const loading = { ...context, speech };
  const other = { ...context, responseId: "other", speech };
  const render = mount(
    <>
      {menu(loading)}
      {menu(other)}
    </>,
  );
  const preparing = page.getByRole("button", { name: "Read response aloud: Preparing…" });
  expect(preparing.element().getAttribute("aria-busy")).toBe("true");
  expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
  expect(
    page.getByRole("button", { name: "Read response aloud", exact: true }).elements(),
  ).toHaveLength(1);
  await preparing.click();
  await page.getByText("Stop", { exact: true }).click();
  expect(stopped).toBe(1);

  const speaking = { ...context, speech: { ...speech, status: "speaking" as const } };
  render(menu(speaking));
  await page.getByRole("button", { name: "Read response aloud: Speaking" }).click();
  expect(document.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
  await page.getByText("Stop", { exact: true }).click();
  expect(stopped).toBe(2);
  render(menu(context));
  expect(
    page.getByRole("button", { name: "Read response aloud", exact: true }).elements(),
  ).toHaveLength(1);
  expect(document.body.textContent).not.toContain("Speaking");
});

it("reports callback failures to the host toast API", async () => {
  const { context } = fixture();
  const failed = {
    ...context,
    speech: {
      ...context.speech,
      speak: async () => {
        throw new Error("Speech unavailable");
      },
    },
  };
  mount(menu(failed));
  await page.getByRole("button", { name: "Read response aloud" }).click();
  await page.getByText("Speak summary", { exact: true }).click();
  await expect.poll(() => errors).toEqual(["Speech unavailable"]);
});
