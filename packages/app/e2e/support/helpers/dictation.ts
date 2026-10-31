import { expect, type Page } from "../fixtures";

/**
 * Replaces the browser microphone with an oscillator. `silent` keeps the stream
 * running at zero gain, which is what a muted or wrongly routed input delivers.
 */
export async function installSyntheticMicrophone(
  page: Page,
  options: { silent?: boolean } = {},
): Promise<void> {
  await page.addInitScript((silent: boolean) => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = silent ? 0 : 1;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain);
        gain.connect(destination);
        oscillator.start();
        return destination.stream;
      },
    });
  }, options.silent ?? false);
}

/** Observe real browser/daemon traffic without intercepting or answering it. */
export function observeDictation(page: Page) {
  const streams = new Map<string, { audio: Map<number, string>; finalSeq: number }>();
  const recordings: Array<{ audio: string[]; finalSeq: number; text: string }> = [];
  let resolveAudio!: () => void;
  const audio = new Promise<void>((resolve) => {
    resolveAudio = resolve;
  });

  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const request = sessionMessage(payload);
      if (!request || typeof request.dictationId !== "string") return;
      const id = request.dictationId;
      if (request.type === "dictation_stream_start") {
        streams.set(id, { audio: new Map(), finalSeq: -1 });
      }
      if (request.type === "dictation_stream_chunk") {
        streams.get(id)!.audio.set(request.seq as number, request.audio as string);
        resolveAudio();
      }
      if (request.type === "dictation_stream_finish") {
        streams.get(id)!.finalSeq = request.finalSeq as number;
      }
    });
    socket.on("framereceived", ({ payload }) => {
      const response = sessionMessage(payload);
      if (response?.type !== "dictation_stream_final") return;
      const final = response.payload as { dictationId: string; text: string };
      const stream = streams.get(final.dictationId)!;
      recordings.push({
        audio: [...stream.audio.entries()].sort(([a], [b]) => a - b).map(([, chunk]) => chunk),
        finalSeq: stream.finalSeq,
        text: final.text,
      });
    });
  });
  return { waitForAudio: () => audio, recordings };
}

function sessionMessage(payload: string | Buffer): Record<string, unknown> | null {
  try {
    const envelope = JSON.parse(typeof payload === "string" ? payload : payload.toString("utf8"));
    return envelope.type === "session" ? envelope.message : null;
  } catch {
    return null;
  }
}

export async function recordDictation(page: Page, observed: { waitForAudio(): Promise<void> }) {
  await page.getByRole("button", { name: "Start dictation", exact: true }).click();
  await observed.waitForAudio();
  await page.getByRole("button", { name: "Insert transcription", exact: true }).click();
}

export async function expectEmptyDictation(page: Page) {
  const message = page.getByText("No transcription was returned. Tap retry to try again.", {
    exact: true,
  });
  await expect(message).toBeVisible();
  const bounds = await message.boundingBox();
  const cancel = await page
    .getByRole("button", { name: "Cancel dictation", exact: true })
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(cancel).not.toBeNull();
  expect(bounds!.y).toBeGreaterThanOrEqual(cancel!.y);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(cancel!.y + cancel!.height);
}

export async function retryDictation(page: Page) {
  await page.getByRole("button", { name: "Retry dictation", exact: true }).click();
}

export async function discardDictation(page: Page) {
  await page.getByRole("button", { name: "Cancel dictation", exact: true }).click();
}
