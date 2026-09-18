import { getVercelOidcToken } from "@vercel/oidc";

export interface VercelCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

function decodeClaims(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid OIDC token format");
  const payload = parts[1];
  const json = Buffer.from(payload, "base64url").toString("utf8");
  return JSON.parse(json) as Record<string, unknown>;
}

export async function resolveVercelCredentials(options?: {
  team?: string;
  project?: string;
}): Promise<VercelCredentials> {
  if (process.env.VERCEL_TOKEN) {
    const teamId = process.env.VERCEL_TEAM_ID ?? options?.team;
    const projectId = process.env.VERCEL_PROJECT_ID ?? options?.project;
    if (!teamId || !projectId) {
      throw new Error(
        "VERCEL_TOKEN requires VERCEL_TEAM_ID and VERCEL_PROJECT_ID, or pass --team and --project.",
      );
    }
    return { token: process.env.VERCEL_TOKEN, teamId, projectId };
  }

  const token = await getVercelOidcToken({ team: options?.team, project: options?.project });
  const claims = decodeClaims(token);
  const teamId = claims.owner_id as string | undefined;
  const projectId = claims.project_id as string | undefined;
  if (!teamId || !projectId) throw new Error("OIDC token did not include project scope");
  return { token, teamId, projectId };
}

export function resolveAgentKey(): string {
  const key = process.env.AI_GATEWAY_API_KEY;
  if (!key) throw new Error("AI_GATEWAY_API_KEY is required for Codex through Vercel AI Gateway");
  return key;
}

export async function verifyAgentKey(key: string): Promise<void> {
  const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("AI_GATEWAY_API_KEY was rejected by Vercel AI Gateway");
  }
  if (!res.ok) throw new Error(`AI Gateway check failed with HTTP ${res.status}`);
}
