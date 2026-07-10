import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type PressableStateCallbackType,
} from "react-native";
import { router } from "expo-router";
import { Server } from "lucide-react-native";
import { create } from "zustand";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { HostStatusDotSlot } from "@/components/hosts/host-picker";
import { isNative } from "@/constants/platform";
import { useLocalDaemonServerId } from "@/hooks/use-is-local-daemon";
import { useHosts } from "@/runtime/host-runtime";
import { orderHostsLocalFirst, type HostProfile } from "@/types/host-connection";
import { buildSettingsAddHostRoute } from "@/utils/host-routes";

type HostFilter = (host: HostProfile) => boolean;
type HostChoiceHandler = (serverId: string) => void | Promise<void>;

export interface ChooseHostInput {
  title?: string;
  filter?: HostFilter;
  onChooseHost: HostChoiceHandler;
  onNoHosts?: () => void;
}

interface HostChoiceRequest {
  id: number;
  title: string;
  serverIds: string[];
  onChooseHost: HostChoiceHandler;
}

interface HostChooserState {
  request: HostChoiceRequest | null;
  open: (request: Omit<HostChoiceRequest, "id">) => void;
  close: () => void;
}

let nextRequestId = 1;

const useHostChooserStore = create<HostChooserState>((set) => ({
  request: null,
  open: (request) => {
    set({ request: { ...request, id: nextRequestId++ } });
  },
  close: () => set({ request: null }),
}));

function matchesHostQuery(host: HostProfile, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return (
    host.label.toLowerCase().includes(normalized) ||
    host.serverId.toLowerCase().includes(normalized)
  );
}

export function useHostChooser() {
  const hosts = useHosts();
  const localServerId = useLocalDaemonServerId();
  const open = useHostChooserStore((state) => state.open);

  return useCallback(
    (input: ChooseHostInput) => {
      const availableHosts = orderHostsLocalFirst(hosts, localServerId).filter(
        input.filter ?? (() => true),
      );

      if (availableHosts.length === 0) {
        (input.onNoHosts ?? (() => router.push(buildSettingsAddHostRoute(Date.now()))))();
        return false;
      }

      if (availableHosts.length === 1) {
        void input.onChooseHost(availableHosts[0].serverId);
        return true;
      }

      open({
        title: input.title ?? "Choose host",
        serverIds: availableHosts.map((host) => host.serverId),
        onChooseHost: input.onChooseHost,
      });
      return true;
    },
    [hosts, localServerId, open],
  );
}

function HostChooserRow({
  host,
  active,
  onChooseHost,
}: {
  host: HostProfile;
  active: boolean;
  onChooseHost: (serverId: string) => void;
}) {
  const { theme } = useUnistyles();
  const handlePress = useCallback(() => onChooseHost(host.serverId), [host.serverId, onChooseHost]);
  const rowStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.row,
      (active || hovered || pressed) && styles.rowActive,
    ],
    [active],
  );

  return (
    <Pressable
      accessibilityRole="button"
      onPress={handlePress}
      style={rowStyle}
      testID={`host-chooser-row-${host.serverId}`}
    >
      <View style={styles.rowIconSlot}>
        <HostStatusDotSlot serverId={host.serverId} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {host.label}
        </Text>
        <Text style={styles.rowSubtitle} numberOfLines={1}>
          {host.serverId}
        </Text>
      </View>
      <Server size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function HostChooserModal() {
  const { theme } = useUnistyles();
  const hosts = useHosts();
  const request = useHostChooserStore((state) => state.request);
  const close = useHostChooserStore((state) => state.close);
  const inputRef = useRef<TextInput>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  const requestHosts = useMemo(() => {
    if (!request) return [];
    const hostByServerId = new Map(hosts.map((host) => [host.serverId, host] as const));
    return request.serverIds.flatMap((serverId) => {
      const host = hostByServerId.get(serverId);
      return host ? [host] : [];
    });
  }, [hosts, request]);

  const options = useMemo(
    () => requestHosts.filter((host) => matchesHostQuery(host, query)),
    [query, requestHosts],
  );
  const activeOptionIndex = options.length === 0 ? 0 : Math.min(activeIndex, options.length - 1);

  useEffect(() => {
    if (!request) return;
    setQuery("");
    setActiveIndex(0);
    const id = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [request]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    setActiveIndex(0);
  }, []);

  const chooseHost = useCallback(
    (serverId: string) => {
      const currentRequest = request;
      close();
      if (!currentRequest) return;
      void currentRequest.onChooseHost(serverId);
    },
    [close, request],
  );

  useEffect(() => {
    if (!request || isNative || typeof window === "undefined") return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key !== "ArrowDown" &&
        event.key !== "ArrowUp" &&
        event.key !== "Enter" &&
        event.key !== "Escape"
      ) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "Enter") {
        const host = options[activeOptionIndex];
        if (!host) return;
        event.preventDefault();
        chooseHost(host.serverId);
        return;
      }

      if (options.length === 0) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? activeOptionIndex + 1 : activeOptionIndex - 1;
      if (next < 0) {
        setActiveIndex(options.length - 1);
        return;
      }
      if (next >= options.length) {
        setActiveIndex(0);
        return;
      }
      setActiveIndex(next);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeOptionIndex, chooseHost, close, options, request]);

  if (!request) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={close} testID="host-chooser">
      <View style={styles.overlay}>
        <Pressable style={styles.backdrop} onPress={close} />
        <View style={styles.panel}>
          <View style={styles.header}>
            <Text style={styles.title}>{request.title}</Text>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={handleQueryChange}
              placeholder="Search hosts..."
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              testID="host-chooser-search"
            />
          </View>
          <ScrollView
            style={styles.results}
            contentContainerStyle={styles.resultsContent}
            keyboardShouldPersistTaps="always"
            showsVerticalScrollIndicator={false}
          >
            {options.length === 0 ? <Text style={styles.emptyText}>No matching hosts</Text> : null}
            {options.map((host, index) => (
              <HostChooserRow
                key={host.serverId}
                host={host}
                active={index === activeOptionIndex}
                onChooseHost={chooseHost}
              />
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create((theme) => ({
  overlay: {
    flex: 1,
    justifyContent: "flex-start",
    alignItems: "center",
    paddingTop: theme.spacing[12],
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.5)",
  },
  panel: {
    width: 640,
    maxWidth: "92%",
    maxHeight: "80%",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    ...theme.shadow.lg,
  },
  header: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[4],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    padding: 0,
    outlineStyle: "none",
  } as object,
  results: {
    maxHeight: 420,
  },
  resultsContent: {
    paddingVertical: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 56,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  rowActive: {
    backgroundColor: theme.colors.surface1,
  },
  rowIconSlot: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  rowTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
}));
