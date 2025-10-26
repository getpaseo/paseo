import { Session } from "./packages/server/src/server/session.js";
import { AgentManager } from "./packages/server/src/server/acp/agent-manager.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "./packages/server/src/server/messages.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

async function testWorktreeE2E() {
  console.log("=== Testing End-to-End Worktree Agent Creation ===");
  console.log("(Simulating frontend -> WebSocket -> Session -> AgentManager flow)\n");

  const testBranchName = "test-e2e-worktree";
  const cwd = process.cwd(); // voice-dev directory
  let capturedMessages: SessionOutboundMessage[] = [];
  let createdAgentId: string | null = null;
  let worktreePath: string | null = null;

  try {
    // Step 1: Set up Session (like the WebSocket handler does)
    console.log("Step 1: Creating Session and AgentManager...");
    const agentManager = new AgentManager();
    await agentManager.initialize();

    const session = new Session(
      "test-client",
      (msg: SessionOutboundMessage) => {
        capturedMessages.push(msg);
        console.log(`  [Session emit] ${msg.type}`);
        
        // Capture agent_created message
        if (msg.type === "agent_created") {
          createdAgentId = msg.payload.agentId;
          worktreePath = msg.payload.cwd;
          console.log(`    Agent ID: ${createdAgentId}`);
          console.log(`    CWD: ${worktreePath}`);
        }
      },
      agentManager
    );
    console.log("✓ Session created\n");

    // Step 2: Send create_agent_request message (like frontend does)
    console.log("Step 2: Sending create_agent_request with worktreeName...");
    const createAgentMessage: SessionInboundMessage = {
      type: "create_agent_request",
      cwd: cwd,
      worktreeName: testBranchName,
      requestId: "test-request-123",
    };

    console.log(`  Message: ${JSON.stringify(createAgentMessage, null, 2)}`);
    
    await session.handleMessage(createAgentMessage);
    
    console.log("✓ Message handled\n");

    // Step 3: Verify agent_created message was emitted
    console.log("Step 3: Verifying agent_created message...");
    const agentCreatedMsg = capturedMessages.find(m => m.type === "agent_created");
    
    if (!agentCreatedMsg) {
      throw new Error("No agent_created message emitted!");
    }

    if (agentCreatedMsg.type !== "agent_created") {
      throw new Error("Wrong message type!");
    }

    console.log(`✓ agent_created message emitted`);
    console.log(`  Agent ID: ${agentCreatedMsg.payload.agentId}`);
    console.log(`  CWD: ${agentCreatedMsg.payload.cwd}`);
    console.log(`  Request ID: ${agentCreatedMsg.payload.requestId}\n`);

    if (!createdAgentId) {
      throw new Error("Agent ID not captured!");
    }

    if (!worktreePath) {
      throw new Error("Worktree path not captured!");
    }

    // Step 4: Verify worktree was actually created
    console.log("Step 4: Verifying worktree exists...");
    const { stdout: worktreeList } = await execAsync("git worktree list");
    
    if (!worktreeList.includes(worktreePath)) {
      console.error("Git worktree list:");
      console.error(worktreeList);
      throw new Error(`Worktree not found in git! Expected: ${worktreePath}`);
    }
    console.log("✓ Worktree exists in git\n");

    // Step 5: Verify the worktree path contains branch name
    console.log("Step 5: Verifying worktree path...");
    if (!worktreePath.includes(testBranchName)) {
      throw new Error(`Worktree path doesn't contain branch name! Path: ${worktreePath}`);
    }
    console.log(`✓ Worktree path correct: ${worktreePath}\n`);

    // Step 6: Verify agent is in the worktree
    console.log("Step 6: Verifying agent CWD...");
    const agentInfo = agentManager.listAgents().find(a => a.id === createdAgentId);
    
    if (!agentInfo) {
      throw new Error("Agent not found in manager!");
    }

    console.log(`  Agent CWD: ${agentInfo.cwd}`);
    console.log(`  Expected:  ${worktreePath}`);

    if (agentInfo.cwd !== worktreePath) {
      throw new Error(`Agent CWD mismatch! Expected ${worktreePath}, got ${agentInfo.cwd}`);
    }
    console.log("✓ Agent CWD matches worktree path\n");

    // Step 7: Test agent can run commands in worktree
    console.log("Step 7: Testing agent execution in worktree...");
    const { didComplete } = await agentManager.sendPrompt(
      createdAgentId,
      "Run 'pwd' and 'git branch --show-current'. Just show me the output.",
      { maxWait: 30000 }
    );

    console.log(`  Prompt completed: ${didComplete}`);

    const updates = agentManager.getAgentUpdates(createdAgentId);
    const messageChunks = updates
      .filter(u => u.notification.type === "session" && 
                   u.notification.notification.update.sessionUpdate === "agent_message_chunk")
      .map(u => {
        const update = u.notification as any;
        return update.notification.update.content?.text || "";
      })
      .join("");

    console.log("\n  Agent response:");
    console.log(messageChunks);

    if (!messageChunks.includes(testBranchName)) {
      throw new Error("Agent response doesn't mention branch name!");
    }
    
    if (!messageChunks.includes(worktreePath)) {
      throw new Error("Agent response doesn't show worktree path!");
    }

    console.log("\n✓ Agent successfully executing in worktree\n");

    // Step 8: Cleanup
    console.log("Step 8: Cleaning up...");
    await agentManager.killAgent(createdAgentId);
    console.log("✓ Agent killed\n");

    console.log("=== END-TO-END TEST PASSED ===");
    console.log("\n✅ The complete workflow works:");
    console.log("   Frontend creates agent with worktreeName");
    console.log("   → Message flows through Session");
    console.log("   → Session creates worktree");
    console.log("   → Agent is created in worktree");
    console.log("   → Agent executes commands in worktree");

    console.log("\n⚠️  Worktree still exists at:");
    console.log(`    ${worktreePath}`);
    console.log("\nCleanup commands:");
    console.log(`    git worktree remove ${worktreePath}`);
    console.log(`    git branch -D ${testBranchName}`);

    process.exit(0);
  } catch (error) {
    console.error("\n❌ END-TO-END TEST FAILED:");
    console.error(error);
    
    console.log("\n⚠️  Manual cleanup may be needed:");
    console.log(`    git worktree remove voice-dev-${testBranchName} 2>/dev/null || true`);
    console.log(`    git branch -D ${testBranchName} 2>/dev/null || true`);
    
    process.exit(1);
  }
}

testWorktreeE2E();
