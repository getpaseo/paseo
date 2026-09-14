import type { ProjectIconSource } from "@getpaseo/protocol/messages";

/**
 * What the user asked the icon to become. A URL is client-side only: the caller
 * acquires its bytes and submits the same upload payload a picked file produces.
 */
export type ProjectIconIntent = ProjectIconSource | { type: "url"; url: string };

/** The RPCs one submit has to issue. A null field is a field the user left alone. */
export interface ProjectEditSubmission {
  rename: { customName: string | null } | null;
  icon: ProjectIconIntent | null;
}

export interface ProjectEditFormError {
  /** Which field the failure belongs under. */
  scope: "name" | "icon";
  message: string;
}

export interface ProjectEditFormState {
  name: string;
  /** The image the icon tile renders, null for the derived letter fallback. */
  previewDataUri: string | null;
  previewEmoji: string | null;
  emoji: string;
  pickedFileName: string | null;
  /** False once the resulting icon is the automatic one — the reset has nothing to do. */
  canUseAutomatic: boolean;
  canSubmit: boolean;
  error: ProjectEditFormError | null;
  /** Bumped only when the model clears the URL box on the user's behalf. */
  urlResetKey: number;
  emojiResetKey: number;
  submission: ProjectEditSubmission;
}

export interface ProjectEditFormModel {
  getState: () => ProjectEditFormState;
  subscribe: (listener: () => void) => () => void;
  setName: (name: string) => void;
  setImageUrl: (url: string) => void;
  setEmoji: (emoji: string) => void;
  setPickedImage: (image: { fileName: string; mimeType: string; data: string }) => void;
  useAutomaticIcon: () => void;
  setError: (error: ProjectEditFormError | null) => void;
}

export interface ProjectEditFormSnapshot {
  /** The name on screen today, custom or derived. Seeds the input's placeholder. */
  projectName: string;
  /** The override in effect, null while the project uses its derived name. */
  projectCustomName: string | null;
  hasCustomIcon: boolean;
  /** The icon the project renders today, custom or derived. */
  currentIconDataUri: string | null;
  currentIconEmoji: string | null;
}

type IconChoice = "unchanged" | "automatic" | "upload" | "url" | "emoji";

interface PickedImage {
  fileName: string;
  mimeType: string;
  data: string;
}

export function openProjectEditForm(snapshot: ProjectEditFormSnapshot): ProjectEditFormModel {
  let name = snapshot.projectCustomName ?? "";
  let urlText = "";
  let emojiText = snapshot.currentIconEmoji ?? "";
  let picked: PickedImage | null = null;
  let iconChoice: IconChoice = "unchanged";
  let error: ProjectEditFormError | null = null;
  let urlResetKey = 0;
  let emojiResetKey = 0;
  const listeners = new Set<() => void>();

  function deriveRename(): ProjectEditSubmission["rename"] {
    const trimmed = name.trim();
    const customName = trimmed.length === 0 ? null : trimmed;
    return customName === snapshot.projectCustomName ? null : { customName };
  }

  function deriveIcon(): ProjectIconIntent | null {
    if (iconChoice === "automatic") {
      return snapshot.hasCustomIcon ? { type: "automatic" } : null;
    }
    if (iconChoice === "upload" && picked) {
      return { type: "upload", data: picked.data };
    }
    if (iconChoice === "url") {
      const url = urlText.trim();
      return url.length === 0 ? null : { type: "url", url };
    }
    if (iconChoice === "emoji") {
      return emojiText === snapshot.currentIconEmoji ? null : { type: "emoji", emoji: emojiText };
    }
    return null;
  }

  function derivePreview(): string | null {
    // Dropping a custom icon leaves the daemon to re-derive one, so the tile
    // falls back to the letter rather than claiming to know the result.
    if (iconChoice === "automatic") return null;
    if (iconChoice === "upload" && picked) {
      return `data:${picked.mimeType};base64,${picked.data}`;
    }
    return snapshot.currentIconDataUri;
  }

  function derivePreviewEmoji(): string | null {
    if (iconChoice === "unchanged") return snapshot.currentIconEmoji;
    return iconChoice === "emoji" ? emojiText : null;
  }

  function deriveState(): ProjectEditFormState {
    const submission = { rename: deriveRename(), icon: deriveIcon() };
    const willBeCustom = submission.icon
      ? submission.icon.type !== "automatic"
      : snapshot.hasCustomIcon;
    return {
      name,
      previewDataUri: derivePreview(),
      previewEmoji: derivePreviewEmoji(),
      emoji: emojiText,
      pickedFileName: iconChoice === "upload" ? (picked?.fileName ?? null) : null,
      canUseAutomatic: willBeCustom,
      canSubmit: Boolean(submission.rename || submission.icon),
      error,
      urlResetKey,
      emojiResetKey,
      submission,
    };
  }

  let state = deriveState();

  function publish(): void {
    state = deriveState();
    for (const listener of listeners) listener();
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setName: (nextName) => {
      name = nextName;
      error = null;
      publish();
    },
    setImageUrl: (url) => {
      urlText = url;
      if (url.trim().length > 0) {
        picked = null;
        emojiText = "";
        emojiResetKey += 1;
        iconChoice = "url";
      } else if (iconChoice === "url") {
        iconChoice = snapshot.hasCustomIcon ? "automatic" : "unchanged";
      }
      error = null;
      publish();
    },
    setEmoji: (emoji) => {
      emojiText = emoji.trim();
      if (emojiText) {
        picked = null;
        urlText = "";
        urlResetKey += 1;
        iconChoice = "emoji";
      } else if (iconChoice === "emoji" || snapshot.currentIconEmoji) {
        iconChoice = snapshot.hasCustomIcon ? "automatic" : "unchanged";
      }
      error = null;
      publish();
    },
    setPickedImage: (image) => {
      picked = image;
      urlText = "";
      emojiText = "";
      urlResetKey += 1;
      emojiResetKey += 1;
      iconChoice = "upload";
      error = null;
      publish();
    },
    useAutomaticIcon: () => {
      picked = null;
      urlText = "";
      urlResetKey += 1;
      emojiText = "";
      emojiResetKey += 1;
      iconChoice = snapshot.hasCustomIcon ? "automatic" : "unchanged";
      error = null;
      publish();
    },
    setError: (nextError) => {
      error = nextError;
      publish();
    },
  };
}
