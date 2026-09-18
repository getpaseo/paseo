export interface SidebarWorkspaceSection {
  id: string;
  name: string;
  workspaceKeys: string[];
}

function normalizeKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const rawKey of keys) {
    const key = rawKey.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }

  return normalized;
}

export function normalizeWorkspaceSections(
  sections: readonly SidebarWorkspaceSection[],
): SidebarWorkspaceSection[] {
  const seenSectionIds = new Set<string>();
  const placedWorkspaceKeys = new Set<string>();
  const normalized: SidebarWorkspaceSection[] = [];

  for (const section of sections) {
    const id = section.id.trim();
    const name = section.name.trim();
    if (!id || !name || seenSectionIds.has(id)) continue;

    const workspaceKeys = normalizeKeys(section.workspaceKeys).filter((workspaceKey) => {
      if (placedWorkspaceKeys.has(workspaceKey)) return false;
      placedWorkspaceKeys.add(workspaceKey);
      return true;
    });
    seenSectionIds.add(id);
    normalized.push({ id, name, workspaceKeys });
  }

  return normalized;
}

export function renameWorkspaceSection(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
  name: string,
): SidebarWorkspaceSection[] {
  return sections.map((section) => (section.id === sectionId ? { ...section, name } : section));
}

export function reorderWorkspaceSections(
  sections: SidebarWorkspaceSection[],
  sectionIds: readonly string[],
): SidebarWorkspaceSection[] {
  const byId = new Map(sections.map((section) => [section.id, section]));
  const reordered = sectionIds.flatMap((id) => {
    const section = byId.get(id);
    return section ? [section] : [];
  });
  const reorderedIds = new Set(reordered.map((section) => section.id));
  return [...reordered, ...sections.filter((section) => !reorderedIds.has(section.id))];
}

export function reorderSectionWorkspaceKeys(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
  workspaceKeys: readonly string[],
): SidebarWorkspaceSection[] {
  return sections.map((section) => {
    if (section.id !== sectionId) return section;
    const currentKeys = new Set(section.workspaceKeys);
    const orderedKeys = workspaceKeys.filter((key) => currentKeys.has(key));
    const orderedKeySet = new Set(orderedKeys);
    return {
      ...section,
      workspaceKeys: [
        ...orderedKeys,
        ...section.workspaceKeys.filter((key) => !orderedKeySet.has(key)),
      ],
    };
  });
}

export function removeWorkspaceSection(
  sections: SidebarWorkspaceSection[],
  sectionId: string,
): SidebarWorkspaceSection[] {
  return sections.filter((section) => section.id !== sectionId);
}

export function moveWorkspaceToSection(
  sections: SidebarWorkspaceSection[],
  workspaceKey: string,
  sectionId: string | null,
): SidebarWorkspaceSection[] {
  return moveWorkspacesToSection(sections, [workspaceKey], sectionId);
}

export function moveWorkspacesToSection(
  sections: SidebarWorkspaceSection[],
  workspaceKeys: readonly string[],
  sectionId: string | null,
): SidebarWorkspaceSection[] {
  const targetExists = sectionId === null || sections.some((section) => section.id === sectionId);
  if (!targetExists) return sections;
  const movedKeys = new Set(workspaceKeys);
  return sections.map((section) => {
    const remainingKeys = section.workspaceKeys.filter((key) => !movedKeys.has(key));
    if (section.id !== sectionId) return { ...section, workspaceKeys: remainingKeys };
    return { ...section, workspaceKeys: [...remainingKeys, ...workspaceKeys] };
  });
}
