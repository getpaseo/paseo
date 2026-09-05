import { useCallback, useRef, useState } from "react";

interface WorkspacePinGroupDeleteActionInput {
  enabled: boolean;
  confirm: () => Promise<boolean>;
  execute: () => Promise<void>;
  onError: (cause: unknown) => void;
}

export function useWorkspacePinGroupDeleteAction(
  input: WorkspacePinGroupDeleteActionInput,
): Readonly<{ pending: boolean; run: () => Promise<void> }> {
  const { confirm, enabled, execute, onError } = input;
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);

  const run = useCallback(async () => {
    if (!enabled || pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    try {
      if (!(await confirm())) return;
      await execute();
    } catch (cause) {
      onError(cause);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [confirm, enabled, execute, onError]);

  return { pending, run };
}
