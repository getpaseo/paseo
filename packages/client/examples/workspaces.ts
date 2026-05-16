import { createPaseoClient, type PaseoClient } from "@getpaseo/client";

export function createClient(url: string): PaseoClient {
  return createPaseoClient({
    url,
  });
}

export async function createOpenAndArchiveWorkspace(url: string, cwd: string): Promise<void> {
  const client = createClient(url);

  try {
    await client.connect();

    const created = await client.workspaces.create(cwd);
    if (!created.workspace) {
      throw new Error(created.error ?? "Workspace creation failed");
    }

    const opened = await client.workspaces.open(cwd);
    if (!opened.workspace) {
      throw new Error(opened.error ?? "Workspace open failed");
    }

    await opened.workspace.refetch();
    await opened.workspace.archive();
  } finally {
    await client.close();
  }
}
