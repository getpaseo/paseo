import { isTypeScriptFile } from "@getpaseo/protocol/code-language";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import type { CodeTarget } from "@/code-language/actions";
import type { DiffDocumentModel, DiffHit } from "./types";

export function diffLanguageTarget(
  model: DiffDocumentModel,
  hit: DiffHit | null,
  cwd: string,
): CodeTarget | null {
  if (hit?.kind !== "cell") return null;
  const row = model.rows[hit.position.rowIndex];
  if (row?.kind !== "line") return null;
  const cell = row.cells[hit.position.cellIndex];
  const file = model.files[row.fileIndex]?.file;
  if (!cell || !file || !isTypeScriptFile(file.path)) return null;
  if (
    cell.sourceIdentity.side !== "new" ||
    cell.lineNumber === null ||
    (cell.type !== "add" && cell.type !== "context")
  )
    return null;
  if (!file.targetContentId) return null;
  const bomWidth = cell.lineNumber === 1 && cell.content.startsWith("\uFEFF") ? 1 : 0;
  return {
    path: buildAbsoluteExplorerPath({ workspaceRoot: cwd, entryPath: file.path }),
    position: {
      line: cell.lineNumber - 1,
      character: Math.max(0, hit.position.sourceOffset - bomWidth),
    },
    targetContentId: file.targetContentId,
  };
}
