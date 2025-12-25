# Review Report: New Agent Page (`/agent/new`) Feature Gap Analysis

**Date**: 2025-12-25
**Reviewer**: Agent
**Files Reviewed**:
- `packages/app/src/app/agent/new.tsx` (560 lines) - New agent creation page
- `packages/app/src/components/create-agent-modal.tsx` (~2700 lines) - Old modal with full features
- `packages/app/src/components/home-footer.tsx` - Entry points for agent creation

---

## Executive Summary

The new `/agent/new` page is a **partial implementation** that handles basic agent creation but is missing **critical features** from the old modal. The old modal code is still in the codebase but **unused** (dead code). This review identifies all gaps and provides implementation recommendations.

---

## Current State

### Entry Points
| Button | Action | Status |
|--------|--------|--------|
| "New Agent" | `router.push("/agent/new")` | Uses new page (incomplete) |
| "Import" | `setShowImportModal(true)` | Uses old modal (works) |
| Dead code: `CreateAgentModal` | `showCreateModal` never set to `true` | Unused |

### What Works in New Page
1. **Host selection** - Dropdown with connection states
2. **Provider selection** - `AssistantDropdown` with provider definitions
3. **Mode selection** - `PermissionsDropdown` with mode options
4. **Model selection** - `ModelDropdown` with loading/error states
5. **Working directory** - `WorkingDirectoryDropdown` with suggestions
6. **Agent creation** - Basic `createAgent()` call with config
7. **Navigation** - Redirects to `/agent/[serverId]/[agentId]` on success

---

## Missing Features (Critical)

### 1. Git Options Section
**Location in old modal**: `create-agent-modal.tsx:1936-1993` and `GitOptionsSection` component at line 2398-2565

**Features missing**:
- Base branch selection dropdown (fetches branches from repo)
- "Create new branch" toggle + branch name input with auto-slug
- "Create worktree" toggle + worktree slug input
- Git validation errors display
- Dirty working directory warning
- Non-git directory detection and handling

**Impact**: Users cannot create agents on feature branches or worktrees - a core workflow.

**Implementation Effort**: HIGH (~200 lines of state + UI + validation logic)

---

### 2. Image Attachments
**Location in old modal**: Uses `useImageAttachmentPicker` hook, but the new page **already has this** via `AgentInputArea`!

**Current new page behavior** (`new.tsx:216-218`):
```typescript
if (images && images.length > 0) {
  return;  // Silently returns without creating agent!
}
```

**Fix required**: Remove the early return and include images in the `createAgent()` call:
```typescript
const config: AgentSessionConfig = {
  provider: selectedProvider,
  cwd: trimmedPath,
  images, // Add this
  // ...
};
```

**Impact**: CRITICAL - Users cannot create agents with image attachments.

**Implementation Effort**: LOW (5 lines to fix)

---

### 3. Error Message Display
**Location in old modal**: `errorMessage` state + `setErrorMessage()` calls + display in UI

**Current new page behavior**:
- No `errorMessage` state
- No error display to user
- Errors like "Working directory is required" are not shown

**Fix required**: Add `errorMessage` state and display it in the UI.

**Implementation Effort**: LOW (~20 lines)

---

### 4. Loading State During Creation
**Location in old modal**: `isLoading` state + `setIsLoading(true)` before create + button spinner

**Current new page behavior**:
- No `isLoading` state
- Button doesn't disable during creation
- No spinner/loading indicator

**Fix required**: Add `isLoading` state, disable button, show spinner.

**Implementation Effort**: LOW (~15 lines)

---

### 5. Daemon Availability Error Handling
**Location in old modal**: `daemonAvailabilityError` + display when daemon offline

**Current new page behavior**:
- Checks `selectedServerId` exists before calling `createAgent`
- Does NOT show error when daemon is offline
- Silent failures possible

**Fix required**: Add offline detection and display friendly error message.

**Implementation Effort**: LOW (~20 lines)

---

### 6. Creation Failure Handling
**Location in old modal**: Listens for `agent_create_failed` status and displays `payload.error`

**Current new page behavior** (`new.tsx:269-271`):
```typescript
if (payload.status === "agent_create_failed") {
  pendingRequestIdRef.current = null;
  return;  // Does nothing! User sees no error.
}
```

**Fix required**: Add `setErrorMessage(payload.error)` to show the failure reason.

**Implementation Effort**: LOW (2 lines)

---

### 7. Dictation Support
**Location in old modal**: Full `useDictation` integration with:
- `handleDictationStart/Cancel/Confirm` handlers
- `PromptDictationControls` component
- `DictationStatusNotice` for retry/error toasts
- Audio debug notices

**Current new page behavior**:
- `AgentInputArea` already has dictation support built-in!
- No additional work needed if `AgentInputArea` is correctly configured

**Verification needed**: Check if `AgentInputArea` dictation works for draft agent creation.

**Impact**: Likely already works via `AgentInputArea` - needs testing.

---

### 8. Import Flow
**Location in old modal**: `flow: "create" | "import"` prop, import list, resume logic

**Current state**:
- Import button already uses `ImportAgentModal` (old modal with `flow="import"`)
- This is **intentional separation** - import stays in modal

**No action needed**: Import flow is separate and working.

---

## Dead Code to Remove

After completing the new page, the following can be deleted from `home-footer.tsx`:

```typescript
// Line 25 - unused state
const [showCreateModal, setShowCreateModal] = useState(false);

// Lines 206-209 - unused modal
<CreateAgentModal
  isVisible={showCreateModal}
  onClose={() => setShowCreateModal(false)}
/>
```

Additionally, if `CreateAgentModal` is no longer used anywhere after this:
- Consider removing the `isVisible` wrapper logic
- Or rename to `AgentFlowModal` since it's only used for Import

---

## Implementation Priority

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| P0 | Fix image attachments (remove early return) | 5 lines | CRITICAL |
| P0 | Add creation failure error display | 2 lines | HIGH |
| P0 | Add error message state + display | 20 lines | HIGH |
| P1 | Add loading state + button disable | 15 lines | MEDIUM |
| P1 | Add daemon offline error handling | 20 lines | MEDIUM |
| P2 | Git Options Section | ~200 lines | HIGH (workflow) |
| P2 | Verify dictation works | Testing | LOW |

**Recommendation**: Complete P0/P1 items first (~60 lines), then tackle Git Options as a separate task.

---

## Verification Steps

After implementation:
1. **Image test**: Attach image, create agent - should include image in request
2. **Error test**: Enter empty working directory - should show error message
3. **Loading test**: Create agent - button should show spinner, be disabled
4. **Offline test**: Disconnect daemon - should show "host offline" message
5. **Failure test**: Create with invalid path - should show server error
6. **Git test**: Select base branch, create new branch, create worktree

---

## Conclusion

The new `/agent/new` page needs ~60 lines of fixes for critical functionality (P0/P1), plus ~200 lines for Git options (P2). The `AgentInputArea` component already provides dictation and image picker, so those features just need proper wiring.

Dead code cleanup should happen after feature parity is achieved.
