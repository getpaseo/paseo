import "dotenv/config";

export const config = {
  port: parseInt(process.env.COLYSEUS_PORT || "6800", 10),
  authServerUrl: process.env.AUTH_SERVER_URL || "http://localhost:3002",
  /** Secret used to verify internal requests from the daemon */
  internalSecret: process.env.COLYSEUS_INTERNAL_SECRET || "dev-secret",
} as const;
