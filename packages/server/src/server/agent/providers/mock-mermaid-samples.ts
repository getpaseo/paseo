/**
 * Representative Mermaid diagrams for mock stream QA (Mermaid 11.x, securityLevel strict).
 * Keep samples small and syntax-stable so Paseo markdown fences render reliably.
 */

export const MOCK_MERMAID_DIAGRAM_IDS = [
  "flowchart",
  "sequence",
  "class",
  "state",
  "er",
  "journey",
  "gantt",
  "pie",
  "gitGraph",
  "mindmap",
  "timeline",
  "quadrant",
] as const;

export type MockMermaidDiagramId = (typeof MOCK_MERMAID_DIAGRAM_IDS)[number];

const MOCK_MERMAID_SAMPLES: Record<MockMermaidDiagramId, string> = {
  flowchart: `flowchart LR
  Client --> Daemon
  Daemon --> Agent`,

  sequence: `sequenceDiagram
  participant U as User
  participant P as Paseo
  U->>P: Send prompt
  P-->>U: Stream tokens`,

  class: `classDiagram
  class AgentSession {
    +run()
  }
  class AgentClient {
    +createSession()
  }
  AgentClient --> AgentSession`,

  state: `stateDiagram-v2
  [*] --> Idle
  Idle --> Running: prompt
  Running --> Idle: turn done`,

  er: `erDiagram
  AGENT ||--o{ TURN : has
  TURN {
    string turnId
  }`,

  journey: `journey
  title Mock stream
  section Render
    Open chat: 5: User
    See diagram: 5: User`,

  gantt: `gantt
  title Cycle 1
  dateFormat YYYY-MM-DD
  section Work
  Parse markdown :a1, 2026-01-01, 1d
  Render mermaid :a2, after a1, 1d`,

  pie: `pie title Token mix
  "assistant" : 45
  "tools" : 30
  "reasoning" : 25`,

  gitGraph: `gitGraph
  commit id: "init"
  commit id: "mermaid"
  branch feat/mermaid
  checkout feat/mermaid
  commit id: "gallery"`,

  mindmap: `mindmap
  root((Paseo))
    Markdown
      Mermaid
      Code fences
    Stream
      Mock provider`,

  timeline: `timeline
  title Mermaid in stream
  section Cycle 1
    Gallery emitted : Markdown fences`,

  quadrant: `quadrantChart
  title Priority
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Do first
  quadrant-2 Plan
  quadrant-3 Later
  quadrant-4 Skip
  Mock gallery: [0.3, 0.7]`,
};

export function buildMermaidFence(diagramId: MockMermaidDiagramId): string {
  const body = MOCK_MERMAID_SAMPLES[diagramId];
  return ["```mermaid", body, "```"].join("\n");
}

export function buildMermaidMarkdownGallery(): string {
  const sections = MOCK_MERMAID_DIAGRAM_IDS.map((id) => {
    const title = id.charAt(0).toUpperCase() + id.slice(1);
    return [`### ${title}`, "", buildMermaidFence(id), ""].join("\n");
  });
  return ["## Mermaid gallery (mock stream)", "", ...sections].join("\n");
}
