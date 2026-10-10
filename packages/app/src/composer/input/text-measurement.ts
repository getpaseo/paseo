import { useEffect, useState } from "react";

/** Keeps native line measurement local to the text surface while applying replacement commands. */
export function useComposerTextMeasurement(text: string, replacementKey: string, enabled: boolean) {
  const [measurementText, setMeasurementText] = useState(text);
  useEffect(() => {
    if (enabled) setMeasurementText(text);
  }, [text, replacementKey, enabled]);
  return [measurementText, setMeasurementText] as const;
}
