import "dotenv/config";
import { writeFile, mkdir } from "node:fs/promises";
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

  const defaultOutPath = path.resolve(repoRoot, "tmp", "dictation-baseline.transcript.txt");
  const audioPath =
    process.env.DICTATION_AUDIO_PATH ?? (process.argv[2] ? path.resolve(process.argv[2]) : null);
  const outPath = path.resolve(process.env.DICTATION_OUT_PATH ?? process.argv[3] ?? defaultOutPath);

  if (!audioPath) {
    // eslint-disable-next-line no-console
    console.error(
      "Usage: npx tsx packages/server/scripts/dictation-generate-baseline.ts <audioPath> [outPath]\n" +
        "  Or set DICTATION_AUDIO_PATH / DICTATION_OUT_PATH.\n",
    );
    process.exit(2);
  }

  const apiKey = requireEnv("OPENAI_API_KEY");
  const transcriptionModel = process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL ?? "gpt-4o-transcribe";
  const prompt =
    process.env.OPENAI_REALTIME_DICTATION_TRANSCRIPTION_PROMPT ??
    "Transcribe only what the speaker says. Do not add words. Preserve punctuation and casing. If the audio is silence or non-speech noise, return an empty transcript.";

  const openai = new OpenAI({ apiKey });

  const response = await openai.audio.transcriptions.create({
    file: await import("node:fs").then((fs) => fs.createReadStream(audioPath)),
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
  console.log(`Wrote transcript baseline to ${outPath}`);
}

await main();
