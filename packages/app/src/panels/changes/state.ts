import { z } from "zod";

export const changesStateSchema = z.strictObject({
  mode: z.enum(["uncommitted", "base"]),
  baseRef: z.string().optional(),
  layout: z.enum(["unified", "split"]),
  wrapLines: z.boolean(),
  hideWhitespace: z.boolean(),
  treeVisible: z.boolean(),
  treeWidth: z.number().optional(),
  collapsedFilePaths: z.array(z.string()),
  collapsedFolderPaths: z.array(z.string()),
  commitsCollapsed: z.boolean(),
});

export type ChangesState = z.infer<typeof changesStateSchema>;

export const defaultChangesState: ChangesState = {
  mode: "uncommitted",
  layout: "unified",
  wrapLines: false,
  hideWhitespace: false,
  treeVisible: false,
  collapsedFilePaths: [],
  collapsedFolderPaths: [],
  commitsCollapsed: true,
};
