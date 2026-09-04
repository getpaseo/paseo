import type { PluginTheme } from "@getpaseo/plugin";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from "react";
import { Pressable, Text, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { composerPillStyles } from "@/composer/pill-styles";
import { useToast } from "@/contexts/toast-context";
import type { Theme } from "@/styles/theme";
import { Icon } from "../icons";
import { toPluginTheme } from "../theme";
import type { PluginDraftActionContribution } from "../types";
import { createPluginDraftActionGuard, type PluginDraftActionGuard } from "./guard";
import { pluginDraftActionStore } from "./store";

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });

interface PluginDraftActionSurface {
  serverId: string;
  workspaceId?: string;
  agentId?: string;
  text: string;
  replaceText: (text: string) => void;
  /** True while the composer is submitting with a preserved (locked) draft. */
  locked?: boolean;
}

const PluginDraftActionsContext = createContext<
  (PluginDraftActionSurface & { guard: RefObject<PluginDraftActionGuard> }) | null
>(null);

export function PluginDraftActionsProvider({
  serverId,
  workspaceId,
  agentId,
  text,
  replaceText,
  locked,
  children,
}: PluginDraftActionSurface & { children: ReactNode }) {
  const guard = useRef<PluginDraftActionGuard>(createPluginDraftActionGuard());
  const settled = useRef(false);
  useLayoutEffect(() => {
    // Layout effect: it runs in the same synchronous commit as the rendered
    // surface inputs, so a transform resolving between the commit and a
    // passive effect flush cannot slip past the guard. Unrelated re-renders
    // don't invalidate; only real surface changes (edited or sent draft,
    // switched surface, lock flipped for submission) do.
    if (!settled.current) {
      settled.current = true;
    } else {
      guard.current.invalidate();
    }
    // The cleanup runs synchronously in the same commit that unmounts the
    // composer, before pending microtasks, so a transform resolving after the
    // surface is gone is discarded even if the button's passive unmount
    // tracking has not flipped yet.
    const currentGuard = guard.current;
    return () => currentGuard.invalidate();
  }, [agentId, locked, serverId, text, workspaceId]);
  const value = useMemo(
    () => ({ serverId, workspaceId, agentId, text, replaceText, locked, guard }),
    [agentId, guard, locked, replaceText, serverId, text, workspaceId],
  );
  return (
    <PluginDraftActionsContext.Provider value={value}>
      {children}
    </PluginDraftActionsContext.Provider>
  );
}

function PluginDraftActionButton({
  contribution,
  workspaceId,
  agentId,
  text,
  replaceText,
  guard,
  locked,
  theme,
}: {
  contribution: PluginDraftActionContribution;
  workspaceId?: string;
  agentId?: string;
  text: string;
  replaceText: (text: string) => void;
  guard: RefObject<PluginDraftActionGuard>;
  locked?: boolean;
  theme: PluginTheme;
}) {
  const toast = useToast();
  const [pending, setPending] = useState(false);
  const disabled = pending || locked || text.trim().length === 0;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const press = useCallback(async () => {
    if (disabled) return;
    const startedWith = text;
    const generation = guard.current.capture();
    setPending(true);
    try {
      const next = await contribution.transform(text, { workspaceId, agentId });
      // Discard when the surface moved on while the transform ran: another
      // action was pressed, the draft was edited or sent, or the composer
      // unmounted. A late result must never clobber newer input.
      if (!mounted.current || !guard.current.isCurrent(generation)) return;
      if (typeof next !== "string") {
        throw new Error(`Draft action ${contribution.id} returned a non-string result`);
      }
      if (next !== startedWith) replaceText(next);
    } catch (error) {
      if (mounted.current) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }, [agentId, contribution, disabled, guard, replaceText, text, toast, workspaceId]);
  const pillStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      composerPillStyles.body,
      styles.pill,
      (hovered || pressed) && composerPillStyles.bodyActive,
      disabled && styles.disabled,
    ],
    [disabled],
  );
  const accessibilityState = useMemo(() => ({ busy: pending, disabled }), [disabled, pending]);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={contribution.title}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={press}
      style={pillStyle}
    >
      {pending ? (
        <LoadingSpinner size="small" color={theme.colors.foregroundMuted} />
      ) : (
        <Icon
          name={contribution.icon ?? "Sparkles"}
          size={14}
          color={theme.colors.foregroundMuted}
        />
      )}
      <Text style={composerPillStyles.label}>{contribution.title}</Text>
    </Pressable>
  );
}

const ThemedPluginDraftActionButton = withUnistyles(PluginDraftActionButton);

export function PluginDraftActionsInline() {
  const surface = useContext(PluginDraftActionsContext);
  const registrations = useSyncExternalStore(
    pluginDraftActionStore.subscribe,
    pluginDraftActionStore.getSnapshot,
    pluginDraftActionStore.getSnapshot,
  );
  const visible = useMemo(
    () =>
      surface
        ? registrations.filter(({ installation }) => installation.serverId === surface.serverId)
        : [],
    [registrations, surface],
  );
  if (!surface || visible.length === 0) return null;
  return (
    <>
      {visible.map(({ installation, contribution }) => (
        <ThemedPluginDraftActionButton
          key={`${installation.serverId}/${installation.id}/${contribution.id}`}
          contribution={contribution}
          workspaceId={surface.workspaceId}
          agentId={surface.agentId}
          text={surface.text}
          replaceText={surface.replaceText}
          guard={surface.guard}
          locked={surface.locked}
          uniProps={pluginThemeMapping}
        />
      ))}
    </>
  );
}

const styles = StyleSheet.create(() => ({
  pill: {
    height: 28,
    flexShrink: 0,
    gap: 6,
  },
  disabled: {
    opacity: 0.5,
  },
}));
