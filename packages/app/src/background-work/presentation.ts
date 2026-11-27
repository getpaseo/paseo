export function backgroundWorkText(
  item: { description: string | null; command?: string },
  kind: string,
): { title: string; command: string | null } {
  const title = item.description ?? item.command ?? kind;
  return { title, command: item.command && item.command !== title ? item.command : null };
}
