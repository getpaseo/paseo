import type {
  CommandCenterContribution,
  CommandCenterContributionSnapshot,
  CommandCenterRegistration,
  CommandCenterRegistrationOwner,
} from "./contributions";

export interface CommandCenterRegistry {
  getSnapshot(): CommandCenterContributionSnapshot;
  subscribe(listener: () => void): () => void;
  replace(registration: CommandCenterRegistration): void;
  remove(owner: CommandCenterRegistrationOwner): void;
  runShortcut(shortcutId: string): boolean;
}

interface ActiveRegistration {
  owner: CommandCenterRegistrationOwner;
  contributions: readonly CommandCenterContribution[];
}

interface ShortcutCatalogEntry {
  sourceId: string;
  contribution: CommandCenterContribution;
}

const EMPTY_SNAPSHOT: CommandCenterContributionSnapshot = {
  contributions: [],
  shortcutCatalog: [],
};

function contributionId(sourceId: string, id: string): string {
  return `${sourceId}:${id}`;
}

function compareContributions(
  left: CommandCenterContribution,
  right: CommandCenterContribution,
): number {
  if (left.groupRank !== right.groupRank) return left.groupRank - right.groupRank;
  const groupDelta = left.group.localeCompare(right.group);
  if (groupDelta !== 0) return groupDelta;
  if (left.rank !== right.rank) return left.rank - right.rank;
  return left.id.localeCompare(right.id);
}

function sameContributions(
  left: readonly CommandCenterContribution[],
  right: readonly CommandCenterContribution[],
): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

export function createCommandCenterRegistry(): CommandCenterRegistry {
  const registrations = new Map<string, ActiveRegistration>();
  const shortcutCatalog = new Map<string, ShortcutCatalogEntry>();
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_SNAPSHOT;

  function publish(): void {
    const contributions: CommandCenterContribution[] = [];
    const ids = new Set<string>();

    for (const registration of registrations.values()) {
      for (const contribution of registration.contributions) {
        const id = contributionId(registration.owner.sourceId, contribution.id);
        if (ids.has(id)) {
          throw new Error(`Duplicate Command Center contribution id: ${id}`);
        }
        ids.add(id);
        const registeredContribution = { ...contribution, id };
        contributions.push(registeredContribution);
        if (registeredContribution.shortcutId) {
          shortcutCatalog.set(registeredContribution.shortcutId, {
            sourceId: registration.owner.sourceId,
            contribution: registeredContribution,
          });
        }
      }
    }
    contributions.sort(compareContributions);
    const catalogContributions = [...shortcutCatalog.values()]
      .map((entry) => entry.contribution)
      .sort(compareContributions);

    if (
      sameContributions(snapshot.contributions, contributions) &&
      sameContributions(snapshot.shortcutCatalog, catalogContributions)
    ) {
      return;
    }
    snapshot = { contributions, shortcutCatalog: catalogContributions };
    for (const listener of listeners) listener();
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    replace(registration) {
      const current = registrations.get(registration.owner.sourceId);
      if (
        current?.owner.token === registration.owner.token &&
        sameContributions(current.contributions, registration.contributions)
      ) {
        return;
      }
      const nextShortcutIds = new Set(
        registration.contributions.flatMap((contribution) =>
          contribution.shortcutId ? [contribution.shortcutId] : [],
        ),
      );
      for (const contribution of current?.contributions ?? []) {
        if (!contribution.shortcutId || nextShortcutIds.has(contribution.shortcutId)) continue;
        const catalogEntry = shortcutCatalog.get(contribution.shortcutId);
        if (catalogEntry?.sourceId === registration.owner.sourceId) {
          shortcutCatalog.delete(contribution.shortcutId);
        }
      }
      const ids = new Set<string>();
      for (const contribution of registration.contributions) {
        const id = contributionId(registration.owner.sourceId, contribution.id);
        if (ids.has(id)) throw new Error(`Duplicate Command Center contribution id: ${id}`);
        ids.add(id);
      }
      registrations.set(registration.owner.sourceId, registration);
      publish();
    },
    remove(owner) {
      const current = registrations.get(owner.sourceId);
      if (current?.owner.token !== owner.token) return;
      registrations.delete(owner.sourceId);
      publish();
    },
    runShortcut(shortcutId) {
      const matches = snapshot.contributions.filter(
        (contribution) => contribution.shortcutId === shortcutId,
      );
      if (matches.length !== 1) return false;
      void matches[0].run();
      return true;
    },
  };
}
