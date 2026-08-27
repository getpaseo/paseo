import React, { useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { CircleCheck, ExternalLink } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import type { CheckoutPipelineJob, CheckoutPipelineStage } from "@getpaseo/protocol/messages";
import { GitLabIcon } from "@/components/icons/gitlab-icon";
import {
  definePaneContribution,
  type ClientForgeViewModule,
  type PaneChecksSlotContext,
} from "@/git/client-forge-module";
import { openExternalUrl } from "@/utils/open-external-url";
import { formatDuration } from "@/utils/time";
import { COUNTED_CHECK_PRESENTATIONS } from "@/git/check-presentation";
import { CheckPresentationIcon } from "@/git/check-presentation.view";
import {
  CheckPresentationSummaryPill,
  Section,
  foregroundMutedColorMapping,
  sectionKitStyles,
  successColorMapping,
} from "@/git/pull-request-panel/section-kit";
import { useGitLabPipeline } from "@/git/pull-request-panel/use-pipeline";
import {
  classifyGitlabPipelineJob,
  deriveGitlabApprovals,
  deriveGitlabPipelineSummary,
  countGitlabPipelineJobs,
  GitlabMergeFactsSchema,
  isPipelineActiveStatus,
  type GitlabApprovals,
  type GitlabMergeFacts,
  type GitlabPipelineSummary,
} from "./gitlab";

function renderGitlabHeaderMeta(facts: GitlabMergeFacts): ReactNode {
  const approvals = deriveGitlabApprovals(facts);
  if (!approvals) {
    return null;
  }
  return <GitlabApprovalsBadge approvals={approvals} />;
}

function renderGitlabChecksSection(facts: GitlabMergeFacts, ctx: PaneChecksSlotContext): ReactNode {
  if (!ctx.enabled) {
    return null;
  }
  const summary = deriveGitlabPipelineSummary(facts);
  if (!summary) {
    return null;
  }
  return (
    <GitLabPipelineSection
      serverId={ctx.serverId}
      cwd={ctx.cwd}
      changeRequestNumber={ctx.changeRequestNumber}
      summary={summary}
      open={ctx.open}
      onToggle={ctx.onToggle}
      canFetchCheckDetails={ctx.canFetchCheckDetails}
    />
  );
}

const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedExternalLink = withUnistyles(ExternalLink);

function GitlabApprovalsBadge({ approvals }: { approvals: GitlabApprovals }) {
  const { t } = useTranslation();
  return (
    <View style={styles.approvalsBadge} testID="pr-pane-approvals">
      <ThemedCircleCheck
        size={11}
        uniProps={
          approvals.given >= approvals.required ? successColorMapping : foregroundMutedColorMapping
        }
      />
      <Text style={styles.approvalsText}>
        {t("workspace.git.pr.approvals", { given: approvals.given, required: approvals.required })}
      </Text>
    </View>
  );
}

function rowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [sectionKitStyles.checkRow, Boolean(hovered) && styles.hoverable];
}

function jobRowPressableStyle({ hovered }: { hovered?: boolean }) {
  return [styles.pipelineJobRow, Boolean(hovered) && styles.hoverable];
}

function formatPipelineDuration(seconds: number | null): string {
  if (seconds === null || seconds <= 0) {
    return "";
  }
  return formatDuration(seconds * 1000);
}

function GitLabPipelineSection({
  serverId,
  cwd,
  changeRequestNumber,
  summary,
  open,
  onToggle,
  canFetchCheckDetails,
}: {
  serverId: string;
  cwd: string;
  changeRequestNumber: number;
  summary: GitlabPipelineSummary;
  open: boolean;
  onToggle: () => void;
  canFetchCheckDetails: boolean;
}) {
  const { t } = useTranslation();
  const { pipeline, isLoading, isPlaceholderData, error } = useGitLabPipeline({
    serverId,
    cwd,
    pipelineId: summary.id,
    changeRequestNumber,
    enabled: open && canFetchCheckDetails,
    live: isPipelineActiveStatus(summary.rawStatus),
  });

  const counts = useMemo(
    () => countGitlabPipelineJobs((pipeline?.stages ?? []).flatMap((stage) => stage.jobs)),
    [pipeline],
  );

  const totalCounted = Object.values(counts).reduce((total, count) => total + count, 0);
  const showBreakdown = !isPlaceholderData && totalCounted > 0;
  const displayCounts = showBreakdown ? counts : countGitlabPipelineJobs([]);

  const handleOpenPipeline = useCallback(() => {
    if (summary.url) {
      void openExternalUrl(summary.url);
    }
  }, [summary.url]);

  const sectionSummary = (
    <>
      {COUNTED_CHECK_PRESENTATIONS.map((presentation) => (
        <CheckPresentationSummaryPill
          key={presentation}
          count={displayCounts[presentation]}
          presentation={presentation}
          testID={`pr-pane-pipeline-${presentation}`}
        />
      ))}
      {showBreakdown ? null : <GitLabPipelineStatusIcon status={summary.rawStatus} />}
    </>
  );

  return (
    <Section
      title={t("workspace.git.pr.sections.pipeline")}
      open={open}
      onToggle={onToggle}
      summary={sectionSummary}
    >
      <Pressable
        onPress={handleOpenPipeline}
        style={rowPressableStyle}
        disabled={!summary.url}
        testID="pr-pane-pipeline-link"
      >
        <GitLabPipelineStatusIcon status={summary.rawStatus} />
        <Text style={sectionKitStyles.checkName} numberOfLines={1}>
          {`Pipeline #${summary.id}`}
        </Text>
        {summary.rawStatus ? (
          <Text style={sectionKitStyles.checkWorkflow} numberOfLines={1}>
            {summary.rawStatus}
          </Text>
        ) : null}
        {summary.url ? (
          <View style={sectionKitStyles.checkTrailing}>
            <ThemedExternalLink size={12} uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
      </Pressable>
      {isLoading ? (
        <Text style={sectionKitStyles.emptyText}>
          {t("workspace.git.pr.empty.loadingPipeline")}
        </Text>
      ) : null}
      {!isLoading && pipeline && pipeline.stages.length === 0 ? (
        <Text style={sectionKitStyles.emptyText}>{t("workspace.git.pr.empty.noJobs")}</Text>
      ) : null}
      {!isLoading && pipeline && pipeline.stages.length > 0
        ? pipeline.stages.map((stage) => <PipelineStageGroup key={stage.name} stage={stage} />)
        : null}
      {!isLoading && !pipeline && error ? (
        <Text style={sectionKitStyles.emptyText}>
          {t("workspace.git.pr.empty.pipelineJobsLoadFailed")}
        </Text>
      ) : null}
    </Section>
  );
}

function PipelineStageGroup({ stage }: { stage: CheckoutPipelineStage }) {
  return (
    <View>
      <View style={styles.pipelineStageHeader}>
        <GitLabPipelineStatusIcon status={stage.status} />
        <Text style={styles.pipelineStageName} numberOfLines={1}>
          {stage.name}
        </Text>
      </View>
      {stage.jobs.map((job) => (
        <PipelineJobRow key={job.id} job={job} />
      ))}
    </View>
  );
}

function PipelineJobRow({ job }: { job: CheckoutPipelineJob }) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (job.url) {
      void openExternalUrl(job.url);
    }
  }, [job.url]);
  const duration = formatPipelineDuration(job.durationSeconds);
  return (
    <Pressable onPress={handlePress} style={jobRowPressableStyle} disabled={!job.url}>
      <GitLabPipelineStatusIcon status={job.status} allowFailure={job.allowFailure} />
      <Text style={sectionKitStyles.checkName} numberOfLines={1}>
        {job.name}
      </Text>
      {job.allowFailure ? (
        <Text style={sectionKitStyles.checkWorkflow} numberOfLines={1}>
          {t("workspace.git.pr.empty.allowedToFail")}
        </Text>
      ) : null}
      <View style={sectionKitStyles.checkTrailing}>
        {duration ? <Text style={sectionKitStyles.checkDuration}>{duration}</Text> : null}
      </View>
    </Pressable>
  );
}

function GitLabPipelineStatusIcon({
  status,
  allowFailure = false,
}: {
  status: string;
  allowFailure?: boolean;
}) {
  const presentation = classifyGitlabPipelineJob({ status, allowFailure });
  return <CheckPresentationIcon presentation={presentation} size={14} />;
}

export const gitlabForgeView = {
  id: "gitlab",
  icon: GitLabIcon,
  brandColor: {
    light: "#FC6D26",
    dark: "#FC6D26",
  },
  paneContributions: [
    definePaneContribution(GitlabMergeFactsSchema, {
      renderHeaderMeta: renderGitlabHeaderMeta,
      renderChecksSection: renderGitlabChecksSection,
    }),
  ],
} satisfies ClientForgeViewModule;

const styles = StyleSheet.create((theme) => ({
  approvalsBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  approvalsText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  hoverable: {
    backgroundColor: theme.colors.surface1,
  },
  pipelineStageHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  pipelineStageName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flexShrink: 1,
  },
  pipelineJobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingLeft: theme.spacing[6],
    minHeight: 32,
  },
}));
