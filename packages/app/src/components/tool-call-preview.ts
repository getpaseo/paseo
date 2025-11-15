import {
  extractCommandDetails,
  extractEditEntries,
  extractReadEntries,
  type CommandDetails,
  type EditEntry,
  type ReadEntry,
} from "@/utils/tool-call-parsers";

export type ToolCallPreviewSource = {
  args?: unknown;
  result?: unknown;
  parsedEditEntries?: EditEntry[] | undefined;
  parsedReadEntries?: ReadEntry[] | undefined;
  parsedCommandDetails?: CommandDetails | null | undefined;
};

export type ToolCallPreview = {
  editEntries: EditEntry[];
  readEntries: ReadEntry[];
  commandDetails: CommandDetails | null | undefined;
};

export function resolveToolCallPreview({
  args,
  result,
  parsedEditEntries,
  parsedReadEntries,
  parsedCommandDetails,
}: ToolCallPreviewSource): ToolCallPreview {
  const fallbackEditEntries = extractEditEntries(args, result);
  const fallbackReadEntries = extractReadEntries(result, args);
  const fallbackCommandDetails = extractCommandDetails(args, result);

  return {
    editEntries: parsedEditEntries ?? fallbackEditEntries,
    readEntries: parsedReadEntries ?? fallbackReadEntries,
    commandDetails: parsedCommandDetails ?? fallbackCommandDetails,
  };
}
