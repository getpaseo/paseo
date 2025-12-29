# Image Attachment Flow Investigation Report

**Date**: 2025-12-29
**Task**: Test image attachment flow via Playwright MCP

## Summary

Image attachments are **NOT WORKING** for any platform (web, iOS, Android) due to multiple issues in the implementation pipeline.

## Issues Found

### Issue 1: Agent Creation Does Not Support Images (By Design)

**Location**: `packages/app/src/app/agent/new.tsx:576-580`

```typescript
// TODO: Images in initial agent creation are not yet supported by the server API.
// For now we log a warning. Images can be sent after agent creation via sendAgentMessage.
if (images && images.length > 0) {
  console.warn("[DraftAgentScreen] Image attachments on agent creation not yet supported");
}
```

**Impact**: Images selected on the new agent screen are silently dropped when creating an agent.

**Evidence**: Console warning logged during Playwright test when attaching an image and creating an agent.

---

### Issue 2: Web Platform Cannot Base64 Encode Images

**Location**: `packages/app/src/contexts/session-context.tsx:1307-1331`

```typescript
const data = await FileSystem.readAsStringAsync(uri, {
  encoding: "base64",
});
```

**Error**:
```
[ERROR] [Session] Failed to convert image: Error: Method readAsStringAsync imported from "expo-file-system"...
```

**Impact**: On web, `expo-file-system.readAsStringAsync` is not available/deprecated, causing image base64 encoding to fail silently. The message is sent without the image data.

**Evidence**: Console error logged when trying to send an image attachment to an existing agent on web.

---

### Issue 3: Server Does Not Pass Image Bytes to LLM

**Location**: `packages/server/src/server/session.ts:316-334`

```typescript
private buildAgentPrompt(
  text: string,
  images?: Array<{ data: string; mimeType: string }>
): AgentPromptInput {
  const normalized = text?.trim() ?? "";
  if (!images || images.length === 0) {
    return normalized;
  }

  const attachmentSummary = images
    .map((image, index) => {
      const sizeKb = Math.round((image.data.length * 0.75) / 1024);
      return `Attachment ${index + 1}: ${image.mimeType}, ~${sizeKb}KB base64`;
    })
    .join("\n");

  const base = normalized.length > 0 ? normalized : "User shared image attachment(s).";
  return `${base}\n\n[Image attachments]\n${attachmentSummary}\n(Actual image bytes omitted; request a screenshot or file if needed.)`;
}
```

**Impact**: Even if images were successfully uploaded to the server, they are NOT sent to the LLM. Instead, a text summary is created that says "(Actual image bytes omitted)".

**Evidence**: Agent responses consistently state "I don't see any image attached to your message" even when images are selected in the UI.

---

## Test Results

### Test 1: Claude Agent - Image on Creation
- **Action**: Attached red.png, asked "what color is this image?"
- **Result**: FAILED - Image silently dropped, agent asked for image path
- **Console**: `[WARNING] [DraftAgentScreen] Image attachments on agent creation not yet supported`

### Test 2: Claude Agent - Image on Existing Agent (Web)
- **Action**: Attached red.png to existing agent, asked "what color is the attached image?"
- **Result**: FAILED - Base64 encoding failed on web platform
- **Console**: `[ERROR] [Session] Failed to convert image: Error: Method readAsStringAsync imported from "expo-file-system"...`

### Test 3: Codex Agent
- **Not Tested**: Would fail for same reasons as Claude

---

## Image Flow Architecture

```
UI (file picker)
    ↓
Image selected → shown as thumbnail ✅
    ↓
[Agent Creation Path]
    → Warning logged, image dropped ❌

[Existing Agent Path]
    → FileSystem.readAsStringAsync(uri, {encoding: 'base64'})
        → FAILS on web ❌
        → May work on native (not tested)
    ↓
WebSocket → send_agent_message with images array
    ↓
Server → buildAgentPrompt()
    → Creates TEXT SUMMARY only ❌
    → Actual bytes NOT passed to LLM
    ↓
LLM receives: "what color is this image?\n\n[Image attachments]\nAttachment 1: image/png, ~1KB base64\n(Actual image bytes omitted)"
    → Agent cannot see image ❌
```

---

## Required Fixes

### Fix 1: Implement Image Support for Agent Creation
- Extend `create_agent_request` server API to accept images
- Pass images from UI through to the initial prompt

### Fix 2: Fix Web Platform Base64 Encoding
- Replace `expo-file-system.readAsStringAsync` with web-compatible alternative
- Use `FileReader.readAsDataURL()` or similar for web platform
- Or use a cross-platform library that works on all Expo platforms

### Fix 3: Pass Actual Image Bytes to LLM
- Modify `buildAgentPrompt` to return image content blocks, not just text
- Update agent providers (Claude, Codex) to handle multimodal prompts
- For Claude: Use content blocks with `type: "image"` and base64 data
- For Codex: Check if/how OpenAI API handles image inputs

---

## Recommended Task Additions

```markdown
- [ ] **Fix 1**: Add image support to agent creation API
    - Extend `create_agent_request` to accept images array
    - Pass images to `handleSendAgentMessage` after agent creation
    - Remove warning in `new.tsx` once implemented

- [ ] **Fix 2**: Fix web platform image base64 encoding
    - Replace `FileSystem.readAsStringAsync` with cross-platform solution
    - Use blob URL + fetch or FileReader API for web
    - Test on web, iOS, and Android

- [ ] **Fix 3**: Implement multimodal prompt building on server
    - Modify `buildAgentPrompt` to return structured content with images
    - Update `AgentPromptInput` type to support content blocks
    - Implement Claude-specific image content blocks
    - Implement Codex/OpenAI image handling
```
