import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  TRANSPORT_BY_TARGET,
  type LibraryScope,
  type LibrarySyncTarget,
  type LibraryVisibility,
  type McpPayload,
  type McpTransport,
} from "@/api/library";
import { fetchMcpCatalogDetail, type CatalogItem } from "@/api/catalog";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { ScopeVisibilityPicker } from "./scope-visibility-picker";
import { SyncTargetsPicker } from "./sync-targets-picker";
import { KeyValueEditor } from "./key-value-editor";

export interface AddMcpInitial {
  /** Pre-fill from a catalog item; empty = custom. */
  fromCatalog?: CatalogItem;
  /** Default name to render in the Name input. */
  suggestedName?: string;
}

export interface AddMcpModalProps {
  visible: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    name: string;
    displayName: string;
    description: string | null;
    payload: McpPayload;
    iconUrl: string | null;
    source: "custom" | "catalog";
    catalogId: string | null;
    scope: LibraryScope;
    scopeId: string | null;
    visibility: LibraryVisibility;
    syncTargets: LibrarySyncTarget[];
  }) => Promise<void> | void;
  initial?: AddMcpInitial;
  activeOrgId: string | null;
  activeProjectId: string | null;
  submitting?: boolean;
  /** Hide transport switcher when coming from a catalog that pinned it. */
  lockTransport?: boolean;
}

const ALL_TARGETS: LibrarySyncTarget[] = ["claude-code", "codex", "opencode"];

// rgba so it sits between background and foregroundMuted — clearly placeholder,
// not user-typed text. Avoids the "did the catalog autofill this?" confusion.
const mutedPlaceholder = "rgba(160, 160, 170, 0.55)";

function hostnameOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, "");
  } catch {
    return href;
  }
}

/**
 * Prefer the GitHub README over the PulseMCP catalog page. The catalog page
 * only mirrors metadata; the README is where the install instructions + env
 * vars actually live. Falls back to whatever homepage the catalog item has.
 */
function readmeUrlFor(item: CatalogItem | undefined): string | null {
  if (!item) return null;
  const homepage = item.homepage ?? null;
  if (homepage) {
    try {
      const u = new URL(homepage);
      // github.com/<owner>/<repo>[/...] → keep, strip sub-paths.
      if (u.hostname === "github.com") {
        const parts = u.pathname.split("/").filter(Boolean);
        if (parts.length >= 2) {
          return `https://github.com/${parts[0]}/${parts[1]}#readme`;
        }
      }
    } catch {
      /* fall through */
    }
  }
  return homepage;
}

export function AddMcpModal({
  visible,
  onClose,
  onSubmit,
  initial,
  activeOrgId,
  activeProjectId,
  submitting,
  lockTransport,
}: AddMcpModalProps) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<McpTransport>("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [url, setUrl] = useState("");
  const [headers, setHeaders] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<Record<string, string>>({});
  const [scope, setScope] = useState<LibraryScope>("user");
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<LibraryVisibility>("private");
  const [syncTargets, setSyncTargets] = useState<LibrarySyncTarget[]>([]);

  const { session } = useAuthSession();
  const sessionToken = session?.sessionToken ?? null;

  // Apply a (possibly enriched) catalog item to the form state. Extracted so
  // we can call it synchronously on open + again once the detail fetch
  // resolves without duplicating field resets.
  const applyCatalog = (c: CatalogItem | undefined) => {
    setName(c?.name.toLowerCase().replace(/\s+/g, "-") ?? initial?.suggestedName ?? "");
    const initialTransport: McpTransport = c?.install?.url
      ? "http"
      : c?.transports?.[0] ?? "stdio";
    setTransport(initialTransport);
    setCommand(c?.install?.command ?? "");
    setArgsText((c?.install?.args ?? []).join("\n"));
    setUrl(c?.install?.url ?? "");
    setHeaders(c?.install?.headers ?? {});
    // Pre-seed env vars with empty values so the required keys show up in the
    // editor — users fill in the secret + click Add.
    const seededEnv: Record<string, string> = {};
    for (const key of c?.install?.envVars ?? []) seededEnv[key] = "";
    setEnv(seededEnv);
    setScope("user");
    setScopeId(null);
    setVisibility("private");
    setSyncTargets(
      ALL_TARGETS.filter((t) => TRANSPORT_BY_TARGET[t].includes(initialTransport)),
    );
  };

  // Reset every time the modal opens — prevents stale state from a previous
  // Add/Cancel cycle leaking into the next catalog card click.
  useEffect(() => {
    if (!visible) return;
    applyCatalog(initial?.fromCatalog);

    // Smithery list items are intentionally lean; hit the detail endpoint to
    // learn the required env vars + actual deployment URL / stdio command.
    const stub = initial?.fromCatalog;
    if (stub && !stub.install) {
      let cancelled = false;
      void fetchMcpCatalogDetail({ sessionToken, id: stub.id }).then((enriched) => {
        if (cancelled || !enriched) return;
        applyCatalog({ ...stub, ...enriched });
      });
      return () => {
        cancelled = true;
      };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, initial]);

  const displayName = useMemo(
    () => initial?.fromCatalog?.name ?? name ?? "",
    [initial, name],
  );

  const isValid =
    name.trim().length > 0 &&
    (transport === "stdio"
      ? command.trim().length > 0
      : url.trim().length > 0);

  // True when the catalog couldn't suggest a Command/URL — usually means the
  // server isn't published as an npm/pypi package and has no remote endpoint,
  // so the user needs to copy the install line from the project's README.
  const needsManualInstall =
    !!initial?.fromCatalog &&
    transport === "stdio" &&
    !initial.fromCatalog.install?.command;

  const handleSubmit = async () => {
    if (!isValid || submitting) return;
    const args = argsText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const payload: McpPayload =
      transport === "stdio"
        ? {
            transport: "stdio",
            command: command.trim(),
            ...(args.length ? { args } : {}),
            ...(Object.keys(env).length ? { env } : {}),
          }
        : {
            transport,
            url: url.trim(),
            ...(Object.keys(headers).length ? { headers } : {}),
            ...(Object.keys(env).length ? { env } : {}),
          };
    await onSubmit({
      name: name.trim(),
      displayName: displayName.trim() || name.trim(),
      description: initial?.fromCatalog?.description ?? null,
      payload,
      iconUrl: initial?.fromCatalog?.iconUrl ?? null,
      source: initial?.fromCatalog ? "catalog" : "custom",
      catalogId: initial?.fromCatalog?.id ?? null,
      scope,
      scopeId,
      visibility,
      syncTargets: syncTargets.filter((t) =>
        TRANSPORT_BY_TARGET[t].includes(transport),
      ),
    });
  };

  // Auto-narrow sync targets when transport flips — picker UI already shows
  // disabled state but we also want the stored value to stay consistent if
  // the user never touches it.
  useEffect(() => {
    setSyncTargets((current) =>
      current.filter((t) => TRANSPORT_BY_TARGET[t].includes(transport)),
    );
  }, [transport]);

  const title = initial?.fromCatalog
    ? `Add ${initial.fromCatalog.name}`
    : "Add Custom MCP Server";

  return (
    <AdaptiveModalSheet title={title} visible={visible} onClose={onClose}>
      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
      >
        {initial?.fromCatalog?.description ? (
          <Text style={styles.subtitle}>{initial.fromCatalog.description}</Text>
        ) : null}

        <Field label="Server Name">
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="my-server"
            placeholderTextColor={mutedPlaceholder}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
        </Field>

        {!lockTransport ? (
          <Field label="Transport">
            <View style={styles.transportRow}>
              {(["stdio", "http", "sse"] as const).map((t) => (
                <Pressable
                  key={t}
                  onPress={() => setTransport(t)}
                  style={({ hovered }) => [
                    styles.transportChip,
                    transport === t && styles.transportChipActive,
                    transport !== t && hovered && styles.transportChipHovered,
                  ]}
                >
                  <Text
                    style={[
                      styles.transportChipText,
                      transport === t && styles.transportChipTextActive,
                    ]}
                  >
                    {t}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>
        ) : null}

        {transport === "stdio" ? (
          <>
            {needsManualInstall ? (
              <View style={styles.helperBanner}>
                <Text style={styles.helperBannerText}>
                  This server isn't published as a package, so we couldn't
                  pre-fill the install command. Check the project's README
                  {readmeUrlFor(initial?.fromCatalog) ? (
                    <Text
                      style={styles.helperLink}
                      accessibilityRole="link"
                      onPress={() => {
                        const url = readmeUrlFor(initial?.fromCatalog);
                        if (url) void openExternalUrl(url);
                      }}
                    >
                      {" "}({hostnameOf(readmeUrlFor(initial?.fromCatalog)!)})
                    </Text>
                  ) : null}{" "}
                  and paste the command + args below.
                </Text>
              </View>
            ) : null}
            <Field label="Command">
              <TextInput
                value={command}
                onChangeText={setCommand}
                placeholder="npx"
                placeholderTextColor={mutedPlaceholder}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </Field>
            <Field label="Arguments (one per line)">
              <TextInput
                value={argsText}
                onChangeText={setArgsText}
                placeholder={"-y\n@playwright/mcp@latest"}
                placeholderTextColor={mutedPlaceholder}
                multiline
                numberOfLines={4}
                style={[styles.input, styles.multiline]}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <TextInput
                value={url}
                onChangeText={setUrl}
                placeholder="https://mcp.example.com/mcp"
                placeholderTextColor={mutedPlaceholder}
                keyboardType="url"
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
            </Field>
            <KeyValueEditor
              label="Headers"
              addLabel="Add header"
              value={headers}
              onChange={setHeaders}
              keyPlaceholder="Authorization"
              valuePlaceholder="Bearer ..."
            />
          </>
        )}

        <KeyValueEditor
          label="Environment Variables"
          addLabel="Add env var"
          value={env}
          onChange={setEnv}
          maskValues
        />

        <ScopeVisibilityPicker
          scope={scope}
          scopeId={scopeId}
          visibility={visibility}
          onChange={(patch) => {
            if (patch.scope !== undefined) setScope(patch.scope);
            if (patch.scopeId !== undefined) setScopeId(patch.scopeId);
            if (patch.visibility !== undefined) setVisibility(patch.visibility);
          }}
          activeOrgId={activeOrgId}
          activeProjectId={activeProjectId}
        />

        <SyncTargetsPicker
          transport={transport}
          value={syncTargets}
          onChange={setSyncTargets}
        />

        <View style={styles.actions}>
          <Pressable
            onPress={onClose}
            style={({ hovered }) => [
              styles.cancelBtn,
              hovered && styles.cancelBtnHovered,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={handleSubmit}
            disabled={!isValid || submitting}
            style={({ hovered }) => [
              styles.submitBtn,
              (!isValid || submitting) && styles.submitBtnDisabled,
              isValid && !submitting && hovered && styles.submitBtnHovered,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.submitText}>{submitting ? "Adding…" : "Add"}</Text>
          </Pressable>
        </View>
      </ScrollView>
    </AdaptiveModalSheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    gap: theme.spacing[4],
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    marginTop: -theme.spacing[2],
  },
  field: {
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  input: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  multiline: {
    minHeight: 96,
    textAlignVertical: "top" as const,
    paddingTop: 10,
  },
  transportRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  transportChip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  transportChipHovered: {
    backgroundColor: theme.colors.surface2,
  },
  transportChipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  transportChipText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foregroundMuted,
    textTransform: "lowercase" as const,
  },
  transportChipTextActive: {
    color: theme.colors.accent,
    fontWeight: "600" as const,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  cancelBtn: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  cancelBtnHovered: {
    backgroundColor: theme.colors.surface2,
  },
  cancelText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  submitBtn: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.accent,
  },
  submitBtnHovered: {
    backgroundColor: theme.colors.accentBright,
  },
  submitBtnDisabled: {
    opacity: 0.5,
  },
  submitText: {
    fontSize: theme.fontSize.sm,
    fontWeight: "600" as const,
    color: theme.colors.accentForeground,
  },
  helperBanner: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
  },
  helperBannerText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  helperLink: {
    color: theme.colors.accent,
    textDecorationLine: "underline" as const,
  },
}));
