import {
  DictationStreamSender,
  type DictationStreamClient,
} from "@/dictation/dictation-stream-sender";
import { resolveDictationEmptyReason } from "@/dictation/empty-transcript-reason";
import { pcm16PeakFromBase64 } from "@/dictation/pcm-level";
import { PCM_DICTATION_FORMAT } from "@/hooks/use-dictation.shared";
import type { DictationRecordingOutcome } from "./types";

/** Sends saved audio through a fresh dictation stream and reports what came back. */
export async function transcribeRecording(
  client: DictationStreamClient,
  segments: string[],
): Promise<DictationRecordingOutcome> {
  const sender = new DictationStreamSender({ client, format: PCM_DICTATION_FORMAT });
  try {
    for (const segment of segments) {
      sender.enqueueSegment(segment);
    }
    const { text } = await sender.finish(segments.length - 1);
    const trimmed = text.trim();
    if (trimmed) {
      return { kind: "transcribed", text: trimmed };
    }
    const peak = segments.reduce(
      (loudest, segment) => Math.max(loudest, pcm16PeakFromBase64(segment)),
      0,
    );
    return {
      kind: "empty",
      reason: resolveDictationEmptyReason({ segmentCount: segments.length, peak }),
    };
  } finally {
    sender.dispose();
  }
}
