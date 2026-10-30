import { useEffect, useState } from "react";
import { getDictationRecordingStore, type DictationRecording } from "./index";

export function useDictationRecordings(): {
  recordings: DictationRecording[] | null;
  error: string | null;
} {
  const [recordings, setRecordings] = useState<DictationRecording[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const store = getDictationRecordingStore();
    let current = true;
    const load = async () => {
      try {
        const next = await store.list();
        if (!current) return;
        setRecordings(next);
        setError(null);
      } catch (loadError) {
        if (!current) return;
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    };
    void load();
    const unsubscribe = store.subscribe(() => void load());
    return () => {
      current = false;
      unsubscribe();
    };
  }, []);

  return { recordings, error };
}
