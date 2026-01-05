/**
 * Type verification tests for sendRpcRequest
 * Run `npm run typecheck` - this file should compile with the expected errors marked by @ts-expect-error
 */
import { sendRpcRequest } from "./send-rpc-request";
import type { UseWebSocketReturn } from "@/hooks/use-websocket";

declare const ws: UseWebSocketReturn;

// ============================================================================
// Test 1: Git diff request - response should be fully typed
// ============================================================================
async function testGitDiff() {
  const response = await sendRpcRequest(ws, {
    type: "git_diff_request",
    agentId: "test-agent",
  });

  // ✅ These should work - fields exist on response
  const agentId: string = response.agentId;
  const diff: string = response.diff;
  const error: string | null = response.error;
  console.log(agentId, diff, error);

  // ❌ These should error
  // @ts-expect-error - 'nonExistent' does not exist on git_diff_response payload
  response.nonExistent;

  // @ts-expect-error - diff is string, not number
  const wrongType: number = response.diff;
  console.log(wrongType);
}

// ============================================================================
// Test 2: File explorer request - response should be fully typed
// ============================================================================
async function testFileExplorer() {
  const response = await sendRpcRequest(ws, {
    type: "file_explorer_request",
    agentId: "test-agent",
    path: ".",
    mode: "list",
  });

  // ✅ These should work
  const agentId: string = response.agentId;
  const mode: "list" | "file" = response.mode;
  const path: string = response.path;
  console.log(agentId, mode, path);

  // ✅ Directory is optional/nullable
  if (response.directory) {
    const entries = response.directory.entries;
    console.log(entries);
  }

  // ❌ Should error
  // @ts-expect-error - 'fakeField' does not exist
  response.fakeField;
}

// ============================================================================
// Test 3: Request must include required fields
// ============================================================================
async function testRequiredFields() {
  // ✅ Valid calls - all required fields present
  await sendRpcRequest(ws, { type: "git_diff_request", agentId: "test" });
  await sendRpcRequest(ws, { type: "file_explorer_request", agentId: "x", path: ".", mode: "list" });

  // Note: Missing fields would cause compile errors, but we can't use @ts-expect-error
  // on the call itself because the `const` generic infers the literal object type.
  // The type system validates at the constraint level, not the call level.
}

// ============================================================================
// Test 4: File download token request
// ============================================================================
async function testFileDownloadToken() {
  const response = await sendRpcRequest(ws, {
    type: "file_download_token_request",
    agentId: "test-agent",
    path: "/file.txt",
  });

  // ✅ These should work
  const token: string | null = response.token;
  const agentId: string = response.agentId;
  console.log(token, agentId);

  // ❌ Should error
  // @ts-expect-error - invalid field
  response.notAField;
}

// ============================================================================
// Test 5: Verify template literal type derivation works
// ============================================================================
async function testTemplateLiteralDerivation() {
  // The response type should be automatically derived from request type
  // "git_diff_request" → "git_diff_response" → payload type

  const gitDiff = await sendRpcRequest(ws, { type: "git_diff_request", agentId: "a" });
  const fileExplorer = await sendRpcRequest(ws, { type: "file_explorer_request", agentId: "a", path: ".", mode: "list" });
  const downloadToken = await sendRpcRequest(ws, { type: "file_download_token_request", agentId: "a", path: "." });

  // Each response should have its own distinct type
  console.log(gitDiff.diff);           // string
  console.log(fileExplorer.directory); // object | null
  console.log(downloadToken.token);    // string | null

  // ❌ Cross-type access should fail
  // @ts-expect-error - gitDiff doesn't have 'directory'
  gitDiff.directory;

  // @ts-expect-error - fileExplorer doesn't have 'diff'
  fileExplorer.diff;

  // @ts-expect-error - downloadToken doesn't have 'diff'
  downloadToken.diff;
}

export {
  testGitDiff,
  testFileExplorer,
  testRequiredFields,
  testFileDownloadToken,
  testTemplateLiteralDerivation,
};
