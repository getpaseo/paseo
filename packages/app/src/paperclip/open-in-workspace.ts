// The workspace on screen registers how it opens a URL as its own browser tab (desktop only);
// Paperclip issue links use it so the task opens next to the session instead of elsewhere.
let opener: ((url: string) => void) | null = null;

const PAPERCLIP_ISSUE_PATH = /\/[A-Z][A-Z0-9]*\/issues\/[A-Z][A-Z0-9]*-\d+(?:[/?#]|$)/;

export function registerWorkspaceUrlOpener(open: (url: string) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** Opens a Paperclip issue URL as a workspace tab; false when it is not one or no tab host exists. */
export function openPaperclipIssueInWorkspace(url: string): boolean {
  if (!opener || !PAPERCLIP_ISSUE_PATH.test(url)) return false;
  opener(url);
  return true;
}
