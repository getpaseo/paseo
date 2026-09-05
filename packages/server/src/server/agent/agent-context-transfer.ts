import { Buffer } from "node:buffer";
import {
  MAX_AGENT_CONTEXT_ATTACHMENTS,
  MAX_AGENT_CONTEXT_ATTACHMENTS_TOTAL_BYTES,
} from "@getpaseo/protocol/agent-context-limits";
import type { AgentAttachment, AgentContextTransferEnvelope } from "@getpaseo/protocol/messages";
import { decrypt, deriveSharedKey, encrypt, importPublicKey } from "@getpaseo/relay";
import { exportPublicKey, type KeyPair } from "@getpaseo/relay/e2ee";
import { z } from "zod";

type TextAgentAttachment = Extract<AgentAttachment, { type: "text" }>;

const TRANSFER_ATTACHMENT_MAX_BYTES = Math.floor(
  MAX_AGENT_CONTEXT_ATTACHMENTS_TOTAL_BYTES / MAX_AGENT_CONTEXT_ATTACHMENTS,
);

const AgentContextTransferCapsuleSchema = z.object({
  version: z.literal(1),
  destinationServerId: z.string().min(1).max(256),
  sourceServerId: z.string().min(1).max(256),
  sourceAgentId: z.string().min(1),
  createdAt: z.string().datetime(),
  attachment: z.object({
    type: z.literal("text"),
    mimeType: z.literal("text/plain"),
    contextKind: z.literal("chat_history"),
    title: z.string().nullable().optional(),
    text: z.string(),
  }),
});

type AgentContextTransferErrorCode =
  | "invalid_destination"
  | "invalid_envelope"
  | "oversized_context";

export class AgentContextTransferError extends Error {
  readonly code: AgentContextTransferErrorCode;

  constructor(code: AgentContextTransferErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentContextTransferError";
    this.code = code;
  }
}

export interface AgentContextTransferRecipient {
  serverId: string;
  publicKeyB64: string;
}

export interface AgentContextTransferCrypto {
  getRecipient(): AgentContextTransferRecipient;
  seal(input: {
    destination: AgentContextTransferRecipient;
    sourceAgentId: string;
    attachment: TextAgentAttachment;
  }): AgentContextTransferEnvelope;
  open(input: {
    envelope: AgentContextTransferEnvelope;
    sourceAgentId: string;
    maxBytes: number;
  }): TextAgentAttachment;
}

function textByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function decodeBase64(value: string): Uint8Array {
  const decoded = Buffer.from(value, "base64");
  const canonical = decoded.toString("base64");
  if (decoded.byteLength === 0 || canonical !== value) {
    throw new AgentContextTransferError(
      "invalid_envelope",
      "Cross-host agent context transfer is malformed.",
    );
  }
  return new Uint8Array(decoded);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function parseCapsule(value: ArrayBuffer) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    return AgentContextTransferCapsuleSchema.parse(JSON.parse(decoded));
  } catch (error) {
    throw new AgentContextTransferError(
      "invalid_envelope",
      "Cross-host agent context transfer could not be verified.",
      { cause: error },
    );
  }
}

export function createAgentContextTransferCrypto(input: {
  serverId: string;
  keyPair: KeyPair;
  now?: () => Date;
}): AgentContextTransferCrypto {
  const serverId = input.serverId.trim();
  if (!serverId) {
    throw new Error("Agent context transfer requires a server id.");
  }
  const publicKeyB64 = exportPublicKey(input.keyPair.publicKey);
  const now = input.now ?? (() => new Date());

  return {
    getRecipient() {
      return { serverId, publicKeyB64 };
    },

    seal({ destination, sourceAgentId, attachment }) {
      if (textByteLength(attachment.text) > TRANSFER_ATTACHMENT_MAX_BYTES) {
        throw new AgentContextTransferError(
          "oversized_context",
          "Cross-host agent context exceeds the transfer limit.",
        );
      }
      try {
        const sharedKey = deriveSharedKey(
          input.keyPair.secretKey,
          importPublicKey(destination.publicKeyB64),
        );
        const capsule = AgentContextTransferCapsuleSchema.parse({
          version: 1,
          destinationServerId: destination.serverId,
          sourceServerId: serverId,
          sourceAgentId,
          createdAt: now().toISOString(),
          attachment,
        });
        const ciphertext = encrypt(sharedKey, JSON.stringify(capsule));
        return {
          version: 1,
          destinationServerId: destination.serverId,
          sourcePublicKeyB64: publicKeyB64,
          ciphertextB64: Buffer.from(ciphertext).toString("base64"),
        };
      } catch (error) {
        if (error instanceof AgentContextTransferError) {
          throw error;
        }
        throw new AgentContextTransferError(
          "invalid_destination",
          "Destination host transfer identity is invalid.",
          { cause: error },
        );
      }
    },

    open({ envelope, sourceAgentId, maxBytes }) {
      if (envelope.destinationServerId !== serverId) {
        throw new AgentContextTransferError(
          "invalid_destination",
          "Cross-host agent context was encrypted for another host.",
        );
      }
      try {
        const sharedKey = deriveSharedKey(
          input.keyPair.secretKey,
          importPublicKey(envelope.sourcePublicKeyB64),
        );
        const ciphertext = decodeBase64(envelope.ciphertextB64);
        const plaintext = decrypt(sharedKey, toArrayBuffer(ciphertext));
        const capsule = parseCapsule(plaintext);
        if (capsule.destinationServerId !== serverId) {
          throw new AgentContextTransferError(
            "invalid_destination",
            "Cross-host agent context was encrypted for another host.",
          );
        }
        if (capsule.sourceAgentId !== sourceAgentId) {
          throw new AgentContextTransferError(
            "invalid_envelope",
            "Cross-host agent context source identity does not match the encrypted capsule.",
          );
        }
        if (textByteLength(capsule.attachment.text) > maxBytes) {
          throw new AgentContextTransferError(
            "oversized_context",
            "Cross-host agent context exceeds this prompt's attachment budget.",
          );
        }
        return capsule.attachment;
      } catch (error) {
        if (error instanceof AgentContextTransferError) {
          throw error;
        }
        throw new AgentContextTransferError(
          "invalid_envelope",
          "Cross-host agent context transfer could not be verified.",
          { cause: error },
        );
      }
    },
  };
}

export const AGENT_CONTEXT_TRANSFER_ATTACHMENT_MAX_BYTES = TRANSFER_ATTACHMENT_MAX_BYTES;
