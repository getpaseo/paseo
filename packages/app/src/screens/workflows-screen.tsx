import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Play, Plus, RefreshCw, RotateCcw, Square } from "lucide-react-native";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  WorkflowRunDetails,
  WorkflowRunSummary,
  WorkflowSpecSummary,
  WorkflowValidationResult,
} from "@getpaseo/protocol/workflow/types";
import { MenuHeader } from "@/components/headers/menu-header";
import { HostFilter } from "@/components/hosts/host-filter";
import { ALL_HOSTS_OPTION_ID } from "@/components/hosts/host-picker";
import { SettingsTextAreaCard } from "@/components/settings-textarea";
import { Alert, type AlertVariant } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, useHosts } from "@/runtime/host-runtime";
import { buildHostAgentDetailRoute, buildHostWorkspaceRoute } from "@/utils/host-routes";
import {
  openWorkflowLaunchForm,
  submitWorkflowLaunchForm,
  updateWorkflowLaunchValue,
  type WorkflowLaunchForm,
} from "@/workflows/launch-form-model";
import { WorkflowJsonImport } from "@/workflows/workflow-json-import";

type ActionStatus =
  | { kind: "idle" }
  | { kind: "pending"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

const EMPTY_FORM: WorkflowLaunchForm = { values: {}, errors: {} };
const ACTIVE_STATUSES = new Set(["queued", "running", "stopping"]);

export function WorkflowsScreen(): ReactElement {
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
    agentId?: string | string[];
  }>();
  const hosts = useHosts();
  const routeServerId = firstParam(params.serverId);
  const routeWorkspaceId = firstParam(params.workspaceId);
  const routeAgentId = firstParam(params.agentId);
  const [selectedHost, setSelectedHost] = useState(routeServerId ?? hosts[0]?.serverId ?? "");
  const supportsWorkflows = useHostFeature(selectedHost || null, "workflows");

  useEffect(() => {
    if (hosts.length === 0) {
      setSelectedHost("");
      return;
    }
    if (!hosts.some((host) => host.serverId === selectedHost)) {
      setSelectedHost(routeServerId ?? hosts[0]?.serverId ?? "");
    }
  }, [hosts, routeServerId, selectedHost]);

  const context = useMemo(
    () =>
      routeServerId === selectedHost
        ? { workspaceId: routeWorkspaceId ?? undefined, agentId: routeAgentId ?? undefined }
        : {},
    [routeAgentId, routeServerId, routeWorkspaceId, selectedHost],
  );
  const handleSelectHost = useCallback((serverId: string) => {
    if (serverId !== ALL_HOSTS_OPTION_ID) setSelectedHost(serverId);
  }, []);
  const contextLabel = workflowContextLabel(context);
  let content: ReactElement;
  if (!selectedHost) {
    content = <CenteredMessage message="Connect a host to use workflows." />;
  } else if (!supportsWorkflows) {
    content = (
      <View style={styles.alertWrap}>
        <Alert
          variant="warning"
          title="Host update required"
          description="This host does not advertise native workflows. Update Paseo on the host, then reconnect."
          testID="workflows-unsupported"
        />
      </View>
    );
  } else {
    content = <WorkflowHostScreen serverId={selectedHost} context={context} />;
  }

  return (
    <View style={styles.container}>
      <MenuHeader title="Workflows" />
      <View style={styles.toolbar}>
        {hosts.length > 1 ? (
          <HostFilter
            hosts={hosts}
            selectedHost={selectedHost}
            onSelectHost={handleSelectHost}
            triggerTestID="workflows-host-filter"
          />
        ) : null}
        <Text style={styles.contextText}>{contextLabel}</Text>
      </View>
      {content}
    </View>
  );
}

function WorkflowHostScreen({
  serverId,
  context,
}: {
  serverId: string;
  context: { workspaceId?: string; agentId?: string };
}): ReactElement {
  const [specs, setSpecs] = useState<WorkflowSpecSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRunSummary[]>([]);
  const [details, setDetails] = useState<WorkflowRunDetails | null>(null);
  const [selectedSpec, setSelectedSpec] = useState<WorkflowSpecSummary | null>(null);
  const [validation, setValidation] = useState<WorkflowValidationResult | null>(null);
  const [launchForm, setLaunchForm] = useState<WorkflowLaunchForm>(EMPTY_FORM);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionStatus>({ kind: "idle" });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editor, setEditor] = useState("");

  const client = getHostRuntimeStore().getClient(serverId);

  const load = useCallback(
    async (quiet = false) => {
      if (!client) {
        setLoadError("The host is disconnected. Reconnect, then try again.");
        setLoading(false);
        return;
      }
      if (!quiet) setLoading(true);
      try {
        const [specPayload, runPayload] = await Promise.all([
          client.workflowSpecList(),
          client.workflowRunList(),
        ]);
        if (specPayload.error) throw new Error(specPayload.error);
        if (runPayload.error) throw new Error(runPayload.error);
        setSpecs(specPayload.specs);
        setRuns(runPayload.runs);
        setLoadError(null);
      } catch (error) {
        setLoadError(errorMessage(error));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [client],
  );

  const refreshDetails = useCallback(
    async (runId: string) => {
      if (!client) {
        setAction({
          kind: "error",
          message: "The host is disconnected. Reconnect, then try again.",
        });
        return false;
      }
      try {
        const payload = await client.workflowRunInspect(runId);
        if (payload.error) throw new Error(payload.error);
        if (payload.details) setDetails(payload.details);
        return true;
      } catch (error) {
        setAction({ kind: "error", message: errorMessage(error) });
        return false;
      }
    },
    [client],
  );

  useEffect(() => {
    setDetails(null);
    setSelectedSpec(null);
    setValidation(null);
    setAction({ kind: "idle" });
    void load();
  }, [load, serverId]);

  useEffect(() => {
    if (!runs.some((run) => ACTIVE_STATUSES.has(run.status))) return;
    const timer = setInterval(() => {
      void load(true);
      if (details?.run.id) void refreshDetails(details.run.id);
    }, 1_500);
    return () => clearInterval(timer);
  }, [details?.run.id, load, refreshDetails, runs]);

  const chooseSpec = useCallback(
    async (spec: WorkflowSpecSummary) => {
      if (!client) return;
      setAction({ kind: "pending", message: `Loading ${spec.name}…` });
      try {
        const payload = await client.workflowSpecGet(spec.id);
        if (payload.error) throw new Error(payload.error);
        if (!payload.spec) throw new Error(`Workflow definition not found: ${spec.id}`);
        const validationPayload = await client.workflowSpecValidate(payload.spec);
        if (validationPayload.error) throw new Error(validationPayload.error);
        setSelectedSpec(spec);
        setValidation(validationPayload.validation);
        setLaunchForm(openWorkflowLaunchForm(validationPayload.validation));
        setAction({ kind: "idle" });
      } catch (error) {
        setAction({ kind: "error", message: errorMessage(error) });
      }
    },
    [client],
  );

  const launch = useCallback(async () => {
    if (!client || !selectedSpec || !validation) return;
    const submitted = submitWorkflowLaunchForm(launchForm, validation);
    if (!submitted.ok) {
      setLaunchForm(submitted.form);
      return;
    }
    setAction({ kind: "pending", message: `Queueing ${selectedSpec.name}…` });
    try {
      const payload = await client.workflowRunStart({
        workflowId: selectedSpec.id,
        parameters: submitted.parameters,
        context,
      });
      if (payload.error) throw new Error(payload.error);
      if (!payload.run) throw new Error("The host did not return the queued run.");
      setAction({ kind: "success", message: `Queued ${payload.run.id}` });
      setSelectedSpec(null);
      setValidation(null);
      setDetails(null);
      await load(true);
      await refreshDetails(payload.run.id);
    } catch (error) {
      setAction({ kind: "error", message: errorMessage(error) });
    }
  }, [client, context, launchForm, load, refreshDetails, selectedSpec, validation]);

  const validateEditor = useCallback(async () => {
    if (!client) return;
    setAction({ kind: "pending", message: "Validating JSON workflow…" });
    try {
      const spec = parseEditor(editor);
      const payload = await client.workflowSpecValidate(spec);
      if (payload.error) throw new Error(payload.error);
      if (!payload.validation.valid) {
        throw new Error(
          payload.validation.issues
            .map((issue) => `${issue.path || "$"}: ${issue.message}`)
            .join("\n"),
        );
      }
      setAction({ kind: "success", message: "Workflow JSON is valid." });
    } catch (error) {
      setAction({ kind: "error", message: errorMessage(error) });
    }
  }, [client, editor]);

  const saveEditor = useCallback(async () => {
    if (!client) return;
    setAction({ kind: "pending", message: "Saving workflow definition…" });
    try {
      const payload = await client.workflowSpecSave(parseEditor(editor));
      if (payload.error) throw new Error(payload.error);
      if (!payload.summary) throw new Error("The host did not return the saved workflow.");
      setAction({ kind: "success", message: `Saved ${payload.summary.name}` });
      setEditorOpen(false);
      await load(true);
    } catch (error) {
      setAction({ kind: "error", message: errorMessage(error) });
    }
  }, [client, editor, load]);

  const inspect = useCallback(
    async (run: WorkflowRunSummary) => {
      setAction({ kind: "pending", message: `Loading ${run.id}…` });
      if (await refreshDetails(run.id)) setAction({ kind: "idle" });
    },
    [refreshDetails],
  );

  const mutateRun = useCallback(
    async (kind: "stop" | "resume") => {
      if (!client || !details) return;
      setAction({
        kind: "pending",
        message: kind === "stop" ? "Requesting graceful stop…" : "Resuming workflow…",
      });
      try {
        const payload =
          kind === "stop"
            ? await client.workflowRunStop(details.run.id)
            : await client.workflowRunResume(details.run.id);
        if (payload.error) throw new Error(payload.error);
        setAction({
          kind: "success",
          message: kind === "stop" ? "Stop requested." : "Workflow resumed.",
        });
        await load(true);
        await refreshDetails(details.run.id);
      } catch (error) {
        setAction({ kind: "error", message: errorMessage(error) });
      }
    },
    [client, details, load, refreshDetails],
  );
  const handleRetry = useCallback(() => {
    void load();
  }, [load]);
  const handleToggleEditor = useCallback(() => {
    setEditorOpen((value) => !value);
  }, []);
  const handleRefresh = useCallback(() => {
    void load();
  }, [load]);
  const handleLaunchFormChange = useCallback((name: string, value: string) => {
    setLaunchForm((current) => updateWorkflowLaunchValue(current, name, value));
  }, []);
  const handleLaunch = useCallback(() => {
    void launch();
  }, [launch]);
  const handleStop = useCallback(() => {
    void mutateRun("stop");
  }, [mutateRun]);
  const handleResume = useCallback(() => {
    void mutateRun("resume");
  }, [mutateRun]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }

  return (
    <View style={styles.body}>
      {loadError ? (
        <View style={styles.alertWrap}>
          <Alert
            variant="error"
            title="Unable to load workflows"
            description={loadError}
            testID="workflows-load-error"
          >
            <Button variant="outline" size="sm" onPress={handleRetry} leftIcon={RefreshCw}>
              Retry
            </Button>
          </Alert>
        </View>
      ) : null}
      {action.kind !== "idle" ? (
        <View style={styles.alertWrap}>
          <Alert
            variant={actionAlertVariant(action)}
            title={actionAlertTitle(action)}
            description={action.message}
            testID={`workflows-action-${action.kind}`}
          />
        </View>
      ) : null}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.grid}>
          <View style={styles.column}>
            <SectionHeader
              title="Definitions"
              subtitle="Built-in templates and JSON saved in this host's Paseo home."
            >
              <Button
                variant="outline"
                size="sm"
                leftIcon={Plus}
                onPress={handleToggleEditor}
                testID="workflows-new-json"
              >
                New JSON
              </Button>
            </SectionHeader>
            {editorOpen ? (
              <WorkflowEditor
                value={editor}
                onChange={setEditor}
                onValidate={validateEditor}
                onSave={saveEditor}
              />
            ) : null}
            <View style={styles.list}>
              {specs.map((spec) => (
                <WorkflowSpecCard
                  key={spec.id}
                  spec={spec}
                  selected={selectedSpec?.id === spec.id}
                  onSelect={chooseSpec}
                />
              ))}
            </View>
            {selectedSpec && validation ? (
              <LaunchForm
                spec={selectedSpec}
                validation={validation}
                form={launchForm}
                context={context}
                onChange={handleLaunchFormChange}
                onLaunch={handleLaunch}
                pending={action.kind === "pending"}
              />
            ) : null}
          </View>
          <View style={styles.column}>
            <SectionHeader title="Runs" subtitle="Persisted state and native execution identities.">
              <Button
                variant="ghost"
                size="sm"
                leftIcon={RefreshCw}
                onPress={handleRefresh}
                testID="workflows-refresh"
              >
                Refresh
              </Button>
            </SectionHeader>
            {runs.length === 0 ? (
              <View style={styles.emptyCard}>
                <Text style={styles.cardDescription}>No workflow runs yet.</Text>
              </View>
            ) : (
              <View style={styles.list}>
                {runs.map((run) => (
                  <WorkflowRunCard
                    key={run.id}
                    run={run}
                    selected={details?.run.id === run.id}
                    onSelect={inspect}
                  />
                ))}
              </View>
            )}
            {details ? (
              <RunDetails
                serverId={serverId}
                details={details}
                onStop={handleStop}
                onResume={handleResume}
                pending={action.kind === "pending"}
              />
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

function WorkflowEditor({
  value,
  onChange,
  onValidate,
  onSave,
}: {
  value: string;
  onChange: (value: string) => void;
  onValidate: () => Promise<void>;
  onSave: () => Promise<void>;
}): ReactElement {
  return (
    <View style={styles.card} testID="workflow-json-editor">
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle}>Import workflow JSON</Text>
        <WorkflowJsonImport onLoad={onChange} />
      </View>
      <SettingsTextAreaCard
        accessibilityLabel="Workflow JSON"
        value={value}
        onChangeText={onChange}
        placeholder="Paste one paseo.workflows/v0.2 JSON object"
        testID="workflow-json-input"
        style={styles.jsonEditor}
      />
      <View style={styles.actionRow}>
        <Button variant="outline" size="sm" onPress={onValidate} testID="workflow-json-validate">
          Validate
        </Button>
        <Button size="sm" onPress={onSave} testID="workflow-json-save">
          Save
        </Button>
      </View>
    </View>
  );
}

function WorkflowSpecCard({
  spec,
  selected,
  onSelect,
}: {
  spec: WorkflowSpecSummary;
  selected: boolean;
  onSelect: (spec: WorkflowSpecSummary) => Promise<void>;
}): ReactElement {
  const handlePress = useCallback(() => {
    void onSelect(spec);
  }, [onSelect, spec]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.listCard, selected && styles.selectedCard]}
      testID={`workflow-spec-${spec.id}`}
    >
      <View style={styles.cardTitleRow}>
        <Text style={styles.cardTitle}>{spec.name}</Text>
        <StatusBadge label={spec.source} />
      </View>
      <Text style={styles.cardDescription}>{spec.description}</Text>
      <Text style={styles.metaText}>{`v${spec.version}`}</Text>
    </Pressable>
  );
}

function WorkflowRunCard({
  run,
  selected,
  onSelect,
}: {
  run: WorkflowRunSummary;
  selected: boolean;
  onSelect: (run: WorkflowRunSummary) => Promise<void>;
}): ReactElement {
  const handlePress = useCallback(() => {
    void onSelect(run);
  }, [onSelect, run]);
  return (
    <Pressable
      onPress={handlePress}
      style={[styles.listCard, selected && styles.selectedCard]}
      testID={`workflow-run-${run.id}`}
    >
      <View style={styles.cardTitleRow}>
        <Text style={styles.cardTitle}>{run.workflowName}</Text>
        <StatusBadge label={run.status} variant={runBadgeVariant(run.status)} />
      </View>
      <Text style={styles.metaText}>{run.id}</Text>
      <Text style={styles.cardDescription}>
        {`${run.iteration} turns · ${run.activeTurns} active · ${run.workspaceIds.length} workspaces`}
      </Text>
    </Pressable>
  );
}

function LaunchForm({
  spec,
  validation,
  form,
  context,
  onChange,
  onLaunch,
  pending,
}: {
  spec: WorkflowSpecSummary;
  validation: WorkflowValidationResult;
  form: WorkflowLaunchForm;
  context: { workspaceId?: string; agentId?: string };
  onChange: (name: string, value: string) => void;
  onLaunch: () => void;
  pending: boolean;
}): ReactElement {
  return (
    <View style={styles.card} testID="workflow-launch-form">
      <Text style={styles.sectionTitle}>{`Launch ${spec.name}`}</Text>
      {validation.parameters.map((parameter) => (
        <WorkflowParameterField
          key={parameter.name}
          parameter={parameter}
          value={form.values[parameter.name] ?? ""}
          error={form.errors[parameter.name]}
          context={context}
          onChange={onChange}
          pending={pending}
        />
      ))}
      <Button
        leftIcon={Play}
        onPress={onLaunch}
        loading={pending}
        disabled={pending || !validation.valid}
        testID="workflow-launch-submit"
      >
        Launch workflow
      </Button>
    </View>
  );
}

function WorkflowParameterField({
  parameter,
  value,
  error,
  context,
  onChange,
  pending,
}: {
  parameter: WorkflowValidationResult["parameters"][number];
  value: string;
  error: string | undefined;
  context: { workspaceId?: string; agentId?: string };
  onChange: (name: string, value: string) => void;
  pending: boolean;
}): ReactElement {
  const handleChange = useCallback(
    (nextValue: string) => onChange(parameter.name, nextValue),
    [onChange, parameter.name],
  );
  const hint = parameter.defaultFrom
    ? `${parameter.description} Uses ${parameter.defaultFrom} when left blank.`
    : parameter.description;
  return (
    <Field
      label={parameter.name}
      hint={hint}
      error={error}
      testID={`workflow-param-${parameter.name}`}
    >
      <FormTextInput
        value={value}
        onChangeText={handleChange}
        placeholder={parameterPlaceholder(parameter, context)}
        editable={!pending}
      />
    </Field>
  );
}

function RunDetails({
  serverId,
  details,
  onStop,
  onResume,
  pending,
}: {
  serverId: string;
  details: WorkflowRunDetails;
  onStop: () => void;
  onResume: () => void;
  pending: boolean;
}): ReactElement {
  const run = details.run;
  return (
    <View style={styles.detailCard} testID="workflow-run-details">
      <View style={styles.cardTitleRow}>
        <View>
          <Text style={styles.sectionTitle}>{run.workflowName}</Text>
          <Text style={styles.metaText}>{run.id}</Text>
        </View>
        <StatusBadge label={run.status} variant={runBadgeVariant(run.status)} />
      </View>
      <View style={styles.actionRow}>
        {ACTIVE_STATUSES.has(run.status) ? (
          <Button
            variant="destructive"
            size="sm"
            leftIcon={Square}
            onPress={onStop}
            disabled={pending || run.status === "stopping"}
            testID="workflow-run-stop"
          >
            Stop
          </Button>
        ) : null}
        {(run.status === "stopped" || run.status === "failed") && run.resumable ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={RotateCcw}
            onPress={onResume}
            disabled={pending}
            testID="workflow-run-resume"
          >
            Resume
          </Button>
        ) : null}
      </View>
      <AuditLinks label="Workspaces" ids={run.workspaceIds} serverId={serverId} kind="workspace" />
      <AuditLinks label="Agents" ids={run.agentIds} serverId={serverId} kind="agent" />
      <AuditSection title={`Events (${details.events.length})`}>
        {details.events.slice(-30).map((event) => (
          <View key={event.seq} style={styles.auditRow}>
            <Text style={styles.auditSeq}>{String(event.seq)}</Text>
            <View style={styles.auditBody}>
              <Text style={styles.auditTitle}>
                {event.event ? `${event.type}: ${event.event}` : event.type}
              </Text>
              {event.message ? <Text style={styles.auditText}>{event.message}</Text> : null}
              <Text style={styles.metaText}>{event.timestamp}</Text>
            </View>
          </View>
        ))}
      </AuditSection>
      <AuditSection title={`Rendered prompts (${details.prompts.length})`}>
        {details.prompts.map((prompt) => (
          <View key={prompt.name} style={styles.promptCard}>
            <Text style={styles.auditTitle}>{prompt.name}</Text>
            <Text style={styles.promptText} numberOfLines={12}>
              {prompt.content}
            </Text>
          </View>
        ))}
      </AuditSection>
      <AuditSection title="Persisted state">
        <Text style={styles.codeText}>{JSON.stringify(details.state, null, 2)}</Text>
      </AuditSection>
    </View>
  );
}

function AuditLinks({
  label,
  ids,
  serverId,
  kind,
}: {
  label: string;
  ids: string[];
  serverId: string;
  kind: "workspace" | "agent";
}): ReactElement | null {
  if (ids.length === 0) return null;
  return (
    <View style={styles.auditSection}>
      <Text style={styles.auditHeading}>{label}</Text>
      <View style={styles.linkWrap}>
        {ids.map((id) => (
          <AuditLinkButton key={id} serverId={serverId} id={id} kind={kind} />
        ))}
      </View>
    </View>
  );
}

function AuditLinkButton({
  serverId,
  id,
  kind,
}: {
  serverId: string;
  id: string;
  kind: "workspace" | "agent";
}): ReactElement {
  const handlePress = useCallback(() => {
    router.push(
      kind === "workspace"
        ? buildHostWorkspaceRoute(serverId, id)
        : buildHostAgentDetailRoute(serverId, id),
    );
  }, [id, kind, serverId]);
  return (
    <Button variant="ghost" size="xs" onPress={handlePress}>
      {id}
    </Button>
  );
}

function AuditSection({
  title,
  children,
}: {
  title: string;
  children: ReactElement | ReactElement[];
}): ReactElement {
  return (
    <View style={styles.auditSection}>
      <Text style={styles.auditHeading}>{title}</Text>
      <View style={styles.auditList}>{children}</View>
    </View>
  );
}

function SectionHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactElement;
}): ReactElement {
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionHeadingText}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.cardDescription}>{subtitle}</Text>
      </View>
      {children}
    </View>
  );
}

function CenteredMessage({ message }: { message: string }): ReactElement {
  return (
    <View style={styles.centered}>
      <Text style={styles.cardDescription}>{message}</Text>
    </View>
  );
}

function bindingPreview(
  binding: "current.workspace" | "current.worktree" | "current.agent",
  context: { workspaceId?: string; agentId?: string },
): string {
  if (binding === "current.agent") return context.agentId ?? "No current agent";
  if (binding === "current.workspace") return context.workspaceId ?? "No current workspace";
  return context.workspaceId ? "Current workspace worktree" : "No current worktree";
}

function parameterPlaceholder(
  parameter: WorkflowValidationResult["parameters"][number],
  context: { workspaceId?: string; agentId?: string },
): string {
  if (parameter.defaultFrom) return bindingPreview(parameter.defaultFrom, context);
  if (parameter.type === "object" || parameter.type === "array") {
    return `JSON ${parameter.type}`;
  }
  return parameter.type;
}

function workflowContextLabel(context: { workspaceId?: string; agentId?: string }): string {
  if (context.agentId) return `Current agent: ${context.agentId}`;
  if (context.workspaceId) return `Current workspace: ${context.workspaceId}`;
  return "No current.* context";
}

function actionAlertVariant(action: ActionStatus): AlertVariant {
  if (action.kind === "error") return "error";
  if (action.kind === "success") return "success";
  return "info";
}

function actionAlertTitle(action: ActionStatus): string {
  if (action.kind === "error") return "Action failed";
  if (action.kind === "success") return "Done";
  return "Working";
}

function runBadgeVariant(status: WorkflowRunSummary["status"]): "success" | "error" | "muted" {
  if (status === "complete") return "success";
  if (status === "failed") return "error";
  return "muted";
}

function parseEditor(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Workflow JSON must contain one object.");
  }
  return parsed as Record<string, unknown>;
}

function firstParam(value: string | string[] | undefined): string | null {
  const resolved = Array.isArray(value) ? value[0] : value;
  return resolved?.trim() || null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    minHeight: 0,
  },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
  },
  contextText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  alertWrap: {
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[4],
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    padding: theme.spacing[6],
  },
  grid: {
    width: "100%",
    maxWidth: 1400,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  column: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[4],
  },
  sectionHeader: {
    minHeight: 48,
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  sectionHeadingText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  sectionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  list: {
    gap: theme.spacing[2],
  },
  listCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface1,
  },
  selectedCard: {
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface2,
  },
  card: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  detailCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[4],
    backgroundColor: theme.colors.surface1,
  },
  emptyCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[6],
    alignItems: "center",
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  cardTitleRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  cardTitle: {
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  cardDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
  },
  metaText: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
  },
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  jsonEditor: {
    minHeight: 220,
    fontFamily: "monospace",
  },
  auditSection: {
    gap: theme.spacing[2],
  },
  auditHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  auditList: {
    gap: theme.spacing[2],
  },
  auditRow: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  auditSeq: {
    width: 32,
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
  },
  auditBody: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[1],
  },
  auditTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
  },
  auditText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 18,
  },
  promptCard: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  promptText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    lineHeight: 18,
  },
  codeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    fontFamily: "monospace",
    lineHeight: 18,
  },
  linkWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
}));
