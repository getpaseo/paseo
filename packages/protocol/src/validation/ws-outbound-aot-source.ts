import { WSOutboundMessageSchema as SourceWSOutboundMessageSchema } from "../messages.js";
import { compile } from "zod-aot";

export const WSOutboundMessageSchema = compile(SourceWSOutboundMessageSchema);
