/**
 * Headless check of the lab speech providers: speak one sentence through lab TTS, resample the
 * 24 kHz audio to 16 kHz, transcribe it back through lab STT, and print both texts.
 *
 *   PASEO_LAB_TTS_URL=<ws url> PASEO_LAB_STT_URL=<ws url> \
 *     npx tsx scripts/pyrgos/lab-speech-roundtrip.mts ["sentence"]
 *
 * Exit 0 when the transcript matches the sentence (case and punctuation ignored).
 */
import pino from "pino";
import { resolveLabSpeechConfig } from "../../packages/server/src/server/speech/providers/lab/config.js";
import {
  LabSTT,
  resamplePcm16,
} from "../../packages/server/src/server/speech/providers/lab/stt.js";
import { LabTTS } from "../../packages/server/src/server/speech/providers/lab/tts.js";

const sentence = process.argv[2] ?? "The quick brown fox jumps over the lazy dog.";
const config = resolveLabSpeechConfig();
if (!config.ttsUrl || !config.sttUrl) {
  console.error("Set PASEO_LAB_TTS_URL and PASEO_LAB_STT_URL.");
  process.exit(2);
}
const logger = pino({ level: "silent" });

const tts = new LabTTS(
  {
    url: config.ttsUrl,
    voice: config.ttsVoice,
    connectTimeoutMs: config.connectTimeoutMs,
    fallback: null,
  },
  logger,
);
const started = Date.now();
const { stream, format } = await tts.synthesizeSpeech(sentence);
const chunks: Buffer[] = [];
let firstAudioMs: number | null = null;
for await (const chunk of stream) {
  firstAudioMs ??= Date.now() - started;
  chunks.push(Buffer.from(chunk));
}
const audio = Buffer.concat(chunks);
const sourceRate = Number(/rate=(\d+)/.exec(format)?.[1] ?? 24000);
console.log(`tts: ${audio.length} bytes (${format}), first audio ${firstAudioMs} ms`);

const stt = new LabSTT(
  { url: config.sttUrl, connectTimeoutMs: config.connectTimeoutMs, fallback: null },
  logger,
);
const session = stt.createSession({ logger, language: "en" });
const transcript = new Promise<string>((resolve, reject) => {
  session.on("transcript", (event) => {
    if (event.isFinal) resolve(event.transcript);
  });
  session.on("error", reject);
  setTimeout(() => reject(new Error("timed out waiting for a final transcript")), 15000);
});
await session.connect();
const pcm16k = resamplePcm16(audio, sourceRate, session.requiredSampleRate);
for (let offset = 0; offset < pcm16k.length; offset += 6400) {
  session.appendPcm16(pcm16k.subarray(offset, offset + 6400));
}
session.commit();
const heard = await transcript;
session.close();

const normalize = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
const ok = normalize(heard) === normalize(sentence);
console.log(`said:  ${sentence}\nheard: ${heard}\n${ok ? "PASS" : "FAIL"}`);
process.exit(ok ? 0 : 1);
