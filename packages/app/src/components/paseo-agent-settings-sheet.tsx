import React, { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, Plus } from "lucide-react-native";
import type {
  PaseoAgentCatalogEntry,
  RedactedPaseoAgentProviderConfig,
} from "@getpaseo/protocol/messages";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { getProviderIcon } from "@/components/provider-icons";
import { resolveProviderIconName } from "@/components/provider-icon-name";
import { ExternalLink } from "@/components/ui/external-link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { usePaseoAgentProviders } from "@/hooks/use-paseo-agent-providers";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type {
  PaseoAgentOAuthCompleteResult,
  PaseoAgentOAuthStartResult,
  PaseoAgentRenameProviderInput,
  PaseoAgentSetProviderInput,
} from "@/hooks/use-paseo-agent-providers";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";
import {
  type PaseoAgentApiKeyAuthManifest,
  type PaseoAgentOAuthMode,
  createPaseoAgentProviderInput,
  getPaseoAgentApiKeyAuth,
  getPaseoAgentOAuthAuth,
  isPaseoAgentCatalogEntrySupported,
  nextPaseoAgentProviderName,
  paseoAgentAuthBadge,
  paseoAgentProviderLabel,
  preferredPaseoAgentOAuthMode,
} from "./paseo-agent-settings-sheet-model";

interface PaseoAgentSettingsSheetProps {
  serverId: string;
  visible: boolean;
  onClose: () => void;
}

interface DynamicProviderIconProps {
  iconKey: string;
  size: number;
  color?: string;
}

type AddSheetState =
  | { kind: "closed" }
  | { kind: "picker" }
  | {
      kind: "form";
      entry: PaseoAgentCatalogEntry;
      name: string;
      returnToPicker: boolean;
    }
  | {
      kind: "rename";
      provider: RedactedPaseoAgentProviderConfig;
    };

type OAuthState =
  | { status: "idle" }
  | {
      status: "authorizing";
      mode: PaseoAgentOAuthMode;
      authorization: PaseoAgentOAuthStartResult["authorization"];
    }
  | {
      status: "completing";
      mode: PaseoAgentOAuthMode;
      authorization: PaseoAgentOAuthStartResult["authorization"];
    }
  | {
      status: "error";
      mode: PaseoAgentOAuthMode;
      message: string;
      authorization: PaseoAgentOAuthStartResult["authorization"];
    };

interface ApiKeyFieldsProps {
  auth: PaseoAgentApiKeyAuthManifest;
  apiKey: string;
  resetKey: number;
  onApiKeyChange: (value: string) => void;
}

interface ProviderFormActionsProps {
  saving: boolean;
  canSubmit: boolean;
  canComplete: boolean;
  hasApiKeyAuth: boolean;
  hasOAuthAuth: boolean;
  preferredOAuthMode: PaseoAgentOAuthMode;
  oauthStatus: OAuthState["status"];
  onClose: () => void;
  onSubmitApiKey: () => void;
  onStartOAuth: (mode: PaseoAgentOAuthMode) => void;
  onCompleteOAuth: () => void;
}

const MAIN_SNAP_POINTS = ["65%", "92%"];
const PICKER_SNAP_POINTS = ["70%", "92%"];
const FORM_SNAP_POINTS = ["78%", "92%"];
const HEADER: SheetHeader = { title: "Paseo Agent" };
const PICKER_HEADER: SheetHeader = { title: "Add model provider" };
const CATALOG_UPDATE_MESSAGE = "Update the Paseo daemon to use this.";
const APP_UPDATE_PROVIDER_MESSAGE = "Update the app to use this provider";

function StateBox({ children, testID }: { children: React.ReactNode; testID?: string }) {
  return (
    <View style={styles.stateBox} testID={testID}>
      <Text style={styles.stateText}>{children}</Text>
    </View>
  );
}

function DynamicProviderIcon({ iconKey, size, color = "" }: DynamicProviderIconProps) {
  const Icon = getProviderIcon(iconKey);
  return <Icon size={size} color={color} />;
}

const ThemedDynamicProviderIcon = withUnistyles(DynamicProviderIcon);
const ThemedBot = withUnistyles(Bot);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function describeError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function modelCountLabel(count: number): string {
  return count === 1 ? "1 model" : `${count} models`;
}

function catalogAuthSummary(entry: PaseoAgentCatalogEntry): string | null {
  if (getPaseoAgentOAuthAuth(entry)) {
    return "Sign in";
  }
  if (getPaseoAgentApiKeyAuth(entry)) {
    return "API key";
  }
  return null;
}

function hasKnownProviderIcon(iconName: string | undefined): iconName is string {
  return Boolean(iconName && resolveProviderIconName(iconName).kind !== "bot");
}

function getAuthorizationUrl(
  authorization: PaseoAgentOAuthStartResult["authorization"],
): string | null {
  if (!authorization) {
    return null;
  }
  if (typeof authorization.url === "string") {
    return authorization.url;
  }
  if (typeof authorization.verificationUri === "string") {
    return authorization.verificationUri;
  }
  return null;
}

function getAuthorizationInstructions(
  authorization: PaseoAgentOAuthStartResult["authorization"],
): string | null {
  return authorization && typeof authorization.instructions === "string"
    ? authorization.instructions
    : null;
}

function canCompleteAuthorization(
  authorization: PaseoAgentOAuthStartResult["authorization"],
): boolean {
  if (!authorization) {
    return true;
  }
  if (authorization.kind === "device_code" || authorization.kind === "auth_url") {
    return true;
  }
  const hasUrl = getAuthorizationUrl(authorization) !== null;
  const hasInstructions = getAuthorizationInstructions(authorization) !== null;
  return hasUrl || hasInstructions;
}

function CatalogEntryIcon({ entry }: { entry: PaseoAgentCatalogEntry }) {
  if (hasKnownProviderIcon(entry.iconName)) {
    return (
      <ThemedDynamicProviderIcon iconKey={entry.iconName} size={18} uniProps={mutedColorMapping} />
    );
  }
  return <ThemedBot size={18} uniProps={mutedColorMapping} />;
}

function ProviderRow({
  provider,
  catalogEntry,
  isFirst,
  onReauth,
  onRename,
}: {
  provider: RedactedPaseoAgentProviderConfig;
  catalogEntry: PaseoAgentCatalogEntry | undefined;
  isFirst: boolean;
  onReauth: (provider: RedactedPaseoAgentProviderConfig, entry: PaseoAgentCatalogEntry) => void;
  onRename: (provider: RedactedPaseoAgentProviderConfig) => void;
}) {
  const modelLabel = modelCountLabel(provider.models.length);
  const authBadge = paseoAgentAuthBadge(provider.auth);
  const providerLabel = paseoAgentProviderLabel(provider, catalogEntry);
  const providerName = provider.displayName ?? provider.name;
  const canReauth = Boolean(catalogEntry && isPaseoAgentCatalogEntrySupported(catalogEntry));
  const accessibilityLabel = authBadge
    ? `${providerName}, ${providerLabel}, ${modelLabel}, ${authBadge.label}`
    : `${providerName}, ${providerLabel}, ${modelLabel}`;
  const rowStyle = useMemo(() => [styles.providerRow, !isFirst && styles.rowBorder], [isFirst]);

  const handleReauth = useCallback(() => {
    if (catalogEntry) {
      onReauth(provider, catalogEntry);
    }
  }, [catalogEntry, onReauth, provider]);
  const handleRename = useCallback(() => {
    onRename(provider);
  }, [onRename, provider]);

  return (
    <View
      style={rowStyle}
      accessible
      role="listitem"
      accessibilityLabel={accessibilityLabel}
      testID={`paseo-agent-provider-row-${provider.name}`}
    >
      <View style={provider.available ? styles.dotAvailable : styles.dotMuted} />
      <View style={styles.providerText}>
        <Text style={styles.providerName} numberOfLines={1}>
          {providerName}
        </Text>
        <Text style={styles.providerMeta} numberOfLines={1}>
          {providerLabel} · {modelLabel}
        </Text>
      </View>
      {authBadge ? <StatusBadge label={authBadge.label} variant={authBadge.variant} /> : null}
      <Button
        variant="outline"
        size="xs"
        onPress={handleRename}
        testID={`paseo-agent-provider-rename-${provider.name}`}
      >
        Rename
      </Button>
      {canReauth ? (
        <Button
          variant="outline"
          size="xs"
          onPress={handleReauth}
          testID={`paseo-agent-provider-reauth-${provider.name}`}
        >
          Re-auth
        </Button>
      ) : null}
    </View>
  );
}

function CatalogEntryRow({
  entry,
  isFirst,
  onSelect,
}: {
  entry: PaseoAgentCatalogEntry;
  isFirst: boolean;
  onSelect: (entry: PaseoAgentCatalogEntry) => void;
}) {
  const supported = isPaseoAgentCatalogEntrySupported(entry);
  const authSummary = catalogAuthSummary(entry);
  const rowStyle = useMemo(
    () => [styles.catalogRow, !isFirst && styles.rowBorder, !supported && styles.disabledRow],
    [isFirst, supported],
  );
  const handleSelect = useCallback(() => onSelect(entry), [entry, onSelect]);

  return (
    <View
      style={rowStyle}
      accessible
      role="listitem"
      accessibilityLabel={entry.label}
      testID={`paseo-agent-catalog-entry-${entry.id}`}
    >
      <View style={styles.catalogIcon} testID={`paseo-agent-catalog-icon-${entry.id}`}>
        <CatalogEntryIcon entry={entry} />
      </View>
      <View style={styles.catalogText}>
        <Text style={styles.providerName} numberOfLines={1}>
          {entry.label}
        </Text>
        {authSummary ? (
          <Text style={styles.providerMeta} numberOfLines={1}>
            {authSummary}
          </Text>
        ) : null}
        {entry.docsUrl ? (
          <ExternalLink
            href={entry.docsUrl}
            label="Docs"
            testID={`paseo-agent-catalog-docs-${entry.id}`}
            accessibilityLabel={`${entry.label} docs`}
          />
        ) : null}
        {!supported ? <Text style={styles.formHint}>{APP_UPDATE_PROVIDER_MESSAGE}</Text> : null}
      </View>
      <Button
        variant="outline"
        size="sm"
        onPress={handleSelect}
        disabled={!supported}
        testID={`paseo-agent-catalog-select-${entry.id}`}
      >
        Select
      </Button>
    </View>
  );
}

function CatalogPickerSubSheet({
  visible,
  catalog,
  isLoading,
  error,
  onClose,
  onSelect,
}: {
  visible: boolean;
  catalog: PaseoAgentCatalogEntry[];
  isLoading: boolean;
  error: string | null;
  onClose: () => void;
  onSelect: (entry: PaseoAgentCatalogEntry) => void;
}) {
  let body: React.ReactNode;
  if (error) {
    body = <StateBox>{error}</StateBox>;
  } else if (isLoading) {
    body = <StateBox>Loading...</StateBox>;
  } else if (catalog.length === 0) {
    body = <StateBox>No providers available.</StateBox>;
  } else {
    body = (
      <View style={styles.list} accessibilityRole="list">
        {catalog.map((entry, index) => (
          <CatalogEntryRow key={entry.id} entry={entry} isFirst={index === 0} onSelect={onSelect} />
        ))}
      </View>
    );
  }

  return (
    <AdaptiveModalSheet
      header={PICKER_HEADER}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={560}
      snapPoints={PICKER_SNAP_POINTS}
      testID="paseo-agent-provider-picker"
    >
      {body}
    </AdaptiveModalSheet>
  );
}

function AuthorizationUrl({ url, label, testID }: { url: string; label: string; testID: string }) {
  return (
    <View style={styles.linkStack}>
      <Text style={styles.formHint} numberOfLines={1}>
        {url}
      </Text>
      <ExternalLink href={url} label={label} testID={testID} />
    </View>
  );
}

function OAuthAuthorizationPanel({
  authorization,
}: {
  authorization: PaseoAgentOAuthStartResult["authorization"];
}) {
  if (!authorization) {
    return (
      <View style={styles.authorizationBox}>
        <Text style={styles.formHint}>Finish sign in, then complete the flow.</Text>
      </View>
    );
  }

  const instructions = getAuthorizationInstructions(authorization);
  const url = getAuthorizationUrl(authorization);

  if (authorization.kind === "device_code") {
    return (
      <View style={styles.authorizationBox}>
        {typeof authorization.userCode === "string" ? (
          <>
            <Text style={styles.formLabel}>Device code</Text>
            <Text style={styles.userCode} testID="paseo-agent-oauth-user-code">
              {authorization.userCode}
            </Text>
          </>
        ) : null}
        {typeof authorization.verificationUri === "string" ? (
          <AuthorizationUrl
            url={authorization.verificationUri}
            label="Open verification page"
            testID="paseo-agent-oauth-verification-link"
          />
        ) : null}
        {instructions ? <Text style={styles.formHint}>{instructions}</Text> : null}
        {typeof authorization.expiresInSeconds === "number" ? (
          <Text style={styles.formHint}>
            Expires in about {Math.max(1, Math.round(authorization.expiresInSeconds / 60))} minutes.
          </Text>
        ) : null}
      </View>
    );
  }

  if (authorization.kind === "auth_url") {
    return (
      <View style={styles.authorizationBox}>
        {url ? (
          <AuthorizationUrl url={url} label="Open sign-in page" testID="paseo-agent-oauth-url" />
        ) : null}
        {instructions ? <Text style={styles.formHint}>{instructions}</Text> : null}
      </View>
    );
  }

  return (
    <View style={styles.authorizationBox}>
      {url ? (
        <AuthorizationUrl url={url} label="Open sign-in page" testID="paseo-agent-oauth-url" />
      ) : null}
      {instructions ? <Text style={styles.formHint}>{instructions}</Text> : null}
      {!url && !instructions ? <Text style={styles.formHint}>Update the app</Text> : null}
    </View>
  );
}

function ApiKeyFields({ auth, apiKey, resetKey, onApiKeyChange }: ApiKeyFieldsProps) {
  const envHint = `Leave blank to use $${auth.envVar} on the host.`;
  const apiKeyHint = auth.hint ?? "Stored on the host and never shown again.";

  return (
    <>
      <View style={styles.labelRow}>
        <Text style={styles.formLabel}>API key</Text>
        {auth.keyUrl ? (
          <ExternalLink href={auth.keyUrl} label="Get your key" testID="paseo-agent-key-url" />
        ) : null}
      </View>
      <AdaptiveTextInput
        testID="paseo-agent-api-key"
        accessibilityLabel="API key"
        initialValue={apiKey}
        resetKey={`paseo-agent-api-key-${resetKey}`}
        value={apiKey}
        onChangeText={onApiKeyChange}
        placeholder={auth.placeholder ?? `$${auth.envVar}`}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.formInput}
      />
      <Text style={styles.formHint}>
        {apiKeyHint} {envHint}
      </Text>
    </>
  );
}

function ProviderFormActions({
  saving,
  canSubmit,
  canComplete,
  hasApiKeyAuth,
  hasOAuthAuth,
  preferredOAuthMode,
  oauthStatus,
  onClose,
  onSubmitApiKey,
  onStartOAuth,
  onCompleteOAuth,
}: ProviderFormActionsProps) {
  const isOAuthIdle = oauthStatus === "idle";
  const isOAuthError = oauthStatus === "error";
  const isOAuthCompleting = oauthStatus === "completing";
  const showOAuthComplete = hasOAuthAuth && !isOAuthIdle && !isOAuthError;
  const handleStartBrowserOAuth = useCallback(() => {
    onStartOAuth("browser");
  }, [onStartOAuth]);
  const handleStartDeviceCodeOAuth = useCallback(() => {
    onStartOAuth("device_code");
  }, [onStartOAuth]);
  const handleRetryOAuth = useCallback(() => {
    onStartOAuth(preferredOAuthMode);
  }, [onStartOAuth, preferredOAuthMode]);
  const browserButton = (
    <Button
      variant={preferredOAuthMode === "browser" ? "default" : "outline"}
      size="sm"
      onPress={handleStartBrowserOAuth}
      disabled={!canSubmit}
      loading={saving}
      testID="paseo-agent-oauth-start-browser"
    >
      {saving ? "Starting..." : "Sign in with browser"}
    </Button>
  );
  const deviceCodeButton = (
    <Button
      variant={preferredOAuthMode === "device_code" ? "default" : "outline"}
      size="sm"
      onPress={handleStartDeviceCodeOAuth}
      disabled={!canSubmit}
      loading={saving}
      testID="paseo-agent-oauth-start-device-code"
    >
      {saving ? "Starting..." : "Use a code instead"}
    </Button>
  );
  let oauthStartActions: React.ReactNode = null;
  if (hasOAuthAuth && isOAuthIdle) {
    oauthStartActions =
      preferredOAuthMode === "device_code" ? (
        <>
          {deviceCodeButton}
          {browserButton}
        </>
      ) : (
        <>
          {browserButton}
          {deviceCodeButton}
        </>
      );
  }

  return (
    <View style={styles.formActions}>
      <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
        Cancel
      </Button>
      {hasApiKeyAuth ? (
        <Button
          variant="default"
          size="sm"
          onPress={onSubmitApiKey}
          disabled={!canSubmit}
          loading={saving}
          testID="paseo-agent-provider-submit"
        >
          {saving ? "Saving..." : "Save provider"}
        </Button>
      ) : null}
      {oauthStartActions}
      {hasOAuthAuth && isOAuthError ? (
        <Button
          variant="outline"
          size="sm"
          onPress={handleRetryOAuth}
          disabled={!canSubmit}
          loading={saving}
          testID="paseo-agent-oauth-retry"
        >
          Retry sign in
        </Button>
      ) : null}
      {showOAuthComplete ? (
        <Button
          variant="default"
          size="sm"
          onPress={onCompleteOAuth}
          disabled={!canSubmit || !canComplete}
          loading={isOAuthCompleting}
          testID="paseo-agent-oauth-complete"
        >
          {isOAuthCompleting ? "Completing..." : "Complete sign in"}
        </Button>
      ) : null}
    </View>
  );
}

function PaseoAgentProviderFormSheet({
  entry,
  visible,
  name,
  onBack,
  onClose,
  setProvider,
  startOAuth,
  completeOAuth,
  preferredOAuthMode,
}: {
  entry: PaseoAgentCatalogEntry | null;
  visible: boolean;
  name: string | undefined;
  onBack: () => void;
  onClose: () => void;
  setProvider: (
    input: PaseoAgentSetProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
  startOAuth: (name: string, mode?: string) => Promise<PaseoAgentOAuthStartResult>;
  completeOAuth: (name: string) => Promise<PaseoAgentOAuthCompleteResult>;
  preferredOAuthMode: PaseoAgentOAuthMode;
}) {
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [oauthState, setOAuthState] = useState<OAuthState>({ status: "idle" });
  const [resetKey, bumpResetKey] = useReducer((key: number) => key + 1, 0);

  useEffect(() => {
    if (visible && entry) {
      setApiKey("");
      setError(null);
      setSaving(false);
      setOAuthState({ status: "idle" });
      bumpResetKey();
    }
  }, [entry, name, visible]);

  const header = useMemo<SheetHeader>(
    () => ({
      title: entry ? entry.label : "Provider",
      back: { label: "Providers", onPress: onBack },
    }),
    [entry, onBack],
  );
  const apiKeyAuth = entry ? getPaseoAgentApiKeyAuth(entry) : null;
  const oauthAuth = entry ? getPaseoAgentOAuthAuth(entry) : null;
  const trimmedName = name?.trim() ?? "";
  const canSubmit = Boolean(entry && trimmedName.length > 0 && !saving);
  const activeAuthorization =
    oauthState.status === "authorizing" ||
    oauthState.status === "completing" ||
    oauthState.status === "error"
      ? oauthState.authorization
      : null;
  const canComplete =
    oauthState.status === "authorizing" && canCompleteAuthorization(oauthState.authorization);

  const handleSubmitApiKey = useCallback(() => {
    if (!entry || !canSubmit) return;
    setError(null);
    setSaving(true);
    void setProvider(
      createPaseoAgentProviderInput({
        entry,
        name: trimmedName,
        apiKey,
      }),
    )
      .then(() => {
        setApiKey("");
        onClose();
        return undefined;
      })
      .catch((err: unknown) => {
        setError(describeError(err, "Failed to save provider"));
      })
      .finally(() => setSaving(false));
  }, [apiKey, canSubmit, entry, onClose, setProvider, trimmedName]);

  const handleStartOAuth = useCallback(
    (mode: PaseoAgentOAuthMode) => {
      if (!entry || !canSubmit) return;
      setError(null);
      setSaving(true);
      setOAuthState({ status: "idle" });
      let authorization: PaseoAgentOAuthStartResult["authorization"] = null;
      void setProvider(
        createPaseoAgentProviderInput({
          entry,
          name: trimmedName,
        }),
      )
        .then(() => startOAuth(trimmedName, mode))
        .then(async (result) => {
          authorization = result.authorization;
          setOAuthState({ status: "authorizing", mode, authorization });
          if (mode === "browser" && authorization?.kind === "auth_url") {
            const url = getAuthorizationUrl(authorization);
            if (url) {
              await openExternalUrl(url);
            }
          }
          return undefined;
        })
        .catch((err: unknown) => {
          setOAuthState({
            status: "error",
            mode,
            message: describeError(err, "Failed to start sign in"),
            authorization,
          });
        })
        .finally(() => setSaving(false));
    },
    [canSubmit, entry, setProvider, startOAuth, trimmedName],
  );

  const handleCompleteOAuth = useCallback(() => {
    if (!canSubmit || !canComplete) return;
    setError(null);
    setSaving(true);
    const mode = oauthState.status === "authorizing" ? oauthState.mode : preferredOAuthMode;
    setOAuthState({ status: "completing", mode, authorization: activeAuthorization });
    void completeOAuth(trimmedName)
      .then(() => {
        onClose();
        return undefined;
      })
      .catch((err: unknown) => {
        setOAuthState({
          status: "error",
          mode,
          message: describeError(err, "Failed to complete sign in"),
          authorization: activeAuthorization,
        });
      })
      .finally(() => setSaving(false));
  }, [
    activeAuthorization,
    canComplete,
    canSubmit,
    completeOAuth,
    oauthState,
    onClose,
    preferredOAuthMode,
    trimmedName,
  ]);

  if (!entry) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={480}
      snapPoints={FORM_SNAP_POINTS}
      testID={oauthAuth ? "paseo-agent-oauth-sign-in" : "paseo-agent-provider-form"}
    >
      <View style={styles.formGroup}>
        {apiKeyAuth ? (
          <ApiKeyFields
            auth={apiKeyAuth}
            apiKey={apiKey}
            resetKey={resetKey}
            onApiKeyChange={setApiKey}
          />
        ) : null}

        {oauthAuth ? (
          <>
            {activeAuthorization ? (
              <OAuthAuthorizationPanel authorization={activeAuthorization} />
            ) : (
              <Text style={styles.formHint}>Sign in to connect this provider.</Text>
            )}
            {oauthState.status === "error" ? (
              <Text style={styles.errorText} testID="paseo-agent-oauth-error">
                {oauthState.message}
              </Text>
            ) : null}
          </>
        ) : null}

        {!apiKeyAuth && !oauthAuth ? (
          <Text style={styles.formHint}>{APP_UPDATE_PROVIDER_MESSAGE}</Text>
        ) : null}

        {error ? (
          <Text style={styles.errorText} testID="paseo-agent-provider-error">
            {error}
          </Text>
        ) : null}

        <ProviderFormActions
          saving={saving}
          canSubmit={canSubmit}
          canComplete={canComplete}
          hasApiKeyAuth={Boolean(apiKeyAuth)}
          hasOAuthAuth={Boolean(oauthAuth)}
          preferredOAuthMode={preferredOAuthMode}
          oauthStatus={oauthState.status}
          onClose={onClose}
          onSubmitApiKey={handleSubmitApiKey}
          onStartOAuth={handleStartOAuth}
          onCompleteOAuth={handleCompleteOAuth}
        />
      </View>
    </AdaptiveModalSheet>
  );
}

function PaseoAgentProviderRenameSheet({
  provider,
  visible,
  onClose,
  renameProvider,
}: {
  provider: RedactedPaseoAgentProviderConfig | null;
  visible: boolean;
  onClose: () => void;
  renameProvider: (
    input: PaseoAgentRenameProviderInput,
  ) => Promise<RedactedPaseoAgentProviderConfig | null>;
}) {
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetKey, bumpResetKey] = useReducer((key: number) => key + 1, 0);

  useEffect(() => {
    if (visible && provider) {
      setDisplayName(provider.displayName ?? provider.name);
      setError(null);
      setSaving(false);
      bumpResetKey();
    }
  }, [provider, visible]);

  const header = useMemo<SheetHeader>(() => ({ title: "Rename provider" }), []);
  const trimmedDisplayName = displayName.trim();
  const canSave = Boolean(provider && trimmedDisplayName.length > 0 && !saving);

  const handleSave = useCallback(() => {
    if (!provider || !canSave) return;
    setError(null);
    setSaving(true);
    void renameProvider({ name: provider.name, displayName: trimmedDisplayName })
      .then(() => {
        onClose();
        return undefined;
      })
      .catch((err: unknown) => {
        setError(describeError(err, "Failed to rename provider"));
      })
      .finally(() => setSaving(false));
  }, [canSave, onClose, provider, renameProvider, trimmedDisplayName]);

  if (!provider) {
    return null;
  }

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      desktopMaxWidth={420}
      snapPoints={FORM_SNAP_POINTS}
      testID="paseo-agent-provider-rename-form"
    >
      <View style={styles.formGroup}>
        <Text style={styles.formLabel}>Provider name</Text>
        <AdaptiveTextInput
          testID="paseo-agent-provider-display-name"
          accessibilityLabel="Provider name"
          initialValue={displayName}
          resetKey={`paseo-agent-provider-display-name-${resetKey}`}
          value={displayName}
          onChangeText={setDisplayName}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.formInput}
        />
        {error ? (
          <Text style={styles.errorText} testID="paseo-agent-provider-rename-error">
            {error}
          </Text>
        ) : null}
        <View style={styles.formActions}>
          <Button variant="secondary" size="sm" onPress={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={handleSave}
            disabled={!canSave}
            loading={saving}
            testID="paseo-agent-provider-rename-submit"
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

export function PaseoAgentSettingsSheet({
  serverId,
  visible,
  onClose,
}: PaseoAgentSettingsSheetProps) {
  const {
    supported,
    catalogSupported,
    providers,
    catalog,
    isLoading,
    isCatalogLoading,
    error,
    catalogError,
    setProvider,
    startOAuth,
    completeOAuth,
    renameProvider,
  } = usePaseoAgentProviders(serverId);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const preferredOAuthMode = preferredPaseoAgentOAuthMode(activeConnection);
  const [addSheet, setAddSheet] = useState<AddSheetState>({ kind: "closed" });

  useEffect(() => {
    if (!visible) {
      setAddSheet({ kind: "closed" });
    }
  }, [visible]);

  const catalogById = useMemo(() => {
    const map = new Map<string, PaseoAgentCatalogEntry>();
    for (const entry of catalog) {
      map.set(entry.id, entry);
    }
    return map;
  }, [catalog]);

  const handleOpenPicker = useCallback(() => setAddSheet({ kind: "picker" }), []);
  const handleCloseSubSheet = useCallback(() => setAddSheet({ kind: "closed" }), []);
  const handleSelectEntry = useCallback(
    (entry: PaseoAgentCatalogEntry) => {
      setAddSheet({
        kind: "form",
        entry,
        name: nextPaseoAgentProviderName(entry, providers),
        returnToPicker: true,
      });
    },
    [providers],
  );
  const handleReauth = useCallback(
    (provider: RedactedPaseoAgentProviderConfig, entry: PaseoAgentCatalogEntry) => {
      setAddSheet({
        kind: "form",
        entry,
        name: provider.name,
        returnToPicker: false,
      });
    },
    [],
  );
  const handleRename = useCallback((provider: RedactedPaseoAgentProviderConfig) => {
    setAddSheet({ kind: "rename", provider });
  }, []);
  const handleBackFromForm = useCallback(() => {
    setAddSheet((current) =>
      current.kind === "form" && current.returnToPicker ? { kind: "picker" } : { kind: "closed" },
    );
  }, []);

  const footer = useMemo(() => {
    if (!supported) {
      return undefined;
    }
    if (!catalogSupported) {
      return (
        <View style={styles.footerActions}>
          <Text style={styles.updateText} testID="paseo-agent-catalog-unsupported">
            {CATALOG_UPDATE_MESSAGE}
          </Text>
        </View>
      );
    }
    return (
      <View style={styles.footerActions}>
        <Button
          variant="default"
          size="sm"
          leftIcon={Plus}
          onPress={handleOpenPicker}
          testID="paseo-agent-add-provider"
        >
          Add model provider
        </Button>
      </View>
    );
  }, [catalogSupported, handleOpenPicker, supported]);

  let body: React.ReactNode;
  if (!supported) {
    body = (
      <StateBox testID="paseo-agent-unsupported">
        Update the host to configure Paseo Agent.
      </StateBox>
    );
  } else if (error) {
    body = <StateBox>{error}</StateBox>;
  } else if (isLoading) {
    body = <StateBox>Loading...</StateBox>;
  } else if (providers.length === 0) {
    body = <StateBox>No providers configured yet.</StateBox>;
  } else {
    body = (
      <View style={styles.list} accessibilityRole="list">
        {providers.map((provider, index) => (
          <ProviderRow
            key={provider.name}
            provider={provider}
            catalogEntry={catalogById.get(provider.providerType)}
            isFirst={index === 0}
            onReauth={handleReauth}
            onRename={handleRename}
          />
        ))}
      </View>
    );
  }

  return (
    <>
      <AdaptiveModalSheet
        header={HEADER}
        visible={visible}
        onClose={onClose}
        footer={footer}
        snapPoints={MAIN_SNAP_POINTS}
        testID="paseo-agent-settings-sheet"
      >
        {body}
      </AdaptiveModalSheet>
      {supported && catalogSupported ? (
        <CatalogPickerSubSheet
          visible={addSheet.kind === "picker"}
          catalog={catalog}
          isLoading={isCatalogLoading}
          error={catalogError}
          onClose={handleCloseSubSheet}
          onSelect={handleSelectEntry}
        />
      ) : null}
      {supported && catalogSupported ? (
        <PaseoAgentProviderFormSheet
          entry={addSheet.kind === "form" ? addSheet.entry : null}
          visible={addSheet.kind === "form"}
          name={addSheet.kind === "form" ? addSheet.name : undefined}
          onBack={handleBackFromForm}
          onClose={handleCloseSubSheet}
          setProvider={setProvider}
          startOAuth={startOAuth}
          completeOAuth={completeOAuth}
          preferredOAuthMode={preferredOAuthMode}
        />
      ) : null}
      {supported && catalogSupported ? (
        <PaseoAgentProviderRenameSheet
          provider={addSheet.kind === "rename" ? addSheet.provider : null}
          visible={addSheet.kind === "rename"}
          onClose={handleCloseSubSheet}
          renameProvider={renameProvider}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  list: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  rowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  providerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  providerText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  providerName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
  providerMeta: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  dotAvailable: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotMuted: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: theme.colors.foregroundMuted,
  },
  catalogRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  catalogIcon: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
  },
  catalogText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  disabledRow: {
    opacity: theme.opacity[50],
  },
  stateBox: {
    minHeight: 96,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  stateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  footerActions: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    alignItems: "center",
  },
  updateText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "right",
  },
  formGroup: {
    gap: theme.spacing[2],
  },
  formLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    marginTop: theme.spacing[2],
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  formHint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  formInput: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.sm,
  },
  authorizationBox: {
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  userCode: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    letterSpacing: 0,
  },
  linkStack: {
    gap: theme.spacing[1],
  },
  errorText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.destructive,
  },
  formActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[3],
  },
}));
