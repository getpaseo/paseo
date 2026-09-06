import { z } from "zod";

export const LOCAL_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const LOCAL_FILES_MAX_COUNT = 100;
export const LOCAL_FILES_MAX_BYTES = 25 * 1024 * 1024;
export const LOCAL_FILE_AUTOSELECT_BYTES = 1024 * 1024;

export const LocalFilePathSchema = z.string().min(1).max(512);
export const LocalFileRevisionSchema = z.string().max(128);
export const LocalFileInfoSchema = z.object({
  path: LocalFilePathSchema,
  status: z.enum(["ready", "missing", "not_ignored", "unsupported", "too_large", "unavailable"]),
  size: z.number().nonnegative(),
  revision: LocalFileRevisionSchema.nullable(),
});
export type LocalFileInfo = z.infer<typeof LocalFileInfoSchema>;

export const LocalFileErrorSchema = z.enum([
  "project_not_found",
  "invalid_path",
  "not_ignored",
  "unsupported",
  "too_large",
  "missing",
  "changed",
  "invalid_data",
  "unavailable",
  "invalid_config",
]);
export type LocalFileError = z.infer<typeof LocalFileErrorSchema>;

export const InspectLocalFilesRequestSchema = z.object({
  type: z.literal("project.local_files.inspect.request"),
  requestId: z.string(),
  projectId: z.string(),
  paths: z.array(LocalFilePathSchema).max(LOCAL_FILES_MAX_COUNT).optional(),
});
export const InspectLocalFilesResponseSchema = z.object({
  type: z.literal("project.local_files.inspect.response"),
  payload: z.object({
    requestId: z.string(),
    files: z.array(LocalFileInfoSchema),
    error: LocalFileErrorSchema.nullable(),
  }),
});
export const ReadLocalFileRequestSchema = z.object({
  type: z.literal("project.local_files.read.request"),
  requestId: z.string(),
  projectId: z.string(),
  path: LocalFilePathSchema,
  expectedRevision: LocalFileRevisionSchema,
});
export const ReadLocalFileResponseSchema = z.object({
  type: z.literal("project.local_files.read.response"),
  payload: z.object({
    requestId: z.string(),
    data: z.string().nullable(),
    error: LocalFileErrorSchema.nullable(),
  }),
});
export const ImportLocalFileRequestSchema = z.object({
  type: z.literal("project.local_files.import.request"),
  requestId: z.string(),
  projectId: z.string(),
  path: LocalFilePathSchema,
  expectedRevision: LocalFileRevisionSchema.nullable(),
  data: z.string().max(Math.ceil(LOCAL_FILE_MAX_BYTES / 3) * 4),
});
export const ImportLocalFileResponseSchema = z.object({
  type: z.literal("project.local_files.import.response"),
  payload: z.object({
    requestId: z.string(),
    file: LocalFileInfoSchema.nullable(),
    error: LocalFileErrorSchema.nullable(),
  }),
});
