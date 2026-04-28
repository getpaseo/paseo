import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  AlertTriangle,
  ImagePlus,
  Info,
  LogIn,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Terminal,
  User,
  X,
  Zap,
} from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { resizeImageToDataUrl } from "@/utils/resize-image-to-data-url";
import { isWeb } from "@/constants/platform";
import { router } from "expo-router";
import { openExternalUrl } from "@/utils/open-external-url";
import { useWindowControlsPadding } from "@/utils/desktop-window";
import { getIsElectron } from "@/constants/platform";
import { DESKTOP_TRAFFIC_LIGHT_HEIGHT, DESKTOP_TRAFFIC_LIGHT_WIDTH } from "@/constants/layout";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useOrganizations } from "@/desktop/hooks/use-organizations";
import { setActiveOrgId, useActiveOrgId } from "@/stores/active-org-store";
import { useWorkspaceTabsStore } from "@/stores/workspace-tabs-store";
import { useChatStore } from "@/stores/chat-store";
import { StatusPicker, StatusDot } from "@/components/status-picker";
import { useIsInSharedSession, useIsSharedRecipient } from "@/stores/shared-session-store";

/**
 * Full-width accent strip across the Electron titlebar so the traffic-light
 * area shares the same brand color as the rail — no black gap at the top.
 * Pointer events disabled so it doesn't steal clicks from the window
 * controls or the sidebar toggle.
 */
export function DesktopTitlebarAccent() {
  const { theme } = useUnistyles();
  const setCommandCenterOpen = useKeyboardShortcutsStore((s) => s.setCommandCenterOpen);
  // Hide for *any* shared session (host or recipient) — the participant bar
  // already occupies the titlebar area and reserves traffic-light space, so
  // stacking the pink accent on top would leave an empty strip between them.
  const hideAccent = useIsInSharedSession();
  if (!getIsElectron()) return null;
  if (hideAccent) return null;

  // The whole strip is draggable (WebkitAppRegion: "drag") — except the search
  // pill which needs to receive clicks. Electron treats any descendant with
  // `no-drag` as interactive and lets the rest remain as window drag surface.
  //
  // Rendered as a raw <div> (not <View>) because React Native Web strips the
  // non-standard `WebkitAppRegion` property from View styles.
  const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const shortcutLabel = isMac ? "⌘K" : "Ctrl+K";

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: DESKTOP_TRAFFIC_LIGHT_HEIGHT,
        backgroundColor: theme.colors.accent,
        zIndex: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        paddingLeft: DESKTOP_TRAFFIC_LIGHT_WIDTH,
        paddingRight: 16,
        // @ts-expect-error — WebkitAppRegion is not in CSSProperties
        WebkitAppRegion: "drag",
      }}
    >
      <button
        type="button"
        onClick={() => setCommandCenterOpen(true)}
        style={{
          // no-drag so the click actually reaches the button
          // @ts-expect-error — WebkitAppRegion is not in CSSProperties
          WebkitAppRegion: "no-drag",
          display: "flex",
          alignItems: "center",
          gap: 8,
          maxWidth: 520,
          width: "min(520px, 40vw)",
          minWidth: 0,
          height: 26,
          padding: "0 10px",
          borderRadius: 6,
          border: "1px solid rgba(255, 255, 255, 0.28)",
          backgroundColor: "rgba(0, 0, 0, 0.18)",
          color: "rgba(255, 255, 255, 0.85)",
          fontSize: 12,
          cursor: "pointer",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
        aria-label={`Open command center (${shortcutLabel})`}
      >
        <Search size={12} color="currentColor" style={{ flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            textAlign: "left",
            opacity: 0.75,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          Search projects, agents, commands…
        </span>
        <span
          style={{
            flexShrink: 0,
            opacity: 0.6,
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {shortcutLabel}
        </span>
      </button>
    </div>
  );
}

/**
 * Slack-style slim rail for switching between organizations. Shows the
 * signed-in user avatar at the top, org tiles in the middle (click to
 * select — updates the global `activeOrgId` store which drives shares,
 * members, and workspace visibility elsewhere), and a "+" button to create
 * a new organization. Rendered on web + desktop, hidden on mobile/native.
 */
export function DesktopOrgRail() {
  const { theme } = useUnistyles();
  const { user, isAuthenticated, signIn, isSigningIn } = useAuthSession();
  const { organizations, createOrganization, isCreating } = useOrganizations();
  const activeOrgId = useActiveOrgId();
  const windowPadding = useWindowControlsPadding("sidebar");
  const isInSharedSession = useIsSharedRecipient();
  const sharedSessionActive = useIsInSharedSession();
  const [modalOpen, setModalOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const myStatus = useChatStore((s) => s.myStatus);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [logoDataUrl, setLogoDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handlePickLogo = useCallback(() => {
    if (!isWeb || !fileInputRef.current) return;
    fileInputRef.current.value = "";
    fileInputRef.current.click();
  }, []);

  const handleLogoFileChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageToDataUrl(file, { targetSize: 256 });
      setLogoDataUrl(dataUrl);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to process image");
    }
  }, []);

  const handleRemoveLogo = useCallback(() => {
    setLogoDataUrl(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  // Default to the first org if no selection has been made yet.
  useEffect(() => {
    if (!activeOrgId && organizations.length > 0) {
      setActiveOrgId(organizations[0].id);
    }
  }, [activeOrgId, organizations]);

  const orgTiles = useMemo(() => {
    return organizations.map((o) => ({
      id: o.id,
      name: o.name,
      initial: (o.name ?? "").trim().charAt(0).toUpperCase() || "?",
      logo: o.logo,
    }));
  }, [organizations]);

  const handleCreate = async () => {
    if (!name.trim() || !slug.trim()) {
      setError("Name and slug are required");
      return;
    }
    setError(null);
    try {
      const created = await createOrganization({
        name: name.trim(),
        slug: slug.trim(),
        ...(logoDataUrl ? { logo: logoDataUrl } : {}),
      });
      setModalOpen(false);
      setName("");
      setSlug("");
      setLogoDataUrl(null);
      if (created?.id) {
        useWorkspaceTabsStore.getState().resetAll();
        setActiveOrgId(created.id);
        router.replace("/welcome");
      }
    } catch (err) {
      const raw = err instanceof Error ? err.message : "Failed to create organization";
      setError(cleanErrorMessage(raw));
    }
  };

  const isLimitError = !!error && /limit\s*reached|upgrade/i.test(error);

  // Hide the rail entirely when inside a shared-workspace session — the
  // recipient is scoped to a single workspace owned by someone else, so
  // switching orgs there makes no sense.
  if (isInSharedSession) return null;

  // On Electron/macOS, clear the pink rail from the traffic-light area so the
  // close/minimize/fullscreen buttons sit on the window's native background
  // instead of on top of the accent color.
  const backgroundTop = getIsElectron() && !sharedSessionActive ? DESKTOP_TRAFFIC_LIGHT_HEIGHT : 0;

  return (
    <View
      style={[
        styles.rail,
        // Electron on macOS puts traffic lights ~45px tall at the top-left,
        // and they extend horizontally past this 56px rail. Reserve enough
        // headroom even if `useWindowControlsPadding` returns 0 during the
        // initial render flash.
        {
          // When the participant bar sits on top, it absorbs the traffic-light
          // cluster + titlebar height — no need to reserve that space again.
          paddingTop:
            getIsElectron() && !sharedSessionActive ? Math.max(windowPadding.top, 48) + 8 : 12,
        },
      ]}
    >
      <View
        style={{
          pointerEvents: "none",
          position: "absolute",
          top: backgroundTop,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: theme.colors.accent,
          borderRightWidth: 1,
          borderRightColor: theme.colors.border,
        }}
      />
      {!isAuthenticated ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Sign in to unlock Messages, Skills, MCP and shared workspaces"
            disabled={isSigningIn}
            style={({ hovered = false }) => [styles.avatarWrap, hovered && styles.itemHovered]}
            onPress={() => void signIn(undefined)}
          >
            <View style={[styles.avatar, styles.avatarFallback]}>
              <LogIn size={16} color="rgba(255,255,255,0.9)" />
            </View>
          </Pressable>
          <View style={styles.divider} />
        </>
      ) : null}
      {isAuthenticated ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Set status (current: ${myStatus})`}
            style={({ hovered = false }) => [styles.avatarWrap, hovered && styles.itemHovered]}
            onPress={() => setStatusOpen(true)}
          >
            <View style={{ width: 32, height: 32 }}>
              {user?.avatarUrl ? (
                <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
              ) : (
                <View style={[styles.avatar, styles.avatarFallback]}>
                  <User size={16} color="rgba(255,255,255,0.85)" />
                </View>
              )}
              <View style={styles.statusDotWrap}>
                <StatusDot status={myStatus} size={10} />
              </View>
            </View>
          </Pressable>
          <StatusPicker visible={statusOpen} onClose={() => setStatusOpen(false)} />

          <View style={styles.divider} />
        </>
      ) : null}

      <View style={styles.orgList}>
        {orgTiles.map((o) => {
          const active = o.id === activeOrgId;
          return (
            <Pressable
              key={o.id}
              accessibilityRole="button"
              accessibilityLabel={`Select organization ${o.name}`}
              onPress={() => {
                if (o.id !== activeOrgId) {
                  useWorkspaceTabsStore.getState().resetAll();
                  setActiveOrgId(o.id);
                  router.replace("/welcome");
                }
              }}
              style={({ hovered = false }) => [
                styles.orgTile,
                active && styles.orgTileActive,
                hovered && !active && styles.itemHovered,
              ]}
            >
              {o.logo ? (
                <Image source={{ uri: o.logo }} style={styles.orgLogo} />
              ) : (
                <Text style={[styles.orgInitial, active && styles.orgInitialActive]}>
                  {o.initial}
                </Text>
              )}
            </Pressable>
          );
        })}

        {isAuthenticated ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Create organization"
            style={({ hovered = false }) => [styles.addTile, hovered && styles.itemHovered]}
            onPress={() => setModalOpen(true)}
          >
            <Plus size={16} color="rgba(255,255,255,0.85)" />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.spacer} />

      <DropdownMenu>
        <DropdownMenuTrigger
          accessibilityRole="button"
          accessibilityLabel="Agent extensions"
          style={({ hovered = false }) => [styles.bottomTile, hovered && styles.itemHovered]}
        >
          <Zap size={14} color="rgba(255,255,255,0.85)" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" minWidth={180}>
          <DropdownMenuItem
            leading={<Sparkles size={14} color={"white"} />}
            onSelect={() => router.push("/settings?tab=hooks")}
          >
            Hooks
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={<Terminal size={14} color={"white"} />}
            onSelect={() => router.push("/settings?tab=commands")}
          >
            Commands
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={<Info size={14} color={"white"} />}
            onSelect={() => router.push("/settings?tab=rules")}
          >
            Rules
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        style={({ hovered = false }) => [styles.bottomTile, hovered && styles.itemHovered]}
        onPress={() => router.push("/settings")}
      >
        <SettingsIcon size={14} color="rgba(255,255,255,0.85)" />
      </Pressable>

      <AdaptiveModalSheet
        visible={modalOpen}
        onClose={() => setModalOpen(false)}
        title="Create organization"
      >
        <View style={styles.modalContent}>
          <Text style={styles.fieldLabel}>Logo</Text>
          <View style={styles.logoRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Upload organization logo"
              onPress={handlePickLogo}
              style={styles.logoPreviewButton}
            >
              {logoDataUrl ? (
                <Image source={{ uri: logoDataUrl }} style={styles.logoPreviewImage} />
              ) : (
                <ImagePlus size={20} color={theme.colors.foregroundMuted} />
              )}
            </Pressable>
            <View style={styles.logoCopy}>
              <Text style={styles.logoHint}>
                {logoDataUrl ? "Logo added" : "Upload a square image"}
              </Text>
              <View style={styles.logoActions}>
                <Button variant="ghost" size="sm" onPress={handlePickLogo}>
                  {logoDataUrl ? "Change" : "Upload"}
                </Button>
                {logoDataUrl ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Remove logo"
                    onPress={handleRemoveLogo}
                    style={styles.logoRemoveBtn}
                  >
                    <X size={12} color={theme.colors.foregroundMuted} />
                    <Text style={styles.logoRemoveText}>Remove</Text>
                  </Pressable>
                ) : null}
              </View>
            </View>
          </View>
          {isWeb ? (
            // React Native's <Modal> doesn't render in the DOM tree, so the
            // hidden file input lives inline and is triggered programatically.
            // eslint-disable-next-line react/forbid-elements
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={handleLogoFileChange}
            />
          ) : null}

          <Text style={styles.fieldLabel}>Name</Text>
          <TextInput
            value={name}
            onChangeText={(v) => {
              setName(v);
              setSlug((prev) =>
                prev === "" || prev === slugifyLocal(name) ? slugifyLocal(v) : prev,
              );
            }}
            placeholder="Acme Inc."
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, { color: theme.colors.foreground }]}
            autoFocus
          />

          <Text style={styles.fieldLabel}>Slug</Text>
          <TextInput
            value={slug}
            onChangeText={setSlug}
            placeholder="acme"
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, { color: theme.colors.foreground }]}
            autoCapitalize="none"
          />

          {error &&
            (isLimitError ? (
              <View style={styles.upgradeCard}>
                <View style={styles.upgradeIconWrap}>
                  <Sparkles size={14} color={theme.colors.accent} />
                </View>
                <View style={styles.upgradeBody}>
                  <Text style={styles.upgradeTitle}>You've reached your plan limit</Text>
                  <Text style={styles.upgradeHint}>
                    Upgrade your plan to create more organizations.
                  </Text>
                </View>
                <Button
                  variant="default"
                  size="sm"
                  onPress={() => {
                    void openExternalUrl(
                      __DEV__
                        ? "http://localhost:3002/dashboard/billing"
                        : "https://auth.hubcode.ai/dashboard/billing",
                    );
                  }}
                >
                  Upgrade
                </Button>
              </View>
            ) : (
              <View style={styles.errorCard}>
                <AlertTriangle size={14} color={theme.colors.destructive} />
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ))}

          <View style={styles.modalActions}>
            <Button variant="ghost" size="md" onPress={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="md"
              onPress={() => void handleCreate()}
              disabled={isCreating}
            >
              {isCreating ? "Creating..." : "Create"}
            </Button>
          </View>
        </View>
      </AdaptiveModalSheet>
    </View>
  );
}

function slugifyLocal(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Electron IPC errors arrive as
//   "Error invoking remote method 'hubcode:invoke': Error: <actual message>"
// Strip the boilerplate so the user sees just the cause.
function cleanErrorMessage(raw: string): string {
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "")
    .trim();
}

const RAIL_WIDTH = 56;

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: RAIL_WIDTH,
    flexDirection: "column",
    alignItems: "center",
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  avatarWrap: {
    width: 36,
    height: 36,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.lg,
  },
  statusDotWrap: {
    position: "absolute",
    right: -2,
    bottom: -2,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.lg,
  },
  avatarFallback: {
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    width: 20,
    height: 1,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginVertical: theme.spacing[1],
  },
  orgList: {
    alignItems: "center",
    gap: theme.spacing[2] - 2,
  },
  orgTile: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "transparent",
  },
  orgTileActive: {
    borderColor: "#ffffff",
    backgroundColor: "rgba(255,255,255,0.25)",
  },
  orgLogo: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.base,
  },
  orgInitial: {
    color: "rgba(255,255,255,0.75)",
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  orgInitialActive: {
    color: "#ffffff",
  },
  addTile: {
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
    borderStyle: "dashed",
  },
  itemHovered: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  spacer: {
    flex: 1,
  },
  bottomTile: {
    width: 32,
    height: 32,
    borderRadius: theme.borderRadius.base,
    alignItems: "center",
    justifyContent: "center",
  },
  modalContent: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  fieldLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  logoRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  logoPreviewButton: {
    width: 56,
    height: 56,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  logoPreviewImage: {
    width: "100%",
    height: "100%",
  },
  logoCopy: {
    flex: 1,
    gap: theme.spacing[1],
  },
  logoHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  logoActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  logoRemoveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  logoRemoveText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  input: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2] + 2,
    backgroundColor: theme.colors.surface1,
    fontSize: theme.fontSize.sm,
  },
  errorCard: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.destructive,
  },
  errorText: {
    flex: 1,
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.4,
  },
  upgradeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  upgradeIconWrap: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.base,
    backgroundColor: `${theme.colors.accent}22`,
  },
  upgradeBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  upgradeTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  upgradeHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.35,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
}));
