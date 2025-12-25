# Deep Comparison: New Agent Page vs Old Modal

**Date**: 2025-12-25
**Files Compared**:
- New: `packages/app/src/app/agent/new.tsx` (600 lines)
- Old: `packages/app/src/components/create-agent-modal.tsx` (~2700 lines)
- Reference: `packages/app/src/app/agent/[serverId]/[agentId].tsx` (1152 lines)

## Executive Summary

The new agent page (`/agent/new`) has addressed the critical bugs identified in the previous review. The remaining gaps are mostly **feature parity** issues (Git options) rather than bugs. The input area styling matches the agent screen well.

---

## 1. Loading State ✅ FIXED

**New Page** (`new.tsx:122-123, 228-229, 248-252, 291, 296-300`):
- Has `isLoading` state variable
- Prevents double-submit with `if (isLoading) { return; }`
- Sets `setIsLoading(true)` before creation, `setIsLoading(false)` on completion/failure

**Old Modal** (`create-agent-modal.tsx:456, 1338, 1368, 1554, 1577, 2015-2024`):
- Same pattern with `isLoading` state
- Shows `<ActivityIndicator>` and "Creating..." text when loading
- Disables button when `createDisabled` (includes `isLoading`)

**Gap**: The new page does NOT show a visual loading indicator. The button still says "send" and has no disabled styling.

### Fix Task Required
```
- [ ] **FIX (App)**: New agent page - add visual loading indicator during creation
  - `new.tsx`: Currently has `isLoading` state but no visual feedback
  - Add ActivityIndicator or "Creating..." text like old modal (`create-agent-modal.tsx:2015-2024`)
  - Disable the submit button visually when `isLoading` is true
```

---

## 2. Input Area Styling ✅ MATCHES

**Visual Comparison**: Both screens use the same `AgentInputArea` component.

**New Page** (`new.tsx:468-472`):
```tsx
<AgentInputArea
  agentId={DRAFT_AGENT_ID}
  serverId={selectedServerId ?? ""}
  onSubmitMessage={handleCreateFromInput}
/>
```

**Agent Screen** (`[agentId].tsx:687-688`):
```tsx
<AgentInputArea agentId={resolvedAgentId} serverId={serverId} />
```

**Playwright Verification**: Screenshots show identical input area styling:
- Same gray rounded input box
- Same button layout (attachment, mic, realtime)
- Same spacing and padding

**Result**: No fix needed - styling matches.

---

## 3. Git Options ❌ MISSING (~200 lines)

The old modal has a complete Git configuration section that is entirely absent from the new page.

**Old Modal Features** (`create-agent-modal.tsx:1936-1993`):
1. **Base branch dropdown** - Select which branch to base work on
2. **Create new branch toggle** - Checkbox + branch name input
3. **Create worktree toggle** - Checkbox + worktree slug input
4. **Git validation errors** - Shows blocking errors (`gitBlockingError`)
5. **Dirty directory warnings** - Warns about uncommitted changes
6. **Non-git directory detection** - Disables git options gracefully

**Git State Variables** (`create-agent-modal.tsx:448-454`):
```tsx
const [baseBranch, setBaseBranch] = useState("");
const [createNewBranch, setCreateNewBranch] = useState(false);
const [branchName, setBranchName] = useState("");
const [createWorktree, setCreateWorktree] = useState(false);
const [worktreeSlug, setWorktreeSlug] = useState("");
```

**Git Validation Logic** (`create-agent-modal.tsx:1653-1707`):
- Validates branch name format
- Validates worktree slug format
- Checks for uncommitted changes + checkout intent
- Returns blocking error or null

**New Page**: Has NONE of these. The `createAgent` call only includes:
```tsx
const config: AgentSessionConfig = {
  provider: selectedProvider,
  cwd: trimmedPath,
  ...(modeId ? { modeId } : {}),
  ...(trimmedModel ? { model: trimmedModel } : {}),
};
```

### Fix Task Required
```
- [ ] **FEATURE (App)**: New agent page - add Git Options Section
  - Port `GitOptionsSection` component usage from old modal
  - Add state: baseBranch, createNewBranch, branchName, createWorktree, worktreeSlug
  - Add git repo info request hook (already exists in old modal)
  - Add gitBlockingError validation
  - Pass git options to createAgent call
  - Reference: create-agent-modal.tsx:1936-1993 (UI), 1653-1707 (validation), 1388-1401 (createAgent call)
  - Estimated: ~200 lines of code
```

---

## 4. Error Handling ✅ FIXED

**New Page** (`new.tsx:122, 213-234, 289-292, 461-464`):
- Has `errorMessage` state
- Validates: working directory, prompt, host selection, connection
- Shows creation failure errors from server
- Displays error in styled container

**Comparison to Old Modal**:
| Check | Old Modal | New Page |
|-------|-----------|----------|
| Working dir empty | ✅ | ✅ |
| Prompt empty | ✅ | ✅ |
| No host selected | ✅ | ✅ |
| Host offline | ✅ | ✅ (line 233) |
| Creation failed | ✅ | ✅ (line 289-292) |
| Git validation | ✅ | ❌ (no git options) |

**Result**: Error handling is complete for current features. Git errors will come with Git feature.

---

## 5. Visual Parity ✅ GOOD

**Playwright Screenshots Analysis**:

| Element | New Page | Agent Screen | Match? |
|---------|----------|--------------|--------|
| Header | "New Agent" title + back arrow | Agent title + back arrow + menu | ✅ Similar |
| Config rows | Card style with chevron | N/A (agent screen has no config) | ✅ Appropriate |
| Input area | Gray rounded box | Gray rounded box | ✅ Identical |
| Button row | Attachment, mic, realtime | Same + status bar | ✅ Matches |
| Error display | Red background container | N/A | ✅ Styled |

**Minor Styling Notes**:
- New page config rows use card styling that looks clean
- Input placeholder "Message agent..." is consistent
- Colors match the theme

---

## 6. Dead Code ✅ ALREADY FIXED

Per the previous review task completion, the dead `CreateAgentModal` code in `home-footer.tsx` has been cleaned up:
- `showCreateModal` state (line 25) - REMOVED
- `<CreateAgentModal>` component (lines 206-209) - REMOVED

---

## Summary of Required Fix Tasks

### P1 - Should Fix Soon
```
- [ ] **FIX (App)**: New agent page - add visual loading indicator during creation
  Location: new.tsx
  Issue: Has isLoading state but no visual feedback (button doesn't show loading, no spinner)
  Fix: Add ActivityIndicator when isLoading, change button text to "Creating...", disable button visually
  Effort: ~20 lines
```

### P2 - Feature Parity
```
- [ ] **FEATURE (App)**: New agent page - add Git Options Section
  Location: new.tsx
  Issue: Missing base branch, new branch, worktree options from old modal
  Fix: Port GitOptionsSection and related state/validation from create-agent-modal.tsx
  Effort: ~200 lines
  Reference: create-agent-modal.tsx:1388-1401, 1653-1707, 1936-1993
```

### Already Completed (Previous Task)
- [x] Fix image attachments (early return removed)
- [x] Fix creation failure display (error shown to user)
- [x] Add error/loading states
- [x] Remove dead CreateAgentModal code

---

## Files Reference

| File | Lines | Purpose |
|------|-------|---------|
| `new.tsx` | 600 | New agent page |
| `create-agent-modal.tsx` | 2700 | Old modal (reference for git options) |
| `[agentId].tsx` | 1152 | Agent screen (reference for styling) |
| `agent-input-area.tsx` | 1287 | Shared input component |
| `agent-form-dropdowns.tsx` | - | Shared dropdown components |
