import { z } from "zod";

export const providerResultKind = "provider-result";

export const providerResultSchema = z.object({
  label: z.string(),
  detail: z.string(),
});
