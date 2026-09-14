import React, { useEffect, useState, type ReactNode } from "react";
import { Freeze } from "react-freeze";
import { useRetainedPanelActive } from "@/components/retained-panel";

export function AgentPanelFreeze({ children }: { children: ReactNode }) {
  const active = useRetainedPanelActive();
  const [frozen, setFrozen] = useState(!active);
  // First let visibility-gated queries and animations receive active=false.
  // The following commit freezes every chat subscriber while the model keeps streaming.
  useEffect(() => setFrozen(!active), [active]);
  return <Freeze freeze={!active && frozen}>{children}</Freeze>;
}
