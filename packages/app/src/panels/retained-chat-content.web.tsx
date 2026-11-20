import React, { useEffect, useState, type ReactNode } from "react";
import { Freeze } from "react-freeze";
import { useRetainedPanelActive } from "@/components/retained-panel";

/**
 * Web only: suspends a hidden chat so its subscribers stop rendering while the
 * model keeps streaming. DOM nodes have no Fabric ownership to lose, so
 * suspension is safe here; native keeps the subtree live (see the base file).
 */
export function RetainedChatContent({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [frozen, setFrozen] = useState(!active);
  // First let visibility-gated queries and animations receive active=false.
  // The following commit freezes every chat subscriber while the model keeps streaming.
  useEffect(() => setFrozen(!active), [active]);
  return <Freeze freeze={!active && frozen}>{children}</Freeze>;
}
