import {
  pgTable,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  foreignKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ─── Better Auth Core Tables ────────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"), // 'user' | 'admin'
  banned: boolean("banned").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Organization Plugin Tables ─────────────────────────────────────────────

export const organization = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const member = pgTable("member", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"), // 'owner' | 'admin' | 'member'
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const invitation = pgTable("invitation", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("member"),
  status: text("status").notNull().default("pending"), // pending | accepted | declined | canceled
  inviterId: text("inviter_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Plan & Feature Flags ───────────────────────────────────────────────────

export const plan = pgTable("plan", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  stripeMonthlyPriceId: text("stripe_monthly_price_id"),
  stripeYearlyPriceId: text("stripe_yearly_price_id"),
  monthlyPriceCents: integer("monthly_price_cents").notNull().default(0),
  yearlyPriceCents: integer("yearly_price_cents").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const planFeature = pgTable(
  "plan_feature",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    featureKey: text("feature_key").notNull(),
    value: text("value").notNull(),
    description: text("description"),
  },
  (table) => [uniqueIndex("plan_feature_unique").on(table.planId, table.featureKey)],
);

// ─── Subscription & Billing ─────────────────────────────────────────────────

export const subscription = pgTable("subscription", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: "cascade" }),
  planId: text("plan_id")
    .notNull()
    .references(() => plan.id),
  billingInterval: text("billing_interval").notNull().default("monthly"), // monthly | yearly
  stripeSubscriptionId: text("stripe_subscription_id").unique(),
  stripeCustomerId: text("stripe_customer_id"),
  status: text("status").notNull().default("active"), // active | canceled | past_due | trialing
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Desktop PKCE Flow ──────────────────────────────────────────────────────

export const pkceChallenge = pgTable("pkce_challenge", {
  id: text("id").primaryKey(),
  state: text("state").notNull().unique(),
  codeChallenge: text("code_challenge").notNull(),
  codeChallengeMethod: text("code_challenge_method").notNull().default("S256"),
  redirectUri: text("redirect_uri").notNull(),
  providerId: text("provider_id").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
});

export const authorizationCode = pgTable("authorization_code", {
  id: text("id").primaryKey(),
  code: text("code").notNull().unique(),
  state: text("state").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  providerId: text("provider_id").notNull(),
  codeChallenge: text("code_challenge"),
  codeChallengeMethod: text("code_challenge_method"),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  used: boolean("used").notNull().default(false),
});

// ─── Activity Log ───────────────────────────────────────────────────────────

export const activityLog = pgTable("activity_log", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  details: jsonb("details"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Session Sharing ────────────────────────────────────────────────────────

export const sessionShare = pgTable("session_share", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  daemonSessionId: text("daemon_session_id").notNull(),
  serverId: text("server_id").notNull(),
  orgId: text("org_id"),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessLevel: text("access_level").notNull().default("read_only"),
  pairingUrl: text("pairing_url"),
  allowedUserIds: jsonb("allowed_user_ids").notNull().default([]),
  maxParticipants: integer("max_participants").notNull().default(5),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const sessionParticipant = pgTable("session_participant", {
  id: text("id").primaryKey(),
  shareId: text("share_id")
    .notNull()
    .references(() => sessionShare.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  joinedAt: timestamp("joined_at").notNull().defaultNow(),
  leftAt: timestamp("left_at"),
});

// ─── Workspace Sharing ──────────────────────────────────────────────────────

export const workspaceShare = pgTable("workspace_share", {
  id: text("id").primaryKey(),
  token: text("token").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  serverId: text("server_id").notNull(),
  projectId: text("project_id").notNull(),
  projectName: text("project_name").notNull(),
  workspaceName: text("workspace_name").notNull(),
  orgId: text("org_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  ownerId: text("owner_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessLevel: text("access_level").notNull().default("read_only"),
  pairingUrl: text("pairing_url"),
  allowedUserIds: jsonb("allowed_user_ids").notNull().default([]),
  expiresAt: timestamp("expires_at"),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Lightweight Online Project Registry ────────────────────────────────────
//
// Stores a *registry* entry per org+project — enough metadata for any user in
// the org to see which projects exist and to clone them locally if the owner
// has configured a git remote. Paths and filesystem state stay on the daemon;
// only shareable identity + remote URL live online.
export const projectRegistry = pgTable(
  "project_registry",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    // Daemon-assigned stable identifier (e.g. `remote:github.com/owner/repo`
    // for git projects, or a local-path hash for non-git). Used to dedupe
    // across multiple daemons registering the same project.
    projectKey: text("project_key").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    iconEmoji: text("icon_emoji"),
    iconColor: text("icon_color"),
    gitRemoteUrl: text("git_remote_url"),
    defaultBranch: text("default_branch"),
    lastSeenAt: timestamp("last_seen_at").notNull().defaultNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    orgProjectKeyIdx: uniqueIndex("project_registry_org_key_unique").on(
      table.orgId,
      table.projectKey,
    ),
  }),
);

// ─── Chat ───────────────────────────────────────────────────────────────────

export const channel = pgTable(
  "channel",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name"), // null allowed for DMs
    topic: text("topic"),
    kind: text("kind").notNull(), // 'public' | 'private' | 'dm'
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    // Unique channel name per org, but only when name is set (skips DMs).
    uniqueIndex("channel_org_name_unique").on(t.orgId, t.name).where(sql`name is not null`),
    index("channel_org_idx").on(t.orgId),
  ],
);

export const channelMember = pgTable(
  "channel_member",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"), // 'admin' | 'member'
    joinedAt: timestamp("joined_at").notNull().defaultNow(),
    lastReadAt: timestamp("last_read_at"),
    muted: boolean("muted").notNull().default(false),
    notifyPref: text("notify_pref").notNull().default("all"), // 'all' | 'mentions' | 'nothing'
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.userId] }),
    index("channel_member_user_idx").on(t.userId),
  ],
);

export const message = pgTable(
  "message",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    parentId: text("parent_id"),
    quotedMessageId: text("quoted_message_id"),
    content: text("content").notNull().default(""), // markdown source
    createdAt: timestamp("created_at").notNull().defaultNow(),
    editedAt: timestamp("edited_at"),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    index("message_channel_created_idx").on(t.channelId, t.createdAt, t.id),
    index("message_parent_idx").on(t.parentId),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: "message_parent_fkey",
    }).onDelete("set null"),
  ],
);

export const attachment = pgTable(
  "attachment",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    mimeType: text("mime_type").notNull(),
    filename: text("filename").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("attachment_message_idx").on(t.messageId)],
);

export const reaction = pgTable(
  "reaction",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.messageId, t.userId, t.emoji] }),
    index("reaction_message_idx").on(t.messageId),
  ],
);

export const mention = pgTable(
  "mention",
  {
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.userId] }), index("mention_user_idx").on(t.userId)],
);

export const pin = pgTable(
  "pin",
  {
    channelId: text("channel_id")
      .notNull()
      .references(() => channel.id, { onDelete: "cascade" }),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id, { onDelete: "cascade" }),
    pinnedBy: text("pinned_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    pinnedAt: timestamp("pinned_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channelId, t.messageId] }),
    index("pin_channel_idx").on(t.channelId),
  ],
);

// ─── Library (MCP servers + Skills marketplace) ──────────────────────────────
// Persists user-authored MCP server configs and skill modules. Each entry has
// two independent axes:
//   - scope: where the entry applies ("user" | "org" | "project")
//   - visibility: who can discover it ("private" | "shared")
// Shared entries in org/project scope show up as recommendations to other
// members, who opt in individually via `libraryActivation` (per-user row with
// per-agent sync targets). Global entries have visibility pinned to private.

export const libraryEntry = pgTable(
  "library_entry",
  {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // 'mcp' | 'skill'
    name: text("name").notNull(), // slug-like id, unique within (scope, scopeId, kind)
    displayName: text("display_name").notNull(),
    description: text("description"),
    // Catalog payload: for MCP `{ transport, command?, args?, env?, url?, headers? }`,
    // for skill `{ instructionsPath?, instructionsInline?, examplePrompt? }`.
    // Kept as jsonb to stay forward-compatible with new transports/fields.
    payload: jsonb("payload").notNull(),
    // Icon either a remote URL (we proxy/cache in catalog_icon_cache) or a
    // one-letter fallback glyph the client renders when no icon is available.
    iconUrl: text("icon_url"),
    // Source: "custom" when user-authored, "catalog" when pulled from the
    // PulseMCP / skills catalog. Stored so the UI can show "Installed from X".
    source: text("source").notNull().default("custom"), // 'custom' | 'catalog'
    catalogId: text("catalog_id"), // upstream id when source='catalog'
    scope: text("scope").notNull(), // 'user' | 'org' | 'project'
    // For scope='user': null (creator is implicit). For 'org': organization.id.
    // For 'project': project_registry.id.
    scopeId: text("scope_id"),
    visibility: text("visibility").notNull().default("private"), // 'private' | 'shared'
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    deletedAt: timestamp("deleted_at"),
  },
  (t) => [
    // Lookup by (scope, scopeId) is the hot path for listing entries visible
    // to a user — org members scan their orgs, project members scan their
    // projects, and everyone scans their own user scope.
    index("library_entry_scope_idx").on(t.scope, t.scopeId, t.kind),
    index("library_entry_created_by_idx").on(t.createdBy),
    // Prevent duplicate names within the same scope/kind. Two members in the
    // same org cannot both name an entry "linear" under that org.
    uniqueIndex("library_entry_scope_name_unique").on(
      t.scope,
      t.scopeId,
      t.kind,
      t.name,
    ),
  ],
);

export const libraryActivation = pgTable(
  "library_activation",
  {
    entryId: text("entry_id")
      .notNull()
      .references(() => libraryEntry.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(true),
    // Which external agent CLIs this user wants synced. Subset of
    // ['claude-code', 'codex', 'opencode']. Server enforces valid transport
    // per target on write.
    syncTargets: jsonb("sync_targets").notNull().default(sql`'[]'::jsonb`),
    activatedAt: timestamp("activated_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.entryId, t.userId] }),
    index("library_activation_user_idx").on(t.userId),
  ],
);

// Catalog cache keyed by (source, query). `query` lets us cache paginated
// searches separately from the unfiltered recommended set. A background
// refresh job re-fetches expired rows; clients never hit upstream directly.
export const catalogCache = pgTable(
  "catalog_cache",
  {
    source: text("source").notNull(), // 'pulsemcp' | 'anthropic-skills' | 'openai-skills' | 'skills-sh'
    queryKey: text("query_key").notNull().default(""), // '' for "recommended"
    data: jsonb("data").notNull(),
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.source, t.queryKey] })],
);

// Remote icons cached as bytes so we never 404 if upstream moves them and so
// clients don't hit a third-party host on every render. Keyed by SHA-256 of
// the original URL.
export const catalogIconCache = pgTable(
  "catalog_icon_cache",
  {
    hash: text("hash").primaryKey(), // sha256 of source url
    sourceUrl: text("source_url").notNull(),
    mimeType: text("mime_type").notNull(),
    bytes: text("bytes").notNull(), // base64-encoded payload
    fetchedAt: timestamp("fetched_at").notNull().defaultNow(),
  },
);
