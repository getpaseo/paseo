const NEW_WORKSPACE_DEEP_LINK_HOST = "new";

export function parseNewWorkspaceDeepLink(input: unknown): string | null {
  if (typeof input !== "string" || !URL.canParse(input)) {
    return null;
  }

  const url = new URL(input);
  if (
    url.protocol !== "paseo:" ||
    url.hostname !== NEW_WORKSPACE_DEEP_LINK_HOST ||
    url.username ||
    url.password ||
    url.port ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    return null;
  }

  return `/new${url.search}`;
}

export function parseNewWorkspaceDeepLinkFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    const route = parseNewWorkspaceDeepLink(arg);
    if (route) {
      return route;
    }
  }
  return null;
}

export function redactNewWorkspacePromptFromArgv(argv: string[]): string[] {
  return argv.map((arg) => {
    if (!parseNewWorkspaceDeepLink(arg)) {
      return arg;
    }

    const url = new URL(arg);
    if (!url.searchParams.has("q")) {
      return arg;
    }
    url.searchParams.set("q", "REDACTED");
    return url.toString();
  });
}
