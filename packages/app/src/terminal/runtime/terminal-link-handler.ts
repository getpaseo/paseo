import type { ILinkHandler } from "@xterm/xterm";

type UrlOpener = (url: string) => Promise<void> | void;

// OSC 8 hyperlinks bypass the web-links addon. Without a linkHandler xterm falls back to
// confirm() + window.open(), which on Electron spawns a new Paseo window. Route them
// through the same opener plain-text URLs already use.
export function createTerminalLinkHandler(getOpener: () => UrlOpener | undefined): ILinkHandler {
  return {
    activate: (event, uri) => {
      event.preventDefault();
      void getOpener()?.(uri);
    },
  };
}
