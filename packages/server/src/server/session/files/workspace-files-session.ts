import type pino from "pino";
import { areEquivalentPaths } from "../../../utils/path.js";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  FileDownloadTokenRequest,
  FileEntryCreateRequest,
  FileEntryDeleteRequest,
  FileEntryDuplicateRequest,
  FileEntryRenameRequest,
  FileExplorerRequest,
  FileUploadRequest,
  FileSubscribeRequest,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { WorkspaceFileKind, WorkspaceFiles } from "@getpaseo/workspace-helper";
import type { WorkspaceRuntimeService } from "../../workspace-runtime/index.js";
import type { WorkspaceRegistry } from "../../workspace-registry.js";
import { FileUploadStore } from "../../file-upload/index.js";
import type { DownloadTokenStore } from "../../file-download/token-store.js";
import {
  createExplorerEntry,
  deleteExplorerEntry,
  duplicateExplorerEntry,
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  renameExplorerEntry,
  streamExplorerFile,
  writeExplorerFile,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import {
  getProjectIcon,
  ICON_PATTERNS,
  IGNORED_DIRS,
  MONOREPO_PACKAGE_DIRS,
  PRIORITY_DIRS,
  projectIconFromBytes,
} from "../../../utils/project-icon.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage, source?: object): void;
  emitBinary(frame: Uint8Array, source?: object): Promise<void>;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
  workspaceRuntime?: WorkspaceRuntimeService;
  workspaceRegistry?: Pick<WorkspaceRegistry, "get" | "list">;
}

/**
 * A client's workspace file-access surface: browsing directories, reading file
 * contents (inline JSON or binary frames), receiving uploads, issuing download
 * tokens, and reading project icons. It owns the upload store and reaches no
 * workspace-git, registry, or subscription state — file I/O scoped to a cwd is
 * the whole concern.
 */
export class WorkspaceFilesSession {
  private readonly host: WorkspaceFilesSessionHost;
  private readonly downloadTokenStore: DownloadTokenStore;
  private readonly logger: pino.Logger;
  private readonly fileUploads: FileUploadStore;
  private readonly fileObserver: FileObserver;
  private readonly workspaceRuntime: WorkspaceRuntimeService | null;
  private readonly workspaceRegistry: Pick<WorkspaceRegistry, "get" | "list"> | null;
  private readonly fileSubscriptions = new Map<string, () => Promise<void>>();

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
    this.workspaceRuntime = options.workspaceRuntime ?? null;
    this.workspaceRegistry = options.workspaceRegistry ?? null;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    await this.fileSubscriptions.get(request.subscriptionId)?.();
    try {
      const selectedFiles = await this.resolveSelectedFiles(request.cwd, request.workspaceId);
      if (selectedFiles) {
        const subscription = await selectedFiles.subscribe({ paths: [request.path] }, (event) => {
          if (event.type === "overflow") return;
          if (event.type === "error") {
            this.host.emit({
              type: "fs.file.update",
              payload: {
                subscriptionId: request.subscriptionId,
                version: {
                  status: "error",
                  cwd: request.cwd,
                  path: request.path,
                  error: event.error,
                },
              },
            });
            return;
          }
          void selectedFiles.stat(request.path).then(
            (version) =>
              this.host.emit({
                type: "fs.file.update",
                payload: {
                  subscriptionId: request.subscriptionId,
                  version: toProtocolVersion(request.cwd, version),
                },
              }),
            (error) =>
              this.host.emit({
                type: "fs.file.update",
                payload: {
                  subscriptionId: request.subscriptionId,
                  version: {
                    status: "error",
                    cwd: request.cwd,
                    path: request.path,
                    error: getErrorMessage(error),
                  },
                },
              }),
          );
        });
        const initial = toProtocolVersion(request.cwd, await selectedFiles.stat(request.path));
        this.fileSubscriptions.set(request.subscriptionId, () => subscription.unsubscribe());
        this.host.emit({
          type: "fs.file.subscribe.response",
          payload: {
            subscriptionId: request.subscriptionId,
            initial,
            requestId: request.requestId,
          },
        });
        return;
      }
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.host.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(request.subscriptionId, async () => subscription.unsubscribe());
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: getErrorMessage(error),
          },
          requestId: request.requestId,
        },
      });
    }
  }

  async handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): Promise<void> {
    await this.fileSubscriptions.get(request.subscriptionId)?.();
    this.fileSubscriptions.delete(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const selectedFiles = await this.resolveSelectedFiles(request.cwd, request.workspaceId);
    const result = selectedFiles
      ? toProtocolWriteResult(
          request.cwd,
          await selectedFiles.write({
            path: request.path,
            contents: Buffer.from(request.content, "utf8"),
            expectedModifiedAt: request.expectedModifiedAt,
            expectedRevision: request.expectedRevision,
          }),
        )
      : await writeExplorerFile({
          root: request.cwd,
          relativePath: request.path,
          content: request.content,
          expectedModifiedAt: request.expectedModifiedAt,
          expectedRevision: request.expectedRevision,
        });
    this.host.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    const result = await createExplorerEntry({
      root: request.cwd,
      parentPath: request.parentPath,
      name: request.name,
      kind: request.kind,
    });
    this.host.emit({
      type: "fs.entry.create.response",
      payload: {
        cwd: request.cwd,
        parentPath: request.parentPath,
        path: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryRenameRequest(request: FileEntryRenameRequest): Promise<void> {
    const result = await renameExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
      name: request.name,
    });
    this.host.emit({
      type: "fs.entry.rename.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        renamedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDuplicateRequest(request: FileEntryDuplicateRequest): Promise<void> {
    const result = await duplicateExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.duplicate.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        duplicatedPath: result.status === "ok" ? result.path : null,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async handleFileEntryDeleteRequest(request: FileEntryDeleteRequest): Promise<void> {
    const result = await deleteExplorerEntry({
      root: request.cwd,
      relativePath: request.path,
    });
    this.host.emit({
      type: "fs.entry.delete.response",
      payload: {
        cwd: request.cwd,
        path: request.path,
        success: result.status === "ok",
        error: result.status === "ok" ? null : result.error,
        requestId: request.requestId,
      },
    });
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.fileSubscriptions.values()].map((unsubscribe) => unsubscribe()));
    this.fileSubscriptions.clear();
  }

  async handleFileExplorerRequest(request: FileExplorerRequest, source?: object): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd: workspaceCwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: "cwd is required",
            requestId,
          },
        },
        source,
      );
      return;
    }

    try {
      const selectedFiles = await this.resolveSelectedFiles(cwd, request.workspaceId);
      if (mode === "list") {
        const directory = selectedFiles
          ? await selectedFiles.list(requestedPath)
          : await listDirectoryEntries({ root: cwd, relativePath: requestedPath });

        this.host.emit(
          {
            type: "file_explorer_response",
            payload: {
              cwd,
              path: directory.path,
              mode,
              directory,
              file: null,
              error: null,
              requestId,
            },
          },
          source,
        );
      } else {
        if (selectedFiles) {
          const file = await selectedFiles.read(requestedPath);
          if (request.acceptBinary && this.host.hasBinaryChannel()) {
            await this.emitStream(requestId, file, source);
          } else {
            const bytes = await collectBytes(file.chunks);
            this.host.emit(
              {
                type: "file_explorer_response",
                payload: {
                  cwd,
                  path: file.path,
                  mode,
                  directory: null,
                  file: {
                    path: file.path,
                    kind: file.kind,
                    encoding: explorerEncoding(file.kind),
                    ...explorerContent(file.kind, bytes),
                    mimeType: file.mimeType,
                    size: file.size,
                    modifiedAt: file.modifiedAt,
                    revision: file.revision,
                  },
                  error: null,
                  requestId,
                },
              },
              source,
            );
          }
          return;
        }
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          await streamExplorerFile({ root: cwd, relativePath: requestedPath }, async (file) => {
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileBegin,
                requestId,
                metadata: {
                  mime: file.mimeType,
                  size: file.size,
                  encoding: file.encoding,
                  modifiedAt: file.modifiedAt,
                  revision: file.revision,
                },
              }),
              source,
            );
            for await (const chunk of file.chunks) {
              await this.host.emitBinary(
                encodeFileTransferFrame({
                  opcode: FileTransferOpcode.FileChunk,
                  requestId,
                  payload: chunk,
                }),
                source,
              );
            }
            await this.host.emitBinary(
              encodeFileTransferFrame({
                opcode: FileTransferOpcode.FileEnd,
                requestId,
              }),
              source,
            );
          });
        } else {
          const file = await readExplorerFile({
            root: cwd,
            relativePath: requestedPath,
          });

          this.host.emit(
            {
              type: "file_explorer_response",
              payload: {
                cwd,
                path: file.path,
                mode,
                directory: null,
                file,
                error: null,
                requestId,
              },
            },
            source,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.host.emit(
        {
          type: "file_explorer_response",
          payload: {
            cwd,
            path: requestedPath,
            mode,
            directory: null,
            file: null,
            error: getErrorMessage(error),
            requestId,
          },
        },
        source,
      );
    }
  }

  handleFileUploadRequest(request: FileUploadRequest): void {
    this.fileUploads.beginUpload(request);
  }

  async handleFileTransferFrame(frame: FileTransferFrame): Promise<void> {
    const response = await this.fileUploads.receiveFrame(frame);
    if (response) {
      this.host.emit(response);
    }
  }

  async handleProjectIconRequest(
    request: Extract<SessionInboundMessage, { type: "project_icon_request" }>,
  ): Promise<void> {
    const { cwd, requestId } = request;

    try {
      const selectedFiles = await this.resolveSelectedFiles(cwd, request.workspaceId);
      const icon = selectedFiles
        ? await getWorkspaceProjectIcon(selectedFiles)
        : await getProjectIcon(cwd);
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.host.emit({
        type: "project_icon_response",
        payload: {
          cwd,
          icon: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileDownloadTokenRequest(request: FileDownloadTokenRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd: workspaceCwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    this.logger.debug(
      { cwd, path: requestedPath },
      `Handling file download token request for workspace ${cwd} (${requestedPath})`,
    );

    try {
      const selectedFiles = await this.resolveSelectedFiles(cwd, request.workspaceId);
      if (selectedFiles) {
        const info = await selectedFiles.stat(requestedPath);
        if (info.status !== "ready") {
          throw new Error(info.status === "error" ? info.error : "File not found");
        }
        const entry = this.downloadTokenStore.issueToken({
          path: info.path,
          fileName: info.path.split("/").at(-1) ?? "download",
          mimeType: info.mimeType,
          size: info.size,
          open: async () => {
            const file = await selectedFiles.read(requestedPath);
            return { chunks: file.chunks, size: file.size };
          },
        });
        this.host.emit({
          type: "file_download_token_response",
          payload: {
            cwd,
            path: info.path,
            token: entry.token,
            fileName: entry.fileName,
            mimeType: entry.mimeType,
            size: entry.size,
            error: null,
            requestId,
          },
        });
        return;
      }
      const info = await getDownloadableFileInfo({
        root: cwd,
        relativePath: requestedPath,
      });

      const entry = this.downloadTokenStore.issueToken({
        path: info.path,
        absolutePath: info.absolutePath,
        fileName: info.fileName,
        mimeType: info.mimeType,
        size: info.size,
      });

      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: info.path,
          token: entry.token,
          fileName: entry.fileName,
          mimeType: entry.mimeType,
          size: entry.size,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to issue download token for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file_download_token_response",
        payload: {
          cwd,
          path: requestedPath,
          token: null,
          fileName: null,
          mimeType: null,
          size: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  private async resolveSelectedFiles(
    cwd: string,
    workspaceId: string | undefined,
  ): Promise<WorkspaceFiles | null> {
    if (!this.workspaceRuntime || !this.workspaceRegistry) return null;
    if (workspaceId) {
      const workspace = await this.workspaceRegistry.get(workspaceId);
      if (!workspace) throw new Error(`Workspace not found: ${workspaceId}`);
      return workspace.runtime ? this.workspaceRuntime.files(workspaceId) : null;
    }
    if (
      (await this.workspaceRegistry.list()).some(
        (workspace) =>
          workspace.archivedAt === null &&
          workspace.runtime &&
          areEquivalentPaths(workspace.cwd, cwd),
      )
    ) {
      throw new Error("workspaceId is required for a selected workspace file operation");
    }
    return null;
  }

  private async emitStream(
    requestId: string,
    file: Awaited<ReturnType<WorkspaceFiles["read"]>>,
    source?: object,
  ): Promise<void> {
    await this.host.emitBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: file.mimeType,
          size: file.size,
          encoding: file.encoding,
          modifiedAt: file.modifiedAt,
          revision: file.revision,
        },
      }),
      source,
    );
    for await (const chunk of file.chunks) {
      await this.host.emitBinary(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId,
          payload: chunk,
        }),
        source,
      );
    }
    await this.host.emitBinary(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
      source,
    );
  }
}

function explorerEncoding(kind: WorkspaceFileKind): "base64" | "none" | "utf-8" {
  if (kind === "image") return "base64";
  if (kind === "binary") return "none";
  return "utf-8";
}

function explorerContent(kind: WorkspaceFileKind, bytes: Uint8Array): { content?: string } {
  if (kind === "image") return { content: Buffer.from(bytes).toString("base64") };
  if (kind === "text") return { content: Buffer.from(bytes).toString("utf8") };
  return {};
}

function toProtocolVersion(cwd: string, version: Awaited<ReturnType<WorkspaceFiles["stat"]>>) {
  return { ...version, cwd };
}

function toProtocolWriteResult(cwd: string, result: Awaited<ReturnType<WorkspaceFiles["write"]>>) {
  return result.status === "conflict"
    ? { ...result, version: toProtocolVersion(cwd, result.version) }
    : result;
}

async function collectBytes(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers);
}

async function getWorkspaceProjectIcon(files: WorkspaceFiles) {
  const candidates = [...PRIORITY_DIRS, ...MONOREPO_PACKAGE_DIRS, "."];
  const ignored = new Set(IGNORED_DIRS);
  for (const root of candidates) {
    const icon = await findWorkspaceIcon(files, root, ignored, root === "." ? 0 : 2);
    if (!icon) continue;
    const read = await files.read(icon);
    if (read.size > 32 * 1024) continue;
    return projectIconFromBytes(icon, await collectBytes(read.chunks));
  }
  return null;
}

async function findWorkspaceIcon(
  files: WorkspaceFiles,
  directory: string,
  ignored: ReadonlySet<string>,
  depth: number,
): Promise<string | null> {
  let listing: Awaited<ReturnType<WorkspaceFiles["list"]>>;
  try {
    listing = await files.list(directory);
  } catch {
    return null;
  }
  for (const pattern of ICON_PATTERNS) {
    const expression = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
    const match = listing.entries.find(
      (entry) => entry.kind === "file" && expression.test(entry.name),
    );
    if (match) return match.path;
  }
  if (depth === 0) return null;
  for (const entry of listing.entries) {
    if (entry.kind !== "directory" || ignored.has(entry.name)) continue;
    const nested = await findWorkspaceIcon(files, entry.path, ignored, depth - 1);
    if (nested) return nested;
  }
  return null;
}
