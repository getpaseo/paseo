import type {
  DesktopCaptureDraft,
  DesktopCaptureGesture,
} from "@getpaseo/protocol/desktop-capture";

interface Hold {
  id: string;
  start: Promise<void>;
  cancelled: boolean;
  released: boolean;
  voiceFinished: boolean;
  delivered: boolean;
  text: string;
  error: string;
  capture?: DesktopCaptureDraft;
}

/** Joins independently arriving screenshot and transcription without sending on cancellation. */
export class HoldCapture {
  private active: Hold | null = null;
  private lane: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly input: {
      start(): Promise<void>;
      finish(): Promise<string>;
      cancel(): Promise<void>;
      ready(capture: DesktopCaptureDraft, text: string, error: string): void;
    },
  ) {}
  gesture(event: DesktopCaptureGesture) {
    if (event.phase === "began") {
      if (this.active && !this.active.cancelled && !this.active.delivered) return;
      const hold: Hold = {
        id: event.id,
        start: Promise.resolve(),
        cancelled: false,
        released: false,
        voiceFinished: false,
        delivered: false,
        text: "",
        error: "",
      };
      this.active = hold;
      hold.start = this.lane
        .then(() => (hold.cancelled ? undefined : this.input.start()))
        .catch(() => {
          hold.error ||= "Micro indisponible. Écrivez votre demande.";
        });
      this.lane = hold.start;
      return;
    }
    const hold = this.active;
    if (!hold || hold.id !== event.id) return;
    if (event.phase === "cancelled") {
      this.cancel();
      return;
    }
    if (hold.released || hold.cancelled) return;
    hold.released = true;
    this.lane = hold.start.then(async () => {
      if (hold.cancelled) return;
      try {
        if (!hold.error) hold.text = await this.input.finish();
      } catch {
        hold.error ||= "Dictée indisponible. Écrivez votre demande.";
      }
      hold.voiceFinished = true;
      this.deliver(hold);
      return;
    });
  }
  capture(capture: DesktopCaptureDraft) {
    const hold = this.active;
    if (!hold || hold.id !== capture.id || hold.cancelled) return false;
    hold.capture = capture;
    this.deliver(hold);
    return true;
  }
  fail(error: string) {
    if (this.active) this.active.error = error;
  }
  cancel() {
    const hold = this.active;
    if (!hold || hold.cancelled) return;
    hold.cancelled = true;
    this.active = null;
    this.lane = hold.start.then(() => this.input.cancel()).catch(() => {});
  }
  private deliver(hold: Hold) {
    if (hold.cancelled || hold.delivered || !hold.released || !hold.voiceFinished || !hold.capture)
      return;
    hold.delivered = true;
    this.input.ready(
      hold.capture,
      hold.text,
      hold.error || (!hold.text.trim() ? "Aucune parole détectée. Écrivez votre demande." : ""),
    );
  }
}
