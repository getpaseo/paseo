import type { HostConnection } from "@/types/host-connection";
import { getDesktopHost } from "@/desktop/host";

function connectionListen(connection: HostConnection): string | null {
  switch (connection.type) {
    case "directTcp":
      return connection.endpoint;
    case "directSocket":
      return `unix://${connection.path}`;
    case "directPipe":
      return `pipe://${connection.path}`;
    case "remoteSsh":
    case "relay":
      return null;
  }
}

// Desktop main checks that this target matches the live desktop-managed daemon.
// A plain browser has no bridge and falls back to its saved host password.
export async function readDesktopManagedLocalCredential(
  connection: HostConnection,
  invoke: (listen: string) => Promise<unknown> = async (listen) =>
    getDesktopHost()?.invoke?.("desktop_local_credential", { listen }),
): Promise<string | undefined> {
  const listen = connectionListen(connection);
  if (!listen) return undefined;
  const credential = await invoke(listen);
  return typeof credential === "string" ? credential : undefined;
}
