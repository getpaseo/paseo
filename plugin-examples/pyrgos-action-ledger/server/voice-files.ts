import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampSettings,
  DEFAULT_CAPABILITIES,
  DEFAULT_SETTINGS,
  parseLastUtterance,
  VoiceCapabilitiesSchema,
  VoiceSettingsSchema,
  type Utterance,
  type VoiceCapabilities,
  type VoiceSettings,
  type VoiceSettingsPatch,
} from "../shared/voice-settings";

const WORDS_SUFFIX = ".words.jsonl";

export function voiceDir(): string {
  const harness = process.env.ALCHEMIST_HARNESS;
  const base = harness ? join(harness, ".agents", "feedback") : join(tmpdir(), "pyrgos-feedback");
  return join(base, "voice");
}

async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8").catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readCapabilities(dir: string = voiceDir()): Promise<VoiceCapabilities> {
  const parsed = VoiceCapabilitiesSchema.safeParse(
    await readJson(join(dir, "voice-capabilities.json")),
  );
  return parsed.success ? parsed.data : DEFAULT_CAPABILITIES;
}

export async function readSettings(dir: string = voiceDir()): Promise<VoiceSettings> {
  const parsed = VoiceSettingsSchema.safeParse(await readJson(join(dir, "voice-settings.json")));
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function writeSettings(
  patch: VoiceSettingsPatch,
  dir: string = voiceDir(),
): Promise<{ settings: VoiceSettings; capabilities: VoiceCapabilities }> {
  const capabilities = await readCapabilities(dir);
  const settings = clampSettings(await readSettings(dir), patch, capabilities);
  await mkdir(dir, { recursive: true });
  const target = join(dir, "voice-settings.json");
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await rename(temp, target);
  return { settings, capabilities };
}

export async function readPlayback(
  dir: string = voiceDir(),
): Promise<{ serverNow: number; utterance: Utterance | null }> {
  const names = await readdir(dir).catch(() => []);
  const files = await Promise.all(
    names
      .filter((name) => name.endsWith(WORDS_SUFFIX))
      .map(async (name) => ({
        path: join(dir, name),
        mtime: (await stat(join(dir, name))).mtimeMs,
      })),
  );
  const newest = files.toSorted((a, b) => b.mtime - a.mtime)[0];
  const text = newest ? await readFile(newest.path, "utf8").catch(() => "") : "";
  return { serverNow: Date.now(), utterance: parseLastUtterance(text) };
}
