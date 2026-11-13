import { act, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { PortalHost, PortalProvider } from "@gorhom/portal";
import { Text, View } from "react-native";
import { Portal } from "@/components/ui/portal";
import type { FocusOwner, FocusOwnerScopeProps } from "@/components/ui/focus-owner";

/** Test support for the embed focus browser tests: a screen with two embeds, as `AgentEmbed` draws them. */
export interface EmbedFocusModules {
  useEmbedFocus(embedId: string): { isFocused: boolean; owner: FocusOwner };
  FocusOwnerScope: ComponentType<FocusOwnerScopeProps>;
}

export function mountEmbedFocusScreen(modules: EmbedFocusModules) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const overlayRoot = document.createElement("div");
  document.body.appendChild(overlayRoot);
  const root = createRoot(container);

  // Something the embed owns in each kind of portal: gorhom's (autocomplete, hover card, bottom
  // sheet) and react-dom's (menus, comboboxes, tooltips on web; native Modal keeps the tree too).
  function Embed({ id }: { id: string }) {
    const { isFocused, owner } = modules.useEmbedFocus(id);
    const Scope = modules.FocusOwnerScope;
    return (
      <Scope owner={owner}>
        <View testID={`${id}-root`}>
          <Text testID={`${id}-state`}>{isFocused ? "focused" : "blurred"}</Text>
          <Portal hostName="host">
            <Text testID={`${id}-gorhom`}>gorhom</Text>
          </Portal>
          {createPortal(<span data-testid={`${id}-dom`}>dom</span>, overlayRoot)}
        </View>
      </Scope>
    );
  }

  function render(extra?: ReactNode) {
    act(() =>
      root.render(
        <PortalProvider>
          <span data-testid="outside">outside</span>
          <Embed id="left" />
          <Embed id="right" />
          {extra}
          <PortalHost name="host" />
        </PortalProvider>,
      ),
    );
  }

  return {
    Embed,
    render,
    unmount: () => act(() => root.render(null)),
  };
}

export function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`No element ${id}`);
  return element;
}

export function embedState(id: string): string | null {
  return byTestId(`${id}-state`).textContent;
}

export function pointerDown(id: string): void {
  act(() => {
    byTestId(id).dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
  });
}

export function touchStart(id: string): void {
  const target = byTestId(id);
  const touch = new Touch({ identifier: 1, target, clientX: 1, clientY: 1 });
  const init = { bubbles: true, composed: true, touches: [touch], changedTouches: [touch] };
  act(() => {
    target.dispatchEvent(new TouchEvent("touchstart", init));
    target.dispatchEvent(new TouchEvent("touchend", { ...init, touches: [] }));
  });
}
