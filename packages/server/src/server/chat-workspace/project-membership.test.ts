import path from "node:path";

import type { ProjectCheckoutLitePayload } from "@getpaseo/protocol/messages";
import { expect, test } from "vitest";

import { resolveChatsRoot } from "./scratch-dir.js";
import { classifyChatWorkspaceMembership } from "./project-membership.js";

const PASEO_HOME = path.resolve("/tmp/paseo-home");
const CHAT_DIR_A = "chat-0123456789ab";
const CHAT_DIR_B = "chat-ba9876543210";

function nonGitCheckout(cwd: string): ProjectCheckoutLitePayload {
  return {
    cwd,
    isGit: false,
    currentBranch: null,
    remoteUrl: null,
    worktreeRoot: null,
    isPaseoOwnedWorktree: false,
    mainRepoRoot: null,
  };
}

test("a chat scratch dir classifies into the synthetic Chats project", () => {
  const cwd = path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_A);

  const membership = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd,
    checkout: nonGitCheckout(cwd),
  });

  expect(membership).not.toBeNull();
  expect(membership?.projectName).toBe("Chats");
  expect(membership?.projectKind).toBe("non_git");
  expect(membership?.workspaceKind).toBe("directory");
  expect(membership?.workspaceDisplayName).toBe(CHAT_DIR_A);
  expect(membership?.projectRootPath).toBe(path.resolve(resolveChatsRoot(PASEO_HOME)));
});

test("the projectKey is the resolved chats root, identical for two different chat dirs", () => {
  const first = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd: path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_A),
    checkout: nonGitCheckout(path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_A)),
  });
  const second = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd: path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_B),
    checkout: nonGitCheckout(path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_B)),
  });

  expect(first?.projectKey).toBe(path.resolve(resolveChatsRoot(PASEO_HOME)));
  expect(first?.projectKey).toBe(second?.projectKey);
  expect(first?.workspaceDirectoryKey).not.toBe(second?.workspaceDirectoryKey);
});

test("a sibling directory under paseoHome but outside chats is not a chat workspace", () => {
  const cwd = path.join(PASEO_HOME, "agents", "some-dir");

  const membership = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd,
    checkout: nonGitCheckout(cwd),
  });

  expect(membership).toBeNull();
});

test("the chats root itself is not a chat workspace", () => {
  const cwd = resolveChatsRoot(PASEO_HOME);

  const membership = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd,
    checkout: nonGitCheckout(cwd),
  });

  expect(membership).toBeNull();
});

test("a path nested inside a chat scratch dir is not itself a chat workspace", () => {
  const cwd = path.join(resolveChatsRoot(PASEO_HOME), CHAT_DIR_A, "real-project");

  const membership = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd,
    checkout: nonGitCheckout(cwd),
  });

  expect(membership).toBeNull();
});

test("a direct child of the chats root without the minted chat-<hex> shape is not a chat workspace", () => {
  const cwd = path.join(resolveChatsRoot(PASEO_HOME), "my-project");

  const membership = classifyChatWorkspaceMembership({
    paseoHome: PASEO_HOME,
    cwd,
    checkout: nonGitCheckout(cwd),
  });

  expect(membership).toBeNull();
});
