import { useEffect, useState } from "react";

export function useLatchedBoolean(value: boolean): boolean {
  const [hasLatched, setHasLatched] = useState(value);

  useEffect(() => {
    if (value) {
      setHasLatched(true);
    }
  }, [value]);

  return hasLatched || value;
}
