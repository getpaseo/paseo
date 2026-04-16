import { Schema, type, MapSchema, ArraySchema } from "@colyseus/schema";

export class Participant extends Schema {
  @type("string") userId: string = "";
  @type("string") username: string = "";
  @type("string") avatarUrl: string = "";
  @type("string") role: string = "viewer"; // "owner" | "collaborator" | "viewer"
  @type("boolean") audioEnabled: boolean = false;
  @type("boolean") isOnline: boolean = true;
  @type("uint64") joinedAt: number = 0;
}

export class QueuedMessage extends Schema {
  @type("string") id: string = "";
  @type("string") userId: string = "";
  @type("string") username: string = "";
  @type("string") content: string = "";
  @type("uint64") queuedAt: number = 0;
  @type("string") status: string = "queued"; // "queued" | "processing" | "sent"
}

export class SharedSessionState extends Schema {
  @type("string") shareId: string = "";
  @type("string") accessLevel: string = "read_only"; // "read_only" | "full_access"
  @type("string") agentStatus: string = "idle"; // "idle" | "running" | "waiting_input"
  @type({ map: Participant }) participants = new MapSchema<Participant>();
  @type([QueuedMessage]) messageQueue = new ArraySchema<QueuedMessage>();
}
