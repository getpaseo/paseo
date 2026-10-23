import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ActionItemSchema } from "./ledger-view";

export const listActionItemsRpc = defineRpc({
  name: "pyrgos-action-ledger.list",
  input: z.object({}),
  output: z.object({
    session: z.string().nullable(),
    items: z.array(ActionItemSchema),
  }),
});
