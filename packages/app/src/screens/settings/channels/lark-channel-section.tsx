import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Bot, ExternalLink } from "lucide-react-native";
import type {
  LarkChannelAuthorizedUser,
  LarkChannelBotStatus,
  LarkChannelPendingPairing,
  LarkChannelStatus,
} from "@getpaseo/protocol/messages";
import type { ConfigureLarkChannelOptions } from "@getpaseo/client";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import {
  SelectField,
  type SelectFieldDisplay,
  type SelectFieldOption,
} from "@/components/ui/select-field";
import { Switch } from "@/components/ui/switch";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useAssistants } from "@/hooks/use-assistants";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { useProjects } from "@/hooks/use-projects";
import { useHostFeature } from "@/runtime/host-features";
import { SettingsSection } from "@/screens/settings/settings-section";
import { settingsStyles } from "@/styles/settings";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { type UseLarkChannelResult, useLarkChannel } from "./use-lark-channel";

const LARK_DOCS_URL = "https://open.larkoffice.com/document/server-docs/server-side-sdk";
const LEGACY_LARK_BOT_ID = "__legacy_lark_bot__";
const ROW_WITH_BORDER_STYLE = [settingsStyles.row, settingsStyles.rowBorder];
const EMPTY_PAIRINGS: LarkChannelPendingPairing[] = [];
const EMPTY_AUTHORIZED_USERS: LarkChannelAuthorizedUser[] = [];

const ThemedBot = withUnistyles(Bot);
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

interface LarkChannelSectionProps {
  serverId: string;
}

interface LarkChannelLoadedContentProps {
  serverId: string;
  channel: UseLarkChannelResult;
}

interface StatusCardProps {
  channel: UseLarkChannelResult;
  status: LarkChannelBotStatus | null;
  onEnabledChange: (enabled: boolean) => void;
}

interface BotListCardProps {
  bots: LarkChannelBotStatus[];
  selectedBotId: string | null;
  creating: boolean;
  onSelect: (botId: string) => void;
  onAdd: () => void;
}

interface CredentialsCardProps {
  status: LarkChannelBotStatus | null;
  botName: string;
  creating: boolean;
  canDelete: boolean;
  formRevision: number;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  assistantId: string | null;
  provider: string | null;
  model: string | null;
  cwd: string;
  showOptional: boolean;
  assistantOptions: SelectFieldOption<string>[];
  selectedAssistantDisplay: SelectFieldDisplay | null;
  assistantsLoading: boolean;
  providerOptions: SelectFieldOption<string>[];
  selectedProviderDisplay: SelectFieldDisplay | null;
  modelOptions: SelectFieldOption<string>[];
  selectedModelDisplay: SelectFieldDisplay | null;
  providersLoading: boolean;
  projectOptions: SelectFieldOption<string>[];
  selectedProjectDisplay: SelectFieldDisplay | null;
  saveError: string | null;
  saving: boolean;
  connected: boolean;
  onBotNameChange: (value: string) => void;
  onAppIdChange: (value: string) => void;
  onAppSecretChange: (value: string) => void;
  onEncryptKeyChange: (value: string) => void;
  onVerificationTokenChange: (value: string) => void;
  onAssistantChange: (value: string) => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onCwdChange: (value: string) => void;
  onToggleOptional: () => void;
  onSave: () => void;
  onTest: () => void;
  onDelete: () => void;
  onOpenDocs: () => void;
}

interface PairingRowProps {
  pairing: LarkChannelPendingPairing;
  isFirst: boolean;
  onApprove: (code: string) => void;
  onReject: (code: string) => void;
}

interface AuthorizedUserRowProps {
  user: LarkChannelAuthorizedUser;
  isFirst: boolean;
  onRevoke: (userId: string) => void;
}

function getStatusLabel(status: LarkChannelBotStatus | LarkChannelStatus | null): string {
  if (!status) return "Not configured";
  switch (status.connectionStatus) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    case "disabled":
      return "Disabled";
    default:
      return "Idle";
  }
}

function getStatusTone(
  status: LarkChannelBotStatus | LarkChannelStatus | null,
): "success" | "warning" | "danger" | "muted" {
  if (!status) return "muted";
  if (status.connectionStatus === "connected") return "success";
  if (status.connectionStatus === "connecting") return "warning";
  if (status.connectionStatus === "error") return "danger";
  return "muted";
}

function getStatusDotStyle(status: LarkChannelBotStatus | LarkChannelStatus | null) {
  const tone = getStatusTone(status);
  if (tone === "success") return [styles.statusDot, styles.statusDotSuccess];
  if (tone === "warning") return [styles.statusDot, styles.statusDotWarning];
  if (tone === "danger") return [styles.statusDot, styles.statusDotDanger];
  return [styles.statusDot, styles.statusDotMuted];
}

function addTrimmedField<T extends string>(
  target: Record<string, string>,
  key: T,
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed.length > 0) {
    target[key] = trimmed;
  }
}

function buildConfigureInput(input: {
  botId: string | null;
  botName: string;
  creating: boolean;
  appId: string;
  appSecret: string;
  encryptKey: string;
  verificationToken: string;
  assistantId: string | null;
  provider: string | null;
  model: string | null;
  cwd: string;
  status: LarkChannelBotStatus | null;
}): ConfigureLarkChannelOptions {
  const secrets: Record<string, string> = {};
  addTrimmedField(secrets, "appId", input.appId);
  addTrimmedField(secrets, "appSecret", input.appSecret);
  addTrimmedField(secrets, "encryptKey", input.encryptKey);
  addTrimmedField(secrets, "verificationToken", input.verificationToken);
  const cwd = input.cwd.trim();
  return {
    ...(input.creating || !input.botId ? { createNew: true } : { botId: input.botId }),
    name: input.botName,
    ...secrets,
    domain: input.status?.domain ?? "feishu",
    target: {
      kind: "assistant",
      assistantId: input.assistantId,
      provider: input.provider,
      model: input.model,
      cwd: cwd.length > 0 ? cwd : null,
      workspaceId: input.status?.target.workspaceId ?? null,
    },
  };
}

function UpgradeRequiredCard() {
  return (
    <SettingsSection title="Channels">
      <View style={settingsStyles.card} testID="host-page-channels-upgrade-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Feishu/Lark requires a newer host</Text>
            <Text style={settingsStyles.rowHint}>
              Update the selected Paseo daemon to configure channels.
            </Text>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

function ErrorCard({ message }: { message: string }) {
  return (
    <SettingsSection title="Channels">
      <View style={settingsStyles.card} testID="host-page-channels-error-card">
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>Could not load Feishu/Lark</Text>
            <Text style={settingsStyles.rowError}>{message}</Text>
          </View>
        </View>
      </View>
    </SettingsSection>
  );
}

function LoadingCard() {
  return (
    <SettingsSection title="Channels">
      <View style={styles.loadingRow}>
        <LoadingSpinner size={16} color={styles.spinnerColor.color} />
        <Text style={settingsStyles.rowHint}>Loading Lark channel…</Text>
      </View>
    </SettingsSection>
  );
}

function StatusCard({ channel, status, onEnabledChange }: StatusCardProps) {
  const statusDotStyle = useMemo(() => getStatusDotStyle(status), [status]);
  const mutationError = channel.mutationError?.message ?? null;

  return (
    <SettingsSection title="飞书 / Lark 连接状态">
      <View style={settingsStyles.card}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.titleRow}>
              <ThemedBot size={ICON_SIZE.md} uniProps={foregroundIconMapping} />
              <Text style={settingsStyles.rowTitle}>当前机器人连接</Text>
            </View>
            <View style={styles.statusRow}>
              <View style={statusDotStyle} />
              <Text style={settingsStyles.rowHint}>{getStatusLabel(status)}</Text>
            </View>
            {status?.error ? <Text style={settingsStyles.rowError}>{status.error}</Text> : null}
            {channel.error ? (
              <Text style={settingsStyles.rowError}>{channel.error.message}</Text>
            ) : null}
            {mutationError ? <Text style={settingsStyles.rowError}>{mutationError}</Text> : null}
          </View>
          <Switch
            value={status?.enabled ?? false}
            onValueChange={onEnabledChange}
            disabled={channel.isMutating || !channel.isConnected || !status}
            accessibilityLabel="Enable Lark channel"
            testID="host-page-lark-enabled-switch"
          />
        </View>
      </View>
    </SettingsSection>
  );
}

function getBotDisplayName(bot: LarkChannelBotStatus): string {
  return bot.name || bot.bot?.name || bot.appId || "Untitled Lark bot";
}

function hasLegacyStatusConfig(status: LarkChannelStatus): boolean {
  return Boolean(
    status.appId ||
    status.hasAppSecret ||
    status.hasEncryptKey ||
    status.hasVerificationToken ||
    status.pendingPairings.length > 0 ||
    status.authorizedUsers.length > 0 ||
    status.target.cwd ||
    (status.target.kind === "assistant" && status.target.assistantId) ||
    status.connectionStatus !== "disabled",
  );
}

function buildBotStatuses(status: LarkChannelStatus | null): LarkChannelBotStatus[] {
  if (!status) return [];
  if (status.bots.length > 0) return status.bots;
  if (!hasLegacyStatusConfig(status)) return [];
  return [
    {
      id: status.activeBotId ?? LEGACY_LARK_BOT_ID,
      name: status.bot?.name ?? null,
      enabled: status.enabled,
      connectionStatus: status.connectionStatus,
      error: status.error,
      appId: status.appId,
      hasAppSecret: status.hasAppSecret,
      hasEncryptKey: status.hasEncryptKey,
      hasVerificationToken: status.hasVerificationToken,
      domain: status.domain,
      target: status.target,
      bot: status.bot,
      pendingPairings: status.pendingPairings,
      authorizedUsers: status.authorizedUsers,
    },
  ];
}

function BotListRow({
  bot,
  selected,
  isFirst,
  onSelect,
}: {
  bot: LarkChannelBotStatus;
  selected: boolean;
  isFirst: boolean;
  onSelect: (botId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(bot.id);
  }, [bot.id, onSelect]);

  return (
    <View style={isFirst ? settingsStyles.row : ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{getBotDisplayName(bot)}</Text>
        <Text style={settingsStyles.rowHint}>
          {bot.appId ?? "No App ID"} · {getStatusLabel(bot)}
        </Text>
      </View>
      <Button
        size="sm"
        variant={selected ? "default" : "outline"}
        onPress={handleSelect}
        testID={`host-page-lark-bot-select-${bot.id}`}
      >
        {selected ? "Editing" : "Edit"}
      </Button>
    </View>
  );
}

function BotListCard({ bots, selectedBotId, creating, onSelect, onAdd }: BotListCardProps) {
  return (
    <SettingsSection title={`飞书机器人列表（${bots.length}）`}>
      <View style={settingsStyles.card}>
        {bots.length > 0 ? (
          bots.map((bot, index) => (
            <BotListRow
              key={bot.id}
              bot={bot}
              selected={!creating && bot.id === selectedBotId}
              isFirst={index === 0}
              onSelect={onSelect}
            />
          ))
        ) : (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>暂无已配置的飞书机器人。</Text>
          </View>
        )}
        <View style={bots.length > 0 ? ROW_WITH_BORDER_STYLE : settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <Text style={settingsStyles.rowTitle}>
              {creating ? "正在添加新的飞书机器人" : "添加飞书机器人"}
            </Text>
            <Text style={settingsStyles.rowHint}>
              每个机器人都可以单独配置 App ID、凭证、助手和项目。
            </Text>
          </View>
          <Button
            size="sm"
            variant={creating ? "default" : "outline"}
            onPress={onAdd}
            testID="host-page-lark-add-bot"
          >
            添加
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function CredentialsCard(props: CredentialsCardProps) {
  return (
    <SettingsSection title={props.creating ? "新机器人配置" : "机器人配置"}>
      <View style={styles.formCard}>
        <Field label="机器人名称" testID="host-page-lark-bot-name">
          <FormTextInput
            initialValue={props.botName}
            resetKey={`bot-name:${props.formRevision}`}
            onChangeText={props.onBotNameChange}
            placeholder="bot name"
          />
        </Field>
        <Field label="App ID" testID="host-page-lark-app-id">
          <FormTextInput
            initialValue={props.appId}
            resetKey={`app-id:${props.formRevision}`}
            onChangeText={props.onAppIdChange}
            placeholder="cli_xxxxxxxxxx"
          />
        </Field>
        <Field
          label="App Secret"
          hint={
            props.status?.hasAppSecret
              ? "Configured. Leave blank to keep existing secret."
              : undefined
          }
          testID="host-page-lark-app-secret"
        >
          <FormTextInput
            initialValue={props.appSecret}
            resetKey={`app-secret:${props.formRevision}`}
            onChangeText={props.onAppSecretChange}
            placeholder={props.status?.hasAppSecret ? "••••••••••••••••" : "App Secret"}
            secureTextEntry
          />
        </Field>
        <Button variant="ghost" size="sm" onPress={props.onToggleOptional}>
          {props.showOptional ? "Hide optional settings" : "Show optional settings"}
        </Button>
        {props.showOptional ? <OptionalCredentialFields {...props} /> : null}
        <SelectField
          label="Provider"
          value={props.provider}
          selectedDisplay={props.selectedProviderDisplay}
          options={props.providerOptions}
          onChange={props.onProviderChange}
          placeholder="Select provider"
          emptyText="No providers on this host"
          loading={props.providersLoading}
          searchable
          testID="host-page-lark-provider"
        />
        <SelectField
          label="Model"
          value={props.model}
          selectedDisplay={props.selectedModelDisplay}
          options={props.modelOptions}
          onChange={props.onModelChange}
          placeholder="Select model"
          emptyText="No models for this provider"
          loading={props.providersLoading}
          searchable
          testID="host-page-lark-model"
          disabled={!props.provider}
        />
        <SelectField
          label="Assistant"
          value={props.assistantId}
          selectedDisplay={props.selectedAssistantDisplay}
          options={props.assistantOptions}
          onChange={props.onAssistantChange}
          placeholder="Select an assistant"
          emptyText="No assistants on this host"
          loading={props.assistantsLoading}
          searchable
          testID="host-page-lark-assistant"
        />
        <SelectField
          label="Project path"
          value={props.cwd || null}
          selectedDisplay={props.selectedProjectDisplay}
          options={props.projectOptions}
          onChange={props.onCwdChange}
          placeholder="Select a project"
          emptyText="No opened projects on this host"
          searchable
          testID="host-page-lark-project-path"
          hint="Each Lark topic creates its own Paseo session in this project."
        />
        {props.saveError ? <Text style={settingsStyles.rowError}>{props.saveError}</Text> : null}
        <View style={styles.actionsRow}>
          <Button
            variant="default"
            onPress={props.onSave}
            loading={props.saving}
            disabled={!props.connected}
          >
            Save
          </Button>
          <Button
            variant="outline"
            onPress={props.onTest}
            loading={props.saving}
            disabled={!props.connected}
          >
            Test & Connect
          </Button>
          <Button
            variant="destructive"
            onPress={props.onDelete}
            disabled={!props.canDelete || props.saving || !props.connected}
          >
            Delete bot
          </Button>
          <Button variant="ghost" onPress={props.onOpenDocs} leftIcon={ExternalLink}>
            Lark docs
          </Button>
        </View>
      </View>
    </SettingsSection>
  );
}

function OptionalCredentialFields(props: CredentialsCardProps) {
  return (
    <>
      <Field label="Encrypt Key" testID="host-page-lark-encrypt-key">
        <FormTextInput
          initialValue={props.encryptKey}
          resetKey={`encrypt-key:${props.formRevision}`}
          onChangeText={props.onEncryptKeyChange}
          placeholder={props.status?.hasEncryptKey ? "Configured" : "Optional"}
          secureTextEntry
        />
      </Field>
      <Field label="Verification Token" testID="host-page-lark-verification-token">
        <FormTextInput
          initialValue={props.verificationToken}
          resetKey={`verification-token:${props.formRevision}`}
          onChangeText={props.onVerificationTokenChange}
          placeholder={props.status?.hasVerificationToken ? "Configured" : "Optional"}
          secureTextEntry
        />
      </Field>
    </>
  );
}

function PairingRow({ pairing, isFirst, onApprove, onReject }: PairingRowProps) {
  const handleApprove = useCallback(() => {
    onApprove(pairing.code);
  }, [onApprove, pairing.code]);
  const handleReject = useCallback(() => {
    onReject(pairing.code);
  }, [onReject, pairing.code]);

  return (
    <View style={isFirst ? settingsStyles.row : ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{pairing.displayName}</Text>
        <Text style={settingsStyles.rowHint}>Code {pairing.code}</Text>
      </View>
      <View style={styles.inlineActions}>
        <Button size="sm" variant="default" onPress={handleApprove}>
          Approve
        </Button>
        <Button size="sm" variant="outline" onPress={handleReject}>
          Reject
        </Button>
      </View>
    </View>
  );
}

function PairingRequestsCard(props: {
  pairings: LarkChannelPendingPairing[];
  onApprove: (code: string) => void;
  onReject: (code: string) => void;
}) {
  return (
    <SettingsSection title="Pending pairing requests">
      <View style={settingsStyles.card}>
        {props.pairings.length > 0 ? (
          props.pairings.map((pairing, index) => (
            <PairingRow
              key={pairing.code}
              pairing={pairing}
              isFirst={index === 0}
              onApprove={props.onApprove}
              onReject={props.onReject}
            />
          ))
        ) : (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>
              No pending requests. Send a message to the bot to pair.
            </Text>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

function AuthorizedUserRow({ user, isFirst, onRevoke }: AuthorizedUserRowProps) {
  const handleRevoke = useCallback(() => {
    onRevoke(user.id);
  }, [onRevoke, user.id]);

  return (
    <View style={isFirst ? settingsStyles.row : ROW_WITH_BORDER_STYLE}>
      <View style={settingsStyles.rowContent}>
        <Text style={settingsStyles.rowTitle}>{user.displayName}</Text>
        <Text style={settingsStyles.rowHint}>{user.chatId}</Text>
      </View>
      <Button size="sm" variant="outline" onPress={handleRevoke}>
        Revoke
      </Button>
    </View>
  );
}

function AuthorizedUsersCard(props: {
  users: LarkChannelAuthorizedUser[];
  onRevoke: (userId: string) => void;
}) {
  return (
    <SettingsSection title="Authorized users">
      <View style={settingsStyles.card}>
        {props.users.length > 0 ? (
          props.users.map((user, index) => (
            <AuthorizedUserRow
              key={user.id}
              user={user}
              isFirst={index === 0}
              onRevoke={props.onRevoke}
            />
          ))
        ) : (
          <View style={settingsStyles.row}>
            <Text style={settingsStyles.rowHint}>No authorized users yet.</Text>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

function buildProviderOptions(entries: ProviderSnapshotEntry[]): SelectFieldOption<string>[] {
  return entries
    .filter((entry) => entry.enabled !== false)
    .map((entry) => ({
      id: entry.provider,
      value: entry.provider,
      label: entry.label ?? entry.provider,
      description: entry.description ?? entry.provider,
    }));
}

function buildModelOptions(models: AgentModelDefinition[]): SelectFieldOption<string>[] {
  return models.map((m) => ({
    id: m.id,
    value: m.id,
    label: m.label,
    description: m.description ?? m.id,
  }));
}

function optionDisplay(option: SelectFieldOption<string> | undefined): SelectFieldDisplay | null {
  return option ? { label: option.label, description: option.description } : null;
}

function LarkChannelLoadedContent({ serverId, channel }: LarkChannelLoadedContentProps) {
  const assistants = useAssistants(serverId);
  const providersSnapshot = useProvidersSnapshot(serverId);
  const { projects } = useProjects();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const [botName, setBotName] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [encryptKey, setEncryptKey] = useState("");
  const [verificationToken, setVerificationToken] = useState("");
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [cwd, setCwd] = useState("");
  const [showOptional, setShowOptional] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const status = channel.status;
  const botStatuses = useMemo(() => buildBotStatuses(status), [status]);
  const selectedBotStatus = useMemo<LarkChannelBotStatus | null>(() => {
    if (creatingBot) return null;
    if (selectedBotId) {
      return botStatuses.find((bot) => bot.id === selectedBotId) ?? null;
    }
    if (status?.activeBotId) {
      return botStatuses.find((bot) => bot.id === status.activeBotId) ?? null;
    }
    return botStatuses[0] ?? null;
  }, [botStatuses, creatingBot, selectedBotId, status?.activeBotId]);

  useEffect(() => {
    if (!status || creatingBot) return;
    let nextBotId = botStatuses[0]?.id ?? null;
    if (selectedBotId && botStatuses.some((bot) => bot.id === selectedBotId)) {
      nextBotId = selectedBotId;
    } else if (status.activeBotId && botStatuses.some((bot) => bot.id === status.activeBotId)) {
      nextBotId = status.activeBotId;
    }
    if (nextBotId !== selectedBotId) {
      setSelectedBotId(nextBotId);
    }
  }, [botStatuses, creatingBot, selectedBotId, status]);

  useEffect(() => {
    if (creatingBot) return;
    if (!selectedBotStatus) {
      setBotName("");
      setAppId("");
      setAppSecret("");
      setEncryptKey("");
      setVerificationToken("");
      setAssistantId(null);
      setProvider(null);
      setModel(null);
      setCwd("");
      setFormRevision((value) => value + 1);
      return;
    }
    setBotName(selectedBotStatus.name ?? "");
    setAppId(selectedBotStatus.appId ?? "");
    setAppSecret("");
    setEncryptKey("");
    setVerificationToken("");
    setAssistantId(
      selectedBotStatus.target.kind === "assistant" ? selectedBotStatus.target.assistantId : null,
    );
    setProvider(
      selectedBotStatus.target.kind === "assistant"
        ? (selectedBotStatus.target.provider ?? null)
        : null,
    );
    setModel(
      selectedBotStatus.target.kind === "assistant"
        ? (selectedBotStatus.target.model ?? null)
        : null,
    );
    setCwd(selectedBotStatus.target.cwd ?? "");
    setFormRevision((value) => value + 1);
  }, [creatingBot, selectedBotStatus]);

  const assistantOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      assistants.assistants.map((assistant) => ({
        id: assistant.id,
        value: assistant.id,
        label: assistant.name,
        description: assistant.description || assistant.name,
      })),
    [assistants.assistants],
  );

  const selectedAssistantDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const selected = assistantOptions.find((option) => option.value === assistantId);
    return selected ? { label: selected.label, description: selected.description } : null;
  }, [assistantId, assistantOptions]);

  const providerOptions = useMemo(
    () => buildProviderOptions(providersSnapshot.entries ?? []),
    [providersSnapshot.entries],
  );
  const selectedProviderEntry = useMemo(
    () => providersSnapshot.entries?.find((entry) => entry.provider === provider) ?? null,
    [provider, providersSnapshot.entries],
  );
  const modelOptions = useMemo(
    () => buildModelOptions(selectedProviderEntry?.models ?? []),
    [selectedProviderEntry?.models],
  );
  const selectedProviderDisplay = useMemo(
    () => optionDisplay(providerOptions.find((option) => option.value === provider)),
    [provider, providerOptions],
  );
  const selectedModelDisplay = useMemo(
    () => optionDisplay(modelOptions.find((option) => option.value === model)),
    [model, modelOptions],
  );

  const projectOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const options: SelectFieldOption<string>[] = [];
    for (const project of projects) {
      const host = project.hosts.find(
        (entry) =>
          entry.serverId === serverId && entry.isOnline && entry.repoRoot.trim().length > 0,
      );
      if (!host) continue;
      const label = project.projectCustomName ?? project.projectName;
      options.push({
        id: `${project.projectKey}:${host.repoRoot}`,
        value: host.repoRoot,
        label,
        description: host.repoRoot,
        testID: `host-page-lark-project-option-${project.projectKey}`,
      });
    }
    return options;
  }, [projects, serverId]);

  const selectedProjectDisplay = useMemo<SelectFieldDisplay | null>(() => {
    const selected = projectOptions.find((option) => option.value === cwd);
    return selected ? { label: selected.label, description: selected.description } : null;
  }, [cwd, projectOptions]);

  const clearFormForNewBot = useCallback(() => {
    setBotName("");
    setAppId("");
    setAppSecret("");
    setEncryptKey("");
    setVerificationToken("");
    setAssistantId(null);
    setProvider(null);
    setModel(null);
    setCwd("");
    setSaveError(null);
    setFormRevision((value) => value + 1);
  }, []);
  const handleSelectBot = useCallback((botId: string) => {
    setCreatingBot(false);
    setSelectedBotId(botId);
    setSaveError(null);
  }, []);
  const handleAddBot = useCallback(() => {
    setCreatingBot(true);
    setSelectedBotId(null);
    clearFormForNewBot();
  }, [clearFormForNewBot]);
  const handleBotNameChange = useCallback((value: string) => {
    setBotName(value);
    setSaveError(null);
  }, []);
  const handleAssistantChange = useCallback((value: string) => {
    setAssistantId(value);
    setSaveError(null);
  }, []);
  const handleProviderChange = useCallback((value: string) => {
    setProvider(value);
    setModel(null);
    setSaveError(null);
  }, []);
  const handleModelChange = useCallback((value: string) => {
    setModel(value);
    setSaveError(null);
  }, []);

  const handleProjectChange = useCallback((value: string) => {
    setCwd(value);
    setSaveError(null);
  }, []);

  const handleToggleOptional = useCallback(() => {
    setShowOptional((value) => !value);
  }, []);
  const save = useCallback(async () => {
    try {
      setSaveError(null);
      const nextStatus = await channel.configure(
        buildConfigureInput({
          botId: selectedBotStatus?.id ?? selectedBotId,
          botName,
          creating: creatingBot,
          appId,
          appSecret,
          encryptKey,
          verificationToken,
          assistantId,
          provider,
          model,
          cwd,
          status: selectedBotStatus,
        }),
      );
      const nextBotId = nextStatus.activeBotId ?? nextStatus.bots[0]?.id ?? null;
      setCreatingBot(false);
      setSelectedBotId(nextBotId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(message);
      throw error;
    }
  }, [
    appId,
    appSecret,
    assistantId,
    botName,
    channel,
    creatingBot,
    cwd,
    encryptKey,
    model,
    provider,
    selectedBotId,
    selectedBotStatus,
    verificationToken,
  ]);
  const handleSave = useCallback(async () => {
    try {
      await save();
    } catch {
      // `save` already surfaces the message in the form.
    }
  }, [save]);
  const handleTest = useCallback(async () => {
    try {
      setSaveError(null);
      await save();
      await channel.testConnection(selectedBotStatus?.id ?? selectedBotId);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [channel, save, selectedBotId, selectedBotStatus?.id]);
  const handleEnabledChange = useCallback(
    (enabled: boolean) => {
      void channel.setEnabled(enabled, selectedBotStatus?.id ?? selectedBotId);
    },
    [channel, selectedBotId, selectedBotStatus?.id],
  );
  const handleApprovePairing = useCallback(
    (code: string) => {
      void channel.approvePairing(code, selectedBotStatus?.id ?? selectedBotId);
    },
    [channel, selectedBotId, selectedBotStatus?.id],
  );
  const handleRejectPairing = useCallback(
    (code: string) => {
      void channel.rejectPairing(code, selectedBotStatus?.id ?? selectedBotId);
    },
    [channel, selectedBotId, selectedBotStatus?.id],
  );
  const handleRevokeUser = useCallback(
    (userId: string) => {
      void channel.revokeUser(userId, selectedBotStatus?.id ?? selectedBotId);
    },
    [channel, selectedBotId, selectedBotStatus?.id],
  );
  const handleDeleteBot = useCallback(async () => {
    const botId = selectedBotStatus?.id ?? selectedBotId;
    if (!botId) return;
    try {
      setSaveError(null);
      const nextStatus = await channel.deleteBot(botId);
      const nextBotId = nextStatus.activeBotId ?? nextStatus.bots[0]?.id ?? null;
      setSelectedBotId(nextBotId);
      setCreatingBot(nextBotId === null);
      if (!nextBotId) {
        clearFormForNewBot();
      }
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    }
  }, [channel, clearFormForNewBot, selectedBotId, selectedBotStatus?.id]);
  const openDocs = useCallback(() => {
    void Linking.openURL(LARK_DOCS_URL);
  }, []);

  return (
    <View testID="host-page-channels">
      <BotListCard
        bots={botStatuses}
        selectedBotId={selectedBotStatus?.id ?? selectedBotId}
        creating={creatingBot}
        onSelect={handleSelectBot}
        onAdd={handleAddBot}
      />
      <StatusCard
        channel={channel}
        status={selectedBotStatus}
        onEnabledChange={handleEnabledChange}
      />
      <CredentialsCard
        status={selectedBotStatus}
        botName={botName}
        creating={creatingBot}
        canDelete={Boolean(
          selectedBotStatus?.id && status?.bots.some((bot) => bot.id === selectedBotStatus.id),
        )}
        formRevision={formRevision}
        appId={appId}
        appSecret={appSecret}
        encryptKey={encryptKey}
        verificationToken={verificationToken}
        assistantId={assistantId}
        provider={provider}
        model={model}
        cwd={cwd}
        showOptional={showOptional}
        assistantOptions={assistantOptions}
        selectedAssistantDisplay={selectedAssistantDisplay}
        assistantsLoading={assistants.isLoading}
        providerOptions={providerOptions}
        selectedProviderDisplay={selectedProviderDisplay}
        modelOptions={modelOptions}
        selectedModelDisplay={selectedModelDisplay}
        providersLoading={providersSnapshot.isLoading || providersSnapshot.isFetching}
        projectOptions={projectOptions}
        selectedProjectDisplay={selectedProjectDisplay}
        saveError={saveError}
        saving={channel.isMutating}
        connected={channel.isConnected}
        onBotNameChange={handleBotNameChange}
        onAppIdChange={setAppId}
        onAppSecretChange={setAppSecret}
        onEncryptKeyChange={setEncryptKey}
        onVerificationTokenChange={setVerificationToken}
        onAssistantChange={handleAssistantChange}
        onProviderChange={handleProviderChange}
        onModelChange={handleModelChange}
        onCwdChange={handleProjectChange}
        onToggleOptional={handleToggleOptional}
        onSave={handleSave}
        onTest={handleTest}
        onDelete={handleDeleteBot}
        onOpenDocs={openDocs}
      />
      <PairingRequestsCard
        pairings={selectedBotStatus?.pendingPairings ?? EMPTY_PAIRINGS}
        onApprove={handleApprovePairing}
        onReject={handleRejectPairing}
      />
      <AuthorizedUsersCard
        users={selectedBotStatus?.authorizedUsers ?? EMPTY_AUTHORIZED_USERS}
        onRevoke={handleRevokeUser}
      />
    </View>
  );
}

export function LarkChannelSection({ serverId }: LarkChannelSectionProps) {
  const supportsLark = useHostFeature(serverId, "larkChannel");
  const channel = useLarkChannel(serverId, { enabled: supportsLark });

  if (!supportsLark) return <UpgradeRequiredCard />;
  if (channel.isLoading) return <LoadingCard />;
  if (channel.error && !channel.status) return <ErrorCard message={channel.error.message} />;
  return <LarkChannelLoadedContent serverId={serverId} channel={channel} />;
}

const styles = StyleSheet.create((theme) => ({
  loadingRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
  },
  spinnerColor: {
    color: theme.colors.foregroundMuted,
  },
  titleRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  statusRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
  },
  statusDotSuccess: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusDotWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  statusDotDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
  statusDotMuted: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  formCard: {
    gap: theme.spacing[4],
  },
  actionsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  inlineActions: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
}));
