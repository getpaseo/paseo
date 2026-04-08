import { Globe } from "lucide-react-native";
import invariant from "tiny-invariant";
import { BrowserPane } from "@/components/browser-pane";
import { usePaneContext } from "@/panels/pane-context";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useBrowserStore } from "@/stores/browser-store";

function getBrowserLabel(input: { title: string; url: string }): string {
  const title = input.title.trim();
  if (title) {
    return title;
  }

  try {
    const parsed = new URL(input.url);
    return parsed.hostname || input.url;
  } catch {
    return input.url;
  }
}

function useBrowserPanelDescriptor(target: { kind: "browser"; browserId: string }): PanelDescriptor {
  const browser = useBrowserStore((state) => state.browsersById[target.browserId] ?? null);
  const url = browser?.url ?? "https://example.com";

  return {
    label: getBrowserLabel({ title: browser?.title ?? "", url }),
    subtitle: url,
    titleState: "ready",
    icon: Globe,
    statusBucket: null,
  };
}

function BrowserPanel() {
  const { target } = usePaneContext();
  invariant(target.kind === "browser", "BrowserPanel requires browser target");
  return <BrowserPane browserId={target.browserId} />;
}

export const browserPanelRegistration: PanelRegistration<"browser"> = {
  kind: "browser",
  component: BrowserPanel,
  useDescriptor: useBrowserPanelDescriptor,
};
