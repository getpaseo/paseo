import {
  usePaseo,
  usePluginFileTransfer,
  useRpc,
  type PluginPickedFile,
  type PluginSurfaceProps,
} from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { importFile, inspectDestination, target } from "../shared/contracts";

export function ImportScreen(props: PluginSurfaceProps) {
  if (typeof usePluginFileTransfer !== "function") {
    return <Text style={screenStyle(props.theme).text}>Update this Paseo app to copy files.</Text>;
  }
  return <HostImport key={props.host.id} {...props} />;
}

type Project = Awaited<
  ReturnType<ReturnType<typeof usePaseo>["projects"]["list"]>
>["projects"][number];

function HostImport({ host, theme }: PluginSurfaceProps) {
  const paseo = usePaseo();
  const transfer = usePluginFileTransfer();
  const inspect = useRpc(inspectDestination);
  const projects = useQuery({
    queryKey: ["local-files-projects", host.id],
    queryFn: async () =>
      (await paseo.projects.list()).projects.filter((p) => p.projectKind === "git"),
  });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [review, setReview] = useState<{
    file: PluginPickedFile;
    destination: Parameters<typeof inspect>[0] & { path: string };
  } | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const project = projects.data?.find((p) => p.projectId === projectId);
  const styles = useMemo(() => screenStyle(theme), [theme]);
  const selectProject = useCallback((id: string) => {
    setProjectId(id);
    setReview(null);
    setMessage("");
  }, []);
  const cancel = useCallback(() => setReview(null), []);
  const { refetch } = projects;
  const retry = useCallback(() => void refetch(), [refetch]);

  const chooseFile = useCallback(async () => {
    if (!transfer || !project) return;
    setBusy(true);
    setReview(null);
    setMessage("");
    try {
      const file = await transfer.pick();
      if (!file) return;
      const destination = target.parse({
        projectId: project.projectId,
        root: project.projectRootPath,
        name: file.name,
      });
      const { path, status } = await inspect(destination);
      if (status === "exists") setMessage(`${file.name} already exists in this checkout.`);
      else if (status === "not-ignored")
        setMessage(`Git does not ignore ${file.name} in this checkout.`);
      else setReview({ file, destination: { ...destination, path } });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not select the file.");
    } finally {
      setBusy(false);
    }
  }, [inspect, project, transfer]);

  const copyFile = useCallback(async () => {
    if (!transfer || !review) return;
    setBusy(true);
    setMessage("");
    setReview(null);
    try {
      const header = new TextEncoder().encode(`${JSON.stringify(review.destination)}\n`);
      const { path } = await transfer.send(review.file, importFile, header);
      setMessage(`Copied to ${path} on ${host.label}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not import the file.");
    } finally {
      setBusy(false);
    }
  }, [host.label, review, transfer]);

  return (
    <ScrollView contentContainerStyle={styles.screen}>
      <Text style={styles.muted}>
        Copy one ignored file from this device to a project on {host.label}.
      </Text>
      <Text accessibilityRole="header" style={styles.title}>
        Destination project
      </Text>
      {projects.isPending && <Text style={styles.muted}>Loading projects…</Text>}
      {projects.isError && <Action theme={theme} label="Retry loading projects" onPress={retry} />}
      {projects.data?.length === 0 && (
        <Text style={styles.muted}>No Git projects on this host.</Text>
      )}
      {projects.data?.map((entry) => (
        <ProjectChoice
          key={entry.projectId}
          entry={entry}
          checked={projectId === entry.projectId}
          disabled={busy}
          styles={styles}
          onSelect={selectProject}
        />
      ))}
      {review ? (
        <View style={styles.review}>
          <Text accessibilityRole="header" style={styles.title}>
            Review copy
          </Text>
          <Text style={styles.text}>
            {review.file.name} · {review.file.size} bytes · This device
          </Text>
          <Text style={styles.text}>
            {host.label} · {review.destination.path}
          </Text>
          <Text style={styles.muted}>
            A matching .worktreeinclude rule makes this file available to new worktrees.
          </Text>
          <Action theme={theme} label={`Copy to ${host.label}`} onPress={copyFile} />
          <Action theme={theme} label="Cancel" secondary onPress={cancel} />
        </View>
      ) : (
        <Action
          theme={theme}
          label={busy ? "Working…" : "Choose file from this device"}
          disabled={!project || !transfer || busy}
          onPress={chooseFile}
        />
      )}
      {!transfer && <Text style={styles.muted}>Update this Paseo app to copy files.</Text>}
      {!!message && (
        <Text accessibilityRole="alert" style={styles.text}>
          {message}
        </Text>
      )}
    </ScrollView>
  );
}

function screenStyle({ colors }: PluginSurfaceProps["theme"]) {
  return StyleSheet.create({
    screen: { padding: 20, gap: 16, width: "100%", maxWidth: 640, alignSelf: "center" },
    muted: { color: colors.foregroundMuted },
    text: { color: colors.foreground },
    title: { color: colors.foreground, fontWeight: "600" },
    review: { gap: 12 },
    project: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 8, borderColor: colors.border },
    selected: { borderColor: colors.accent },
  });
}

function ProjectChoice({
  entry,
  checked,
  disabled,
  styles,
  onSelect,
}: {
  entry: Project;
  checked: boolean;
  disabled: boolean;
  styles: ReturnType<typeof screenStyle>;
  onSelect: (id: string) => void;
}) {
  const select = useCallback(() => onSelect(entry.projectId), [entry.projectId, onSelect]);
  const accessibilityState = useMemo(() => ({ checked, disabled }), [checked, disabled]);
  const style = useMemo(() => [styles.project, checked && styles.selected], [styles, checked]);
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={select}
      style={style}
    >
      <Text style={styles.title}>{entry.projectCustomName || entry.projectDisplayName}</Text>
      <Text style={styles.muted}>{entry.projectRootPath}</Text>
    </Pressable>
  );
}

function Action({
  theme,
  onPress,
  label,
  disabled,
  secondary,
}: {
  theme: PluginSurfaceProps["theme"];
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  const { colors } = theme;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        button: {
          minHeight: 44,
          justifyContent: "center",
          alignItems: "center",
          borderRadius: 8,
          paddingHorizontal: 12,
          opacity: disabled ? 0.5 : 1,
          backgroundColor: secondary ? colors.surface1 : colors.accent,
        },
        text: {
          color: secondary ? colors.foreground : colors.accentForeground,
          fontWeight: "600",
        },
      }),
    [colors, disabled, secondary],
  );
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={styles.button}
    >
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  );
}
