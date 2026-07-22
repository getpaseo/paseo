import type { ProjectAppearance } from "@getpaseo/protocol/messages";

export type ProjectIconMode = ProjectAppearance["icon"]["type"];

export interface ProjectAppearanceFormSnapshot {
  appearance: ProjectAppearance | null | undefined;
  labels: {
    automatic: string;
    favicon: string;
    custom: string;
    urlRequired: string;
    customRequired: string;
  };
}

export interface ProjectAppearanceFormState {
  mode: ProjectIconMode;
  faviconUrl: string;
  customText: string;
  color: string;
  selectedDisplay: { label: string };
  showFaviconUrl: boolean;
  showCustomText: boolean;
  valueError: string | null;
  canSubmit: boolean;
  input: Pick<ProjectAppearance, "icon" | "color">;
}

export interface ProjectAppearanceFormModel {
  getState: () => ProjectAppearanceFormState;
  subscribe: (listener: () => void) => () => void;
  close: () => void;
  setMode: (mode: ProjectIconMode) => void;
  setFaviconUrl: (url: string) => void;
  setCustomText: (text: string) => void;
  setColor: (color: string) => void;
}

export function openProjectAppearanceForm(
  snapshot: ProjectAppearanceFormSnapshot,
): ProjectAppearanceFormModel {
  const labelsByMode: Record<ProjectIconMode, string> = {
    automatic: snapshot.labels.automatic,
    favicon: snapshot.labels.favicon,
    custom: snapshot.labels.custom,
  };
  let mode: ProjectIconMode = snapshot.appearance?.icon.type ?? "automatic";
  let faviconUrl = snapshot.appearance?.icon.type === "favicon" ? snapshot.appearance.icon.url : "";
  let customText = snapshot.appearance?.icon.type === "custom" ? snapshot.appearance.icon.text : "";
  let color = snapshot.appearance?.color ?? "";
  let closed = false;
  const listeners = new Set<() => void>();

  const deriveState = (): ProjectAppearanceFormState => {
    const trimmedFaviconUrl = faviconUrl.trim();
    const trimmedCustomText = customText.trim();
    let valueError: string | null = null;
    if (mode === "favicon" && !trimmedFaviconUrl) {
      valueError = snapshot.labels.urlRequired;
    } else if (
      mode === "custom" &&
      (!trimmedCustomText || Array.from(trimmedCustomText).length > 8)
    ) {
      valueError = snapshot.labels.customRequired;
    }

    let icon: ProjectAppearance["icon"] = { type: "automatic" };
    if (mode === "favicon") {
      icon = { type: "favicon", url: trimmedFaviconUrl };
    } else if (mode === "custom") {
      icon = { type: "custom", text: trimmedCustomText };
    }

    return {
      mode,
      faviconUrl,
      customText,
      color,
      selectedDisplay: { label: labelsByMode[mode] },
      showFaviconUrl: mode === "favicon",
      showCustomText: mode === "custom",
      valueError,
      canSubmit: !valueError,
      input: { icon, color: color.trim().toLowerCase() || null },
    };
  };

  let state = deriveState();
  const publish = () => {
    if (closed) return;
    state = deriveState();
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      closed = true;
      listeners.clear();
    },
    setMode: (nextMode) => {
      mode = nextMode;
      publish();
    },
    setFaviconUrl: (url) => {
      faviconUrl = url;
      publish();
    },
    setCustomText: (text) => {
      customText = text;
      publish();
    },
    setColor: (nextColor) => {
      color = nextColor;
      publish();
    },
  };
}
