import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { planNotificationSound, readBoundedFile, resolveCustomSound } from "./notifications";
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from "../settings/desktop-settings";

function settingsWith(notifications: Partial<DesktopSettings["notifications"]>): DesktopSettings {
  return {
    ...DEFAULT_DESKTOP_SETTINGS,
    notifications: { ...DEFAULT_DESKTOP_SETTINGS.notifications, ...notifications },
  };
}

function createSoundReader(files: Record<string, Buffer>) {
  const requested: string[] = [];
  return {
    requested,
    read: async (filePath: string): Promise<Buffer> => {
      requested.push(filePath);
      const contents = files[filePath];
      if (!contents) {
        throw new Error(`ENOENT: ${filePath}`);
      }
      return contents;
    },
  };
}

describe("resolveCustomSound", () => {
  it("returns a base64 data URL with the mime type for the file extension", async () => {
    const reader = createSoundReader({ "/sounds/chime.mp3": Buffer.from("chime-bytes") });

    const sound = await resolveCustomSound(
      settingsWith({ customSoundPath: "/sounds/chime.mp3" }),
      reader.read,
    );

    expect(sound).toEqual({
      dataUrl: `data:audio/mpeg;base64,${Buffer.from("chime-bytes").toString("base64")}`,
    });
  });

  it("maps each supported extension to its own audio mime type", async () => {
    const paths = [
      "/sounds/a.mp3",
      "/sounds/b.wav",
      "/sounds/c.m4a",
      "/sounds/d.aac",
      "/sounds/e.OGG",
      "/sounds/f.flac",
      "/sounds/g.aiff",
    ];
    const reader = createSoundReader(
      Object.fromEntries(paths.map((filePath) => [filePath, Buffer.from("x")])),
    );

    const mimeTypes = await Promise.all(
      paths.map(async (customSoundPath) => {
        const sound = await resolveCustomSound(settingsWith({ customSoundPath }), reader.read);
        return sound?.dataUrl.slice("data:".length, sound.dataUrl.indexOf(";"));
      }),
    );

    expect(mimeTypes).toEqual([
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/aac",
      "audio/ogg",
      "audio/flac",
      "audio/aiff",
    ]);
  });

  it("returns null without reading the file when sound is off", async () => {
    const reader = createSoundReader({ "/sounds/chime.mp3": Buffer.from("chime-bytes") });

    const sound = await resolveCustomSound(
      settingsWith({ playSound: false, customSoundPath: "/sounds/chime.mp3" }),
      reader.read,
    );

    expect(sound).toBeNull();
    expect(reader.requested).toEqual([]);
  });

  it("returns null without reading anything when no custom sound is configured", async () => {
    const reader = createSoundReader({});

    const sound = await resolveCustomSound(settingsWith({ customSoundPath: null }), reader.read);

    expect(sound).toBeNull();
    expect(reader.requested).toEqual([]);
  });

  it("returns null when the configured file is gone", async () => {
    const reader = createSoundReader({});

    const sound = await resolveCustomSound(
      settingsWith({ customSoundPath: "/sounds/deleted.wav" }),
      reader.read,
    );

    expect(sound).toBeNull();
    expect(reader.requested).toEqual(["/sounds/deleted.wav"]);
  });

  it("returns null for a file larger than the 5 MB cap", async () => {
    const oversized = Buffer.alloc(5 * 1024 * 1024 + 1);
    const atCap = Buffer.alloc(5 * 1024 * 1024, 1);
    const reader = createSoundReader({
      "/sounds/oversized.wav": oversized,
      "/sounds/at-cap.wav": atCap,
    });

    const rejected = await resolveCustomSound(
      settingsWith({ customSoundPath: "/sounds/oversized.wav" }),
      reader.read,
    );
    const accepted = await resolveCustomSound(
      settingsWith({ customSoundPath: "/sounds/at-cap.wav" }),
      reader.read,
    );

    expect(rejected).toBeNull();
    expect(accepted?.dataUrl.startsWith("data:audio/wav;base64,")).toBe(true);
  });
});

describe("planNotificationSound", () => {
  it("plays the custom sound silently when one is configured and sound is on", () => {
    expect(planNotificationSound(settingsWith({ customSoundPath: "/sounds/chime.mp3" }))).toEqual({
      silent: true,
      playsCustomSound: true,
    });
  });

  it("lets the system sound play when sound is on without a custom sound", () => {
    expect(planNotificationSound(settingsWith({ customSoundPath: null }))).toEqual({
      silent: false,
      playsCustomSound: false,
    });
  });

  it("stays silent when sound is off even with a custom sound configured", () => {
    expect(
      planNotificationSound(
        settingsWith({ playSound: false, customSoundPath: "/sounds/chime.mp3" }),
      ),
    ).toEqual({ silent: true, playsCustomSound: false });
  });

  it("stays silent when sound is off without a custom sound", () => {
    expect(
      planNotificationSound(settingsWith({ playSound: false, customSoundPath: null })),
    ).toEqual({
      silent: true,
      playsCustomSound: false,
    });
  });
});

describe("readBoundedFile", () => {
  const directories = new Set<string>();

  afterEach(async () => {
    await Promise.all(
      [...directories].map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
    directories.clear();
  });

  async function createSoundFile(fileName: string, contents: string): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "paseo-notification-sound-"));
    directories.add(directory);
    const filePath = path.join(directory, fileName);
    await writeFile(filePath, contents);
    return filePath;
  }

  it("returns the whole file when it fits under the cap", async () => {
    const filePath = await createSoundFile("chime.wav", "chime");

    const contents = await readBoundedFile(filePath, 8);

    expect(contents.toString()).toBe("chime");
  });

  it("reads one byte past the cap so oversize files stay detectable", async () => {
    const filePath = await createSoundFile("chime.wav", "chime-that-is-too-long");

    const contents = await readBoundedFile(filePath, 8);

    expect(contents.byteLength).toBe(9);
  });

  it("rejects when the file does not exist", async () => {
    const filePath = await createSoundFile("chime.wav", "chime");

    await expect(readBoundedFile(`${filePath}.missing`, 8)).rejects.toThrow();
  });

  it("resolves an under-cap file end to end through the bounded reader", async () => {
    const filePath = await createSoundFile("chime.wav", "chime");

    const sound = await resolveCustomSound(
      settingsWith({ customSoundPath: filePath }),
      (soundPath) => readBoundedFile(soundPath, 8),
      8,
    );

    expect(sound).toEqual({
      dataUrl: `data:audio/wav;base64,${Buffer.from("chime").toString("base64")}`,
    });
  });

  it("rejects an over-cap file end to end through the bounded reader", async () => {
    const filePath = await createSoundFile("chime.wav", "chime-that-is-too-long");

    const sound = await resolveCustomSound(
      settingsWith({ customSoundPath: filePath }),
      (soundPath) => readBoundedFile(soundPath, 8),
      8,
    );

    expect(sound).toBeNull();
  });
});
