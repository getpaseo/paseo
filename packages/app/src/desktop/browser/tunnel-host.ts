import { getDesktopHost } from "@/desktop/host";
export const tunnelHost = {
  start: (id: string) => bridge().start(id),
  stop: (id: string) => bridge().stop(id),
  write: (id: string, data: string) => bridge().write(id, data),
  close: (id: string) => bridge().close(id),
  resume: (id: string) => bridge().resume(id),
  onSocket: (
    listener: (event: {
      tunnelId: string;
      connectionId: string;
      kind: "open" | "data" | "close";
      dataBase64?: string;
    }) => void,
  ) => bridge().onSocket(listener),
};
function bridge() {
  const tunnel = getDesktopHost()?.browser?.tunnel;
  if (!tunnel) throw new Error("Update PandaOS on this device to open host-local websites");
  return tunnel;
}
