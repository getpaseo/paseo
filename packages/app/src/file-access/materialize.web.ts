import { getDesktopHost } from "@/desktop/host";
import type { MaterializeInput, MaterializedFile } from "./types";

export async function materializeFile(input: MaterializeInput): Promise<MaterializedFile> {
  input.signal?.throwIfAborted();
  if (!input.client) throw new Error("The host is disconnected");
  const chunks: ArrayBuffer[] = [];
  let received = 0;
  let total = 0;
  const file = await input.client.readFileToSink({
    cwd: input.target.cwd,
    path: input.target.path,
    maxBytes: input.maxBytes ?? 512 * 1024 * 1024,
    signal: input.signal,
    sink: {
      begin(metadata) {
        total = metadata.size;
        input.onProgress?.(0, total);
      },
      write(bytes) {
        chunks.push(bytes.slice().buffer);
        received += bytes.byteLength;
        input.onProgress?.(received, total);
      },
      end() {},
    },
  });
  input.signal?.throwIfAborted();
  const name = input.target.path.replace(/\\/g, "/").split("/").pop() || "file";
  const blob = new Blob(chunks, { type: file.mime });
  const uri = URL.createObjectURL(blob);
  return { ...file, name, uri, release: () => URL.revokeObjectURL(uri) };
}

export async function openMaterializedFile(
  file: MaterializedFile,
  application?: string,
): Promise<void> {
  const bridge = getDesktopHost()?.files;
  if (!bridge) throw new Error("Use Save as to open this file in another application.");
  const response = await fetch(file.uri);
  const localPath = await bridge.materialize({
    name: file.name,
    bytes: new Uint8Array(await response.arrayBuffer()),
  });
  await bridge.open({ path: localPath, application });
}

export async function saveMaterializedFile(file: MaterializedFile): Promise<void> {
  const response = await fetch(file.uri);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const bridge = getDesktopHost()?.files;
  if (bridge) {
    await bridge.save({ name: file.name, bytes });
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = file.uri;
  anchor.download = file.name;
  anchor.click();
}

export async function shareMaterializedFile(file: MaterializedFile): Promise<void> {
  const blob = await (await fetch(file.uri)).blob();
  const shareFile = new File([blob], file.name, { type: file.mime });
  if (!navigator.canShare?.({ files: [shareFile] }))
    throw new Error("File sharing is unavailable. Use Save as.");
  await navigator.share({ files: [shareFile] });
}
