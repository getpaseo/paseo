import { getDesktopHost } from "@/desktop/host";

export type DesktopEventUnlisten = () => void;

type EventEnvelope = {
  payload?: unknown;
};

export async function listenToDesktopEvent<TPayload>(
  event: string,
  handler: (payload: TPayload) => void,
): Promise<DesktopEventUnlisten> {
  const listen = getDesktopHost()?.events?.on;
  if (typeof listen !== "function") {
    throw new Error("Desktop event API is unavailable.");
  }

  const unlisten = await listen(event, (rawEvent: unknown) => {
    const payload =
      typeof rawEvent === "object" && rawEvent !== null && "payload" in rawEvent
        ? (rawEvent as EventEnvelope).payload
        : rawEvent;
    handler(payload as TPayload);
  });

  return typeof unlisten === "function" ? unlisten : () => {};
}
