import { getNextActiveIndex } from "./ui/combobox-keyboard";

export interface AgentSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export function filterCommandAutocompleteOptions(
  commands: AgentSlashCommand[],
  filter: string
): AgentSlashCommand[] {
  const filterLower = filter.toLowerCase();
  return commands.filter((cmd) => cmd.name.toLowerCase().includes(filterLower));
}

export function orderCommandAutocompleteOptions(
  commands: AgentSlashCommand[]
): AgentSlashCommand[] {
  return [...commands].reverse();
}

export function getCommandAutocompleteFallbackIndex(itemCount: number): number {
  if (itemCount <= 0) {
    return -1;
  }
  return itemCount - 1;
}

export function getCommandAutocompleteNextIndex(args: {
  currentIndex: number;
  itemCount: number;
  key: "ArrowDown" | "ArrowUp";
}): number {
  return getNextActiveIndex(args);
}

export function getCommandAutocompleteScrollOffset(args: {
  currentOffset: number;
  viewportHeight: number;
  itemTop: number;
  itemHeight: number;
}): number {
  if (args.viewportHeight <= 0) {
    return args.currentOffset;
  }

  const itemBottom = args.itemTop + args.itemHeight;
  const viewportTop = args.currentOffset;
  const viewportBottom = args.currentOffset + args.viewportHeight;

  if (args.itemTop < viewportTop) {
    return Math.max(0, args.itemTop);
  }

  if (itemBottom > viewportBottom) {
    return Math.max(0, itemBottom - args.viewportHeight);
  }

  return args.currentOffset;
}
