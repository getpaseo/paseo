import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import OpenAI from "openai";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not set (required for real OpenAI transcription in E2E tests)`);
  }
  return value;
}

export function parsePcm16MonoWav(buffer: Buffer): { sampleRate: number; pcm16: Buffer } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Invalid WAV header");
  }
  let offset = 12;
  let fmt:
    | { audioFormat: number; channels: number; sampleRate: number; bitsPerSample: number }
    | null = null;
  let dataChunk: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buffer.length) {
      break;
    }

    if (id === "fmt ") {
      const audioFormat = buffer.readUInt16LE(payloadStart);
      const channels = buffer.readUInt16LE(payloadStart + 2);
      const sampleRate = buffer.readUInt32LE(payloadStart + 4);
      const bitsPerSample = buffer.readUInt16LE(payloadStart + 14);
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    } else if (id === "data") {
      dataChunk = buffer.subarray(payloadStart, payloadEnd);
    }

    offset = payloadEnd + (size % 2);
  }

  if (!fmt || !dataChunk) {
    throw new Error("Missing WAV fmt/data chunks");
  }
  if (fmt.audioFormat !== 1) {
    throw new Error(`Unsupported WAV encoding (audioFormat=${fmt.audioFormat})`);
  }
  if (fmt.channels !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(
      `Unexpected WAV format: channels=${fmt.channels} rate=${fmt.sampleRate} bits=${fmt.bitsPerSample}`
    );
  }
  if (dataChunk.length % 2 !== 0) {
    throw new Error("WAV PCM16 data length must be even");
  }
  return { sampleRate: fmt.sampleRate, pcm16: dataChunk };
}

export async function findLargestDebugWavFixture(): Promise<string> {
  const base = path.resolve(process.cwd(), ".debug", "recordings");
  const files: Array<{ filePath: string; size: number }> = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir, { withFileTypes: true }));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".wav")) {
        continue;
      }
      const stat = await import("node:fs/promises").then((fs) => fs.stat(full));
      files.push({ filePath: full, size: stat.size });
    }
  };

  if (!existsSync(base)) {
    throw new Error(`Missing debug recordings dir: ${base}`);
  }
  await walk(base);
  if (files.length === 0) {
    throw new Error(`No .wav files found under ${base}`);
  }
  files.sort((a, b) => b.size - a.size);
  return files[0]!.filePath;
}

export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\n ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshteinDistanceWords(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;

  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = cur[j]!;
  }
  return prev[n]!;
}

export function wordSimilarity(aText: string, bText: string): number {
  const a = normalizeTranscript(aText).split(" ").filter(Boolean);
  const b = normalizeTranscript(bText).split(" ").filter(Boolean);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  const dist = levenshteinDistanceWords(a, b);
  return 1 - dist / maxLen;
}

export function chunkPcm16(pcm16: Buffer, chunkBytes: number): Buffer[] {
  const out: Buffer[] = [];
  for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
    out.push(pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes)));
  }
  return out;
}

export async function transcribeBaselineOpenAI(params: {
  apiKey: string;
  wav: Buffer;
  model: string;
  prompt: string;
}): Promise<string> {
  const tempDir = mkdtempSync(path.join(tmpdir(), "openai-transcribe-"));
  const wavPath = path.join(tempDir, "audio.wav");
  writeFileSync(wavPath, params.wav);

  try {
    const openai = new OpenAI({ apiKey: params.apiKey });
    const response = await openai.audio.transcriptions.create({
      file: await import("node:fs").then((fs) => fs.createReadStream(wavPath)),
      language: "en",
      model: params.model,
      prompt: params.prompt,
      response_format: "json",
    });
    return response.text;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

