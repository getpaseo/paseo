import type { RefObject } from "react";
import type { ScrollView } from "react-native";

export * from "./workspace-tabs-wheel-scroll-core";

// The platform files provide the runtime implementation; this declaration keeps the
// extensionless import typed for TypeScript, whose resolver does not select .web/.native files.
export declare function useWorkspaceTabsWheelScroll(enabled: boolean): RefObject<ScrollView | null>;
