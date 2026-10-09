import { pluginOverviewPolicy, pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import { pluginMediaKind } from "@getpaseo/protocol/plugin-registry";
import { ChevronLeft, ChevronRight, Play, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

const TILE_CLASS =
  "relative block aspect-video w-[85%] flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:w-[60%]";
// Two tiles fill the row; with more, a third peeks at the right edge to show the strip scrolls.
const FILLING_TILE_CLASS = `${TILE_CLASS} md:w-[calc(50%-0.375rem)]`;
const PEEKING_TILE_CLASS = `${TILE_CLASS} md:w-[42%]`;
// The viewer's room: media never exceeds this box, which leaves a margin around it.
const VIEW_WIDTH = "90vw";
const VIEW_HEIGHT = "85vh";
const VIEW_CLASS = "max-h-[85vh] max-w-[90vw] rounded-lg object-contain";
const VIEWER_BUTTON_CLASS =
  "fixed rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80";
const ARROW_STEPS: Partial<Record<string, number>> = { ArrowLeft: -1, ArrowRight: 1 };

interface MediaItem {
  url: string;
  kind: "image" | "video";
  /** Image alt text, or the video's accessible name. */
  label: string;
}

/** Plugin media in registry order. Each tile opens the viewer; without JavaScript it links to the file. */
export function MediaGallery({ name, media }: { name: string; media: string[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const entries = useMemo(
    () => media.map((url, index) => mediaEntry(name, url, index)),
    [name, media],
  );
  const items = useMemo(() => entries.filter((entry) => typeof entry !== "string"), [entries]);
  const [viewing, setViewing] = useState<number | null>(null);
  const item = viewing === null ? undefined : items[viewing];
  const open = useCallback(
    (opened: MediaItem) => {
      setViewing(items.indexOf(opened));
      dialog.current?.showModal();
    },
    [items],
  );
  const close = useCallback(() => dialog.current?.close(), []);
  // Unmounting the viewed media stops a playing video.
  const handleClose = useCallback(() => setViewing(null), []);
  const closeOnBackdrop = useCallback((event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }, []);
  const step = useCallback(
    (by: number) =>
      setViewing((index) => (index === null ? null : (index + by + items.length) % items.length)),
    [items.length],
  );
  const showPrevious = useCallback(() => step(-1), [step]);
  const showNext = useCallback(() => step(1), [step]);
  // Captured so arrow keys move between items even while a focused video would seek.
  const stepWithArrowKeys = useCallback(
    (event: KeyboardEvent<HTMLDialogElement>) => {
      const by = ARROW_STEPS[event.key];
      if (by === undefined || items.length < 2) return;
      event.preventDefault();
      step(by);
    },
    [items.length, step],
  );

  if (media.length === 0) return null;
  const tileClass = items.length > 2 ? PEEKING_TILE_CLASS : FILLING_TILE_CLASS;
  return (
    <>
      <div className="-mx-6 mt-10 flex gap-3 overflow-x-auto px-6 md:mx-0 md:px-0">
        {entries.map((entry) =>
          typeof entry === "string" ? (
            <p key={entry}>{entry}</p>
          ) : (
            <MediaTile key={entry.url} item={entry} className={tileClass} onOpen={open} />
          ),
        )}
      </div>
      {/* Focusable so arrow keys still reach it after a click on non-focusable media. */}
      <dialog
        ref={dialog}
        tabIndex={-1}
        aria-label={item?.label}
        onClose={handleClose}
        onClick={closeOnBackdrop}
        onKeyDownCapture={stepWithArrowKeys}
        className="m-auto overflow-visible bg-transparent p-0 outline-none backdrop:bg-black/80"
      >
        {item?.kind === "image" && (
          <img key={viewing} src={item.url} alt={item.label} className={VIEW_CLASS} />
        )}
        {item?.kind === "video" && <ViewerVideo key={viewing} url={item.url} label={item.label} />}
        {items.length > 1 && (
          <>
            <button
              type="button"
              aria-label="Previous"
              onClick={showPrevious}
              className={`${VIEWER_BUTTON_CLASS} left-4 top-1/2 -translate-y-1/2`}
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
            <button
              type="button"
              aria-label="Next"
              onClick={showNext}
              className={`${VIEWER_BUTTON_CLASS} right-4 top-1/2 -translate-y-1/2`}
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        )}
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className={`${VIEWER_BUTTON_CLASS} right-4 top-4`}
        >
          <X className="h-5 w-5" />
        </button>
      </dialog>
    </>
  );
}

/** A registry media entry as a gallery item, or the raw entry when it is not a safe URL. */
function mediaEntry(name: string, url: string, index: number): MediaItem | string {
  const source = pluginOverviewUrl(url);
  if (!source) return url;
  const kind = pluginMediaKind(source);
  return {
    url: source,
    kind,
    label: `${name} ${kind === "video" ? "video" : "screenshot"} ${index + 1}`,
  };
}

/** Fills the viewer's room at the video's aspect ratio, scaling small sources up. */
function ViewerVideo({ url, label }: { url: string; label: string }) {
  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const readAspectRatio = useCallback((event: SyntheticEvent<HTMLVideoElement>) => {
    const { videoWidth, videoHeight } = event.currentTarget;
    setAspectRatio(videoWidth / videoHeight);
  }, []);
  const style = useMemo<CSSProperties | undefined>(
    () =>
      aspectRatio === null
        ? undefined
        : { aspectRatio, width: `min(${VIEW_WIDTH}, ${VIEW_HEIGHT} * ${aspectRatio})` },
    [aspectRatio],
  );
  return (
    <video
      src={url}
      aria-label={label}
      controls
      autoPlay
      playsInline
      onLoadedMetadata={readAspectRatio}
      style={style}
      className={VIEW_CLASS}
    />
  );
}

function MediaTile({
  item,
  className,
  onOpen,
}: {
  item: MediaItem;
  className: string;
  onOpen: (item: MediaItem) => void;
}) {
  const { url, kind, label } = item;
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Modified clicks keep the link's own behavior, such as opening the file in a new tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen(item);
    },
    [onOpen, item],
  );
  return (
    <a
      href={url}
      {...pluginOverviewPolicy.link}
      aria-label={kind === "video" ? label : undefined}
      onClick={handleClick}
      className={className}
    >
      {kind === "image" ? (
        <img
          src={url}
          alt={label}
          loading="lazy"
          className="h-full w-full object-cover object-top"
        />
      ) : (
        <>
          <video
            src={url}
            preload="metadata"
            muted
            playsInline
            className="h-full w-full object-cover object-top"
          />
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center bg-black/10"
          >
            <span className="rounded-full bg-black/60 p-3 text-white">
              <Play className="h-5 w-5 fill-current" />
            </span>
          </span>
        </>
      )}
    </a>
  );
}
