import { expect, it } from "vitest";
import { registerSmallWidgetClock, unregisterSmallWidgetClock } from "./small-widget-clock";
import { FakeSmallWidgetClock } from "./small-widget-clock.fake";

function subscribe(clock: FakeSmallWidgetClock, id: number) {
  const time = { value: 0 };
  const registered = { value: false };
  registerSmallWidgetClock(clock, time, registered, id);
  return { time, registered };
}

it("publishes only 30 widget updates during one second on a 120 Hz display", () => {
  const clock = new FakeSmallWidgetClock();
  const widget = subscribe(clock, 1);
  let previous = widget.time.value;
  let updates = 0;
  for (let frame = 1; frame <= 120; frame++) {
    clock.frame(1000 + Math.round((frame * 1000) / 120));
    if (widget.time.value !== previous) updates++;
    previous = widget.time.value;
  }
  expect(updates).toBe(30);
  expect(widget.time.value).toBe(2000);
});

it("synchronizes widgets, including one mounted between ticks, with one frame callback", () => {
  const clock = new FakeSmallWidgetClock();
  const first = subscribe(clock, 1);
  const second = subscribe(clock, 2);
  clock.frame(1010);
  expect(first.time.value).toBe(1000);
  clock.frame(1034);
  expect(first.time.value).toBeCloseTo(1033.333333);
  clock.setTime(1040);
  const late = subscribe(clock, 3);
  expect([second.time.value, late.time.value]).toEqual([first.time.value, first.time.value]);
  expect(clock.pendingFrames).toBe(1);
});

it("freezes an unsubscribed widget while another remains active and rejoins on resume", () => {
  const clock = new FakeSmallWidgetClock();
  const first = subscribe(clock, 1);
  const second = subscribe(clock, 2);
  unregisterSmallWidgetClock(clock, first.registered, 1);
  clock.frame(1100);
  expect(first.time.value).toBe(1000);
  expect(second.time.value).toBe(1100);
  registerSmallWidgetClock(clock, first.time, first.registered, 1);
  expect(first.time.value).toBe(1100);
  expect(clock.pendingFrames).toBe(1);
});

it("stops after the last subscriber leaves and catches up when restarted", () => {
  const clock = new FakeSmallWidgetClock();
  const widget = subscribe(clock, 1);
  unregisterSmallWidgetClock(clock, widget.registered, 1);
  clock.frame(2000);
  expect(widget.time.value).toBe(1000);
  expect(clock.pendingFrames).toBe(0);
  clock.setTime(3000);
  registerSmallWidgetClock(clock, widget.time, widget.registered, 1);
  expect(widget.time.value).toBe(3000);
  expect(clock.pendingFrames).toBe(1);
});

it("keeps one frame callback when the final subscriber leaves and immediately returns", () => {
  const clock = new FakeSmallWidgetClock();
  const widget = subscribe(clock, 1);
  unregisterSmallWidgetClock(clock, widget.registered, 1);
  unregisterSmallWidgetClock(clock, widget.registered, 1);
  registerSmallWidgetClock(clock, widget.time, widget.registered, 1);
  registerSmallWidgetClock(clock, widget.time, widget.registered, 1);
  clock.frame(1100);
  expect(widget.time.value).toBe(1100);
  expect(clock.pendingFrames).toBe(1);
  unregisterSmallWidgetClock(clock, widget.registered, 1);
  clock.frame(1200);
  expect(clock.pendingFrames).toBe(0);
});
