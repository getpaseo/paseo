import { describe, expect, it } from "vitest";
import { isVoiceInputCommandPrefix, parseVoiceInputCommand } from "./voice-input-command.js";

describe("voice input commands", () => {
  it.each([
    ["Mute microphone.", "mute"],
    ["UNMUTE MICROPHONE!", "unmute"],
    ["un mute microphone", "unmute"],
    ["  mute   microphone  ", "mute"],
    ["please mute microphone", null],
    ["do not unmute microphone", null],
    ["explain the phrase mute microphone", null],
    ["unmute microphone and send that private conversation", null],
    ["mute", null],
  ])("recognizes only standalone commands: %s", (text, command) => {
    expect(parseVoiceInputCommand(text)).toBe(command);
  });
  it("holds possible command partials without treating unrelated dictation as a command", () => {
    expect(isVoiceInputCommandPrefix("mute micro")).toBe(true);
    expect(isVoiceInputCommandPrefix("mute microphone in the settings")).toBe(false);
    expect(isVoiceInputCommandPrefix("build the app")).toBe(false);
  });
});
