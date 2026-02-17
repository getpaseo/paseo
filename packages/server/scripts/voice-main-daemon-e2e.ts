import { randomUUID } from "node:crypto";
import pino from "pino";

import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { OpenAITTS } from "../src/server/speech/providers/openai/tts.js";

type RoundTripResult = {
  voiceAgentId: string;
  speakToolCalls: number;
  audioChunks: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks);
}

async function synthesizeInput(text: string, logger: pino.Logger): Promise<Buffer> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required for voice-main-daemon-e2e");
  }

  const tts = new OpenAITTS(
    {
      apiKey,
      responseFormat: "pcm",
      voice: "alloy",
    },
    logger
  );

  const generated = await tts.synthesizeSpeech(text);
  return streamToBuffer(generated.stream as AsyncIterable<unknown>);
}

async function runVoiceRoundTrip(params: {
  daemonUrl: string;
  voiceAgentId: string;
  speechText: string;
  timeoutMs: number;
}): Promise<RoundTripResult> {
  const client = new DaemonClient({ url: `${params.daemonUrl}/ws` });
  await client.connect();
  await client.fetchAgents({
    subscribe: { subscriptionId: `voice-e2e-${randomUUID()}` },
  });

  const mode = await client.setVoiceMode(true, params.voiceAgentId);
  if (!mode.accepted) {
    throw new Error(`set_voice_mode rejected: ${mode.error ?? "unknown error"}`);
  }
  if (!mode.voiceAgentId) {
    throw new Error("set_voice_mode returned null voiceAgentId");
  }

  const activeVoiceAgentId = mode.voiceAgentId;
  const pcm = await synthesizeInput(params.speechText, pino({ level: "warn" }));

  let audioChunks = 0;
  let speakToolCalls = 0;
  let sawLastAudio = false;

  const done = new Promise<void>((resolve) => {
    const offAudio = client.on("audio_output", (msg) => {
      if (msg.type !== "audio_output") return;
      audioChunks += 1;
      if (msg.payload.isLastChunk) {
        sawLastAudio = true;
        offAudio();
        resolve();
      }
    });
  });

  const offStream = client.on("agent_stream", (msg) => {
    if (msg.type !== "agent_stream") return;
    if (msg.payload.agentId !== activeVoiceAgentId) return;
    if (msg.payload.event.type !== "timeline") return;
    const item = msg.payload.event.item;
    if (item.type !== "tool_call") return;
    if (typeof item.name === "string" && item.name.toLowerCase().includes("speak")) {
      speakToolCalls += 1;
    }
  });

  const chunkBytes = 4800;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(pcm.length, offset + chunkBytes));
    const isLast = offset + chunkBytes >= pcm.length;
    await client.sendVoiceAudioChunk(
      chunk.toString("base64"),
      "audio/pcm;rate=24000;bits=16",
      isLast
    );
  }

  try {
    await Promise.race([
      done,
      (async () => {
        await sleep(params.timeoutMs);
        throw new Error("Timed out waiting for audio_output");
      })(),
    ]);
  } finally {
    offStream();
    await client.setVoiceMode(false).catch(() => undefined);
    await client.close().catch(() => undefined);
  }

  if (!sawLastAudio) {
    throw new Error("No final audio chunk observed");
  }
  if (audioChunks === 0) {
    throw new Error("No audio chunks observed");
  }
  if (speakToolCalls === 0) {
    throw new Error("No speak tool call observed in agent stream");
  }

  return {
    voiceAgentId: activeVoiceAgentId,
    speakToolCalls,
    audioChunks,
  };
}

async function main(): Promise<void> {
  const daemonUrl = process.env.PASEO_DAEMON_URL ?? "ws://localhost:6767".replace(/^ws/, "http");
  const timeoutMs = Number(process.env.PASEO_VOICE_E2E_TIMEOUT_MS ?? "120000");
  const voiceAgentId = randomUUID();

  const newAgentResult = await runVoiceRoundTrip({
    daemonUrl,
    voiceAgentId,
    speechText:
      "Use the speak tool and say exactly: new voice agent round trip successful.",
    timeoutMs,
  });

  const resumedResult = await runVoiceRoundTrip({
    daemonUrl,
    voiceAgentId: newAgentResult.voiceAgentId,
    speechText:
      "Use the speak tool and say exactly: resumed voice agent round trip successful.",
    timeoutMs,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        daemonUrl,
        newAgentResult,
        resumedResult,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
