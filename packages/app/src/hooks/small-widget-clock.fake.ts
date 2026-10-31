import type { SmallWidgetClockPort } from "./small-widget-clock";

class FakeClockValue {
  private current = 1000;
  private listeners = new Map<number, (time: number) => void>();

  get value(): number {
    return this.current;
  }
  set value(next: number) {
    if (next === this.current) return;
    this.current = next;
    this.listeners.forEach((listener) => listener(next));
  }
  addListener(id: number, listener: (time: number) => void): void {
    this.listeners.set(id, listener);
  }
  removeListener(id: number): void {
    this.listeners.delete(id);
  }
}

export class FakeSmallWidgetClock implements SmallWidgetClockPort {
  private nowMs = 1000;
  private frames: Array<() => void> = [];
  readonly consumerCount = { value: 0 };
  readonly running = { value: false };
  readonly time = new FakeClockValue();

  now(): number {
    return this.nowMs;
  }
  requestFrame(callback: () => void): void {
    this.frames.push(callback);
  }
  get pendingFrames(): number {
    return this.frames.length;
  }
  setTime(nowMs: number): void {
    this.nowMs = nowMs;
  }
  frame(nowMs: number): void {
    this.setTime(nowMs);
    const pending = this.frames;
    this.frames = [];
    pending.forEach((callback) => callback());
  }
}
