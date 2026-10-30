/** @vitest-environment jsdom */
import React, { useCallback, useEffect, useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { PluginTranslationRuntime } from "@getpaseo/plugin/client/host";
import { usePaseo, useRpc, type PluginFloatingWidgetProps } from "@getpaseo/plugin/client";
import type { PaseoApi } from "@getpaseo/client";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { i18n } from "@/i18n/i18next";
import { useBlockMobilePanelOpenGestures } from "@/mobile-panels/provider";
import type { InstalledPlugin } from "../types";
import { FloatingWidgetView, type FloatingWidgetViewProps } from "./widget";
import type { EvaluatedFloatingWidget } from "./model";

vi.mock("@/mobile-panels/provider", () => ({
  useBlockMobilePanelOpenGestures: vi.fn(),
}));

vi.mock("react-native-unistyles", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-native-unistyles")>();
  return {
    ...original,
    withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) =>
      function Themed({ uniProps, ...props }: { uniProps?: (theme: unknown) => object }) {
        return React.createElement(Component, {
          ...props,
          ...uniProps?.(original.useUnistyles().theme),
        });
      },
  };
});

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("en");
});

const renamedHost = { id: "host-a", label: "Renamed host" };
const keyboardBounds = { x: 8, y: 52, width: 304, height: 100 };

const status = defineRpc({
  name: "widget.status",
  input: z.object({}),
  output: z.object({ ok: z.boolean() }),
});

function fixture(Content: React.ComponentType<PluginFloatingWidgetProps>): FloatingWidgetViewProps {
  const widget: EvaluatedFloatingWidget = {
    contribution: {
      id: "widget",
      title: "Test widget",
      Component: Content,
      size: { width: 160, height: 160 },
    },
    visible: true,
    revealRevision: 0,
    show() {
      widget.visible = true;
      widget.revealRevision += 1;
    },
    hide() {
      widget.visible = false;
    },
  };
  const plugin: InstalledPlugin = {
    id: "widget-fixture",
    serverId: "host-a",
    lifetime: new AbortController(),
    clientBundle: "",
    locale: "en",
    i18n: new PluginTranslationRuntime({ getLocale: () => "en", subscribe: () => () => {} }),
    paseo: { dispose: async () => {} } as PaseoApi,
    invoke: vi.fn(async () => ({ ok: true })),
    queryClient: new QueryClient(),
    cleanup() {},
    surfaces: [],
    settingsScreens: [],
    sidebarItems: { header: [], footer: [] },
    legacySidebarItems: [],
    filePanels: [],
    workspacePanels: [],
    commandCenterItems: [],
    clientSlashCommands: [],
    attachmentSources: [],
    themes: [],
    providerIconOverrides: [],
    workspaceStatusRenderers: [],
    floatingWidgets: [widget],
    timelineTransformers: [],
    timelineRenderers: [],
  };
  return {
    target: { plugin, widget },
    host: { id: "host-a", label: "My computer" },
    layout: { compact: false, platform: "web" },
    bounds: { x: 8, y: 52, width: 374, height: 750 },
  };
}

it("provides installation hooks and props while keeping plugin taps separate from host movement", async () => {
  let mounted = 0;
  let unmounted = 0;
  let receivedPaseo: PaseoApi | null = null;
  let invoke: (() => Promise<{ ok: boolean }>) | null = null;
  function Widget(props: PluginFloatingWidgetProps) {
    receivedPaseo = usePaseo();
    const rpc = useRpc(status);
    invoke = () => rpc({});
    const [taps, setTaps] = useState(0);
    const tap = useCallback(() => setTaps((value) => value + 1), []);
    useEffect(() => {
      mounted += 1;
      return () => {
        unmounted += 1;
      };
    }, []);
    return (
      <button
        type="button"
        onClick={tap}
      >{`${props.host.id}:${props.layout.platform}:${props.size.width}:${props.theme.colors.foreground}:${taps}`}</button>
    );
  }
  const props = fixture(Widget);
  const view = render(<FloatingWidgetView {...props} />);
  fireEvent.click(screen.getByText("host-a:web:160:#111111:0"));
  expect(screen.getByText("host-a:web:160:#111111:1").textContent).toBe("host-a:web:160:#111111:1");
  expect(receivedPaseo).toBe(props.target.plugin.paseo);
  await expect(invoke!()).resolves.toEqual({ ok: true });
  expect(props.target.plugin.invoke).toHaveBeenCalledWith("widget.status", {});

  fireEvent.click(screen.getByRole("button", { name: "Move Test widget to next corner" }));
  const frame = screen.getByTestId("plugin-floating-widget:widget-fixture:widget");
  expect(frame.style.left).toBe("8px");
  expect(frame.style.top).toBe("52px");
  view.rerender(<FloatingWidgetView {...props} host={renamedHost} />);
  expect(mounted).toBe(1);
  expect(unmounted).toBe(0);

  fireEvent.click(screen.getByRole("button", { name: "Collapse Test widget" }));
  expect(screen.queryByText("host-a:web:160:#111111:1")).toBeNull();
  expect(screen.getByRole("button", { name: "Expand Test widget" })).not.toBeNull();
  props.target.widget.show();
  view.rerender(<FloatingWidgetView {...props} />);
  expect(screen.getByText("host-a:web:160:#111111:0")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide Test widget" }));
  view.rerender(<FloatingWidgetView {...props} />);
  expect(screen.queryByTestId("plugin-floating-widget:widget-fixture:widget")).toBeNull();
  props.target.widget.show();
  view.rerender(<FloatingWidgetView {...props} />);
  expect(screen.getByText("host-a:web:160:#111111:0")).not.toBeNull();
});

it("shrinks content to the keyboard-safe viewport and keeps a failed widget closable", () => {
  function Widget({ size }: PluginFloatingWidgetProps) {
    return <span>{`${size.width}x${size.height}`}</span>;
  }
  const props = fixture(Widget);
  const view = render(<FloatingWidgetView {...props} bounds={keyboardBounds} />);
  expect(screen.getByText("160x60")).not.toBeNull();
  expect(screen.getByTestId("plugin-floating-widget:widget-fixture:widget").style.top).toBe("52px");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  props.target.widget.contribution.Component = () => {
    throw new Error("widget unavailable");
  };
  view.rerender(<FloatingWidgetView {...props} />);
  expect(screen.getByText("Plugin failed: widget unavailable")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Hide Test widget" }));
  expect(props.target.widget.visible).toBe(false);
  warn.mockRestore();
  error.mockRestore();
});

it("blocks sidebar opening while dragging and releases the blocker after the pointer ends", () => {
  const props = fixture(() => null);
  render(<FloatingWidgetView {...props} />);
  const handle = screen.getByRole("button", { name: "Move Test widget to next corner" });
  fireEvent.mouseDown(handle, { clientX: 190, clientY: 100, buttons: 1 });
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(true);
  fireEvent.mouseMove(handle, { clientX: 220, clientY: 110, buttons: 1 });
  fireEvent.mouseUp(handle, { clientX: 220, clientY: 110, buttons: 0 });
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(false);
});

it("renders content-only widgets at their full size, with command movement and hide-on-collapse", () => {
  let collapse: (() => void) | undefined;
  function Widget(props: PluginFloatingWidgetProps) {
    collapse = props.collapse;
    return <span>{`${props.size.width}x${props.size.height}`}</span>;
  }
  const props = fixture(Widget);
  props.target.widget.contribution.chrome = "none";
  const view = render(<FloatingWidgetView {...props} bounds={keyboardBounds} />);
  const frame = screen.getByTestId("plugin-floating-widget:widget-fixture:widget");
  expect(screen.getByText("160x100")).not.toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
  expect(frame.style.width).toBe("160px");
  view.rerender(<FloatingWidgetView {...props} bounds={keyboardBounds} moveRevision={1} />);
  expect(frame.style.left).toBe("8px");
  expect(frame.style.top).toBe("52px");
  collapse!();
  expect(props.target.widget.visible).toBe(false);
  view.rerender(<FloatingWidgetView {...props} />);
  expect(screen.queryByTestId("plugin-floating-widget:widget-fixture:widget")).toBeNull();
});

it("releases native panel blocking when a content drag is cancelled or its widget is hidden", () => {
  function Widget({ DragHandle }: PluginFloatingWidgetProps) {
    return (
      <DragHandle accessibilityLabel="Widget body">
        <span>Widget</span>
      </DragHandle>
    );
  }
  const props = fixture(Widget);
  props.target.widget.contribution.chrome = "none";
  const view = render(<FloatingWidgetView {...props} />);
  const body = screen.getByRole("button", { name: "Widget body" });
  const touch = { identifier: 1, pageX: 100, pageY: 100, clientX: 100, clientY: 100, target: body };
  fireEvent.touchStart(body, { touches: [touch], changedTouches: [touch] });
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(true);
  fireEvent.touchCancel(body, { touches: [], changedTouches: [touch] });
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(false);
  fireEvent.touchStart(body, { touches: [touch], changedTouches: [touch] });
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(true);
  props.target.widget.hide();
  view.rerender(<FloatingWidgetView {...props} />);
  expect(useBlockMobilePanelOpenGestures).toHaveBeenLastCalledWith(false);
});

it("keeps toolbar drag coordinates after the trailing click and moves only once for a pointer tap", () => {
  const props = fixture(() => null);
  render(<FloatingWidgetView {...props} />);
  const handle = screen.getByRole("button", { name: "Move Test widget to next corner" });
  const frame = screen.getByTestId("plugin-floating-widget:widget-fixture:widget");
  const pointer = (type: "mouseDown" | "mouseMove" | "mouseUp", x: number, y: number) => {
    const event = createEvent[type](handle, {
      clientX: x,
      clientY: y,
      buttons: type === "mouseUp" ? 0 : 1,
    });
    Object.defineProperties(event, { pageX: { value: x }, pageY: { value: y } });
    fireEvent(handle, event);
  };
  pointer("mouseDown", 190, 620);
  pointer("mouseMove", 150, 590);
  pointer("mouseUp", 150, 590);
  fireEvent.click(handle, { detail: 1 });
  expect(frame.style.left).toBe("134px");
  expect(frame.style.top).toBe("572px");
  pointer("mouseDown", 150, 590);
  pointer("mouseUp", 150, 590);
  fireEvent.click(handle, { detail: 1 });
  expect(frame.style.left).toBe("8px");
  expect(frame.style.top).toBe("52px");
  fireEvent.click(handle, { detail: 0 });
  expect(frame.style.left).toBe("174px");
  expect(frame.style.top).toBe("52px");
});
