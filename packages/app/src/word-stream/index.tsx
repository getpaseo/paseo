import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { MarkdownPhase } from "@/components/markdown/fence/types";
import { Reveal } from "./internal/reveal";
import type { SourceText } from "./internal/markdown-source";
import { WordStream } from "./internal/model";

/**
 * The paced prefix to paint, how long its latest word owns the reveal front,
 * shared by every renderer.
 */
export interface PacedText {
  text: string;
  spanMs: number;
}

const StreamingWordsContext = createContext<Reveal>(Reveal.begin(""));
const SurfaceContext = createContext<SourceText | null>(null);

export function StreamingWords({ stream, children }: { stream: PacedText; children: ReactNode }) {
  const [reveal, setReveal] = useState(() => Reveal.begin(stream.text));
  const current = reveal.receive(stream.text, Date.now(), stream.spanMs);
  if (current !== reveal) setReveal(current);
  return <StreamingWordsContext value={current}>{children}</StreamingWordsContext>;
}

export function WordFadeScope({ source, children }: { source: SourceText; children: ReactNode }) {
  return <SurfaceContext value={source}>{children}</SurfaceContext>;
}

export function useWordFadeSurface() {
  const reveal = useContext(StreamingWordsContext);
  const source = useContext(SurfaceContext);
  const plain = useMemo(() => source && { text: source.text, ranges: [] }, [source]);
  return useMemo(() => {
    const text = source?.text ?? reveal.text;
    const offsets = source?.offsets ?? Array.from({ length: text.length }, (_, i) => i);
    const ranges = reveal.surface(text, offsets, Date.now());
    return ranges.length === 0 && plain ? plain : { text, ranges };
  }, [reveal, source, plain]);
}

export function useWordStream(text: string, phase: MarkdownPhase): PacedText {
  const [model] = useState(() => new WordStream(text));
  const [visible, setVisible] = useState<PacedText>({
    text,
    spanMs: model.spanMs,
  });
  const lastFrame = useRef<number | null>(null);

  useEffect(() => {
    model.receive(text, phase === "streaming");
    const publish = () => {
      setVisible((current) =>
        current.text === model.text && current.spanMs === model.spanMs
          ? current
          : { text: model.text, spanMs: model.spanMs },
      );
    };
    publish();
    if (!model.pending) {
      lastFrame.current = null;
      return;
    }
    let frame: number;
    const tick = (now: number) => {
      const elapsed = lastFrame.current === null ? 16 : now - lastFrame.current;
      lastFrame.current = now;
      model.advance(elapsed);
      publish();
      if (model.pending) frame = requestAnimationFrame(tick);
      else lastFrame.current = null;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [model, text, phase]);

  return visible;
}

export function useWordPacedText(text: string, phase: MarkdownPhase): string {
  return useWordStream(text, phase).text;
}

export { trackMarkdownSource } from "./internal/markdown-source";
