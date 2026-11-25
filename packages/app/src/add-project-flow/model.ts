export interface AddProjectHost {
  serverId: string;
  label: string;
  online: boolean;
  canAddProject: boolean;
  canBrowse: boolean;
  canCloneGithubRepositories: boolean;
  canSearchGithubRepositories: boolean;
  canCreateDirectory: boolean;
}

export interface GithubRepositoryChoice {
  id: string;
  nameWithOwner: string;
  cloneUrl: string;
  cloneProtocol?: "https" | "ssh";
  description: string | null;
  updatedAt: string | null;
}

/** The three ways to add a project, in the order the segmented control and Mod+1/2/3 walk them. */
export const ADD_PROJECT_TABS = ["existing", "clone", "new-folder"] as const;
export type AddProjectTab = (typeof ADD_PROJECT_TABS)[number];

interface ListDraft {
  query: string;
  /**
   * The row the user picked, by id, so it stays picked when a search refresh reorders the rows.
   * `null`, or an id no longer listed, means the first row.
   */
  selectedId: string | null;
}

/** `location: null` means the default parent directory for the current host. */
interface CloneDraft extends ListDraft {
  location: string | null;
}

interface NewFolderDraft {
  name: string;
  location: string | null;
}

export type AddProjectSubmission =
  | { status: "idle" }
  | { status: "submitting"; tab: AddProjectTab }
  | { status: "failed"; tab: AddProjectTab; message: string };

export interface AddProjectFlowState {
  hosts: AddProjectHost[];
  hostId: string | null;
  tab: AddProjectTab;
  existing: ListDraft;
  clone: CloneDraft;
  newFolder: NewFolderDraft;
  submission: AddProjectSubmission;
}

export interface OpenAddProjectFlowInput {
  hosts: AddProjectHost[];
  preferredHostId?: string;
}

const IDLE: AddProjectSubmission = { status: "idle" };

function pickHostId(hosts: AddProjectHost[], preferredHostId?: string | null): string | null {
  const online = hosts.filter((host) => host.online);
  const preferred = preferredHostId
    ? online.find((host) => host.serverId === preferredHostId)
    : undefined;
  return (preferred ?? online[0])?.serverId ?? null;
}

export function openAddProjectFlow(input: OpenAddProjectFlowInput): AddProjectFlowState {
  return {
    hosts: input.hosts,
    hostId: pickHostId(input.hosts, input.preferredHostId),
    tab: "existing",
    existing: { query: "", selectedId: null },
    clone: { query: "", selectedId: null, location: null },
    newFolder: { name: "", location: null },
    submission: IDLE,
  };
}

export function currentAddProjectHost(state: AddProjectFlowState): AddProjectHost | null {
  return state.hosts.find((host) => host.serverId === state.hostId) ?? null;
}

export function isAddProjectSubmitting(state: AddProjectFlowState): boolean {
  return state.submission.status === "submitting";
}

/** The failure to show on the current tab, if the last submission there failed. */
export function addProjectFailure(state: AddProjectFlowState): string | null {
  const { submission } = state;
  return submission.status === "failed" && submission.tab === state.tab ? submission.message : null;
}

/** The hosts the user can switch to: every online host, plus the current one even while offline. */
export function selectableAddProjectHosts(state: AddProjectFlowState): AddProjectHost[] {
  return state.hosts.filter((host) => host.online || host.serverId === state.hostId);
}

/**
 * The chosen host stays chosen while it is offline, with its drafts, so a disconnect never sends
 * them to another host. A host is picked only when none is chosen or the chosen one was removed.
 */
export function applyAvailableAddProjectHosts(
  state: AddProjectFlowState,
  hosts: AddProjectHost[],
): AddProjectFlowState {
  const stillListed = hosts.some((host) => host.serverId === state.hostId);
  if (stillListed) return { ...state, hosts };
  return withHost({ ...state, hosts }, pickHostId(hosts));
}

function withHost(state: AddProjectFlowState, hostId: string | null): AddProjectFlowState {
  return {
    ...state,
    hostId,
    existing: { ...state.existing, selectedId: null },
    clone: { ...state.clone, selectedId: null, location: null },
    newFolder: { ...state.newFolder, location: null },
    submission: IDLE,
  };
}

export function selectAddProjectHost(
  state: AddProjectFlowState,
  hostId: string,
): AddProjectFlowState {
  if (isAddProjectSubmitting(state) || hostId === state.hostId) return state;
  if (!state.hosts.some((host) => host.serverId === hostId && host.online)) return state;
  return withHost(state, hostId);
}

export function selectAddProjectTab(
  state: AddProjectFlowState,
  tab: AddProjectTab,
): AddProjectFlowState {
  if (isAddProjectSubmitting(state) || tab === state.tab) return state;
  return { ...state, tab, submission: IDLE };
}

/** Sets the search text of the current list tab. */
export function setAddProjectQuery(state: AddProjectFlowState, query: string): AddProjectFlowState {
  if (state.tab === "existing") {
    return { ...state, existing: { query, selectedId: null }, submission: IDLE };
  }
  if (state.tab === "clone") {
    return { ...state, clone: { ...state.clone, query, selectedId: null }, submission: IDLE };
  }
  return state;
}

export function setNewFolderName(state: AddProjectFlowState, name: string): AddProjectFlowState {
  return { ...state, newFolder: { ...state.newFolder, name }, submission: IDLE };
}

/** Sets the parent directory of the current tab that creates a folder. */
export function setAddProjectLocation(
  state: AddProjectFlowState,
  location: string,
): AddProjectFlowState {
  if (state.tab === "clone") {
    return { ...state, clone: { ...state.clone, location }, submission: IDLE };
  }
  if (state.tab === "new-folder") {
    return { ...state, newFolder: { ...state.newFolder, location }, submission: IDLE };
  }
  return state;
}

export function selectAddProjectRow(
  state: AddProjectFlowState,
  selectedId: string,
): AddProjectFlowState {
  // The row being added stays put until its submission ends; choosing another clears the
  // failure of the last one.
  if (isAddProjectSubmitting(state)) return state;
  if (state.tab === "existing") {
    return { ...state, existing: { ...state.existing, selectedId }, submission: IDLE };
  }
  if (state.tab === "clone") {
    return { ...state, clone: { ...state.clone, selectedId }, submission: IDLE };
  }
  return state;
}

export function startAddProjectSubmission(state: AddProjectFlowState): AddProjectFlowState {
  if (isAddProjectSubmitting(state)) return state;
  return { ...state, submission: { status: "submitting", tab: state.tab } };
}

export function failAddProjectSubmission(
  state: AddProjectFlowState,
  message: string,
): AddProjectFlowState {
  if (state.submission.status !== "submitting") return state;
  return { ...state, submission: { status: "failed", tab: state.submission.tab, message } };
}

export function moveAddProjectActiveIndex(
  activeIndex: number,
  optionCount: number,
  direction: "next" | "previous",
): number {
  if (optionCount === 0) return 0;
  const delta = direction === "next" ? 1 : -1;
  const next = activeIndex + delta;
  if (next < 0) return optionCount - 1;
  if (next >= optionCount) return 0;
  return next;
}

export interface AddProjectKeyInput {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type AddProjectKeyCommand =
  | { kind: "tab"; tab: AddProjectTab }
  | { kind: "move"; direction: "next" | "previous" }
  | { kind: "submit" };

/** Keys the sheet claims besides Escape. Digits only act with the platform's Mod key. */
export const ADD_PROJECT_KEYS = ["Enter", "ArrowUp", "ArrowDown", "1", "2", "3"] as const;

export function resolveAddProjectKey(
  input: AddProjectKeyInput,
  isMac: boolean,
): AddProjectKeyCommand | null {
  const modOnly =
    (isMac ? input.metaKey && !input.ctrlKey : input.ctrlKey && !input.metaKey) &&
    !input.altKey &&
    !input.shiftKey;
  const plain = !input.metaKey && !input.ctrlKey && !input.altKey && !input.shiftKey;
  const tabIndex = ["1", "2", "3"].indexOf(input.key);
  const tab = ADD_PROJECT_TABS[tabIndex];
  if (tab && modOnly) return { kind: "tab", tab };
  if (!plain) return null;
  if (input.key === "ArrowDown") return { kind: "move", direction: "next" };
  if (input.key === "ArrowUp") return { kind: "move", direction: "previous" };
  if (input.key === "Enter") return { kind: "submit" };
  return null;
}
