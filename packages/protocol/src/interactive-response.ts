import { InteractiveStateSchema, type InteractiveState } from "./interactive-response-schema.js";
export {
  InteractiveStateSchema,
  InteractiveDocumentSchema,
  InteractiveReferenceSchema,
  type InteractiveState,
  type InteractiveDocument,
} from "./interactive-response-schema.js";
import { z } from "zod";
import {
  createLibrary,
  createParser,
  defineComponent,
  generateSystemPrompt,
  type ElementNode,
} from "@openuidev/lang-core";

const shortText = z.string().max(10000);
const fieldId = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
const points = z
  .array(z.object({ label: shortText, value: z.number().finite() }))
  .min(1)
  .max(200);
export const interactiveComponentSchemas = {
  Text: z.object({ content: shortText }),
  Layout: z.object({ children: z.array(z.unknown()).max(100) }),
  Comparison: z.object({
    columns: z.array(shortText).min(1).max(12),
    rows: z.array(z.array(shortText).max(12)).max(100),
  }),
  Selection: z.object({
    name: fieldId,
    label: shortText,
    options: z.array(shortText).min(1).max(50),
  }),
  Form: z.object({ children: z.array(z.unknown()).max(100) }),
  Input: z.object({ name: fieldId, label: shortText }),
  Slider: z.object({
    name: fieldId,
    label: shortText,
    min: z.number().finite(),
    max: z.number().finite(),
  }),
  BarChart: z.object({ data: points, title: shortText }),
  LineChart: z.object({ data: points, title: shortText }),
  Mermaid: z.object({ source: z.string().max(30000) }),
  HtmlArtifact: z.object({ html: z.string().max(100000), name: fieldId.optional() }),
};
export const interactiveLibrary = createLibrary({
  root: "Layout",
  components: Object.entries(interactiveComponentSchemas).map(([name, props]) =>
    defineComponent({ name, props, description: name, component: () => null }),
  ),
});
export const interactiveInstructions =
  generateSystemPrompt(interactiveLibrary.toSpec()) +
  `
Use plain text for simple answers. When comparison, decisions or explanation benefit from an interface, call render_interactive_response with a title, textual summary and complete OpenUI source. Use only the listed components and static literals/references; do not use Query, Mutation, actions, reactive expressions or external resources. Field names must be unique. Each proposal creates a new document. HtmlArtifact documents must be self-contained. Inline classic scripts run in an isolated JavaScript interpreter, never in the browser. There is no document, window, fetch, storage, navigation, imports or external library loading. Use the frozen paseo API: getState() returns restored JSON or null; setState(json) persists JSON; propose(text) prepares a message shown outside the visual for explicit user sending; render(html) replaces the visual with filtered HTML/CSS/SVG; on(id, "click"|"input"|"change", callback) receives {id,type,value,checked}. Give controls unique ids. Use setTimeout/clearTimeout or requestAnimationFrame/cancelAnimationFrame for bounded animation (at most 16 timers, minimum 32ms); there is no setInterval. Scripts have finite CPU/memory limits. Keep state under 64KB including the proposed text (at most 10000 characters). For multiple HtmlArtifact components provide a unique optional second argument name to each (default "artifact"). Render self-contained markup with style tags and inline styles, never event-handler attributes. Initialize from getState() and re-render on events. Example script: let n=paseo.getState()?.n??0; function draw(){paseo.render('<button id="add">'+n+'</button>')} draw(); paseo.on('add','click',()=>{n++;paseo.setState({n});paseo.propose('Choose '+n);draw()}); Paseo owns sending choices to the agent; changing fields never sends a message. Existing tool restrictions still apply.`;
const parser = createParser(interactiveLibrary.toJSONSchema());

export function validateInteractiveSource(source: string): ElementNode {
  z.string().min(1).max(131072).parse(source);
  const result = parser.parse(source);
  if (
    !result.root ||
    result.meta.incomplete ||
    result.meta.unresolved.length ||
    result.meta.errors.length ||
    result.rootExpression ||
    result.queryStatements.length ||
    result.mutationStatements.length ||
    Object.keys(result.stateDeclarations).length
  )
    throw new Error("Invalid or incomplete OpenUI source");
  let count = 0;
  const fields = new Set<string>();
  function visit(node: ElementNode, depth: number): void {
    if (++count > 200 || depth > 16 || node.partial || node.hasDynamicProps)
      throw new Error("OpenUI limits or static source required");
    const schema =
      interactiveComponentSchemas[node.typeName as keyof typeof interactiveComponentSchemas];
    if (!schema) throw new Error("Unknown OpenUI component");
    const props = schema.parse(node.props);
    let name = node.typeName === "HtmlArtifact" ? "artifact" : undefined;
    if ("name" in props && typeof props.name === "string") name = props.name;
    if (name !== undefined) {
      if (fields.has(name)) throw new Error("Duplicate field name");
      fields.add(name);
    }
    if (node.typeName === "Slider" && Number(node.props.max) < Number(node.props.min))
      throw new Error("Invalid slider range");
    if ("children" in props)
      for (const child of props.children) {
        if (!child || typeof child !== "object" || !("type" in child) || child.type !== "element")
          throw new Error("Invalid child");
        visit(child as ElementNode, depth + 1);
      }
  }
  visit(result.root, 0);
  return result.root;
}

export function validateInteractiveState(source: string, state: unknown): InteractiveState {
  const parsed = InteractiveStateSchema.parse(state);
  if (JSON.stringify(parsed).length > 65536) throw new Error("Interactive state too large");
  const fields = new Map<string, ElementNode>();
  function visit(node: ElementNode): void {
    if (typeof node.props.name === "string") fields.set(node.props.name, node);
    if (node.typeName === "HtmlArtifact")
      fields.set(typeof node.props.name === "string" ? node.props.name : "artifact", node);
    if (Array.isArray(node.props.children))
      for (const child of node.props.children) visit(child as ElementNode);
  }
  visit(validateInteractiveSource(source));
  for (const [name, value] of Object.entries(parsed)) {
    const field = fields.get(name);
    if (!field) throw new Error("Unknown interactive field");
    if (
      field.typeName === "Selection" &&
      (typeof value !== "string" || !(field.props.options as string[]).includes(value))
    )
      throw new Error("Invalid selection");
    if (field.typeName === "Input" && typeof value !== "string") throw new Error("Invalid input");
    if (
      field.typeName === "Slider" &&
      (typeof value !== "number" ||
        value < Number(field.props.min) ||
        value > Number(field.props.max))
    )
      throw new Error("Invalid slider value");
    if (field.typeName === "HtmlArtifact") {
      if (typeof value !== "string") throw new Error("Invalid artifact state");
      JSON.parse(value);
    }
  }
  return parsed;
}
