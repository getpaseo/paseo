import { compile } from "zod-aot";
import { WSOutboundMessageSchema as SourceWSOutboundMessageSchema } from "../src/messages.js";

export const WSOutboundMessageSchema = compile(SourceWSOutboundMessageSchema);
