import { z } from "zod";

export const fileStateSchema = z.strictObject({
  treeVisible: z.boolean(),
  treeWidth: z.number().optional(),
});

export type FileState = z.infer<typeof fileStateSchema>;

export const defaultFileState: FileState = { treeVisible: false };

export const fileStateForFilesView: FileState = { treeVisible: true };
