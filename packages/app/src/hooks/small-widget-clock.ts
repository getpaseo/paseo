export interface ClockValue<T> {
  value: T;
}

export interface SmallWidgetClockPort {
  time: ClockValue<number> & {
    addListener(id: number, listener: (time: number) => void): void;
    removeListener(id: number): void;
  };
  consumerCount: ClockValue<number>;
  running: ClockValue<boolean>;
  now(): number;
  requestFrame(callback: () => void): void;
}

export function smallWidgetClockTime(nowMs: number): number {
  "worklet";
  return (Math.floor((nowMs * 30) / 1000) * 1000) / 30;
}

function advanceClock(port: SmallWidgetClockPort): void {
  "worklet";
  if (port.consumerCount.value === 0) {
    port.running.value = false;
    return;
  }

  // Publish on the same 30 Hz boundaries for rings, dots and shimmer sweeps.
  // RAF still follows the display refresh rate; unchanged ticks do no style work.
  const time = smallWidgetClockTime(port.now());
  if (port.time.value !== time) port.time.value = time;
  port.requestFrame(() => advanceClock(port));
}

export function registerSmallWidgetClock(
  port: SmallWidgetClockPort,
  time: ClockValue<number>,
  registered: ClockValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (registered.value) return;

  if (!port.running.value) {
    port.time.value = smallWidgetClockTime(port.now());
    port.running.value = true;
    port.requestFrame(() => advanceClock(port));
  }
  registered.value = true;
  time.value = port.time.value;
  port.time.addListener(listenerId, (value) => {
    time.value = value;
  });
  port.consumerCount.value += 1;
}

export function unregisterSmallWidgetClock(
  port: SmallWidgetClockPort,
  registered: ClockValue<boolean>,
  listenerId: number,
): void {
  "worklet";
  if (!registered.value) return;
  registered.value = false;
  port.time.removeListener(listenerId);
  port.consumerCount.value -= 1;
}
