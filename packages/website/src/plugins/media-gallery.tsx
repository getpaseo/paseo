import { pluginOverviewPolicy, pluginOverviewUrl } from "@getpaseo/protocol/plugin-overview";
import { pluginMediaKind } from "@getpaseo/protocol/plugin-registry";
import { Play, X } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent,
  type SyntheticEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";

const TILE_CLASS =
  "relative block aspect-video w-[85%] flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] sm:w-[60%] md:w-[calc(50%-0.375rem)]";
// The viewer's room: media never exceeds this box, which leaves a margin around it.
const VIEW_WIDTH = "90vw";
const VIEW_HEIGHT = "85vh";
const VIEW_CLASS = "max-h-[85vh] max-w-[90vw] rounded-lg object-contain";

interface MediaItem {
  url: string;
  kind: "image" | "video";
  /** Image alt text, or the video's accessible name. */
  label: string;
}

/** Plugin media in registry order. Each tile opens the viewer; without JavaScript it links to the file. */
export function MediaGallery({ name, media }: { name: string; media: string[] }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [viewing, setViewing] = useState<MediaItem | null>(null);
  const open = useCallback((item: MediaItem) => {
    setViewing(item);
    dialog.current?.showModal();
  }, []);
  const close = useCallback(() => dialog.current?.close(), []);
  // Unmounting the viewed media stops a playing video.
  const handleClose = useCallback(() => setViewing(null), []);
  const closeOnBackdrop = useCallback((event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  }, []);

  if (media.length === 0) return null;
  return (
    <>
      <div className="-mx-6 mt-10 flex gap-3 overflow-x-auto px-6 md:mx-0 md:px-0">
        {media.map((url, index) => {
          const source = pluginOverviewUrl(url);
          if (!source) return <p key={url}>{url}</p>;
          const kind = pluginMediaKind(source);
          const label = `${name} ${kind === "video" ? "video" : "screenshot"} ${index + 1}`;
          return <MediaTile key={url} url={source} kind={kind} label={label} onOpen={open} />;
        })}
      </div>
      <dialog
        ref={dialog}
        aria-label={viewing?.label}
        onClose={handleClose}
        onClick={closeOnBackdrop}
        className="m-auto overflow-visible bg-transparent p-0 backdrop:bg-black/80"
      >
        {viewing?.kind === "image" && (
          <img src={viewing.url} alt={viewing.label} className={VIEW_CLASS} />
        )}
        {viewing?.kind === "video" && <ViewerVideo url={viewing.url} label={viewing.label} />}
        <button
          type="button"
          aria-label="Close"
          onClick={close}
          className="fixed right-4 top-4 rounded-full bg-black/60 p-2 text-white transition-colors hover:bg-black/80"
        >
          <X className="h-5 w-5" />
        </button>
      </dialog>
    </>
  );
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
  url,
  kind,
  label,
  onOpen,
}: MediaItem & { onOpen: (item: MediaItem) => void }) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Modified clicks keep the link's own behavior, such as opening the file in a new tab.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      onOpen({ url, kind, label });
    },
    [onOpen, url, kind, label],
  );
  return (
    <a
      href={url}
      {...pluginOverviewPolicy.link}
      aria-label={kind === "video" ? label : undefined}
      onClick={handleClick}
      className={TILE_CLASS}
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
