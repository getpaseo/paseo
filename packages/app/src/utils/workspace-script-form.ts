export type WorkspaceScriptValidationError =
  | "name_required"
  | "command_required"
  | "port_invalid"
  | "name_collision";

export function validateWorkspaceScriptDraft(input: {
  name: string;
  command: string;
  port: string;
  collides?: boolean;
}): WorkspaceScriptValidationError | null {
  if (!input.name.trim()) return "name_required";
  if (!input.command.trim()) return "command_required";
  const port = input.port.trim();
  if (port && (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) {
    return "port_invalid";
  }
  if (input.collides) return "name_collision";
  return null;
}
