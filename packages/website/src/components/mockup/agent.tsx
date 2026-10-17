import type { ComponentType, SVGProps } from "react";

/** Optional branding for the shared desktop and phone composer mockups. */
export interface MockupAgent {
  name: string;
  Icon: ComponentType<SVGProps<SVGSVGElement>>;
  model?: string;
}

export function MockupAgentIcon({ agent, size }: { agent: MockupAgent; size: number }) {
  return <agent.Icon width={size} height={size} className="shrink-0" />;
}
