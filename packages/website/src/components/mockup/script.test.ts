import { describe, expect, it } from "vitest";
import { script } from "./script";

const REQUEST = "Rename the panel.";
const REPLY = "Renamed. The panel is now called Radar.";

const scene = script([
  { kind: "wait", ms: 500 },
  { kind: "type", text: REQUEST },
  { kind: "user", text: REQUEST },
  {
    kind: "tools",
    calls: [
      { kind: "read", detail: "panel.tsx" },
      { kind: "write", detail: "panel.tsx" },
    ],
  },
  { kind: "mark", name: "renamed", ms: 400 },
  { kind: "agent", text: REPLY },
  { kind: "turnEnd", worked: "8s" },
]);

const [sent, tools, reply, turnEnd] = scene.entries;

function midway(entry: { start: number; end: number }): number {
  return (entry.start + entry.end) / 2;
}

const POINTER_ENTERS = 200;
const PAUSE_BEFORE_TYPING = 100;

const pointed = script([
  { kind: "wait", ms: POINTER_ENTERS },
  { kind: "click", target: "composer" },
  { kind: "wait", ms: PAUSE_BEFORE_TYPING },
  { kind: "type", text: REQUEST },
  { kind: "user", text: REQUEST },
  { kind: "click", target: "pill" },
  { kind: "click", target: "menu" },
]);
const composerClick = pointed.click("composer");
const pillClick = pointed.click("pill");
const menuClick = pointed.click("menu");

/** The first millisecond of the pointed scene at which something is true. */
function firstMs(holds: (ms: number) => boolean): number {
  for (let ms = 0; ms <= pointed.duration; ms += 1) {
    if (holds(ms)) return ms;
  }
  throw new Error("It never holds");
}

describe("script", () => {
  it("starts with an empty composer, an empty transcript, and no turn running", () => {
    expect(scene.draft(0)).toBe("");
    expect(scene.entered(0)).toBe(0);
    expect(scene.busy(0)).toBe(false);
  });

  it("types the request into the composer, then clears it when the message is sent", () => {
    const typing = { start: 500, end: sent.start };
    const partial = scene.draft(typing.start + 200);
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(REQUEST.length);
    expect(REQUEST.startsWith(partial)).toBe(true);

    expect(scene.draft(typing.end - 1)).toBe(REQUEST);
    expect(scene.draft(sent.start)).toBe("");
    expect(scene.entered(midway(sent))).toBe(1);
  });

  it("runs the turn from the sent message until the turn ends", () => {
    expect(scene.busy(sent.start - 1)).toBe(false);
    expect(scene.busy(sent.start)).toBe(true);
    expect(scene.busy(midway(reply))).toBe(true);
    expect(scene.busy(turnEnd.start)).toBe(false);
  });

  it("lands tool calls one at a time", () => {
    expect(scene.landed(tools, tools.start)).toBe(0);
    expect(scene.landed(tools, tools.start + 1)).toBe(1);
    expect(scene.landed(tools, tools.end)).toBe(2);
  });

  it("streams the agent's text", () => {
    expect(scene.streamed(reply, reply.start)).toBe("");
    const partial = scene.streamed(reply, midway(reply));
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.length).toBeLessThan(REPLY.length);
    expect(REPLY.startsWith(partial)).toBe(true);
    expect(scene.streamed(reply, reply.end)).toBe(REPLY);
  });

  it("reaches a mark after the beats before it and reports progress through it", () => {
    expect(scene.reached("renamed", tools.end)).toBe(false);
    expect(scene.reached("renamed", tools.end + 1)).toBe(true);
    expect(scene.progress("renamed", tools.end + 100)).toBeCloseTo(0.25);
    expect(scene.progress("renamed", reply.start)).toBe(1);
  });

  it("glides the pointer to its target, presses, and lets go", () => {
    const pressedAt = firstMs(composerClick.pressed);
    const doneAt = firstMs(composerClick.done);

    expect(composerClick.opacity(POINTER_ENTERS)).toBe(0);
    expect(composerClick.approach(POINTER_ENTERS)).toBe(0);

    const gliding = (POINTER_ENTERS + pressedAt) / 2;
    expect(composerClick.opacity(gliding)).toBe(1);
    expect(composerClick.approach(gliding)).toBeGreaterThan(0);
    expect(composerClick.approach(gliding)).toBeLessThan(1);
    expect(composerClick.pressed(gliding)).toBe(false);

    expect(composerClick.approach(pressedAt)).toBe(1);
    expect(composerClick.done(pressedAt)).toBe(false);

    expect(doneAt).toBeGreaterThan(pressedAt);
    expect(composerClick.pressed(doneAt)).toBe(false);
  });

  it("keeps the pointer where it clicked until the user types", () => {
    const typingAt = firstMs(composerClick.done) + PAUSE_BEFORE_TYPING;
    expect(composerClick.opacity(typingAt - 1)).toBe(1);
    expect(pointed.draft(typingAt - 1)).toBe("");

    // The pointer fades away while the first characters land.
    expect(pointed.draft(typingAt + 1)).not.toBe("");
    expect(composerClick.opacity(typingAt + 1)).toBeLessThan(1);
    expect(composerClick.opacity(typingAt + 500)).toBe(0);
    expect(composerClick.done(typingAt + 500)).toBe(true);
  });

  it("fades the pointer in when it comes back after typing", () => {
    const setsOffAt = firstMs((ms) => pillClick.approach(ms) > 0);
    expect(pillClick.opacity(setsOffAt)).toBeGreaterThan(0);
    expect(pillClick.opacity(setsOffAt)).toBeLessThan(1);
  });

  it("moves one pointer from a click to the click after it", () => {
    const handoffAt = firstMs(pillClick.done);
    expect(pillClick.opacity(handoffAt - 1)).toBe(1);
    expect(menuClick.opacity(handoffAt - 1)).toBe(0);

    expect(pillClick.opacity(handoffAt)).toBe(0);
    expect(menuClick.opacity(handoffAt)).toBe(1);
    expect(menuClick.approach(handoffAt)).toBe(0);
  });

  it("leaves the pointer on the last thing it clicked", () => {
    expect(menuClick.opacity(pointed.duration)).toBe(1);
    expect(menuClick.approach(pointed.duration)).toBe(1);
    expect(menuClick.done(pointed.duration)).toBe(true);
    expect(composerClick.opacity(pointed.duration)).toBe(0);
    expect(composerClick.done(pointed.duration)).toBe(true);
  });

  it("ends a turn without a footer when the beat gives no time worked", () => {
    const quiet = script([
      { kind: "user", text: REQUEST },
      { kind: "agent", text: REPLY },
      { kind: "turnEnd" },
      { kind: "wait", ms: 300 },
    ]);
    const [, quietReply] = quiet.entries;
    expect(quiet.entries.map((entry) => entry.beat.kind)).toEqual(["user", "agent"]);
    expect(quiet.busy(quietReply.end - 1)).toBe(true);
    expect(quiet.busy(quietReply.end)).toBe(false);
  });

  it("shows the finished scene at its duration", () => {
    expect(scene.duration).toBe(turnEnd.end);
    expect(scene.entered(scene.duration)).toBe(scene.entries.length);
    expect(scene.draft(scene.duration)).toBe("");
    expect(scene.busy(scene.duration)).toBe(false);
    expect(scene.reached("renamed", scene.duration)).toBe(true);
  });
});
