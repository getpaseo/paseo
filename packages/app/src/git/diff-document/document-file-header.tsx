import { memo, useCallback } from "react";
import { FileHeader } from "@/git/file-header";
import type { DiffFileSection } from "./types";
import type { DiffDocumentProps } from "./types";

interface DocumentFileHeaderProps {
  file: DiffFileSection;
  isViewed: boolean;
  viewedActionDisabled: boolean;
  viewedActionPending: boolean;
  selectedPath: string | null;
  mode: DiffDocumentProps["mode"];
  onToggleFile: (path: string) => void;
  onToggleFileViewed: (file: DiffFileSection["file"]) => void;
  onSelectPath: (path: string) => void;
  canvasRendered?: boolean;
  onActiveChange?: (active: boolean) => void;
}

export const DocumentFileHeader = memo(function DocumentFileHeader({
  file,
  isViewed,
  viewedActionDisabled,
  viewedActionPending,
  selectedPath,
  mode,
  onToggleFile,
  onToggleFileViewed,
  onSelectPath,
  canvasRendered = false,
  onActiveChange,
}: DocumentFileHeaderProps) {
  const activate = useCallback(
    (path: string) => {
      if (mode.kind !== "working") return;
      mode.onFilePress?.(path);
      onToggleFile(path);
    },
    [mode, onToggleFile],
  );
  const working = mode.kind === "working" ? mode : null;
  const toggleViewed = useCallback(
    () => onToggleFileViewed(file.file),
    [file.file, onToggleFileViewed],
  );
  return (
    <FileHeader
      file={file.file}
      bodyVisible={!file.isCollapsed}
      isViewed={isViewed}
      viewedActionDisabled={viewedActionDisabled}
      viewedActionPending={viewedActionPending}
      isSelected={selectedPath === file.path}
      interactive={mode.kind === "working"}
      workspaceFileDragScope={working?.workspaceFileDragScope}
      onActivate={activate}
      onSelect={onSelectPath}
      onOpenFile={working?.onOpenFile}
      onOpenToSide={working?.onOpenToSide}
      onAddToChat={working?.onAddToChat}
      onCopyPath={working?.onCopyPath}
      onCopyRelativePath={working?.onCopyRelativePath}
      onReveal={working?.onReveal}
      revealTargetName={working?.revealTargetName}
      onDownload={working?.onDownload}
      onDuplicate={working?.onDuplicate}
      onRevert={working?.onRevert}
      onToggleViewed={working ? toggleViewed : undefined}
      testID={`diff-file-${file.fileIndex}`}
      canvasRendered={canvasRendered && !working}
      onActiveChange={onActiveChange}
    />
  );
}, documentFileHeaderPropsEqual);

function documentFileHeaderPropsEqual(
  previous: DocumentFileHeaderProps,
  next: DocumentFileHeaderProps,
): boolean {
  if (!documentFileHeaderIdentityMatches(previous, next)) return false;
  if (previous.mode.kind === "commit" || next.mode.kind === "commit") return true;
  return (
    previous.mode.onFilePress === next.mode.onFilePress &&
    previous.mode.workspaceFileDragScope === next.mode.workspaceFileDragScope &&
    previous.mode.onOpenFile === next.mode.onOpenFile &&
    previous.mode.onOpenToSide === next.mode.onOpenToSide &&
    previous.mode.onAddToChat === next.mode.onAddToChat &&
    previous.mode.onCopyPath === next.mode.onCopyPath &&
    previous.mode.onCopyRelativePath === next.mode.onCopyRelativePath &&
    previous.mode.onReveal === next.mode.onReveal &&
    previous.mode.revealTargetName === next.mode.revealTargetName &&
    previous.mode.onDownload === next.mode.onDownload &&
    previous.mode.onDuplicate === next.mode.onDuplicate &&
    previous.mode.onRevert === next.mode.onRevert
  );
}

function documentFileHeaderIdentityMatches(
  previous: DocumentFileHeaderProps,
  next: DocumentFileHeaderProps,
): boolean {
  return !(
    previous.file.file !== next.file.file ||
    previous.file.fileIndex !== next.file.fileIndex ||
    previous.file.isCollapsed !== next.file.isCollapsed ||
    previous.isViewed !== next.isViewed ||
    previous.viewedActionDisabled !== next.viewedActionDisabled ||
    previous.viewedActionPending !== next.viewedActionPending ||
    (previous.selectedPath === previous.file.path) !== (next.selectedPath === next.file.path) ||
    previous.onToggleFile !== next.onToggleFile ||
    previous.onToggleFileViewed !== next.onToggleFileViewed ||
    previous.onSelectPath !== next.onSelectPath ||
    previous.canvasRendered !== next.canvasRendered ||
    previous.onActiveChange !== next.onActiveChange ||
    previous.mode.kind !== next.mode.kind
  );
}
