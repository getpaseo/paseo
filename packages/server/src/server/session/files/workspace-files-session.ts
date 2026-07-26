import type pino from "pino";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type { FileTransferFrame } from "@getpaseo/protocol/binary-frames/index";
import { emitChunkedFileTransfer, type FileTransferOutcome } from "./file-transfer-emitter.js";
import type {
  FileDownloadTokenRequest,
  FileExplorerRequest,
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
  getDownloadableFileInfo,
  listDirectoryEntries,
  readExplorerFile,
  readExplorerFileBytes,
  writeExplorerFile,
  type FileExplorerFileBytes,
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
  emit(msg: SessionOutboundMessage): void;
  emitBinary(frame: Uint8Array): void;
  hasBinaryChannel(): boolean;
  /** Bytes queued for the client, or null when the transport reports no signal. */
  getClientBufferedAmount(): number | null;
}

export interface WorkspaceFilesSessionOptions {
  host: WorkspaceFilesSessionHost;
  downloadTokenStore: DownloadTokenStore;
  paseoHome: string;
  logger: pino.Logger;
  fileObserver?: FileObserver;
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
  private readonly fileSubscriptions = new Map<string, () => void>();
  private disposed = false;

  constructor(options: WorkspaceFilesSessionOptions) {
    this.host = options.host;
    this.downloadTokenStore = options.downloadTokenStore;
    this.logger = options.logger;
    this.fileUploads = new FileUploadStore({ paseoHome: options.paseoHome });
    this.fileObserver = options.fileObserver ?? workspaceFileObserver;
  }

  async handleFileSubscribeRequest(request: FileSubscribeRequest): Promise<void> {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    try {
      const subscription = await this.fileObserver.subscribe(
        { cwd: request.cwd, path: request.path },
        (version) => {
          this.host.emit({
            type: "fs.file.update",
            payload: { subscriptionId: request.subscriptionId, version },
          });
        },
      );
      this.fileSubscriptions.set(request.subscriptionId, subscription.unsubscribe);
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

  handleFileUnsubscribeRequest(request: FileUnsubscribeRequest): void {
    this.fileSubscriptions.get(request.subscriptionId)?.();
    this.fileSubscriptions.delete(request.subscriptionId);
    this.host.emit({
      type: "fs.file.unsubscribe.response",
      payload: { subscriptionId: request.subscriptionId, requestId: request.requestId },
    });
  }

  async handleFileWriteRequest(request: FileWriteRequest): Promise<void> {
    const result = await writeExplorerFile({
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

  dispose(): void {
    this.disposed = true;
    for (const unsubscribe of this.fileSubscriptions.values()) unsubscribe();
    this.fileSubscriptions.clear();
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

          const outcome = await emitChunkedFileTransfer({
            sink: {
              emitBinary: (frame) => this.host.emitBinary(frame),
              getClientBufferedAmount: () => this.host.getClientBufferedAmount(),
              isDisposed: () => this.disposed,
            },
            requestId,
            file,
          });

          this.reportFileTransferOutcome({ outcome, cwd, mode, requestId, file });
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

  private reportFileTransferOutcome(input: {
    outcome: FileTransferOutcome;
    cwd: string;
    mode: FileExplorerRequest["mode"];
    requestId: string;
    file: FileExplorerFileBytes;
  }): void {
    const { outcome, cwd, mode, requestId, file } = input;
    if (outcome.status === "sent") {
      return;
    }

    this.logger.warn(
      { requestId, reason: outcome.reason, size: file.size },
      "file transfer aborted",
    );
    if (outcome.reason !== "stalled") {
      return;
    }

    // A stalled client never receives FileEnd, so the read would hang on the
    // correlated response. Fail it explicitly instead.
    this.host.emit({
      type: "file_explorer_response",
      payload: {
        cwd,
        path: file.path,
        mode,
        directory: null,
        file: null,
        error: "File transfer stalled: the client stopped reading.",
        requestId,
      },
    });
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
