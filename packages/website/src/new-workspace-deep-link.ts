export function buildNewWorkspaceDeepLink(input: string): string {
  const source = new URL(input, "https://paseo.sh");
  return `paseo://new${source.search}`;
}

export function createNewWorkspaceRedirect(input: string): Response {
  return new Response(null, {
    status: 307,
    headers: { Location: buildNewWorkspaceDeepLink(input) },
  });
}
