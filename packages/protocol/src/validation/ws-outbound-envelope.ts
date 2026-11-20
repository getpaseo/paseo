import { z } from "zod";
import {
  SessionOutboundMessageSchema,
  WSHelloRejectedMessageSchema,
  WSPongMessageSchema,
} from "../messages.js";

export const sessionOutboundMessageOptions = SessionOutboundMessageSchema.options;

// Loose so the envelope passes the message body through; a stripping object would reduce every
// session message to its tag, and validateWSOutboundMessage returns the envelope's data as-is
// when the message validator applies no defaults.
const [firstSessionTag, ...otherSessionTags] = sessionOutboundMessageOptions.map((option) =>
  z.looseObject({ type: option.shape.type }),
);

// WSOutboundMessageSchema with every session message reduced to its tag. It reports the same
// envelope and discriminator issues, while each session message gets its own generated validator:
// one function for the whole protocol is large enough that V8's Maglev tier spends hundreds of MB
// and seconds compiling it.
export const WSOutboundEnvelopeSchema = z.discriminatedUnion("type", [
  WSPongMessageSchema,
  z.object({
    type: z.literal("session"),
    message: z.discriminatedUnion("type", [firstSessionTag, ...otherSessionTags]),
  }),
  WSHelloRejectedMessageSchema,
]);
