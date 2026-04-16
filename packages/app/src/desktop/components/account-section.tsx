import { useState } from "react";
import { ActivityIndicator, Image, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import {
  LogOut,
  Plus,
  Mail,
  Crown,
  Shield,
  User,
  RefreshCw,
  ArrowRight,
} from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { useOrganizations } from "@/desktop/hooks/use-organizations";
import { useOrgMembers } from "@/desktop/hooks/use-org-members";
import type { DesktopOrganization } from "@/desktop/auth/desktop-auth";
import { UpgradeBanner, UpgradeLimitHint } from "@/desktop/components/upgrade-banner";

// ---------------------------------------------------------------------------
// Sign-in section (shown when not authenticated)
// ---------------------------------------------------------------------------

function SignInContent() {
  const { theme } = useUnistyles();
  const { signIn, isSigningIn, signInError } = useAuthSession();

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={settingsStyles.rowContent}>
          <Text style={settingsStyles.rowTitle}>Sign in</Text>
          <Text style={settingsStyles.rowHint}>
            Manage organizations and sync settings across devices.
          </Text>
          {signInError && <Text style={styles.error}>{signInError}</Text>}
        </View>
        <Pressable
          style={({ hovered }) => [
            styles.signInButton,
            hovered && styles.signInButtonHovered,
            isSigningIn && styles.signInButtonDisabled,
          ]}
          onPress={() => void signIn(undefined)}
          disabled={isSigningIn}
        >
          <Text style={styles.signInButtonText}>{isSigningIn ? "Waiting..." : "Continue"}</Text>
          {!isSigningIn && <ArrowRight size={14} color={theme.colors.foreground} />}
        </Pressable>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// User profile card (shown when authenticated)
// ---------------------------------------------------------------------------

function UserProfileCard() {
  const { theme } = useUnistyles();
  const { user, signOut, isSigningOut } = useAuthSession();

  if (!user) return null;

  return (
    <View style={settingsStyles.card}>
      <View style={settingsStyles.row}>
        <View style={styles.profileRow}>
          {user.avatarUrl ? (
            <Image source={{ uri: user.avatarUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <User size={20} color={theme.colors.foregroundMuted} />
            </View>
          )}
          <View style={styles.profileInfo}>
            <Text style={styles.profileName} numberOfLines={1}>
              {user.username}
            </Text>
            <Text style={styles.profileEmail} numberOfLines={1}>
              {user.email}
            </Text>
          </View>
        </View>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={<LogOut size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />}
          onPress={() => void signOut()}
          disabled={isSigningOut}
        >
          {isSigningOut ? "Signing out…" : "Sign out"}
        </Button>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Organization list
// ---------------------------------------------------------------------------

function OrganizationList({ onSelectOrg }: { onSelectOrg: (org: DesktopOrganization) => void }) {
  const { theme } = useUnistyles();
  const { organizations, isLoading, error, refetch } = useOrganizations();
  const [showCreate, setShowCreate] = useState(false);

  if (isLoading) {
    return (
      <View style={settingsStyles.card}>
        <View style={styles.centered}>
          <ActivityIndicator size="small" />
          <Text style={styles.hint}>Loading organizations…</Text>
        </View>
      </View>
    );
  }

  if (error) {
    return (
      <View style={settingsStyles.card}>
        <View style={styles.centered}>
          <Text style={styles.hint}>{error}</Text>
          <Button
            variant="outline"
            size="sm"
            leftIcon={<RefreshCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
            onPress={refetch}
          >
            Retry
          </Button>
        </View>
      </View>
    );
  }

  return (
    <>
      <View style={settingsStyles.card}>
        {organizations.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.hint}>No organizations yet.</Text>
          </View>
        ) : (
          organizations.map((org, index) => (
            <View
              key={org.id}
              style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
            >
              <View style={settingsStyles.rowContent}>
                <Text style={settingsStyles.rowTitle}>{org.name}</Text>
                <Text style={settingsStyles.rowHint}>
                  {org.memberCount} {org.memberCount === 1 ? "member" : "members"} · {org.role}
                </Text>
              </View>
              <Button variant="ghost" size="sm" onPress={() => onSelectOrg(org)}>
                Manage
              </Button>
            </View>
          ))
        )}
      </View>
      <View style={styles.createButtonRow}>
        {!showCreate ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={<Plus size={theme.iconSize.sm} color={theme.colors.foreground} />}
            onPress={() => setShowCreate(true)}
          >
            Create organization
          </Button>
        ) : (
          <CreateOrganizationForm onDone={() => setShowCreate(false)} />
        )}
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Create organization form
// ---------------------------------------------------------------------------

function CreateOrganizationForm({ onDone }: { onDone: () => void }) {
  const { theme } = useUnistyles();
  const { createOrganization, isCreating, createError } = useOrganizations();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");

  const handleNameChange = (text: string) => {
    setName(text);
    // Auto-generate slug from name
    setSlug(
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, ""),
    );
  };

  const handleCreate = async () => {
    if (!name.trim() || !slug.trim()) return;
    await createOrganization({ name: name.trim(), slug: slug.trim() });
    onDone();
  };

  return (
    <View style={[settingsStyles.card, styles.formCard]}>
      <Text style={styles.formLabel}>Name</Text>
      <TextInput
        style={[styles.input, { color: theme.colors.foreground }]}
        value={name}
        onChangeText={handleNameChange}
        placeholder="My team"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoFocus
      />
      <Text style={styles.formLabel}>Slug</Text>
      <TextInput
        style={[styles.input, { color: theme.colors.foreground }]}
        value={slug}
        onChangeText={setSlug}
        placeholder="my-team"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
      />
      {createError && <Text style={styles.error}>{createError}</Text>}
      <View style={styles.formActions}>
        <Button variant="ghost" size="sm" onPress={onDone} disabled={isCreating}>
          Cancel
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={() => void handleCreate()}
          disabled={isCreating || !name.trim() || !slug.trim()}
        >
          {isCreating ? "Creating…" : "Create"}
        </Button>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Organization detail (members)
// ---------------------------------------------------------------------------

function OrgMembersView({ org, onBack }: { org: DesktopOrganization; onBack: () => void }) {
  const { theme } = useUnistyles();
  const {
    members,
    invitations,
    isLoading,
    inviteMember,
    isInviting,
    inviteError,
    cancelInvitation,
    isCanceling,
    resendInvitation,
    isResending,
  } = useOrgMembers(org.id);
  const [showInvite, setShowInvite] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("member");

  const canManage = org.role === "owner" || org.role === "admin";

  const roleIcon = (role: string) => {
    switch (role) {
      case "owner":
        return <Crown size={14} color={theme.colors.palette.orange[500]} />;
      case "admin":
        return <Shield size={14} color={theme.colors.accent} />;
      default:
        return <User size={14} color={theme.colors.foregroundMuted} />;
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    await inviteMember({ email: inviteEmail.trim(), role: inviteRole });
    setInviteEmail("");
    setShowInvite(false);
  };

  return (
    <>
      <View style={styles.orgHeader}>
        <Button variant="ghost" size="sm" onPress={onBack}>
          Back
        </Button>
        <Text style={styles.orgTitle}>{org.name}</Text>
      </View>

      <View style={settingsStyles.card}>
        {isLoading ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" />
          </View>
        ) : (
          <>
            {members.map((m, index) => (
              <View
                key={m.id}
                style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null]}
              >
                <View style={styles.memberRow}>
                  {m.user?.image ? (
                    <Image source={{ uri: m.user.image }} style={styles.memberAvatar} />
                  ) : (
                    <View style={[styles.memberAvatar, styles.avatarFallback]}>
                      <User size={14} color={theme.colors.foregroundMuted} />
                    </View>
                  )}
                  <View style={{ flex: 1 }}>
                    <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                      {m.user?.name ?? "Unknown"}
                    </Text>
                    <Text style={settingsStyles.rowHint} numberOfLines={1}>
                      {m.user?.email ?? ""}
                    </Text>
                  </View>
                  <View style={styles.roleTag}>
                    {roleIcon(m.role)}
                    <Text style={styles.roleText}>{m.role}</Text>
                  </View>
                </View>
              </View>
            ))}

            {invitations.length > 0 && (
              <>
                <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
                  <Text style={styles.hint}>Pending invitations</Text>
                </View>
                {invitations.map((inv) => (
                  <View key={inv.id} style={[settingsStyles.row, settingsStyles.rowBorder]}>
                    <View style={styles.memberRow}>
                      <Mail size={16} color={theme.colors.foregroundMuted} />
                      <View style={{ flex: 1 }}>
                        <Text style={settingsStyles.rowTitle} numberOfLines={1}>
                          {inv.email}
                        </Text>
                        <Text style={settingsStyles.rowHint}>
                          Invited as {inv.role} · Expires{" "}
                          {new Date(inv.expiresAt).toLocaleDateString()}
                        </Text>
                      </View>
                      {canManage && (
                        <View style={styles.invitationActions}>
                          <Button
                            variant="ghost"
                            size="sm"
                            leftIcon={
                              <RefreshCw
                                size={theme.iconSize.sm}
                                color={theme.colors.foregroundMuted}
                              />
                            }
                            onPress={() => void resendInvitation(inv.id)}
                            disabled={isResending}
                          >
                            Resend
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onPress={() => void cancelInvitation(inv.id)}
                            disabled={isCanceling}
                            textStyle={{ color: theme.colors.destructive }}
                          >
                            Cancel
                          </Button>
                        </View>
                      )}
                    </View>
                  </View>
                ))}
              </>
            )}
          </>
        )}
      </View>

      <UpgradeLimitHint current={members.length} limit={3} noun="members" />

      {canManage && (
        <View style={styles.createButtonRow}>
          {!showInvite ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={<Plus size={theme.iconSize.sm} color={theme.colors.foreground} />}
              onPress={() => setShowInvite(true)}
            >
              Invite member
            </Button>
          ) : (
            <View style={[settingsStyles.card, styles.formCard]}>
              <Text style={styles.formLabel}>Email</Text>
              <TextInput
                style={[styles.input, { color: theme.colors.foreground }]}
                value={inviteEmail}
                onChangeText={setInviteEmail}
                placeholder="user@example.com"
                placeholderTextColor={theme.colors.foregroundMuted}
                keyboardType="email-address"
                autoCapitalize="none"
                autoFocus
              />
              {inviteError && <Text style={styles.error}>{inviteError}</Text>}
              <View style={styles.formActions}>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={() => setShowInvite(false)}
                  disabled={isInviting}
                >
                  Cancel
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onPress={() => void handleInvite()}
                  disabled={isInviting || !inviteEmail.trim()}
                >
                  {isInviting ? "Sending…" : "Send invite"}
                </Button>
              </View>
            </View>
          )}
        </View>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main account section (composed)
// ---------------------------------------------------------------------------

export function AccountSection() {
  const { isAuthenticated } = useAuthSession();
  const [selectedOrg, setSelectedOrg] = useState<DesktopOrganization | null>(null);

  return (
    <View style={settingsStyles.section}>
      <Text style={settingsStyles.sectionTitle}>Account</Text>
      {!isAuthenticated ? (
        <SignInContent />
      ) : (
        <>
          <UserProfileCard />
          <View style={styles.orgSpacer} />
          <UpgradeBanner />
          <View style={styles.orgSpacer} />
          <Text style={settingsStyles.sectionTitle}>Organizations</Text>
          {selectedOrg ? (
            <OrgMembersView org={selectedOrg} onBack={() => setSelectedOrg(null)} />
          ) : (
            <OrganizationList onSelectOrg={setSelectedOrg} />
          )}
        </>
      )}
    </View>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
  },
  // -- Sign in --
  signInButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
  },
  signInButtonHovered: {
    borderColor: theme.colors.foregroundMuted,
    backgroundColor: theme.colors.surface2,
  },
  signInButtonDisabled: {
    opacity: 0.5,
  },
  signInButtonText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.xs,
    marginTop: theme.spacing[1],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  // -- Profile --
  profileRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flex: 1,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
  },
  avatarFallback: {
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: {
    flex: 1,
  },
  profileName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  profileEmail: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    marginTop: 1,
  },
  // -- Orgs --
  createButtonRow: {
    marginTop: theme.spacing[3],
  },
  formCard: {
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    borderRadius: theme.borderRadius.base,
  },
  formLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.base,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.sm,
    outlineStyle: "none",
  } as any,
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
  invitationActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  orgSpacer: {
    height: theme.spacing[4],
  },
  orgHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  orgTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  memberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    flex: 1,
  },
  memberAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
  },
  roleTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  roleText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
