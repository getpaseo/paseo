import { i18n } from "@/i18n/i18next";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { conflictSelectionAvailable, workspaceWorkflowSelection } from "./settings-model";
import type { WorkspaceGitWorkflowConfig } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { materializeAgentProfile, type AgentProfile } from "@/agent-profiles";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";

export type WorkspaceWorkflowAction =
  | "review"
  | "create-pr"
  | "commit-and-push"
  | "repair-checks"
  | "resolve-conflicts";

const DEFAULT_PROMPTS: Record<"review" | "commit-and-push", string> = {
  review: `Tu réalises une revue autonome complète du diff du workspace par rapport à origin/main.
Ton objectif est : détecter, corriger, vérifier puis committer les problèmes confirmés.

## 1. Cadrage

- Capture le diff initial, ses statistiques et la liste exacte des fichiers concernés.
- Préserve toute modification locale extérieure à ce périmètre.
- Lance \`npm run verify:fast\`.
- Ne lis les logs détaillés que pour les commandes en échec.
- Ne transmets aux sous-agents que le diff pertinent, la liste des fichiers et le résumé compact des vérifications.

## 2. Classification

Classe le changement selon son risque réel, pas uniquement son nombre de lignes :

- SIMPLE : changement localisé, sans auth, paiement, migration, sécurité, multi-tenant, brackets, proxy ou natif.
- STRUCTUREL : refactor, duplication importante, nouvelle abstraction, changement transversal ou logique répartie dans plusieurs modules.
- SENSIBLE : auth/session, Stripe, migration, routes tenant-scopées avec clubId, sécurité, brackets, proxy, Capacitor/natif ou données distantes.

## 3. Sous-agents et effort

Les sous-agents travaillent en lecture seule : ils ne modifient rien et ne committent pas.

- SIMPLE : un seul sous-agent économique, modèle \`gpt-5.6-luna\`, effort \`medium\`, pour les bugs de correction et régressions introduits par le diff.
- STANDARD ou STRUCTUREL localisé : un sous-agent \`gpt-5.6-sol\`, effort \`high\`, pour la correction, les cas limites et les tests manquants.
- SENSIBLE ou MAJEUR : au maximum deux sous-agents en parallèle :
  1. \`gpt-6-astra\`, effort \`high\` : sécurité, invariants métier, permissions, multi-tenant et effets de production ;
  2. \`gpt-5.6-sol\`, effort \`high\` : régressions, tests, erreurs et intégration.
- Utilise \`xhigh\` uniquement pour un changement transversal sensible dont le mécanisme ne peut pas être établi avec \`high\`.
- Si un modèle n'est pas disponible, prends le modèle disponible le plus proche.
- Ne lance jamais plusieurs agents avec la même lentille.

## 4. Simplification

La taille seule ne justifie pas une simplification.

- SIMPLE sans duplication manifeste : ne lance aucun simplify.
- STRUCTUREL avec duplication ou complexité réellement introduite : lance une seule passe \`/simplify\`, strictement limitée au diff ou au module concerné, puis lance la code review adaptée.
- MAJEUR et principalement structurel : \`/simplify-loop\` est autorisé uniquement si une première analyse confirme plusieurs problèmes de structure importants. Limite son périmètre au diff ou au module nommé.
- SENSIBLE : ne simplifie pas automatiquement les chemins critiques. Priorise la correction fonctionnelle et la sécurité.

Si \`/simplify-loop\` est exécuté, il lance déjà \`review-loop\`. Ne lance donc aucune seconde code review complète derrière. Contrôle seulement le delta final et les résultats de vérification.

## 5. Validation des findings

Le parent doit vérifier chaque finding avant toute correction :

- rejeter les doublons, spéculations et problèmes préexistants ;
- corriger automatiquement les bugs certains et les simplifications sans changement de comportement ;
- ne pas inventer de décision produit ;
- ne pas élargir le changement au-delà du diff sans nécessité démontrée.

Le parent est le seul à modifier les fichiers.

## 6. Correction et vérification

Après les corrections :

1. relis uniquement le delta produit par la revue ;
2. lance \`npm run verify:fast\` ;
3. lance \`npm run verify:full\` si le changement est structurel, sensible ou majeur ;
4. pour une modification UI, vérifie avec \`agent-browser\` : screenshot, interaction concernée et console ;
5. effectue au maximum une re-revue ciblée du delta corrigé.

Si une vérification échoue à cause des corrections, répare ou retire uniquement la correction responsable. Ne masque jamais une erreur.

## 7. Commit

Committe uniquement si toutes les vérifications requises sont vertes.

- Ajoute explicitement les fichiers du périmètre revu et les corrections associées.
- N'utilise pas \`git add -A\`.
- N'inclus aucune modification locale extérieure au périmètre initial.
- Utilise un message de commit décrivant le changement fonctionnel, pas la review.
- Ne pousse pas, ne merge pas et ne déploie pas.

Si un problème nécessite une décision produit, une migration distante, un secret ou un accès externe indisponible, ne l'invente pas : laisse le workspace non committé et explique précisément le blocage.

## 8. Rapport final

Donne seulement :

- classification retenue ;
- sous-agents et efforts utilisés ;
- problèmes confirmés et corrigés ;
- vérifications exécutées ;
- hash et message du commit ;
- limites restantes éventuelles.`,
  "commit-and-push":
    "Verify the supplied PR is still open and matches this branch. Commit if needed, then push this branch. Do not create a second PR.",
};

function resolveConflictsPrompt(context: {
  cwd: string;
  branch: string | null;
  prUrl?: string | null;
}): string {
  return [
    "Tu résous les conflits de la pull request dans le workspace local.",
    "",
    "## Contexte",
    "",
    `- URL de la PR : ${context.prUrl ?? "inconnue"}`,
    `- Répertoire du workspace : ${context.cwd}`,
    `- Branche courante : ${context.branch ?? "HEAD"}`,
    "",
    "## Procédure",
    "",
    "1. Vérifie sur le forge que la PR est toujours ouverte, qu'elle appartient au dépôt du workspace et que sa branche source correspond à la branche courante. Récupère sa branche cible actuelle depuis la PR. Cette cible prévaut sur la base locale du workspace. Si la PR ou sa branche cible ne peut pas être vérifiée, arrête-toi et explique le blocage.",
    "2. Examine l'état Git et les modifications locales. Préserve tout travail préexistant. Arrête-toi et signale tout obstacle qui empêche une intégration sûre.",
    "3. Récupère la branche cible puis fusionne-la localement dans la branche de la PR. Résous les conflits sans abandonner les changements existants.",
    "4. Lance les vérifications pertinentes. Si elles passent, crée un commit de résolution et pousse la branche de la PR vers son remote.",
    "5. Actualise le statut distant et indique si les conflits sont résolus ou ce qui bloque encore.",
    "",
    "Cette action autorise explicitement la fusion locale de la branche cible dans la branche courante de la PR, le commit de résolution et le push de cette branche vers son remote.",
    "Ne fais aucun force-push, rebase, reset, commit sans résolution, ni fusion distante de la PR. Vérifie que le remote et la branche poussés sont ceux de la PR.",
  ].join("\n");
}
const opening = new Set<string>();

function createPrPrompt(branch: string | null, baseRef: string): string {
  const baseBranch = baseRef.replace(/^refs\/remotes\/origin\//, "").replace(/^origin\//, "");
  return [
    "The user likes the current state of the code.",
    "",
    `The current branch is ${branch ?? "HEAD"}.`,
    `The target branch is ${baseRef}.`,
    "The user requested a PR.",
    "",
    "Follow these steps to create a PR:",
    "",
    "- If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.",
    "- Run `git status` to check for uncommitted changes. If there are any, review them with `git diff` and commit them. Follow any instructions the user gave you about writing commit messages.",
    "- If the branch has no upstream or has unpushed commits, push with `git push -u origin HEAD`. If the branch tracks a remote branch with a different name or on a different remote, push to that upstream instead.",
    `- Use \`git diff ${baseRef}...\` to review the PR diff`,
    `- Use \`gh pr create --base ${baseBranch}\` to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences, unless the user instructed you otherwise. Describe not just changes made in this session but ALL changes in the workspace diff.`,
    "",
    "If any of these steps fail, ask the user for help.",
    "",
    "## PR Description Template",
    "",
    "This workspace has a PR template, which is provided below. Use it for writing the PR description, filling it in based on the changes made.",
    "",
    "```markdown",
    "<!--",
    "Please follow this template. The PR template applies whether you opened the PR via the web UI, `gh pr create`, or any other tool.",
    "",
    "You MUST read CONTRIBUTING.md before sending a PR.",
    "-->",
    "",
    "### Linked issue",
    "",
    "Closes #",
    "",
    "### Type of change",
    "",
    "- [ ] Bug fix",
    "- [ ] New feature",
    "- [ ] Enhancement",
    "- [ ] Refactor",
    "- [ ] Docs",
    "",
    "### Reasoning",
    "",
    "<!-- A short description of the reasoning of this change in your own words. What was wrong, and how do you hope this PR fixes it. If you can't explain this briefly, the PR is probably too big. This description must be grounded in real user flows and framed as value provided to Paseo users. -->",
    "",
    "### Goals",
    "",
    "<!-- A bullet list of what this PR wants to accomplish, include requirements and acceptance criteria. This helps lock down the scope of the PR and prevent expanding scope over the intended goal. -->",
    "",
    "### Non-goals",
    "",
    "<!-- A bullet list of what this PR does not want to accomplish. Add any intentional trade offs taken. This helps lock down the scope of the PR and prevent expanding scope over the intended goal. -->",
    "",
    "### QA",
    "",
    "<!--",
    "This is the section I read most carefully. I need to see that *you* tested this, not that the diff looks plausible.",
    "",
    "- For UI changes: a screenshot or short video on every affected platform (mobile, web, desktop). UI claims without visual proof are not enough.",
    "- For behavior changes: the actual steps you ran, and what you observed.",
    "- For bug fixes: how you reproduced the bug before, and confirmed it's fixed after.",
    "-->",
    "",
    "### Checklist",
    "",
    "- [ ] Plugin changes follow the [SDK import boundaries](../docs/plugins.md#sdk-import-boundaries) (if applicable)",
    "- [ ] One focused change",
    "- [ ] `npm run typecheck` passes",
    "- [ ] `npm run lint` passes",
    "- [ ] `npm run format` passes",
    "- [ ] QA evidence",
    "- [ ] Tests added or updated where it made sense",
    "",
    "```",
    "",
    "IMPORTANT: The following are the user's custom preferences. These preferences take precedence over any default guidelines or instructions provided above. When there is a conflict, always follow the user's preferences.",
    "## User Preferences",
    "<user-preferences>",
    `Create the pull request against \`${baseBranch}\`, the workspace's configured base branch. Do not ask for extra confirmation solely because the target is \`main\`.`,
    "",
    "</user-preferences>",
  ].join("\n");
}

function repairChecksPrompt(context: {
  cwd: string;
  branch: string | null;
  baseRef: string;
  prUrl?: string | null;
}): string {
  return [
    "Tu réalises la réparation locale des contrôles échoués de la pull request de ce workspace.",
    "Ton objectif est de corriger la cause des échecs puis de vérifier localement. Aucune livraison distante n'est attendue.",
    "",
    "## Contexte",
    "",
    `- URL de la PR : ${context.prUrl ?? "inconnue"}`,
    `- Répertoire du workspace : ${context.cwd}`,
    `- Branche courante : ${context.branch ?? "HEAD"}`,
    `- Branche de base : ${context.baseRef}`,
    "",
    "## 1. Cadrage",
    "",
    "- Vérifie que la PR est toujours ouverte et qu'elle correspond bien à ce dépôt et à la branche courante.",
    "- Si la PR est fermée, fusionnée, ou ne correspond pas à la branche courante, arrête-toi et explique-le.",
    "- Préserve toute modification locale préexistante hors du périmètre des échecs.",
    "",
    "## 2. Diagnostic",
    "",
    "- Lis les contrôles et les logs accessibles depuis la PR.",
    "- Identifie la cause réelle des échecs avant de modifier quoi que ce soit.",
    "- Si un log est inaccessible ou si un blocage dépend d'une configuration externe, signale-le précisément sans inventer de diagnostic.",
    "",
    "## 3. Correction et validation locale",
    "",
    "- Corrige le minimum nécessaire pour traiter la cause identifiée.",
    "- Lance les validations locales pertinentes et corrige les régressions que tu introduis.",
    "- Distingue clairement la validation locale de la CI distante, qui restera inchangée jusqu'au prochain push.",
    "",
    "## 4. Interdictions",
    "",
    "- Ne fais aucun commit, push, merge, changement de branche, modification distante ou déploiement.",
    "- Ne pousse rien : la CI distante ne sera pas relancée par cette session.",
    "",
    "## 5. Rapport final",
    "",
    "- cause identifiée ;",
    "- corrections appliquées ;",
    "- validations locales exécutées ;",
    "- logs inaccessibles ou blocages externes ;",
    "- état de la CI distante, inchangée.",
  ].join("\n");
}

function actionPrompt(
  action: WorkspaceWorkflowAction,
  config: WorkspaceGitWorkflowConfig,
  context: { cwd: string; branch: string | null; baseRef: string; prUrl?: string | null },
): string {
  if (action === "resolve-conflicts") return resolveConflictsPrompt(context);
  if (action === "repair-checks") return repairChecksPrompt(context);
  let configured: string | undefined;
  if (action === "review") configured = config.reviewPrompt;
  else if (action === "create-pr") configured = config.createPrPrompt;
  else configured = config.commitAndPushPrompt;
  if (configured?.trim()) return configured;
  if (action === "create-pr") return createPrPrompt(context.branch, context.baseRef);
  if (action === "review") return DEFAULT_PROMPTS.review.replace("origin/main", context.baseRef);
  return DEFAULT_PROMPTS[action];
}

function assertRepairChecksContext(input: {
  action: WorkspaceWorkflowAction;
  prUrl?: string | null;
  branch: string | null;
}): void {
  if (input.action === "repair-checks" && (!input.prUrl || !input.branch)) {
    throw new Error("Repairing checks needs an open pull request and a branch.");
  }
}

interface WorkflowProfile {
  launchProfileId?: string;
  provider: string;
  modelId: string;
  modeId: string;
  thinkingOptionId: string;
  featureValues: Record<string, unknown>;
}

async function resolveWorkflowFeatureValues(input: {
  action: WorkspaceWorkflowAction;
  client: Pick<DaemonClient, "listProviderFeatures"> | null;
  cwd: string;
  profile: WorkflowProfile;
}): Promise<Record<string, unknown>> {
  const { action, client, cwd, profile } = input;
  if (action === "review") return profile.featureValues;
  if (!client) throw new Error("The host is disconnected.");

  const payload = await client.listProviderFeatures({
    provider: profile.provider,
    cwd,
    ...(profile.modeId ? { modeId: profile.modeId } : {}),
    ...(profile.modelId ? { model: profile.modelId } : {}),
    ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
    featureValues: profile.featureValues,
  });
  if (payload.error) throw new Error(payload.error);

  const speed = payload.features?.find(
    (feature) => feature.type === "select" && feature.id === "service_tier",
  );
  if (speed?.type === "select") {
    const fast = speed.options.find((option) => option.label === "Fast");
    if (fast) return { ...profile.featureValues, [speed.id]: fast.id };
  }
  const fastMode = payload.features?.find(
    (feature) => feature.type === "toggle" && feature.id === "fast_mode",
  );
  return fastMode ? { ...profile.featureValues, [fastMode.id]: true } : profile.featureValues;
}

interface LaunchWorkspaceWorkflowInput {
  action: WorkspaceWorkflowAction;
  client: Pick<DaemonClient, "listProviderFeatures"> | null;
  serverId: string;
  workspaceId: string;
  cwd: string;
  baseRef: string;
  branch: string | null;
  prUrl?: string | null;
  profile?: AgentProfile;
  config: WorkspaceGitWorkflowConfig;
  providerEntries?: ProviderSnapshotEntry[];
}

export async function launchWorkspaceWorkflowAction(
  input: LaunchWorkspaceWorkflowInput,
): Promise<{ draftId: string; clientMessageId: string }> {
  assertRepairChecksContext(input);
  const launchKey = `${input.serverId}:${input.workspaceId}:${input.action}`;
  if (opening.has(launchKey)) {
    throw new Error("This workspace action is already opening.");
  }
  const profile = resolveWorkflowProfile(input);
  opening.add(launchKey);
  try {
    const featureValues = await resolveWorkflowFeatureValues({
      action: input.action,
      client: input.client,
      cwd: input.cwd,
      profile,
    });
    const draftId = generateDraftId();
    const clientMessageId = `workspace-draft:${input.serverId}:${input.workspaceId}:${draftId}:prompt`;
    const prompt = [
      actionPrompt(input.action, input.config, input),
      "",
      `Requested action: ${input.action}`,
      `Workspace directory: ${input.cwd}`,
      `Current branch base: ${input.baseRef}`,
      ...(input.prUrl ? [`Existing PR: ${input.prUrl}`] : []),
      ...(input.action === "review" || input.action === "resolve-conflicts"
        ? []
        : [
            "Preserve work outside scope. Do not force-push, reset, rebase, pull, merge, archive, or deploy silently. If the situation changed, stop and explain it.",
          ]),
    ].join("\n");
    const timestamp = Date.now();
    const routing = input.action === "resolve-conflicts" ? { modelRouting: "manual" as const } : {};
    const setup = {
      ...routing,
      ...(profile.launchProfileId ? { launchProfileId: profile.launchProfileId } : {}),
      provider: profile.provider,
      cwd: input.cwd,
      modeId: profile.modeId || null,
      model: profile.modelId || null,
      thinkingOptionId: profile.thinkingOptionId || null,
      featureValues,
    };
    useCreateFlowStore.getState().setPending({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      draftId,
      agentId: null,
      clientMessageId,
      text: prompt,
      timestamp,
    });
    useWorkspaceDraftSubmissionStore.getState().setPending({
      ...routing,
      ...(profile.launchProfileId ? { launchProfileId: profile.launchProfileId } : {}),
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      draftId,
      text: prompt,
      attachments: [],
      cwd: input.cwd,
      provider: profile.provider,
      clientMessageId,
      timestamp,
      ...(profile.modeId ? { modeId: profile.modeId } : {}),
      ...(profile.modelId ? { model: profile.modelId } : {}),
      ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}),
      featureValues,
    });
    navigateToWorkspace({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      target: { kind: "draft", draftId, setup },
      pin: true,
    });
    return { draftId, clientMessageId };
  } finally {
    opening.delete(launchKey);
  }
}

function resolveWorkflowProfile(input: LaunchWorkspaceWorkflowInput) {
  const manual = workspaceWorkflowSelection(input.action, input.config);
  if (
    input.action === "resolve-conflicts" &&
    manual &&
    !conflictSelectionAvailable(manual, input.providerEntries)
  ) {
    throw new Error(i18n.t("workspace.git.workflow.replaceConflictModel"));
  }
  const legacyProfile =
    input.action !== "resolve-conflicts" && input.profile
      ? materializeAgentProfile(input.profile)
      : null;
  const profile = manual
    ? {
        provider: manual.provider,
        modelId: manual.model ?? "",
        thinkingOptionId: manual.thinkingOptionId ?? "",
        modeId: "",
        featureValues: {},
        launchProfileId: undefined,
      }
    : legacyProfile;
  if (!profile) throw new Error("Select a model for this workspace action in settings.");
  if (!profile.provider.trim()) {
    throw new Error("The selected agent profile has no provider.");
  }
  return profile;
}
