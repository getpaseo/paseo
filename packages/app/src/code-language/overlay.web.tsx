import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ChangeEvent,
  type UIEvent,
} from "react";
import { createPortal } from "react-dom";
import { useFetchQuery } from "@/data/query";
import { useTranslation } from "react-i18next";
import { UnistylesRuntime } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import {
  getOverlayRoot,
  useGlobalWebOverlayLayer,
  useWebOverlayRegistration,
} from "@/lib/overlay-root";
import type { CodeLocation } from "@getpaseo/protocol/code-language";
import type { LanguageActions } from "./actions";

export function LanguageOverlay({ actions }: { actions: LanguageActions }) {
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getSnapshot);
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const layer = useGlobalWebOverlayLayer("modal", state.kind === "popup");
  const keyDown = useCallback(
    (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      actions.close();
      return true;
    },
    [actions],
  );
  const setScope = useWebOverlayRegistration({
    active: isWeb && state.kind === "popup",
    layer,
    onKeyDown: keyDown,
  });
  const backdropDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) actions.close();
    },
    [actions],
  );
  useEffect(() => {
    if (!isWeb || state.kind !== "hover") return;
    const scroll = (event: Event) => {
      if (
        event.target instanceof Element &&
        event.target.closest('[data-testid="code-language-hover"]')
      )
        return;
      actions.dismissHover();
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") actions.close();
    };
    window.addEventListener("keydown", escape);
    window.addEventListener("scroll", scroll, true);
    return () => {
      window.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [actions, state.kind]);
  const panelStyle = useMemo<CSSProperties>(
    () => ({
      background: theme.colors.surface0,
      color: theme.colors.foreground,
      border: `1px solid ${theme.colors.border}`,
      borderRadius: 8,
      boxShadow: "0 8px 32px #0004",
      fontFamily: theme.fontFamily.ui,
      width: "min(720px, 92vw)",
      padding: 16,
    }),
    [theme],
  );
  const buttonStyle = useMemo<CSSProperties>(
    () => ({
      background: "transparent",
      color: theme.colors.foreground,
      border: `1px solid ${theme.colors.border}`,
      borderRadius: 4,
      padding: "4px 8px",
      cursor: "pointer",
    }),
    [theme],
  );
  const backdropStyle = useMemo<CSSProperties>(() => ({ ...BACKDROP, zIndex: layer }), [layer]);
  const hoverStyle = useMemo<CSSProperties>(() => {
    if (!isWeb || state.kind !== "hover") return {};
    return {
      ...panelStyle,
      position: "fixed",
      pointerEvents: "auto",
      zIndex: layer,
      left: Math.max(8, Math.min(state.anchor.x, window.innerWidth - 520)),
      top: Math.max(8, Math.min(state.anchor.y + 18, window.innerHeight - 260)),
      width: "max-content",
      maxWidth: "min(500px, 90vw)",
      maxHeight: 240,
      overflow: "auto",
      whiteSpace: "pre-wrap",
      fontFamily: theme.fontFamily.mono,
      fontSize: 12,
    };
  }, [layer, panelStyle, state, theme.fontFamily.mono]);
  if (!isWeb || state.kind === "closed") return null;
  if (state.kind === "hover")
    return createPortal(
      <div
        role="tooltip"
        data-testid="code-language-hover"
        style={hoverStyle}
        onMouseLeave={actions.dismissHover}
      >
        {state.stale ? (
          <>
            {t("codeLanguage.stale")}{" "}
            <button type="button" style={buttonStyle} onClick={actions.openCurrent}>
              {t("codeLanguage.openCurrent")}
            </button>
          </>
        ) : (
          state.text
        )}
      </div>,
      getOverlayRoot(),
    );
  const title = t(TITLE[state.operation]);
  return createPortal(
    <div data-testid="code-language-popup" style={backdropStyle} onMouseDown={backdropDown}>
      <div
        ref={setScope}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={panelStyle}
        tabIndex={-1}
      >
        <div style={HEADING}>
          <strong>{title}</strong>
          <button
            type="button"
            style={buttonStyle}
            onClick={actions.close}
            aria-label={t("codeLanguage.close")}
          >
            ×
          </button>
        </div>
        {state.status === "ready" ? (
          <LocationPicker actions={actions} locations={state.locations} />
        ) : (
          <div role="status">
            {t(`codeLanguage.${state.status}`)}
            {state.status === "error" && (
              <button type="button" style={buttonStyle} onClick={actions.retry}>
                {t("codeLanguage.retry")}
              </button>
            )}
            {state.status === "stale" && (
              <button type="button" style={buttonStyle} onClick={actions.openCurrent}>
                {t("codeLanguage.openCurrent")}
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    getOverlayRoot(),
  );
}
interface PickerState {
  filter: string;
  active: number;
  top: number;
}
type PickerEvent =
  | { kind: "filter"; filter: string }
  | { kind: "active"; active: number }
  | { kind: "scroll"; top: number };
function reducePicker(state: PickerState, event: PickerEvent): PickerState {
  if (event.kind === "filter") return { filter: event.filter, active: 0, top: 0 };
  if (event.kind === "active") return { ...state, active: event.active };
  return { ...state, top: event.top };
}
function LocationPicker({
  actions,
  locations,
}: {
  actions: LanguageActions;
  locations: CodeLocation[];
}) {
  const { t } = useTranslation();
  const theme = UnistylesRuntime.getTheme();
  const inputStyle = useMemo<CSSProperties>(
    () => ({
      ...INPUT,
      background: theme.colors.surface0,
      color: theme.colors.foreground,
      border: `1px solid ${theme.colors.border}`,
      borderRadius: 4,
    }),
    [theme],
  );
  const [state, dispatch] = useReducer(reducePicker, { filter: "", active: 0, top: 0 });
  const list = useRef<HTMLDivElement>(null);
  const filtered = useMemo(
    () =>
      locations.filter((location) =>
        location.path.toLowerCase().includes(state.filter.toLowerCase()),
      ),
    [locations, state.filter],
  );
  const start = Math.max(0, Math.floor(state.top / 64) - 2);
  const visible = useMemo(() => filtered.slice(start, start + 12), [filtered, start]);
  const snippets = useFetchQuery({
    dataShape: "value",
    queryKey: ["code-language-snippets", actions.scope.id, visible],
    queryFn: () => actions.scope.snippets(visible),
    enabled: visible.length > 0,
    staleTimeMs: 0,
  });
  const change = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    dispatch({ kind: "filter", filter: event.target.value });
    if (list.current) list.current.scrollTop = 0;
  }, []);
  const keyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" && filtered[state.active]) {
        event.preventDefault();
        actions.select(filtered[state.active]!);
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const active = Math.max(
        0,
        Math.min(filtered.length - 1, state.active + (event.key === "ArrowDown" ? 1 : -1)),
      );
      dispatch({ kind: "active", active });
      if (!list.current) return;
      const top = active * 64;
      if (top < list.current.scrollTop || top + 64 > list.current.scrollTop + 384)
        list.current.scrollTop = top;
    },
    [actions, filtered, state.active],
  );
  const scroll = useCallback(
    (event: UIEvent<HTMLDivElement>) =>
      dispatch({ kind: "scroll", top: event.currentTarget.scrollTop }),
    [],
  );
  const listStyle = useMemo<CSSProperties>(
    () => ({ height: Math.min(384, filtered.length * 64), overflow: "auto" }),
    [filtered.length],
  );
  const spacerStyle = useMemo<CSSProperties>(
    () => ({ height: filtered.length * 64, position: "relative" }),
    [filtered.length],
  );
  return (
    <>
      <input
        autoFocus
        aria-label={t("codeLanguage.filter")}
        placeholder={t("codeLanguage.filter")}
        value={state.filter}
        role="combobox"
        aria-expanded="true"
        aria-controls="code-language-results"
        aria-activedescendant={filtered.length ? `code-location-${state.active}` : undefined}
        style={inputStyle}
        onChange={change}
        onKeyDown={keyDown}
      />
      {!filtered.length && <div role="status">{t("codeLanguage.empty")}</div>}
      <div ref={list} role="listbox" id="code-language-results" style={listStyle} onScroll={scroll}>
        <div style={spacerStyle}>
          {visible.map((location, offset) => (
            <LocationRow
              key={`${location.path}:${location.range.start.line}:${location.range.start.character}`}
              actions={actions}
              location={location}
              index={start + offset}
              active={start + offset === state.active}
              snippet={snippets.data?.[offset] ?? "…"}
            />
          ))}
        </div>
      </div>
    </>
  );
}
interface LocationRowProps {
  actions: LanguageActions;
  location: CodeLocation;
  index: number;
  active: boolean;
  snippet: string;
}
function LocationRow({ actions, location, index, active, snippet }: LocationRowProps) {
  const select = useCallback(() => actions.select(location), [actions, location]);
  const style = useMemo<CSSProperties>(
    () => ({ ...ROW, top: index * 64, background: active ? "#8883" : "transparent" }),
    [active, index],
  );
  const path = location.path.startsWith(`${actions.scope.cwd}/`)
    ? location.path.slice(actions.scope.cwd.length + 1)
    : location.path;
  return (
    <div
      role="option"
      id={`code-location-${index}`}
      aria-selected={active}
      onMouseDown={preventDefault}
      onClick={select}
      style={style}
    >
      <div style={LABEL}>
        {path}:{location.range.start.line + 1}:{location.range.start.character + 1}
      </div>
      <pre style={SNIPPET}>{snippet}</pre>
    </div>
  );
}
function preventDefault(event: MouseEvent) {
  event.preventDefault();
}
const BACKDROP: CSSProperties = {
  position: "fixed",
  inset: 0,
  pointerEvents: "auto",
  background: "#0005",
  display: "flex",
  justifyContent: "center",
  alignItems: "flex-start",
  paddingTop: "15vh",
};
const HEADING: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  marginBottom: 12,
};
const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: 8,
  marginBottom: 8,
};
const ROW: CSSProperties = {
  position: "absolute",
  height: 64,
  width: "100%",
  boxSizing: "border-box",
  padding: 8,
  cursor: "pointer",
  overflow: "hidden",
};
const LABEL: CSSProperties = { fontSize: 12 };
const SNIPPET: CSSProperties = {
  margin: "4px 0",
  fontSize: 12,
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const TITLE = {
  hover: "codeLanguage.inspect",
  references: "codeLanguage.usages",
  definition: "codeLanguage.definition",
} as const;
