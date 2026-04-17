import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { SharedSessionRoom } from "./rooms/shared-session-room.js";
import { config } from "./config.js";
import http from "node:http";

async function main() {
  const server = new Server({
    transport: new WebSocketTransport({
      // WebRTC signals (SDP offers/answers + ICE candidates) can bump against
      // the default ws payload limit when trickle-ICE accumulates. Raise the
      // ceiling so peer handshakes don't truncate and drop the connection.
      maxPayload: 10 * 1024 * 1024,
    }),
  });

  // Dedup rooms by shareToken so every recipient of the same share ends up in
  // the SAME Colyseus room (and therefore sees each other as participants).
  server.define("shared_session", SharedSessionRoom).filterBy(["shareToken"]);

  // Wait for transport to be ready, then add REST API routes
  const transport = await (server as any)._onTransportReady;
  const expressApp = transport?.getExpressApp?.();

  if (expressApp) {
    // CORS for browser requests
    expressApp.use((_req: any, res: any, next: any) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      if (_req.method === "OPTIONS") return res.sendStatus(204);
      next();
    });

    // GET /api/room/:roomId/state — Get room state as JSON
    expressApp.get("/api/room/:roomId/state", async (req: any, res: any) => {
      try {
        const rooms = await (server as any).matchMaker?.driver?.find({});
        const room = rooms?.find((r: any) => r.roomId === req.params.roomId);
        if (!room) return res.status(404).json({ error: "Room not found" });

        // Get the actual room instance
        const roomInstance = (server as any).matchMaker?.getRoomById?.(req.params.roomId);
        if (!roomInstance) return res.status(404).json({ error: "Room instance not found" });

        res.json({
          shareId: roomInstance.state?.shareId ?? "",
          accessLevel: roomInstance.state?.accessLevel ?? "read_only",
          agentStatus: roomInstance.state?.agentStatus ?? "idle",
          participants: Object.fromEntries(roomInstance.state?.participants ?? new Map()),
          messageQueue: Array.from(roomInstance.state?.messageQueue ?? []),
        });
      } catch (error) {
        res.status(500).json({ error: "Internal error" });
      }
    });
  }

  await server.listen(config.port);
  console.log(`[colyseus] Listening on port ${config.port}`);
  console.log(`[colyseus] REST API available at http://localhost:${config.port}/api/`);
}

main().catch((error) => {
  console.error("[colyseus] Failed to start:", error);
  process.exit(1);
});
