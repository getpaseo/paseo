import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { getIsElectron } from "@/constants/platform";
import { useAppSettings } from "@/hooks/use-settings";
import { isHttpUrl } from "@/utils/http-url";
import { openExternalUrl } from "@/utils/open-external-url";
import { resolveExternalLinkAction, type ExternalLinkClick } from "./external-link-action";
import { LinkPopover, type LinkPopoverTarget } from "./popover";

export type OpenExternalLink = (click: ExternalLinkClick) => void;

function openInSystemBrowser(url: string): void {
  void openExternalUrl(url);
}

function openClickInSystemBrowser(click: ExternalLinkClick): void {
  openInSystemBrowser(click.url);
}

// Surfaces outside a provider have no Paseo browser to offer.
const ExternalLinkContext = createContext<OpenExternalLink>(openClickInSystemBrowser);

/** Opens an http(s) link click the way the user's link settings and modifiers ask for. */
export function useOpenExternalLink(): OpenExternalLink {
  return useContext(ExternalLinkContext);
}

interface ExternalLinkProviderProps {
  onOpenInPaseoBrowser: (url: string) => void;
  children: ReactNode;
}

export function ExternalLinkProvider({
  onOpenInPaseoBrowser,
  children,
}: ExternalLinkProviderProps) {
  const { settings } = useAppSettings();
  const popoverEnabled = settings.linkPopoverEnabled;
  const [popoverTarget, setPopoverTarget] = useState<LinkPopoverTarget | null>(null);
  const closePopover = useCallback(() => setPopoverTarget(null), []);

  const openLink = useCallback(
    (click: ExternalLinkClick) => {
      if (!isHttpUrl(click.url)) {
        return;
      }
      const action = resolveExternalLinkAction({
        primaryModifier: click.primaryModifier,
        shift: click.shift,
        popoverEnabled,
        paseoBrowserAvailable: getIsElectron(),
      });
      switch (action) {
        case "show-popover":
          setPopoverTarget({ url: click.url, x: click.clientX, y: click.clientY });
          return;
        case "open-in-paseo-browser":
          onOpenInPaseoBrowser(click.url);
          return;
        case "open-in-system-browser":
          openInSystemBrowser(click.url);
          return;
      }
    },
    [onOpenInPaseoBrowser, popoverEnabled],
  );

  return (
    <ExternalLinkContext.Provider value={openLink}>
      {children}
      <LinkPopover
        target={popoverTarget}
        onClose={closePopover}
        onOpenInPaseoBrowser={onOpenInPaseoBrowser}
        onOpenInSystemBrowser={openInSystemBrowser}
      />
    </ExternalLinkContext.Provider>
  );
}
