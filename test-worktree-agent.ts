import { AgentManager } from "./packages/server/src/server/acp/agent-manager.js";
import { createWorktree } from "./packages/server/src/utils/worktree.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function testWorktreeAgent() {
  console.log("=== Testing Worktree Agent Creation ===\n");

  const testBranchName = "test-worktree-feature";
  const cwd = process.cwd(); // voice-dev directory

  try {
    // Step 1: Test worktree creation directly
    console.log("Step 1: Testing worktree creation utility...");
    console.log(`  Current directory: ${cwd}`);
    console.log(`  Branch name: ${testBranchName}\n`);

    const worktreeConfig = await createWorktree({
      branchName: testBranchName,
      cwd,
    });

    console.log("✓ Worktree created successfully!");
    console.log(`  Branch: ${worktreeConfig.branchName}`);
    console.log(`  Path: ${worktreeConfig.worktreePath}`);
    console.log(`  Repo type: ${worktreeConfig.repoType}`);
    console.log(`  Repo path: ${worktreeConfig.repoPath}\n`);

    // Step 2: Verify worktree exists in git
    console.log("Step 2: Verifying worktree in git...");
    const { stdout: worktreeList } = await execAsync("git worktree list");
    console.log("Git worktree list:");
    console.log(worktreeList);

    if (!worktreeList.includes(worktreeConfig.worktreePath)) {
      throw new Error("Worktree not found in git worktree list!");
    }
    console.log("✓ Worktree verified in git\n");

    // Step 3: Check pwd and git status in worktree
    console.log("Step 3: Checking pwd and git status in worktree...");
    const { stdout: pwd } = await execAsync("pwd", {
      cwd: worktreeConfig.worktreePath,
    });
    console.log(`  pwd: ${pwd.trim()}`);

    const { stdout: gitStatus } = await execAsync("git status", {
      cwd: worktreeConfig.worktreePath,
    });
    console.log("  git status:");
    console.log(gitStatus);

    if (!pwd.trim().includes(testBranchName)) {
      throw new Error(`pwd doesn't include branch name! Got: ${pwd}`);
    }

    if (!gitStatus.includes(testBranchName)) {
      throw new Error(`git status doesn't show branch! Got: ${gitStatus}`);
    }
    console.log("✓ Working directory and git status verified\n");

    // Step 4: Create agent in worktree
    console.log("Step 4: Creating agent in worktree...");
    const agentManager = new AgentManager();
    await agentManager.initialize();

    const agentId = await agentManager.createAgent({
      cwd: worktreeConfig.worktreePath,
    });

    console.log(`✓ Agent created: ${agentId}`);

    // Step 5: Initialize agent and check its cwd
    console.log("\nStep 5: Initializing agent and verifying cwd...");
    const { info } = await agentManager.initializeAgentAndGetHistory(agentId);
    
    console.log(`  Agent cwd: ${info.cwd}`);
    console.log(`  Expected: ${worktreeConfig.worktreePath}`);

    if (info.cwd !== worktreeConfig.worktreePath) {
      throw new Error(
        `Agent cwd mismatch! Expected ${worktreeConfig.worktreePath}, got ${info.cwd}`
      );
    }
    console.log("✓ Agent cwd verified\n");

    // Step 6: Send a prompt to verify it's working in the worktree
    console.log("Step 6: Sending test prompt to agent...");
    await agentManager.sendPrompt(
      agentId,
      "Run pwd and git status to verify you're in a worktree. Reply with the output.",
    );

    let status = agentManager.getAgentStatus(agentId);
    let attempts = 0;
    while (status === "processing" && attempts < 60) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      status = agentManager.getAgentStatus(agentId);
      attempts++;
    }

    console.log(`  Agent status after prompt: ${status}`);

    // Get agent updates to see the response
    const updates = agentManager.getAgentUpdates(agentId);
    const lastFewUpdates = updates.slice(-5);
    console.log("\n  Last few agent updates:");
    lastFewUpdates.forEach((update, i) => {
      console.log(
        `    ${i + 1}. [${update.notification.type}] ${JSON.stringify(update.notification).substring(0, 100)}...`
      );
    });

    // Kill the agent
    console.log("\nStep 7: Cleaning up agent...");
    await agentManager.killAgent(agentId);
    console.log("✓ Agent killed\n");

    console.log("=== ALL TESTS PASSED ===");
    console.log("\n⚠️  IMPORTANT: Worktree still exists at:");
    console.log(`    ${worktreeConfig.worktreePath}`);
    console.log("\nTo clean up manually, run:");
    console.log(`    git worktree remove ${worktreeConfig.worktreePath}`);
    console.log(`    git branch -D ${testBranchName}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ TEST FAILED:");
    console.error(error);
    console.log("\n⚠️  If worktree was created, clean up manually with:");
    console.log(`    git worktree remove voice-dev-${testBranchName} || true`);
    console.log(`    git branch -D ${testBranchName} || true`);
    process.exit(1);
  }
}

testWorktreeAgent();
