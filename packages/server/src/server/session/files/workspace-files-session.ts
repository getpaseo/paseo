import type pino from "pino";
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
  WorkspaceFileSystemStatusRequest,
  FileUploadRequest,
  FileSubscribeRequest,
  FileUnsubscribeRequest,
  FileWriteRequest,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
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
  type ExplorerFileVersion,
  type ExplorerFileWriteResult,
  type FileExplorerDirectory,
  type FileExplorerFile,
} from "../../file-explorer/service.js";
import { workspaceFileObserver, type FileObserver } from "../../file-explorer/observer.js";
import { getProjectIcon } from "../../../utils/project-icon.js";

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
  fileSystems?: WorkspaceFileSystemResolver;
  maxFileSubscriptions?: number;
  remoteFilePollIntervalMs?: number;
  remoteFilePolling?: RemoteFilePolling;
}

export interface WorkspaceFileSystemProvider {
  key: string;
  writable: boolean;
  getStatus?(input: { cwd: string }): Promise<WorkspaceFileSystemStatus>;
  listDirectory(input: { cwd: string; path: string }): Promise<FileExplorerDirectory>;
  readFile(input: { cwd: string; path: string; maxBytes?: number }): Promise<FileExplorerFile>;
  statFile(input: { cwd: string; path: string }): Promise<ExplorerFileVersion>;
  writeFile?(input: {
    cwd: string;
    path: string;
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<ExplorerFileWriteResult>;
}

export interface WorkspaceFileSystemStatus {
  state: "online" | "connecting" | "offline" | "error" | "unknown";
  detail?: string;
}

export interface WorkspaceFileSystemResolver {
  resolve(cwd: string): Promise<WorkspaceFileSystemProvider | null>;
}

export interface RemoteFilePolling {
  setInterval(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const DEFAULT_REMOTE_FILE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_FILE_SUBSCRIPTIONS = 64;
const nodeRemoteFilePolling: RemoteFilePolling = { setInterval, clearInterval };

function fileVersionFingerprint(version: ExplorerFileVersion): string {
  if (version.status === "ready") {
    return `ready:${version.revision ?? `${version.size}:${version.modifiedAt}`}`;
  }
  if (version.status === "error") return `error:${version.error}`;
  return version.status;
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
  private readonly fileSystems: WorkspaceFileSystemResolver | null;
  private readonly maxFileSubscriptions: number;
  private readonly remoteFilePollIntervalMs: number;
  private readonly remoteFilePolling: RemoteFilePolling;
  private readonly fileSubscriptions = new Map<string, () => void>();

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
    this.fileSystems = options.fileSystems ?? null;
    this.maxFileSubscriptions = options.maxFileSubscriptions ?? DEFAULT_MAX_FILE_SUBSCRIPTIONS;
    this.remoteFilePollIntervalMs =
      options.remoteFilePollIntervalMs ?? DEFAULT_REMOTE_FILE_POLL_INTERVAL_MS;
    this.remoteFilePolling = options.remoteFilePolling ?? nodeRemoteFilePolling;
  }

  async handleWorkspaceFileSystemStatusRequest(
    request: WorkspaceFileSystemStatusRequest,
  ): Promise<void> {
    const cwd = request.cwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "fs.workspace.status.response",
        payload: {
          cwd: request.cwd,
          status: null,
          error: "cwd is required",
          requestId: request.requestId,
        },
      });
      return;
    }

    try {
      const provider = await this.fileSystems?.resolve(cwd);
      const status = provider?.getStatus ? await provider.getStatus({ cwd }) : null;
      this.host.emit({
        type: "fs.workspace.status.response",
        payload: { cwd, status, error: null, requestId: request.requestId },
      });
    } catch (error) {
      this.host.emit({
        type: "fs.workspace.status.response",
        payload: {
          cwd,
          status: { state: "error", detail: getErrorMessage(error) },
          error: null,
          requestId: request.requestId,
        },
      });
    }
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    const previous = this.fileSubscriptions.get(request.subscriptionId);
    if (previous) {
      previous();
      this.fileSubscriptions.delete(request.subscriptionId);
    } else if (this.fileSubscriptions.size >= this.maxFileSubscriptions) {
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: {
            status: "error",
            cwd: request.cwd,
            path: request.path,
            error: `Too many file subscriptions (maximum ${this.maxFileSubscriptions})`,
          },
          requestId: request.requestId,
        },
      });
      return;
    }

    let active = true;
    let cleanup = () => {
      active = false;
    };
    this.fileSubscriptions.set(request.subscriptionId, cleanup);

    const installCleanup = (dispose: () => void): boolean => {
      if (!active) {
        dispose();
        return false;
      }
      cleanup = () => {
        active = false;
        dispose();
      };
      this.fileSubscriptions.set(request.subscriptionId, cleanup);
      return true;
    };

    try {
      const provider = await this.fileSystems?.resolve(request.cwd);
      if (!active) return;
      if (provider) {
        const initial = await provider.statFile({ cwd: request.cwd, path: request.path });
        if (!active) return;
        let checking = false;
        let fingerprint = fileVersionFingerprint(initial);
        const poll = this.remoteFilePolling.setInterval(async () => {
          if (!active || checking) return;
          checking = true;
          let version: ExplorerFileVersion;
          try {
            version = await provider.statFile({ cwd: request.cwd, path: request.path });
          } catch (error) {
            version = {
              status: "error",
              cwd: request.cwd,
              path: request.path,
              error: getErrorMessage(error),
            };
          } finally {
            checking = false;
          }
          if (!active) return;
          const nextFingerprint = fileVersionFingerprint(version);
          if (nextFingerprint === fingerprint) return;
          fingerprint = nextFingerprint;
          this.host.emit({
            type: "fs.file.update",
            payload: {
              subscriptionId: request.subscriptionId,
              version: { ...version, cwd: request.cwd, path: request.path },
            },
          });
        }, this.remoteFilePollIntervalMs);
        poll.unref?.();
        if (!installCleanup(() => this.remoteFilePolling.clearInterval(poll))) return;
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
      if (!installCleanup(subscription.unsubscribe)) return;
      this.host.emit({
        type: "fs.file.subscribe.response",
        payload: {
          subscriptionId: request.subscriptionId,
          initial: subscription.initial,
          requestId: request.requestId,
        },
      });
    } catch (error) {
      if (!active) return;
      if (this.fileSubscriptions.get(request.subscriptionId) === cleanup) {
        this.fileSubscriptions.delete(request.subscriptionId);
        cleanup();
      }
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

  handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): void {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    this.fileSubscriptions.delete(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const provider = await this.fileSystems?.resolve(request.cwd);
    let result: ExplorerFileWriteResult;
    if (!provider) {
      result = await writeExplorerFile({
        root: request.cwd,
        relativePath: request.path,
        content: request.content,
        expectedModifiedAt: request.expectedModifiedAt,
        expectedRevision: request.expectedRevision,
      });
    } else if (!provider.writeFile) {
      result = { status: "error", error: `Workspace file system ${provider.key} is read-only` };
    } else {
      result = await provider.writeFile({
        cwd: request.cwd,
        path: request.path,
        content: request.content,
        expectedModifiedAt: request.expectedModifiedAt,
        expectedRevision: request.expectedRevision,
      });
    }
    this.host.emit({
      type: "fs.file.write.response",
      payload: { result, requestId: request.requestId },
    });
  }

  async handleFileEntryCreateRequest(request: FileEntryCreateRequest): Promise<void> {
    const provider = await this.fileSystems?.resolve(request.cwd);
    if (provider) {
      this.host.emit({
        type: "fs.entry.create.response",
        payload: {
          cwd: request.cwd,
          parentPath: request.parentPath,
          path: null,
          success: false,
          error: `Workspace file system ${provider.key} does not support creating entries`,
          requestId: request.requestId,
        },
      });
      return;
    }
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
    const provider = await this.fileSystems?.resolve(request.cwd);
    if (provider) {
      this.host.emit({
        type: "fs.entry.rename.response",
        payload: {
          cwd: request.cwd,
          path: request.path,
          renamedPath: null,
          success: false,
          error: `Workspace file system ${provider.key} does not support renaming entries`,
          requestId: request.requestId,
        },
      });
      return;
    }
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
    const provider = await this.fileSystems?.resolve(request.cwd);
    if (provider) {
      this.host.emit({
        type: "fs.entry.duplicate.response",
        payload: {
          cwd: request.cwd,
          path: request.path,
          duplicatedPath: null,
          success: false,
          error: `Workspace file system ${provider.key} does not support duplicating entries`,
          requestId: request.requestId,
        },
      });
      return;
    }
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
    const provider = await this.fileSystems?.resolve(request.cwd);
    if (provider) {
      this.host.emit({
        type: "fs.entry.delete.response",
        payload: {
          cwd: request.cwd,
          path: request.path,
          success: false,
          error: `Workspace file system ${provider.key} does not support deleting entries`,
          requestId: request.requestId,
        },
      });
      return;
    }
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

  dispose(): void {
    for (const unsubscribe of this.fileSubscriptions.values()) unsubscribe();
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
      const provider = await this.fileSystems?.resolve(cwd);
      if (mode === "list") {
        const directory = provider
          ? await provider.listDirectory({ cwd, path: requestedPath })
          : await listDirectoryEntries({
              root: cwd,
              relativePath: requestedPath,
            });

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
        if (provider) {
          const file = await provider.readFile({
            cwd,
            path: requestedPath,
            maxBytes: request.maxBytes,
          });
          if (request.maxBytes && file.size > request.maxBytes) {
            throw new Error("File is too large to display");
          }
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
          return;
        }
        if (request.maxBytes) {
          const file = await getDownloadableFileInfo({ root: cwd, relativePath: requestedPath });
          if (file.size > request.maxBytes) {
            throw new Error("File is too large to display");
          }
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
      const icon = await getProjectIcon(cwd);
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
      const provider = await this.fileSystems?.resolve(cwd);
      if (provider) {
        throw new Error(`Workspace file system ${provider.key} does not support downloads`);
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
}
