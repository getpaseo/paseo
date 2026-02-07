import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";

import { createTestPaseoDaemon } from "../src/server/test-utils/paseo-daemon.js";
import { DaemonClient } from "../src/server/test-utils/daemon-client.js";
import { OpenAITTS } from "../src/server/speech/providers/openai/tts.js";

async function streamToBuffer(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike));
  }
  return Buffer.concat(chunks);
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const logger = pino({ level: process.env.PASEO_LOG_LEVEL ?? "info" });
  const daemon = await createTestPaseoDaemon({
    logger,
    agentClients: {},
    openai: { apiKey },
    speech: {
      providers: {
        dictationStt: { provider: "openai", explicit: true },
        voiceStt: { provider: "openai", explicit: true },
        voiceTts: { provider: "openai", explicit: true },
      },
    },
    voiceLlmProvider: "claude",
    voiceLlmProviderExplicit: true,
  });

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
  });

  const cleanup = async () => {
    await client.close().catch(() => undefined);
    await daemon.close().catch(() => undefined);
  };

  try {
    await client.connect();
    client.subscribeAgentUpdates({ subscriptionId: "voice-debug" });

    const voiceCwd = mkdtempSync(path.join(tmpdir(), "voice-roundtrip-debug-"));
    const voiceAgent = await client.createAgent({
      config: {
        provider: "claude",
        cwd: voiceCwd,
        modeId: "bypassPermissions",
      },
    });
    const voiceAgentId = voiceAgent.id;
    const mode = await client.setVoiceMode(true, voiceAgentId);
    console.log("set_voice_mode_response", mode);
    if (!mode.accepted) {
      throw new Error(`setVoiceMode rejected: ${mode.error ?? "unknown error"}`);
    }

    const offTranscript = client.on("transcription_result", (msg) => {
      if (msg.type !== "transcription_result") return;
      console.log("transcription_result", {
        text: msg.payload.text,
        isLowConfidence: msg.payload.isLowConfidence,
      });
    });

    const offActivity = client.on("activity_log", (msg) => {
      if (msg.type !== "activity_log") return;
      if (msg.payload.type === "transcript" || msg.payload.type === "error" || msg.payload.type === "assistant") {
        console.log("activity_log", {
          type: msg.payload.type,
          content: msg.payload.content,
        });
      }
    });

    const offStream = client.on("agent_stream", (msg) => {
      if (msg.type !== "agent_stream") return;
      if (msg.payload.event.type !== "timeline") return;
      const item = msg.payload.event.item;
      if (item.type !== "tool_call") return;
      console.log("agent_stream:tool_call", {
        agentId: msg.payload.agentId,
        name: item.name,
        status: item.status,
      });
    });

    let audioChunkCount = 0;
    const firstAudio = new Promise<void>((resolve) => {
      const offAudio = client.on("audio_output", (msg) => {
        if (msg.type !== "audio_output") return;
        audioChunkCount += 1;
        console.log("audio_output", {
          id: msg.payload.id,
          groupId: msg.payload.groupId,
          chunkIndex: msg.payload.chunkIndex,
          isLastChunk: msg.payload.isLastChunk,
          format: msg.payload.format,
        });
        if (audioChunkCount === 1) {
          offAudio();
          resolve();
        }
      });
    });
    const lastAudio = new Promise<void>((resolve) => {
      const offAudio = client.on("audio_output", (msg) => {
        if (msg.type !== "audio_output") return;
        if (msg.payload.isLastChunk) {
          offAudio();
          resolve();
        }
      });
    });

    const tts = new OpenAITTS(
      {
        apiKey,
        responseFormat: "pcm",
        voice: "alloy",
      },
      logger
    );
    const generated = await tts.synthesizeSpeech(
      "Use the speak tool and say exactly round trip successful."
    );
    const pcm = await streamToBuffer(generated.stream as AsyncIterable<unknown>);

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

    await Promise.race([
      firstAudio,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for first audio_output")), 120000)
      ),
    ]);
    await Promise.race([
      lastAudio,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for final audio_output")), 120000)
      ),
    ]);

    console.log("success", { audioChunkCount });
    await client.setVoiceMode(false);
    rmSync(voiceCwd, { recursive: true, force: true });

    offTranscript();
    offActivity();
    offStream();
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
