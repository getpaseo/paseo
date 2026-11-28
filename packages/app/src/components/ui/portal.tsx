import { Portal as GorhomPortal } from "@gorhom/portal";
import type { ReactNode } from "react";
import { StyleSheet } from "react-native";
import { FocusOwnerScope, useFocusOwner } from "@/components/ui/focus-owner";

/**
 * `@gorhom/portal`'s `Portal`, carrying the focus owner across. Gorhom re-mounts the children
 * under the host, so their React parent is the host and an owner's handlers above the call site
 * never hear a press in them (a plugin embed's autocomplete list blurred the embed it belongs
 * to). Read the owner here, on the near side, and re-open it on the far side. Use this, never
 * gorhom's `Portal` directly (`paseo/no-raw-portal`).
 */
export function Portal({ hostName, children }: { hostName?: string; children: ReactNode }) {
  const owner = useFocusOwner();
  return (
    <GorhomPortal hostName={hostName}>
      {/* Portal hosts fill their layer and their children position absolutely in it. */}
      <FocusOwnerScope owner={owner} style={StyleSheet.absoluteFill}>
        {children}
      </FocusOwnerScope>
    </GorhomPortal>
  );
}
