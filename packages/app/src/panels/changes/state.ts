import { z } from "zod";

export const changesStateSchema = z
  .strictObject({
    // COMPAT(changesModeState): accepted from v0.5.0-beta.3 tab state; mode selection is ephemeral.
    mode: z.enum(["uncommitted", "base"]).optional(),
    baseRef: z.string().optional(),
    layout: z.enum(["unified", "split"]),
    wrapLines: z.boolean(),
    hideWhitespace: z.boolean(),
    treeVisible: z.boolean(),
    treeWidth: z.number().optional(),
    collapsedFilePaths: z.array(z.string()),
    collapsedFolderPaths: z.array(z.string()),
    commitsCollapsed: z.boolean(),
  })
  .transform(({ mode: _mode, baseRef: _baseRef, ...presentation }) => presentation);

export type ChangesState = z.infer<typeof changesStateSchema>;

export const defaultChangesState: ChangesState = {
  layout: "unified",
  wrapLines: false,
  hideWhitespace: false,
  treeVisible: false,
  collapsedFilePaths: [],
  collapsedFolderPaths: [],
  commitsCollapsed: true,
};
