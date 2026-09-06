import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { ProjectRegistry } from "../../workspace-registry.js";
import {
  decodeLocalFile,
  importLocalFile,
  inspectLocalFiles,
  localFileError,
  LocalFileFailure,
  readLocalFile,
} from "../../local-files/files.js";

export type LocalFilesRequest = Extract<
  SessionInboundMessage,
  {
    type:
      | "project.local_files.inspect.request"
      | "project.local_files.read.request"
      | "project.local_files.import.request";
  }
>;

export async function handleLocalFilesRequest(
  msg: LocalFilesRequest,
  registry: Pick<ProjectRegistry, "get">,
): Promise<SessionOutboundMessage> {
  try {
    const project = await registry.get(msg.projectId);
    if (!project || project.archivedAt !== null) throw new LocalFileFailure("project_not_found");
    const root = project.rootPath;
    switch (msg.type) {
      case "project.local_files.inspect.request":
        return {
          type: "project.local_files.inspect.response",
          payload: {
            requestId: msg.requestId,
            files: await inspectLocalFiles(root, msg.paths),
            error: null,
          },
        };
      case "project.local_files.read.request":
        return {
          type: "project.local_files.read.response",
          payload: {
            requestId: msg.requestId,
            data: (await readLocalFile({ ...msg, root })).toString("base64"),
            error: null,
          },
        };
      case "project.local_files.import.request":
        return {
          type: "project.local_files.import.response",
          payload: {
            requestId: msg.requestId,
            file: await importLocalFile({ ...msg, root, bytes: decodeLocalFile(msg.data) }),
            error: null,
          },
        };
    }
  } catch (error) {
    const payload = { requestId: msg.requestId, error: localFileError(error) };
    switch (msg.type) {
      case "project.local_files.inspect.request":
        return { type: "project.local_files.inspect.response", payload: { ...payload, files: [] } };
      case "project.local_files.read.request":
        return { type: "project.local_files.read.response", payload: { ...payload, data: null } };
      case "project.local_files.import.request":
        return { type: "project.local_files.import.response", payload: { ...payload, file: null } };
    }
  }
}
