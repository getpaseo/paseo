import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronDown } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { ScrollView } from "@/components/ui/scroll-view";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import type { Theme } from "@/styles/theme";
import { MenuItem, useMenuContext } from "@/components/ui/menu";
import { MenuContextProvider } from "@/components/ui/menu/menu-context";

interface Panel {
  id: string;
  title: string;
  content: ReactNode;
}

const PanelContext = createContext<{
  selected: string | null;
  select: (id: string | null) => void;
  register: (panel: Panel) => () => void;
} | null>(null);
const PanelContentContext = createContext(new Map<string, Panel>());

/** One kept-open surface per agent pane, never shared between agents or split panes. */
export function KeptPanelProvider({ children }: { children: ReactNode }) {
  const [selected, select] = useState<string | null>(null);
  const [panels, setPanels] = useState(() => new Map<string, Panel>());
  const register = useCallback((panel: Panel) => {
    setPanels((current) => new Map(current).set(panel.id, panel));
    return () => {
      setPanels((current) => {
        if (current.get(panel.id) !== panel) return current;
        const next = new Map(current);
        next.delete(panel.id);
        return next;
      });
    };
  }, []);
  const value = useMemo(() => ({ selected, select, register }), [selected, register]);
  return (
    <PanelContext.Provider value={value}>
      <PanelContentContext.Provider value={panels}>{children}</PanelContentContext.Provider>
    </PanelContext.Provider>
  );
}

export function useKeptPanel(panel: Panel | null) {
  const context = useContext(PanelContext);
  const register = context?.register;
  useEffect(() => {
    if (panel && register) return register(panel);
  }, [panel, register]);
  return context;
}

export function KeepPanelContent({
  id,
  title,
  children,
  renderSurface,
}: {
  id: string;
  title: string;
  children: ReactNode;
  renderSurface: (content: ReactNode) => ReactNode;
}) {
  const menu = useMenuContext("KeepPanelAction");
  const context = useContext(PanelContext);
  const { t } = useTranslation();
  const select = context?.select;
  const close = useCallback(
    (open: boolean) => {
      if (!open) select?.(null);
    },
    [select],
  );
  const bridge = useMemo(() => ({ ...menu, setOpen: close }), [menu, close]);
  const panel = useMemo(
    () => ({
      id,
      title,
      content: <MenuContextProvider value={bridge}>{children}</MenuContextProvider>,
    }),
    [id, title, bridge, children],
  );
  useKeptPanel(panel);
  const keep = useCallback(() => select?.(id), [select, id]);
  if (context?.selected === id) return null;
  return renderSurface(
    <>
      {context ? (
        <MenuItem onSelect={keep} testID={`${id}-keep-open`}>
          {t("composer.keptPanel.keepOpen")}
        </MenuItem>
      ) : null}
      {children}
    </>,
  );
}

const CollapseIcon = withUnistyles(ChevronDown);
const iconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function KeptPanelSlot() {
  const context = useContext(PanelContext);
  const compact = useIsCompactFormFactor();
  const { t } = useTranslation();
  const panels = useContext(PanelContentContext);
  const panel = context?.selected ? panels.get(context.selected) : undefined;
  const collapse = useCallback(() => context?.select(null), [context]);
  if (!panel) return null;
  return (
    <View style={styles.rail} testID="composer-kept-panel">
      <View style={styles.panel} accessibilityLabel={panel.title}>
        <View style={styles.header}>
          <Text style={styles.title}>{panel.title}</Text>
          <ToolbarButton
            label={t("composer.keptPanel.collapse")}
            onPress={collapse}
            testID="composer-kept-panel-collapse"
          >
            <CollapseIcon size={16} uniProps={iconMapping} />
          </ToolbarButton>
        </View>
        <ScrollView
          style={compact ? styles.compactBody : styles.body}
          keyboardShouldPersistTaps="handled"
        >
          {panel.content}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: { width: "100%", alignItems: "center", paddingHorizontal: theme.spacing[4] },
  panel: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    backgroundColor: theme.colors.surface0,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[3],
  },
  title: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  body: { height: 180, flexGrow: 0 },
  compactBody: { height: 108, flexGrow: 0 },
}));
