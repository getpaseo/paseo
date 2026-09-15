import {
  Children,
  useCallback,
  useInsertionEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  memo,
  useState,
  type AnimationEvent,
  type CSSProperties,
} from "react";
import { Text, type TextProps } from "react-native";
// Keep the same grapheme fades on browsers without Intl.Segmenter.
import { graphemeSegments } from "unicode-segmenter/grapheme";
import { useWordFadeSurface } from ".";
import { FADE_DURATION_MS } from "./internal/reveal";

let stylesheet: HTMLStyleElement | null = null;
let stylesheetUsers = 0;

// Use the browser's shaped glyph positions, including bidi text. Batch new words
// before paint so a burst performs all layout reads before any style writes.
const pendingWords = new Set<HTMLSpanElement>();
let positioningScheduled = false;
function positionWord(word: HTMLSpanElement) {
  pendingWords.add(word);
  if (positioningScheduled) return;
  positioningScheduled = true;
  queueMicrotask(() => {
    positioningScheduled = false;
    const positions = Array.from(pendingWords)
      .filter((item) => item.isConnected)
      .map((item) =>
        Array.from(item.children, (child) => ({
          element: child as HTMLSpanElement,
          rect: child.getBoundingClientRect(),
        })).sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left),
      );
    pendingWords.clear();
    for (const letters of positions) {
      letters.forEach(({ element }, index) => {
        const host = element.parentElement!.dataset;
        const startedAt = Number(host.fadeStarted);
        const offset = (index / letters.length) * Number(host.fadeSpan);
        element.style.animationDelay = `${offset}ms`;
        // Pin the word to the document timeline. A CSS animation otherwise
        // starts at whichever frame first resolves its style, which is a
        // different skew for every word and enough to move the front backwards
        // across a word boundary.
        for (const animation of element.getAnimations()) {
          animation.startTime = startedAt - performance.timeOrigin;
        }
        // Absolute start time in wall-clock ms; tests read it to check the front
        // never moves backwards across word boundaries.
        element.dataset.fadeStart = String(startedAt + offset);
        element.dataset.fadeLast = index === letters.length - 1 ? "true" : "false";
      });
    }
  });
}

function FadingString({ text }: { text: string }) {
  const surface = useWordFadeSurface();
  const [finished, setFinished] = useState(0);
  const onAnimationEnd = useCallback((event: AnimationEvent<HTMLSpanElement>) => {
    if (!(event.target instanceof HTMLElement) || event.target.dataset.fadeLast !== "true") return;
    const word = event.currentTarget.dataset;
    const deadline = Number(word.fadeStarted) + Number(word.fadeSpan) + FADE_DURATION_MS;
    setFinished((current) => Math.max(current, deadline));
  }, []);
  const parts = [];
  let end = 0;
  for (const word of surface.ranges) {
    if (word.startedAt + word.spanMs + FADE_DURATION_MS <= finished) continue;
    parts.push(text.slice(end, word.start));
    parts.push(
      <FadingWord
        key={`${word.start}:${word.startedAt}`}
        start={word.start}
        startedAt={word.startedAt}
        spanMs={word.spanMs}
        text={text.slice(word.start, word.end)}
        onAnimationEnd={onAnimationEnd}
      />,
    );
    end = word.end;
  }
  parts.push(text.slice(end));
  return parts;
}

interface FadingWordProps {
  start: number;
  startedAt: number;
  spanMs: number;
  text: string;
  onAnimationEnd: (event: AnimationEvent<HTMLSpanElement>) => void;
}

const FadingWord = memo(function FadingWord({
  start,
  startedAt,
  spanMs,
  text,
  onAnimationEnd,
}: FadingWordProps) {
  const letters = useMemo(() => Array.from(graphemeSegments(text)), [text]);
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const word = ref.current!;
    word.dataset.fadeStarted = String(startedAt);
    word.dataset.fadeSpan = String(spanMs);
    positionWord(word);
    return () => {
      pendingWords.delete(word);
    };
  }, [text, startedAt, spanMs]);
  return (
    <span ref={ref} data-word-fade={start} onAnimationEnd={onAnimationEnd}>
      {letters.map((letter, index) => (
        <FadingLetter
          key={letter.index}
          text={letter.segment}
          delayMs={(index / letters.length) * spanMs}
          last={index === letters.length - 1}
        />
      ))}
    </span>
  );
});

const FadingLetter = memo(function FadingLetter({
  text,
  delayMs,
  last,
}: {
  text: string;
  delayMs: number;
  last: boolean;
}) {
  const style = useMemo<CSSProperties>(
    () => ({
      animationName: "paseo-word-fade",
      animationDuration: `${FADE_DURATION_MS}ms`,
      animationDelay: `${delayMs}ms`,
      animationTimingFunction: "linear",
      animationFillMode: "both",
    }),
    [delayMs],
  );
  return (
    <span data-fade-last={last ? "true" : undefined} style={style}>
      {text}
    </span>
  );
});

export function WordFadeText({ children, ...props }: TextProps) {
  useInsertionEffect(() => {
    stylesheetUsers++;
    if (!stylesheet) {
      stylesheet = document.createElement("style");
      stylesheet.textContent =
        "@keyframes paseo-word-fade { from { opacity: 0 } to { opacity: 1 } }";
      document.head.appendChild(stylesheet);
    }
    return () => {
      if (--stylesheetUsers === 0) {
        stylesheet?.remove();
        stylesheet = null;
      }
    };
  }, []);

  return (
    <Text {...props}>
      {Children.map(children, (child) =>
        typeof child === "string" ? <FadingString text={child} /> : child,
      )}
    </Text>
  );
}
