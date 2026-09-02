import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  WORKSPACE_LABEL_COLORS,
  normalizeWorkspaceLabelName,
  type WorkspaceLabelColor,
} from "@getpaseo/protocol/workspace-labels";
import type { CommandError, OutputSchema } from "../../output/index.js";
import { buildDaemonConnectionCommandError, connectToDaemon } from "../../utils/client.js";

export const CLI_WORKSPACE_LABEL_SUBSCRIPTION_ID = "paseo-cli-workspace-labels";

export function formatWorkspaceLabelNameForTerminal(name: string): string {
  let escaped = "";
  for (const character of name) {
    const code = character.charCodeAt(0);
    const isControlCharacter = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    escaped += isControlCharacter ? `\\u${code.toString(16).padStart(4, "0")}` : character;
  }
  return escaped;
}

export interface WorkspaceLabelRow {
  name: string;
  color: WorkspaceLabelColor;
}

export const workspaceLabelSchema: OutputSchema<WorkspaceLabelRow> = {
  idField: (label) => formatWorkspaceLabelNameForTerminal(label.name),
  columns: [
    {
      header: "NAME",
      field: (label) => formatWorkspaceLabelNameForTerminal(label.name),
      width: 30,
    },
    { header: "COLOR", field: "color", width: 12 },
  ],
};

interface WorkspaceLabelClientOptions {
  host?: string;
  requiresCreate?: boolean;
}

function supportsWorkspaceLabelCreate(client: DaemonClient): boolean {
  const features = client.getLastServerInfoMessage()?.features;
  return features?.workspaceLabelCreate === true;
}

export async function withWorkspaceLabelsClient<T>(
  options: WorkspaceLabelClientOptions,
  run: (client: DaemonClient) => Promise<T>,
): Promise<T> {
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    throw buildDaemonConnectionCommandError({ host: options.host, error });
  });

  try {
    // COMPAT(workspaceLabels): added in v0.5.0, remove gate after 2027-08-14.
    if (client.getLastServerInfoMessage()?.features?.workspaceLabels !== true) {
      throw {
        code: "DAEMON_UPDATE_REQUIRED",
        message: "Update the host to manage workspace labels.",
        details: "The connected daemon does not advertise workspace label support.",
      } satisfies CommandError;
    }

    if (options.requiresCreate) {
      // COMPAT(workspaceLabelCreate): added in v0.7.0, remove gate after 2027-08-28.
      if (!supportsWorkspaceLabelCreate(client)) {
        throw {
          code: "DAEMON_UPDATE_REQUIRED",
          message: "Update the host to create workspace labels.",
          details: "The connected daemon does not advertise workspace label creation support.",
        } satisfies CommandError;
      }
    }

    return await run(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export function resolveWorkspaceLabelName(name: string): string {
  const normalized = normalizeWorkspaceLabelName(name);
  if (normalized.length === 0) {
    throw {
      code: "INVALID_LABEL_NAME",
      message: "Label name cannot be empty.",
      details: "Pass a non-empty workspace label name.",
    } satisfies CommandError;
  }
  return normalized;
}

function isWorkspaceLabelColor(value: string): value is WorkspaceLabelColor {
  return WORKSPACE_LABEL_COLORS.some((color) => color === value);
}

export function resolveWorkspaceLabelColor(color?: string): WorkspaceLabelColor {
  const resolved = color ?? WORKSPACE_LABEL_COLORS[0];
  if (!isWorkspaceLabelColor(resolved)) {
    throw {
      code: "INVALID_LABEL_COLOR",
      message: `Unknown workspace label color: ${resolved}`,
      details: `Choose one of: ${WORKSPACE_LABEL_COLORS.join(", ")}`,
    } satisfies CommandError;
  }
  return resolved;
}
