import { z } from "zod";

export const routerDecision = z.object({
  ready: z.boolean(),
  recommendation: z.enum(["standard", "advanced"]),
  constraints: z.array(z.string()),
  assumptions: z.array(z.string()),
});

export function decisionJson(text: string): unknown {
  return JSON.parse(
    text
      .trim()
      .replace(/^```(?:json)?\s*\n/, "")
      .replace(/\n```$/, ""),
  );
}
