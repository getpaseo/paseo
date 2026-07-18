import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "@getpaseo/protocol/binary-frames/index";
import type {
  FileDownloadTokenRequest,
  FileExplorerCreateRequest,
  FileExplorerDeleteRequest,
  FileExplorerDuplicateRequest,
  FileExplorerRenameRequest,
  FileExplorerRequest,
  FileUploadRequest,
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
  readExplorerFileBytes,
  renameExplorerEntry,
} from "../../file-explorer/service.js";
import { getProjectIcon } from "../../../utils/project-icon.js";

/**
 * What a workspace file-access request reaches outside its own domain: the
 * outbound message channel (text + binary). `hasBinaryChannel` gates the
 * binary file-explorer transfer path the same way the terminal subsystem does
 * — old clients without a binary channel fall back to inline JSON file content.
 */
export interface WorkspaceFilesSessionHost {
  emit(msg: SessionOutboundMessage): void;
  emitBinary(frame: Uint8Array): void;
  hasBinaryChannel(): boolean;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
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

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
  }

  async handleFileExplorerRequest(request: FileExplorerRequest): Promise<void> {
    const { cwd: workspaceCwd, path: requestedPath = ".", mode, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
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
      });
      return;
    }

    try {
      if (mode === "list") {
        const directory = await listDirectoryEntries({
          root: cwd,
          relativePath: requestedPath,
        });

        this.host.emit({
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
        });
      } else {
        if (request.acceptBinary && this.host.hasBinaryChannel()) {
          const file = await readExplorerFileBytes({
            root: cwd,
            relativePath: requestedPath,
          });

          this.host.emitBinary(
            encodeFileTransferFrame({
              opcode: FileTransferOpcode.FileBegin,
              requestId,
              metadata: {
                mime: file.mimeType,
                size: file.size,
                encoding: file.encoding,
                modifiedAt: file.modifiedAt,
              },
            }),
          );
          this.host.emitBinary(
            encodeFileTransferFrame({
              opcode: FileTransferOpcode.FileChunk,
              requestId,
              payload: file.bytes,
            }),
          );
          this.host.emitBinary(
            encodeFileTransferFrame({
              opcode: FileTransferOpcode.FileEnd,
              requestId,
            }),
          );
        } else {
          const file = await readExplorerFile({
            root: cwd,
            relativePath: requestedPath,
          });

          this.host.emit({
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
          });
        }
      }
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: requestedPath },
        `Failed to fulfill file explorer request for workspace ${cwd}`,
      );
      this.host.emit({
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
      });
    }
  }

  async handleFileExplorerCreateRequest(request: FileExplorerCreateRequest): Promise<void> {
    const { cwd: workspaceCwd, parentPath, name, kind, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file.explorer.create.response",
        payload: {
          cwd: workspaceCwd,
          entry: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    try {
      const entry = await createExplorerEntry({
        root: cwd,
        parentPath,
        name,
        kind,
      });
      this.host.emit({
        type: "file.explorer.create.response",
        payload: {
          cwd,
          entry,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, parentPath, name, kind },
        `Failed to create explorer entry for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file.explorer.create.response",
        payload: {
          cwd,
          entry: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileExplorerRenameRequest(request: FileExplorerRenameRequest): Promise<void> {
    const { cwd: workspaceCwd, path: entryPath, newName, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file.explorer.rename.response",
        payload: {
          cwd: workspaceCwd,
          entry: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    try {
      const entry = await renameExplorerEntry({
        root: cwd,
        path: entryPath,
        newName,
      });
      this.host.emit({
        type: "file.explorer.rename.response",
        payload: {
          cwd,
          entry,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: entryPath, newName },
        `Failed to rename explorer entry for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file.explorer.rename.response",
        payload: {
          cwd,
          entry: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileExplorerDeleteRequest(request: FileExplorerDeleteRequest): Promise<void> {
    const { cwd: workspaceCwd, path: entryPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file.explorer.delete.response",
        payload: {
          cwd: workspaceCwd,
          path: entryPath,
          success: false,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    try {
      await deleteExplorerEntry({
        root: cwd,
        path: entryPath,
      });
      this.host.emit({
        type: "file.explorer.delete.response",
        payload: {
          cwd,
          path: entryPath,
          success: true,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: entryPath },
        `Failed to delete explorer entry for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file.explorer.delete.response",
        payload: {
          cwd,
          path: entryPath,
          success: false,
          error: getErrorMessage(error),
          requestId,
        },
      });
    }
  }

  async handleFileExplorerDuplicateRequest(request: FileExplorerDuplicateRequest): Promise<void> {
    const { cwd: workspaceCwd, path: entryPath, requestId } = request;
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      this.host.emit({
        type: "file.explorer.duplicate.response",
        payload: {
          cwd: workspaceCwd,
          entry: null,
          error: "cwd is required",
          requestId,
        },
      });
      return;
    }

    try {
      const entry = await duplicateExplorerEntry({
        root: cwd,
        path: entryPath,
      });
      this.host.emit({
        type: "file.explorer.duplicate.response",
        payload: {
          cwd,
          entry,
          error: null,
          requestId,
        },
      });
    } catch (error) {
      this.logger.error(
        { err: error, cwd, path: entryPath },
        `Failed to duplicate explorer entry for workspace ${cwd}`,
      );
      this.host.emit({
        type: "file.explorer.duplicate.response",
        payload: {
          cwd,
          entry: null,
          error: getErrorMessage(error),
          requestId,
        },
      });
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
