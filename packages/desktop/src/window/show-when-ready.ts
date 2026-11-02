interface ReadyToShowWindow {
  once(event: "ready-to-show", listener: () => void): unknown;
  webContents: {
    once(event: "did-finish-load", listener: () => void): unknown;
  };
  show(): void;
  isDestroyed(): boolean;
}

export function showWindowWhenReady(
  win: ReadyToShowWindow,
  options: { showOnLoad: boolean },
): void {
  let shown = false;
  const show = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
  };

  win.once("ready-to-show", show);
  // On Linux a hidden window can wait for compositor frames until it is shown.
  // Loading the document is sufficient to reveal it without depending on a frame.
  if (options.showOnLoad) win.webContents.once("did-finish-load", show);
}
