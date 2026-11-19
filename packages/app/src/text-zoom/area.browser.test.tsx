import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text } from "react-native";
import { afterEach, beforeEach, expect, it } from "vitest";
import { TextZoomArea } from "./area";
import { enablePinchTextZoom, getTextZoom, getTextZoomPinch, resetTextZoomForTests } from "./store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  resetTextZoomForTests();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetTextZoomForTests();
});

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function wheel(target: Element, deltaY: number, ctrlKey = true): WheelEvent {
  const event = new WheelEvent("wheel", { deltaY, ctrlKey, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

it("zooms live on a trackpad pinch, only its own surface, and ends after the wheel settles", async () => {
  enablePinchTextZoom("terminal");
  enablePinchTextZoom("chat");
  act(() =>
    root.render(
      <>
        <TextZoomArea surface="terminal">
          <Text testID="terminal-content">terminal</Text>
        </TextZoomArea>
        <TextZoomArea surface="chat">
          <Text testID="chat-content">chat</Text>
        </TextZoomArea>
      </>,
    ),
  );
  const terminal = host.querySelector('[data-testid="terminal-content"]')!;

  const first = wheel(terminal, -10);
  expect(first.defaultPrevented).toBe(true);
  expect(getTextZoomPinch()?.surface).toBe("terminal");
  await act(nextFrame);
  expect(getTextZoom("terminal")).toBe(1.1);

  wheel(terminal, -10);
  await act(nextFrame);
  expect(getTextZoom("terminal")).toBe(1.2);
  expect(host.textContent).toContain("120%");
  expect(getTextZoom("chat")).toBe(1);

  await act(() => wait(200));
  expect(getTextZoomPinch()).toBeNull();
  expect(host.textContent).not.toContain("%");
});

it("leaves a plain wheel to scrolling", () => {
  enablePinchTextZoom("chat");
  act(() =>
    root.render(
      <TextZoomArea surface="chat">
        <Text testID="chat-content">chat</Text>
      </TextZoomArea>,
    ),
  );
  const event = wheel(host.querySelector('[data-testid="chat-content"]')!, 40, false);
  expect(event.defaultPrevented).toBe(false);
  expect(getTextZoomPinch()).toBeNull();
});
