// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readPlayback, readSettings, writeSettings } from "../server/voice-files";
import {
  activeWordIndex,
  clampSettings,
  DEFAULT_CAPABILITIES,
  DEFAULT_SETTINGS,
  heldWordIndex,
  parseLastUtterance,
  type VoiceSettingsPatch,
} from "../shared/voice-settings";
import { VoiceSettingsForm } from "./voice-settings-form";
import { WordHighlight } from "./word-highlight";

const fixture = readFileSync(join(__dirname, "../fixtures/session.words.jsonl"), "utf8");
const colors = { foreground: "#fff", muted: "#888", accent: "#0af", surface: "#222" };
const utterance = parseLastUtterance(fixture);
const utteranceWords = utterance?.words ?? [];
const noop = () => {};
const sent: VoiceSettingsPatch[] = [];
const record = (patch: VoiceSettingsPatch) => {
  sent.push(patch);
};
const FIRST_ACKED = { ...DEFAULT_SETTINGS, speed: 1.1 };
const PITCH_CAPS = { speed: true, pitch: true, presets: ["warm"] };

afterEach(cleanup);

describe("activeWordIndex", () => {
  const words = utterance?.words ?? [];

  it("is -1 before the first word and after the last", () => {
    expect(activeWordIndex(words, -0.1)).toBe(-1);
    expect(activeWordIndex(words, 2.5)).toBe(-1);
  });

  it("follows the word whose start has passed", () => {
    expect(activeWordIndex(words, 0)).toBe(0);
    expect(activeWordIndex(words, 0.5)).toBe(1);
    expect(activeWordIndex(words, 1.3)).toBe(4);
    expect(activeWordIndex(words, 1.9)).toBe(5);
  });

  it("is -1 in the gap between words", () => {
    expect(activeWordIndex(words, 0.62)).toBe(-1);
  });
});

describe("heldWordIndex", () => {
  const words = utteranceWords;

  it("holds the last spoken word through gaps and after the end", () => {
    expect(heldWordIndex(words, -1)).toBe(-1);
    expect(heldWordIndex(words, 0.62)).toBe(1);
    expect(heldWordIndex(words, 9)).toBe(5);
  });

  it("keeps the last word highlighted in the rendered output after the end", () => {
    const html = renderToStaticMarkup(
      <WordHighlight words={words} elapsedSeconds={9} colors={colors} />,
    );
    expect(html.match(/word-active/g)).toHaveLength(1);
  });
});

describe("settings form", () => {
  it("patches from the latest pending value, not the last render", () => {
    sent.length = 0;
    render(
      <VoiceSettingsForm
        settings={DEFAULT_SETTINGS}
        capabilities={PITCH_CAPS}
        colors={colors}
        onChange={record}
      />,
    );
    const faster = screen.getByLabelText("Increase Speed");
    fireEvent.click(faster);
    fireEvent.click(faster);
    expect(sent).toEqual([{ speed: 1.1 }, { speed: 1.2 }]);
    const higher = screen.getByLabelText("Increase Pitch");
    fireEvent.click(higher);
    fireEvent.click(higher);
    expect(sent.slice(2)).toEqual([{ pitch: 1 }, { pitch: 2 }]);
  });
});

describe("settings form with staggered acks", () => {
  it("keeps pending edits when a query update lands between presses", async () => {
    const calls: VoiceSettingsPatch[] = [];
    const resolvers: Array<() => void> = [];
    const onChange = (patch: VoiceSettingsPatch) => {
      calls.push(patch);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    };
    const props = { capabilities: PITCH_CAPS, colors, onChange };
    const { rerender } = render(<VoiceSettingsForm settings={DEFAULT_SETTINGS} {...props} />);
    const faster = screen.getByLabelText("Increase Speed");
    fireEvent.click(faster);
    fireEvent.click(faster);
    rerender(<VoiceSettingsForm settings={FIRST_ACKED} {...props} />);
    fireEvent.click(faster);
    expect(calls).toEqual([{ speed: 1.1 }, { speed: 1.2 }, { speed: 1.3 }]);
    for (const resolve of resolvers) resolve();
    await Promise.resolve();
  });
});

describe("settings form after the last save resolves", () => {
  it("keeps the optimistic value when the ack lands before the rerender", async () => {
    const calls: VoiceSettingsPatch[] = [];
    const onChange = (patch: VoiceSettingsPatch) => {
      calls.push(patch);
      return Promise.resolve();
    };
    const props = { capabilities: PITCH_CAPS, colors, onChange };
    const { rerender } = render(<VoiceSettingsForm settings={DEFAULT_SETTINGS} {...props} />);
    const faster = screen.getByLabelText("Increase Speed");
    fireEvent.click(faster);
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(faster);
    expect(calls).toEqual([{ speed: 1.1 }, { speed: 1.2 }]);
    rerender(<VoiceSettingsForm settings={FIRST_ACKED} {...props} />);
    await Promise.resolve();
    fireEvent.click(faster);
    expect(calls.at(-1)).toEqual({ speed: 1.3 });
  });
});

describe("settings form after a failed save", () => {
  it("does not build the next press on a value the server never saved", async () => {
    const calls: VoiceSettingsPatch[] = [];
    const settlers: Array<{ ok: () => void; fail: () => void }> = [];
    const onChange = (patch: VoiceSettingsPatch) => {
      calls.push(patch);
      return new Promise<void>((resolve, reject) =>
        settlers.push({ ok: resolve, fail: () => reject(new Error("save failed")) }),
      );
    };
    const props = { capabilities: PITCH_CAPS, colors, onChange };
    render(<VoiceSettingsForm settings={DEFAULT_SETTINGS} {...props} />);
    const faster = screen.getByLabelText("Increase Speed");
    fireEvent.click(faster);
    fireEvent.click(faster);
    settlers[1]?.fail();
    await Promise.resolve();
    await Promise.resolve();
    settlers[0]?.ok();
    await Promise.resolve();
    await Promise.resolve();
    fireEvent.click(faster);
    expect(calls.map((c) => c.speed)).toEqual([1.1, 1.2, 1.2]);
  });
});

describe("parseLastUtterance", () => {
  it("takes the last valid row", () => {
    expect(utterance?.id).toBe("u2");
    expect(parseLastUtterance(`${fixture}garbage\n`)?.id).toBe("u2");
    expect(parseLastUtterance("")).toBeNull();
  });
});

describe("clampSettings", () => {
  it("clamps speed and ignores unsupported controls", () => {
    expect(clampSettings(DEFAULT_SETTINGS, { speed: 9 }, DEFAULT_CAPABILITIES).speed).toBe(2);
    expect(clampSettings(DEFAULT_SETTINGS, { pitch: 3 }, DEFAULT_CAPABILITIES).pitch).toBe(0);
    expect(
      clampSettings(DEFAULT_SETTINGS, { preset: "warm" }, DEFAULT_CAPABILITIES).preset,
    ).toBeNull();
  });

  it("accepts pitch and known presets when supported", () => {
    const caps = { speed: true, pitch: true, presets: ["warm"] };
    expect(clampSettings(DEFAULT_SETTINGS, { pitch: 3, preset: "warm" }, caps)).toEqual({
      speed: 1,
      pitch: 3,
      preset: "warm",
    });
    expect(clampSettings(DEFAULT_SETTINGS, { preset: "nope" }, caps).preset).toBeNull();
  });
});

describe("components", () => {
  it("highlights the active word from the fixture", () => {
    const html = renderToStaticMarkup(
      <WordHighlight words={utteranceWords} elapsedSeconds={0.7} colors={colors} />,
    );
    expect(html).toContain("word-active");
    expect(html.match(/word-active/g)).toHaveLength(1);
    expect(html).toContain("ledger");
  });

  it("disables unsupported controls", () => {
    const html = renderToStaticMarkup(
      <VoiceSettingsForm
        settings={DEFAULT_SETTINGS}
        capabilities={DEFAULT_CAPABILITIES}
        colors={colors}
        onChange={noop}
      />,
    );
    expect(html).toContain("1.0x");
    expect(html).toContain("n/a");
  });
});

describe("voice files", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "voice-files-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("defaults, then persists a clamped patch", async () => {
    expect(await readSettings(dir)).toEqual(DEFAULT_SETTINGS);
    const saved = await writeSettings({ speed: 1.3, pitch: 5 }, dir);
    expect(saved.settings).toEqual({ speed: 1.3, pitch: 0, preset: null });
    expect(JSON.parse(await readFile(join(dir, "voice-settings.json"), "utf8")).speed).toBe(1.3);
  });

  it("honours capabilities written by the provider", async () => {
    await writeFile(
      join(dir, "voice-capabilities.json"),
      JSON.stringify({ speed: true, pitch: true, presets: ["warm"] }),
    );
    const saved = await writeSettings({ pitch: 2, preset: "warm" }, dir);
    expect(saved.settings).toEqual({ speed: 1, pitch: 2, preset: "warm" });
  });

  it("reads the latest utterance from the newest words file", async () => {
    const row = { ...utterance, startedAt: Date.now() };
    await writeFile(join(dir, "s.words.jsonl"), `${JSON.stringify(row)}\n`);
    const playback = await readPlayback(dir);
    expect(playback.utterance?.id).toBe("u2");
    expect(playback.serverNow).toBeGreaterThan(0);
  });

  it("ignores a words file that vanishes between readdir and stat", async () => {
    const keep = join(dir, "keep.words.jsonl");
    await writeFile(keep, `${JSON.stringify({ ...utterance, startedAt: Date.now() })}\n`);
    await writeFile(join(dir, "gone.words.jsonl"), "");
    const statFile = (async (path: string) => {
      if (path.endsWith("gone.words.jsonl")) {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }
      return stat(path);
    }) as typeof stat;
    expect((await readPlayback(dir, statFile)).utterance?.id).toBe("u2");
  });

  it("does not default over an unreadable or corrupt settings file", async () => {
    await writeFile(join(dir, "voice-settings.json"), "{not json");
    await expect(readSettings(dir)).rejects.toThrow();
    await expect(writeSettings({ speed: 1.3 }, dir)).rejects.toThrow();
    expect(await readFile(join(dir, "voice-settings.json"), "utf8")).toBe("{not json");
  });

  it("expires a finished utterance", async () => {
    await writeFile(join(dir, "s.words.jsonl"), fixture);
    expect((await readPlayback(dir)).utterance).toBeNull();
  });

  it("serializes concurrent settings writes", async () => {
    await Promise.all([1.1, 1.2, 1.3, 1.4, 1.5].map((speed) => writeSettings({ speed }, dir)));
    expect((await readSettings(dir)).speed).toBe(1.5);
    const names = await readdir(dir);
    expect(names.filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
