import type { Page, WebSocketRoute } from "@playwright/test";
import { daemonWsRoutePattern } from "./daemon-port";
import { loadProtocolSchemas } from "./daemon-client-loader";

export async function observeFileUploads(page: Page) {
  const { FileUploadResponseSchema, FileUploadRequestSchema } = await loadProtocolSchemas();
  let failNextUpload = false;
  const routeUploads = (route: WebSocketRoute) => {
    const server = route.connectToServer();
    const forwardUpload = (message: string | Buffer) => {
      if (typeof message === "string" && failNextUpload) {
        const envelope = JSON.parse(message);
        const request = FileUploadRequestSchema.safeParse(envelope.message);
        if (request.success) {
          failNextUpload = false;
          server.send(
            JSON.stringify({
              ...envelope,
              message: { ...request.data, size: request.data.size + 1 },
            }),
          );
          return;
        }
      }
      server.send(message);
    };
    route.onMessage(forwardUpload);
  };
  await page.routeWebSocket(daemonWsRoutePattern(), routeUploads);
  const uploadedPaths: string[] = [];
  const recordUpload = (frame: { payload: string | Buffer }) => {
    if (typeof frame.payload !== "string") return;
    const envelope = JSON.parse(frame.payload);
    const response = FileUploadResponseSchema.safeParse(envelope.message ?? envelope);
    if (response.success && response.data.payload.file)
      uploadedPaths.push(response.data.payload.file.path);
  };
  page.on("websocket", (socket) => socket.on("framereceived", recordUpload));

  return {
    uploadedPaths,
    failNextUpload: () => {
      failNextUpload = true;
    },
  };
}
