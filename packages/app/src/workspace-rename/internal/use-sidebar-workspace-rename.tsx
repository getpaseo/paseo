import { type ReactNode, useCallback, useState } from "react";
import { useToast } from "@/contexts/toast-context";
import { InlineTitleField } from "./inline-title-field";
import { WorkspaceRenameModal } from "./modal";
import { resolveWorkspaceRenameSurface } from "./rename-surface";
import {
  type RenamableWorkspace,
  useSetWorkspaceTitle,
  workspaceRenameInitialValue,
} from "./set-workspace-title";

export interface SidebarRenamableWorkspace extends RenamableWorkspace {
  workspaceKey: string;
}

/**
 * An inline session owns the text editing started from. The field keeps that text while it is
 * open, so a rename arriving from elsewhere must not make an untouched field read as an edit.
 *
 * `saving` and `saved` keep the field on screen holding the submitted text. The daemon answers
 * the request before it pushes the updated workspace, so closing on the answer would show the
 * old title for a beat. `saved` ends when the row's title moves off the one it had at submit,
 * which is not the one editing started from when another client renamed it in between.
 */
type InlineRenameSession = { kind: "inline"; initialValue: string } & (
  | { phase: "editing" }
  | { phase: "saving" | "saved"; titleBeforeSave: string | null }
);

type RenameSession = { kind: "closed" } | { kind: "modal" } | InlineRenameSession;

const CLOSED: RenameSession = { kind: "closed" };

export interface SidebarWorkspaceRename {
  /** Starts a rename: in place on wide pointer layouts, in the rename modal otherwise. */
  begin: () => void;
  /** Rendered in place of the row's title while renaming in place; null otherwise. */
  titleEditor: ReactNode | null;
  /** Always render this; it is the modal for layouts that rename there. */
  modal: ReactNode;
}

export function useSidebarWorkspaceRename(
  workspace: SidebarRenamableWorkspace,
): SidebarWorkspaceRename {
  const toast = useToast();
  const setWorkspaceTitle = useSetWorkspaceTitle(workspace);
  const [session, setSession] = useState<RenameSession>(CLOSED);
  const currentTitle = workspace.title ?? null;

  if (
    session.kind === "inline" &&
    session.phase === "saved" &&
    currentTitle !== session.titleBeforeSave
  ) {
    setSession(CLOSED);
  }

  const initialValue = workspaceRenameInitialValue(workspace);
  const begin = useCallback(() => {
    setSession(
      resolveWorkspaceRenameSurface() === "inline"
        ? { kind: "inline", phase: "editing", initialValue }
        : { kind: "modal" },
    );
  }, [initialValue]);

  const close = useCallback(() => setSession(CLOSED), []);

  const commit = useCallback(
    (text: string) => {
      if (session.kind !== "inline") return;
      const title = text.trim();
      if (title.length === 0 || title === session.initialValue) {
        setSession(CLOSED);
        return;
      }
      setSession({
        kind: "inline",
        initialValue: session.initialValue,
        phase: "saving",
        titleBeforeSave: currentTitle,
      });
      setWorkspaceTitle(title).then(
        () =>
          setSession((previous) =>
            previous.kind === "inline" && previous.phase === "saving"
              ? { ...previous, phase: "saved" }
              : previous,
          ),
        (error: unknown) => {
          setSession(CLOSED);
          toast.error(error instanceof Error ? error.message : String(error));
        },
      );
    },
    [currentTitle, session, setWorkspaceTitle, toast],
  );

  const titleEditor =
    session.kind === "inline" ? (
      <InlineTitleField
        initialValue={session.initialValue}
        placeholder={workspace.name}
        readOnly={session.phase !== "editing"}
        onCommit={commit}
        onCancel={close}
        testID={`sidebar-workspace-rename-input-${workspace.workspaceKey}`}
      />
    ) : null;

  const modal = (
    <WorkspaceRenameModal
      visible={session.kind === "modal"}
      workspace={workspace}
      onClose={close}
      testID={`sidebar-workspace-rename-modal-${workspace.workspaceKey}`}
    />
  );

  return { begin, titleEditor, modal };
}
