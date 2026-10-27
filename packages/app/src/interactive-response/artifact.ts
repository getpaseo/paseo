import { z } from "zod";
export { artifactProgram } from "./html-policy";

const envelope = z.object({ state: z.json(), proposal: z.string().max(10000) });
export type ArtifactState = z.infer<typeof envelope>;
export function artifactState(value: unknown): ArtifactState {
  if (value === undefined) return { state: null, proposal: "" };
  const parsed: unknown = JSON.parse(z.string().max(65536).parse(value));
  const restored = envelope.safeParse(parsed);
  if (restored.success) return restored.data;
  // COMPAT(interactiveArtifactState): added in v0.11.1, remove after 2027-04-24 once pre-runtime documents are retired.
  return { state: z.json().parse(parsed), proposal: "" };
}
const messageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("error") }),
  z.object({ type: z.literal("state"), value: z.string().max(65536) }),
  z.object({ type: z.literal("flushed"), id: z.number().int().nonnegative() }),
]);
export function artifactMessage(value: unknown) {
  const message = messageSchema.parse(value);
  if (message.type === "state") envelope.parse(JSON.parse(message.value));
  return message;
}

export interface HtmlArtifactProps {
  html: string;
  name: string;
  colorScheme?: "light" | "dark";
}

export function artifactProposal(state: Record<string, unknown>, names: readonly string[]): string {
  return names
    .flatMap((name) => {
      const value = state[name];
      if (typeof value !== "string") return [];
      try {
        const parsed = artifactState(value);
        return parsed.proposal ? [parsed.proposal] : [];
      } catch {
        return [];
      }
    })
    .join("\n");
}
