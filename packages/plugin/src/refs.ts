interface EntityRef<Kind extends string> {
  readonly kind: Kind;
  readonly key: string;
  readonly hostId: string;
  readonly id: string;
}

export interface WorkspaceRef extends EntityRef<"workspace"> {}
export interface AgentRef extends EntityRef<"agent"> {}
export interface ProjectRef extends EntityRef<"project"> {}
export interface TerminalRef extends EntityRef<"terminal"> {}
