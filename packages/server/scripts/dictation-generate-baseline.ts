import "dotenv/config";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} not set`);
  }
  return value;
}

async function main(): Promise<void> {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..");

  const fixturePath = path.resolve(
    repoRoot,
    "src",
    "server",
    "fixtures",
    "dictation",
    "dictation-debug-largest.wav"
  );
  const outPath = path.resolve(
    repoRoot,
    "src",
    "server",
    "fixtures",
    "dictation",
    "dictation-debug-largest.transcript.txt"
  );

  const apiKey = requireEnv("OPENAI_API_KEY");
  const transcriptionModel =
    process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
  const prompt =
    process.env.OPENAI_REALTIME_DICTATION_TRANSCRIPTION_PROMPT ??
    "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";

  const openai = new OpenAI({ apiKey });

  // Use a temp file path for the SDK's file stream param.
  // We already have a fixture file, so just stream it.
  const response = await openai.audio.transcriptions.create({
    file: await import("node:fs").then((fs) => fs.createReadStream(fixturePath)),
    language: "en",
    model: transcriptionModel,
    prompt,
    response_format: "json",
    // Aim for determinism.
    temperature: 0,
  });

  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(outPath, `${response.text.trim()}\n`, "utf8");

  // eslint-disable-next-line no-console
  console.log(`Wrote baseline transcript to ${outPath}`);
}

await main();

