import { useCallback, useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Terminal, Globe, Radio, X } from "lucide-react-native";
import type { McpServerRecord } from "@server/server/mcp/mcp-server-types";
import type { McpServerConfig } from "@server/server/agent/agent-sdk-types";
import { AdaptiveModalSheet, AdaptiveTextInput } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";

export type McpServerType = "stdio" | "http" | "sse";

interface McpServerFormData {
  name: string;
  type: McpServerType;
  description: string;
  tags: string;
  enabled: boolean;
  command: string;
  args: string;
  env: string;
  url: string;
  headers: string;
}

interface McpServerModalProps {
  visible: boolean;
  onClose: () => void;
  onSave: (data: {
    name: string;
    type: McpServerType;
    config: McpServerConfig;
    description?: string;
    tags?: string[];
    enabled: boolean;
  }) => Promise<void>;
  server?: McpServerRecord;
  isLoading?: boolean;
}

const SERVER_TYPE_OPTIONS = [
  {
    value: "stdio" as const,
    label: "Stdio",
    icon: ({ color, size }: { color: string; size: number }) => (
      <Terminal size={size} color={color} />
    ),
  },
  {
    value: "http" as const,
    label: "HTTP",
    icon: ({ color, size }: { color: string; size: number }) => <Globe size={size} color={color} />,
  },
  {
    value: "sse" as const,
    label: "SSE",
    icon: ({ color, size }: { color: string; size: number }) => <Radio size={size} color={color} />,
  },
];

function buildInitialFormData(server?: McpServerRecord): McpServerFormData {
  if (!server) {
    return {
      name: "",
      type: "stdio",
      description: "",
      tags: "",
      enabled: true,
      command: "",
      args: "",
      env: "",
      url: "",
      headers: "",
    };
  }

  const { config } = server;
  if (config.type === "stdio") {
    return {
      name: server.name,
      type: "stdio",
      description: server.description ?? "",
      tags: server.tags?.join(", ") ?? "",
      enabled: server.enabled,
      command: config.command,
      args: config.args?.join(" ") ?? "",
      env: config.env
        ? Object.entries(config.env)
            .map(([k, v]) => `${k}=${v}`)
            .join("\n")
        : "",
      url: "",
      headers: "",
    };
  }
  return {
    name: server.name,
    type: config.type,
    description: server.description ?? "",
    tags: server.tags?.join(", ") ?? "",
    enabled: server.enabled,
    command: "",
    args: "",
    env: "",
    url: config.url,
    headers: config.headers
      ? Object.entries(config.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n")
      : "",
  };
}

function buildConfig(form: McpServerFormData): McpServerConfig {
  if (form.type === "stdio") {
    const env: Record<string, string> = {};
    if (form.env.trim()) {
      for (const line of form.env.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          const eqIdx = trimmed.indexOf("=");
          if (eqIdx > 0) {
            env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
          }
        }
      }
    }
    const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined;
    return {
      type: "stdio",
      command: form.command,
      args,
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  const headers: Record<string, string> = {};
  if (form.headers.trim()) {
    for (const line of form.headers.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        const colonIdx = trimmed.indexOf(":");
        if (colonIdx > 0) {
          headers[trimmed.slice(0, colonIdx).trim()] = trimmed.slice(colonIdx + 1).trim();
        }
      }
    }
  }
  if (form.type === "http") {
    return {
      type: "http",
      url: form.url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  }
  return {
    type: "sse",
    url: form.url,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  multilineInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    minHeight: 80,
    textAlignVertical: "top",
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    marginTop: theme.spacing[2],
  },
}));

export function McpServerModal({
  visible,
  onClose,
  onSave,
  server,
  isLoading = false,
}: McpServerModalProps) {
  const { theme } = useUnistyles();
  const [form, setForm] = useState<McpServerFormData>(buildInitialFormData(server));
  const [error, setError] = useState("");

  const handleClose = useCallback(() => {
    if (isLoading) return;
    setForm(buildInitialFormData(server));
    setError("");
    onClose();
  }, [isLoading, server, onClose]);

  const handleSave = useCallback(async () => {
    setError("");

    if (!form.name.trim()) {
      setError("Name is required");
      return;
    }

    if (!form.command.trim() && form.type === "stdio") {
      setError("Command is required for stdio servers");
      return;
    }

    if (!form.url.trim() && form.type !== "stdio") {
      setError("URL is required for HTTP/SSE servers");
      return;
    }

    const tags = form.tags
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    try {
      await onSave({
        name: form.name.trim(),
        type: form.type,
        config: buildConfig(form),
        description: form.description.trim() || undefined,
        tags: tags.length > 0 ? tags : undefined,
        enabled: form.enabled,
      });
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    }
  }, [form, onSave, handleClose]);

  const updateForm = <K extends keyof McpServerFormData>(key: K, value: McpServerFormData[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const isEditing = Boolean(server);

  return (
    <AdaptiveModalSheet
      title={isEditing ? "Edit MCP Server" : "Add MCP Server"}
      visible={visible}
      onClose={handleClose}
      testID="mcp-server-modal"
    >
      <View style={styles.field}>
        <Text style={styles.label}>Name</Text>
        <AdaptiveTextInput
          value={form.name}
          onChangeText={(v) => updateForm("name", v)}
          placeholder="my-mcp-server"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isLoading}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Type</Text>
        <SegmentedControl
          options={SERVER_TYPE_OPTIONS}
          value={form.type}
          onValueChange={(v) => updateForm("type", v)}
          size="md"
        />
      </View>

      {form.type === "stdio" ? (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>Command</Text>
            <AdaptiveTextInput
              value={form.command}
              onChangeText={(v) => updateForm("command", v)}
              placeholder="npx"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Arguments (space-separated)</Text>
            <AdaptiveTextInput
              value={form.args}
              onChangeText={(v) => updateForm("args", v)}
              placeholder="--flag value"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isLoading}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Environment variables (one per line, KEY=value)</Text>
            <AdaptiveTextInput
              value={form.env}
              onChangeText={(v) => updateForm("env", v)}
              placeholder="KEY=value"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.multilineInput}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              numberOfLines={3}
              editable={!isLoading}
            />
          </View>
        </>
      ) : (
        <>
          <View style={styles.field}>
            <Text style={styles.label}>URL</Text>
            <AdaptiveTextInput
              value={form.url}
              onChangeText={(v) => updateForm("url", v)}
              placeholder={
                form.type === "http" ? "http://localhost:8080/mcp" : "http://localhost:8080/sse"
              }
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              editable={!isLoading}
            />
          </View>

          <View style={styles.field}>
            <Text style={styles.label}>Headers (one per line, Key: Value)</Text>
            <AdaptiveTextInput
              value={form.headers}
              onChangeText={(v) => updateForm("headers", v)}
              placeholder="Authorization: Bearer token"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={styles.multilineInput}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              numberOfLines={3}
              editable={!isLoading}
            />
          </View>
        </>
      )}

      <View style={styles.field}>
        <Text style={styles.label}>Description</Text>
        <AdaptiveTextInput
          value={form.description}
          onChangeText={(v) => updateForm("description", v)}
          placeholder="What does this server do?"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="sentences"
          autoCorrect={false}
          editable={!isLoading}
        />
      </View>

      <View style={styles.field}>
        <Text style={styles.label}>Tags (comma-separated)</Text>
        <AdaptiveTextInput
          value={form.tags}
          onChangeText={(v) => updateForm("tags", v)}
          placeholder="api, database, custom"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!isLoading}
        />
      </View>

      <View style={[styles.field, styles.row]}>
        <Text style={styles.label}>Enabled</Text>
        <Switch
          value={form.enabled}
          onValueChange={(v) => updateForm("enabled", v)}
          disabled={isLoading}
          trackColor={{ true: theme.colors.primary, false: theme.colors.surface3 }}
          thumbColor={theme.colors.palette.white}
        />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.actions}>
        <Button
          style={{ flex: 1 }}
          variant="secondary"
          onPress={handleClose}
          disabled={isLoading}
          leftIcon={<X size={16} color={theme.colors.foreground} />}
        >
          Cancel
        </Button>
        <Button
          style={{ flex: 1 }}
          variant="default"
          onPress={() => void handleSave()}
          disabled={isLoading}
        >
          {isLoading ? "Saving..." : isEditing ? "Update" : "Create"}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
