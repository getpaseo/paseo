import { z } from "zod";
import { decisionJson } from "../shared/decisions";

export const routes = [
  { category: "trivial", model: "gpt-5.6-luna", effort: "low" },
  { category: "bounded", model: "gpt-5.6-sol", effort: "medium" },
  { category: "diagnostic", model: "gpt-5.6-sol", effort: "high" },
  { category: "complex", model: "gpt-6-astra", effort: "high" },
  { category: "critical", model: "gpt-6-astra", effort: "xhigh" },
] as const;

export type ExecutionCategory = (typeof routes)[number]["category"];

const routingTable = routes
  .map((route) => `| ${route.category} | ${route.model} | ${route.effort} |`)
  .join("\n");

export const executionDecision = z.object({
  category: z.enum(["trivial", "bounded", "diagnostic", "complex", "critical"]),
  provider: z.literal("codex"),
  model: z.string().min(1),
  effort: z.enum(["low", "medium", "high", "xhigh"]),
  reason: z.string().trim().min(1),
});
export type ExecutionDecision = z.infer<typeof executionDecision>;

export const executionOutputSchema = z.toJSONSchema(executionDecision);

const policy = `Classify the workflow plan into exactly one execution category and return only a complete JSON object matching this schema:
{"category":"trivial|bounded|diagnostic|complex|critical","provider":"codex","model":"...","effort":"...","reason":"..."}
Approved routing policy (one row may be chosen; repeat its model and effort exactly):
| Category | Model | Effort |
${routingTable}
Precedence rules:
- Risk wins over apparent edit size. A small authentication, security, migration, destructive, or user-data change is critical.
- Uncertainty raises the category; it never lowers one to save cost.
- Documentation, copy, formatting, or one isolated mechanical edit is trivial.

Workflow briefing:
`;

export function executionRoutingPrompt(briefing: string): string {
  return `${policy}${briefing}`;
}

export function parseExecutionDecision(text: string): ExecutionDecision {
  const decision = executionDecision.parse(decisionJson(text));
  const route = routes.find((entry) => entry.category === decision.category);
  if (!route || decision.model !== route.model || decision.effort !== route.effort)
    throw new Error("The classifier returned a combination outside the routing policy.");
  return decision;
}
