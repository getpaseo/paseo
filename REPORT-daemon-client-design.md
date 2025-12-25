# DaemonClient Design Report

## Objective

Design a `DaemonClient` class that enables full E2E testing of the Paseo daemon WITHOUT Playwright. Test the daemon directly via WebSocket, ensure API correctness, and UI correctness follows.

---

## Architectural Approaches

### Approach 1: Simple WebSocket Wrapper (Recommended)

**Description**: A thin, typed wrapper around WebSocket that directly mirrors the daemon's message protocol.

```typescript
// packages/server/src/server/test-utils/daemon-client.ts

import WebSocket from "ws";
import { z } from "zod";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "../messages.js";

export interface DaemonClientConfig {
  url: string; // ws://localhost:6767/ws
  authHeader?: string;
}

export type AgentEventHandler = (event: {
  type: "state" | "stream" | "permission_request" | "permission_resolved";
  agentId: string;
  payload: unknown;
}) => void;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private pendingRequests: Map<string, { resolve: Function; reject: Function }> = new Map();
  private eventHandlers: Set<AgentEventHandler> = new Set();

  constructor(private config: DaemonClientConfig) {}

  // --- Connection ---
  async connect(): Promise<void>;
  async close(): Promise<void>;

  // --- Agent Lifecycle ---
  async createAgent(config: CreateAgentConfig): Promise<AgentSnapshotPayload>;
  async deleteAgent(agentId: string): Promise<void>;
  async listAgents(): Promise<AgentSnapshotPayload[]>;
  async listPersistedAgents(): Promise<PersistedAgentDescriptor[]>;

  // --- Agent Interaction ---
  async sendMessage(agentId: string, text: string, options?: SendMessageOptions): Promise<void>;
  async cancelAgent(agentId: string): Promise<void>;
  async setAgentMode(agentId: string, modeId: string): Promise<void>;

  // --- Permissions ---
  async respondToPermission(agentId: string, requestId: string, response: AgentPermissionResponse): Promise<void>;

  // --- Streaming ---
  waitForAgentIdle(agentId: string, options?: { timeout?: number }): Promise<AgentSnapshotPayload>;
  waitForPermission(agentId: string, options?: { timeout?: number }): Promise<AgentPermissionRequest>;

  // --- Event Subscription ---
  on(handler: AgentEventHandler): () => void;

  // --- Raw Message Access ---
  send(message: SessionInboundMessage): Promise<void>;
  receive(): AsyncIterable<SessionOutboundMessage>;
}
```

**Pros**:
- Simple, direct mapping to WebSocket protocol
- Full control over message timing and ordering
- Easy to debug - messages are visible
- No abstraction leaks
- Uses existing Zod schemas for type safety

**Cons**:
- Tests must handle async event streams manually
- No automatic retry/reconnect logic

**Files to create/modify**:
- `packages/server/src/server/test-utils/daemon-client.ts` (new)
- `packages/server/src/server/test-utils/index.ts` (export)

**Scope**: ~300-400 lines of code

---

### Approach 2: Reactive Event Store

**Description**: A more opinionated client that maintains reactive state, similar to how the UI works.

```typescript
export class DaemonClient {
  // Reactive stores (like Zustand)
  agents: Map<string, AgentSnapshotPayload>;
  timelines: Map<string, AgentTimelineItem[]>;
  permissions: Map<string, AgentPermissionRequest[]>;

  // Subscribe to state changes
  subscribe(selector: (state) => T, callback: (value: T) => void): () => void;

  // Wait for state conditions
  waitUntil<T>(selector: (state) => T, predicate: (value: T) => boolean): Promise<T>;
}
```

**Pros**:
- More declarative tests: `await client.waitUntil(s => s.agents.get(id)?.status, s => s === "idle")`
- Automatic state management
- Timeline history automatically tracked

**Cons**:
- More complex implementation
- State management adds overhead
- Harder to test low-level protocol edge cases
- Abstracts away message ordering which may hide bugs

**Files to create/modify**:
- `packages/server/src/server/test-utils/daemon-client.ts` (new, larger)
- Potentially need state management library

**Scope**: ~600-800 lines of code

---

### Approach 3: Hybrid - Simple Core + Helper Methods

**Description**: Simple WebSocket wrapper (Approach 1) with optional convenience helpers.

```typescript
export class DaemonClient {
  // Core: direct WebSocket wrapper (Approach 1)
  // ...

  // Convenience: high-level test helpers
  async createAgentAndWaitIdle(config, initialPrompt?): Promise<{ agent, timeline }>;
  async sendMessageAndWaitIdle(agentId, text): Promise<{ timeline }>;
  async approvePermissionAndWaitIdle(agentId, requestId): Promise<void>;

  // Timeline helpers
  getToolCalls(agentId): AgentTimelineItem[];
  getLastMessage(agentId): string | null;
  hasError(agentId): boolean;
}
```

**Pros**:
- Best of both: simple core, convenient helpers
- Helpers can be added incrementally
- Core stays testable and debuggable
- Helpers reduce test boilerplate

**Cons**:
- Helpers need maintenance as API evolves
- Risk of helpers hiding protocol bugs

**Scope**: ~500-600 lines of code

---

## Recommendation: Approach 1 (Simple WebSocket Wrapper)

**Rationale**:
1. **Matches the existing pattern** - The existing E2E tests (`agent-mcp.e2e.test.ts`) use direct MCP client calls. A WebSocket client should be similarly direct.

2. **Protocol transparency** - E2E tests should verify the actual protocol, not an abstracted version. A simple wrapper exposes the real messages.

3. **Debuggability** - When tests fail, you can see exactly what messages were sent/received. Abstractions hide this.

4. **Incremental** - Can add convenience methods later (Approach 3) if needed.

5. **Low maintenance** - Simple code means less to maintain as the daemon evolves.

---

## Implementation Design (Approach 1)

### Core Types

```typescript
// packages/server/src/server/test-utils/daemon-client.ts

import WebSocket from "ws";
import { nanoid } from "nanoid";
import { z } from "zod";
import type {
  SessionInboundMessage,
  SessionOutboundMessage,
  AgentSnapshotPayload,
  AgentStreamEventPayload,
  AgentPermissionResponse,
} from "../messages.js";

export interface DaemonClientConfig {
  url: string;
  authHeader?: string;
}

export interface CreateAgentOptions {
  provider: "claude" | "codex";
  cwd: string;
  title?: string;
  model?: string;
  modeId?: string;
  initialPrompt?: string;
  mcpServers?: Record<string, unknown>;
}

export interface SendMessageOptions {
  messageId?: string;
  images?: Array<{ data: string; mimeType: string }>;
}

export type DaemonEvent =
  | { type: "agent_state"; agentId: string; payload: AgentSnapshotPayload }
  | { type: "agent_stream"; agentId: string; event: AgentStreamEventPayload; timestamp: string }
  | { type: "session_state"; agents: AgentSnapshotPayload[] }
  | { type: "status"; payload: { status: string } }
  | { type: "error"; message: string };
```

### Class Implementation

```typescript
export class DaemonClient {
  private ws: WebSocket | null = null;
  private messageQueue: SessionOutboundMessage[] = [];
  private eventListeners: Set<(event: DaemonEvent) => void> = new Set();
  private connectPromise: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(private config: DaemonClientConfig) {}

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.config.url, {
        headers: this.config.authHeader
          ? { Authorization: this.config.authHeader }
          : undefined,
      });

      this.ws.on("open", () => {
        this.connectPromise = null;
        resolve();
      });

      this.ws.on("error", (err) => {
        this.connectPromise?.reject(err);
        this.connectPromise = null;
      });

      this.ws.on("message", (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "pong") return;
        if (msg.type === "session") {
          this.handleSessionMessage(msg.message);
        }
      });

      this.connectPromise = { resolve, reject };
    });
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  async createAgent(options: CreateAgentOptions): Promise<AgentSnapshotPayload> {
    const requestId = nanoid();
    this.send({
      type: "create_agent_request",
      requestId,
      config: {
        provider: options.provider,
        cwd: options.cwd,
        title: options.title,
        model: options.model,
        modeId: options.modeId,
        mcpServers: options.mcpServers,
      },
      initialPrompt: options.initialPrompt,
    });

    // Wait for agent_state response
    return this.waitFor((msg) => {
      if (msg.type === "agent_state") {
        return msg.payload;
      }
      return null;
    });
  }

  async deleteAgent(agentId: string): Promise<void> {
    this.send({ type: "delete_agent_request", agentId });
    await this.waitFor((msg) => {
      if (msg.type === "agent_deleted" && msg.payload.agentId === agentId) {
        return true;
      }
      return null;
    });
  }

  async listAgents(): Promise<AgentSnapshotPayload[]> {
    // Trigger session_state by connecting or sending ping
    // session_state is sent on connection
    return this.waitFor((msg) => {
      if (msg.type === "session_state") {
        return msg.payload.agents;
      }
      return null;
    });
  }

  // ============================================================================
  // Agent Interaction
  // ============================================================================

  async sendMessage(agentId: string, text: string, options?: SendMessageOptions): Promise<void> {
    this.send({
      type: "send_agent_message",
      agentId,
      text,
      messageId: options?.messageId,
      images: options?.images,
    });
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.send({ type: "cancel_agent_request", agentId });
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    this.send({ type: "set_agent_mode", agentId, modeId });
  }

  // ============================================================================
  // Permissions
  // ============================================================================

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    this.send({
      type: "agent_permission_response",
      agentId,
      requestId,
      response,
    });
  }

  // ============================================================================
  // Waiting / Streaming
  // ============================================================================

  async waitForAgentIdle(agentId: string, timeout = 60000): Promise<AgentSnapshotPayload> {
    return this.waitFor((msg) => {
      if (msg.type === "agent_state" && msg.payload.id === agentId) {
        if (msg.payload.status === "idle" || msg.payload.status === "error") {
          return msg.payload;
        }
      }
      return null;
    }, timeout);
  }

  async waitForPermission(agentId: string, timeout = 30000): Promise<AgentPermissionRequest> {
    return this.waitFor((msg) => {
      if (msg.type === "agent_permission_request" && msg.payload.agentId === agentId) {
        return msg.payload.request;
      }
      if (msg.type === "agent_stream" && msg.payload.agentId === agentId) {
        if (msg.payload.event.type === "permission_requested") {
          return msg.payload.event.request;
        }
      }
      return null;
    }, timeout);
  }

  // ============================================================================
  // Event Subscription
  // ============================================================================

  on(handler: (event: DaemonEvent) => void): () => void {
    this.eventListeners.add(handler);
    return () => this.eventListeners.delete(handler);
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private send(message: SessionInboundMessage): void {
    this.ws?.send(JSON.stringify({ type: "session", message }));
  }

  private handleSessionMessage(msg: SessionOutboundMessage): void {
    this.messageQueue.push(msg);

    // Notify event listeners
    const event = this.toEvent(msg);
    if (event) {
      for (const handler of this.eventListeners) {
        handler(event);
      }
    }
  }

  private toEvent(msg: SessionOutboundMessage): DaemonEvent | null {
    switch (msg.type) {
      case "agent_state":
        return { type: "agent_state", agentId: msg.payload.id, payload: msg.payload };
      case "agent_stream":
        return { type: "agent_stream", agentId: msg.payload.agentId, event: msg.payload.event, timestamp: msg.payload.timestamp };
      case "session_state":
        return { type: "session_state", agents: msg.payload.agents };
      case "status":
        return { type: "status", payload: msg.payload };
      default:
        return null;
    }
  }

  private async waitFor<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000
  ): Promise<T> {
    const start = Date.now();

    // Check queued messages first
    for (const msg of this.messageQueue) {
      const result = predicate(msg);
      if (result !== null) return result;
    }

    // Wait for new messages
    return new Promise((resolve, reject) => {
      const check = (msg: SessionOutboundMessage) => {
        const result = predicate(msg);
        if (result !== null) {
          resolve(result);
          return true;
        }
        return false;
      };

      const handler = (data: WebSocket.Data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === "session" && check(msg.message)) {
          this.ws?.off("message", handler);
          clearTimeout(timer);
        }
      };

      const timer = setTimeout(() => {
        this.ws?.off("message", handler);
        reject(new Error(`Timeout waiting for message (${timeout}ms)`));
      }, timeout);

      this.ws?.on("message", handler);
    });
  }
}
```

---

## Test Infrastructure

### Test Setup

```typescript
// packages/server/src/server/test-utils/daemon-test-context.ts

import { createTestPaseoDaemon, type TestPaseoDaemon } from "./paseo-daemon.js";
import { DaemonClient } from "./daemon-client.js";

export interface DaemonTestContext {
  daemon: TestPaseoDaemon;
  client: DaemonClient;
  cleanup: () => Promise<void>;
}

export async function createDaemonTestContext(): Promise<DaemonTestContext> {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    authHeader: daemon.agentMcpAuthHeader,
  });
  await client.connect();

  return {
    daemon,
    client,
    cleanup: async () => {
      await client.close();
      await daemon.close();
    },
  };
}
```

---

## Example E2E Tests

### Basic Flow

```typescript
// packages/server/src/server/daemon.e2e.test.ts

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { createDaemonTestContext, type DaemonTestContext } from "./test-utils/daemon-test-context.js";

describe("daemon E2E", () => {
  let ctx: DaemonTestContext;

  beforeEach(async () => {
    ctx = await createDaemonTestContext();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("creates agent and receives response", async () => {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Test Agent",
    });

    expect(agent.id).toBeTruthy();
    expect(agent.provider).toBe("codex");
    expect(agent.status).toBe("idle");

    await ctx.client.sendMessage(agent.id, "Say hello");

    const finalState = await ctx.client.waitForAgentIdle(agent.id);
    expect(finalState.status).toBe("idle");
  });

  test("permission flow: approve", async () => {
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd: "/tmp",
    });

    await ctx.client.sendMessage(agent.id, "Run: rm -f test.txt");

    const permission = await ctx.client.waitForPermission(agent.id);
    expect(permission.name).toContain("Bash");

    await ctx.client.respondToPermission(agent.id, permission.id, {
      behavior: "allow",
    });

    const finalState = await ctx.client.waitForAgentIdle(agent.id);
    expect(finalState.status).toBe("idle");
  });

  test("permission flow: deny", async () => {
    const agent = await ctx.client.createAgent({
      provider: "claude",
      cwd: "/tmp",
    });

    await ctx.client.sendMessage(agent.id, "Run: rm -f test.txt");

    const permission = await ctx.client.waitForPermission(agent.id);
    await ctx.client.respondToPermission(agent.id, permission.id, {
      behavior: "deny",
      message: "Not allowed",
    });

    const finalState = await ctx.client.waitForAgentIdle(agent.id);
    expect(finalState.status).toBe("idle");
  });

  test("agent persistence and resume", async () => {
    const agent = await ctx.client.createAgent({
      provider: "codex",
      cwd: "/tmp",
      title: "Persistent Agent",
    });

    await ctx.client.sendMessage(agent.id, "Remember: the password is 12345");
    await ctx.client.waitForAgentIdle(agent.id);

    // Delete active agent (keeps persistence)
    await ctx.client.deleteAgent(agent.id);

    // List persisted agents
    const persisted = await ctx.client.listPersistedAgents();
    const found = persisted.find((p) => p.title === "Persistent Agent");
    expect(found).toBeTruthy();

    // Resume
    const resumed = await ctx.client.resumeAgent(found!.persistence!);
    expect(resumed.id).toBeTruthy();
  });

  test("multi-agent: agent A launches agent B", async () => {
    const agentA = await ctx.client.createAgent({
      provider: "claude",
      cwd: "/tmp",
      title: "Parent Agent",
      mcpServers: {
        "agent-control": {
          url: `http://127.0.0.1:${ctx.daemon.port}/mcp/agents`,
          headers: { Authorization: ctx.daemon.agentMcpAuthHeader },
        },
      },
    });

    await ctx.client.sendMessage(
      agentA.id,
      "Create a new Codex agent titled 'Child Agent' and have it say hello"
    );

    // Wait for parent to finish (which includes child creation)
    await ctx.client.waitForAgentIdle(agentA.id);

    // Verify child agent was created
    const agents = await ctx.client.listAgents();
    const child = agents.find((a) => a.title === "Child Agent");
    expect(child).toBeTruthy();
    expect(child!.provider).toBe("codex");
  });
});
```

---

## Files Summary

| File | Action | Description |
|------|--------|-------------|
| `packages/server/src/server/test-utils/daemon-client.ts` | Create | DaemonClient class (~300 lines) |
| `packages/server/src/server/test-utils/daemon-test-context.ts` | Create | Test setup helpers (~50 lines) |
| `packages/server/src/server/test-utils/index.ts` | Modify | Export new utilities |
| `packages/server/src/server/daemon.e2e.test.ts` | Create | E2E test suite (~200 lines) |

---

## Scope Estimate

- **DaemonClient implementation**: ~300-400 lines
- **Test context helpers**: ~50 lines
- **Example E2E tests**: ~200 lines
- **Total**: ~550-650 lines of new code

---

## Migration Path

1. **Phase 1**: Implement DaemonClient with core methods (connect, createAgent, sendMessage, waitForIdle)
2. **Phase 2**: Add permission methods (respondToPermission, waitForPermission)
3. **Phase 3**: Add persistence methods (listPersistedAgents, resumeAgent)
4. **Phase 4**: Add advanced features (event streaming, multi-agent tests)
5. **Phase 5**: Migrate existing E2E tests to use DaemonClient (optional)

Each phase is independently shippable and testable.

---

## Alternatives Considered

### Use MCP Client Instead

The existing `agent-mcp.e2e.test.ts` uses the MCP protocol to control agents. However:
- MCP is for agent-to-agent communication
- WebSocket is for client-to-daemon communication
- Testing WebSocket directly verifies the actual UI protocol
- MCP tests are complementary, not replacements

### Use HTTP API Only

The daemon has some HTTP endpoints, but:
- Agent streaming requires WebSocket
- Permission flow requires WebSocket
- Real-time state updates require WebSocket
- HTTP is only for health checks and static files

---

## Recommendation

Proceed with **Approach 1 (Simple WebSocket Wrapper)** for these reasons:

1. Lowest complexity, easiest to maintain
2. Full protocol transparency for debugging
3. Matches existing test patterns in the codebase
4. Can add convenience helpers later if needed
5. Estimated 2-3 hours to implement core functionality
