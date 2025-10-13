# MCP Integration Research & Implementation Plan

## Executive Summary

Based on research into OpenAI's Realtime API and MCP (Model Context Protocol) integration, here's what I've discovered:

### Key Finding: Two Approaches Available

1. **Remote MCP Server** (Recommended for your use case)
2. **Client-Side Function Calling** (Traditional approach)

---

## Approach 1: Remote MCP Server (RECOMMENDED)

### How It Works

**OpenAI executes the MCP calls on their servers, not your client.**

When you configure a remote MCP server URL in the session configuration:
1. You provide the MCP server URL during session creation
2. OpenAI's servers connect to your MCP server directly
3. When the AI needs to call a tool, OpenAI's servers make the request to your MCP server
4. The MCP server returns results to OpenAI's servers
5. OpenAI processes the results and continues the conversation

### Configuration

```typescript
// In app/api/session/route.ts
const response = await fetch(
  'https://api.openai.com/v1/realtime/sessions',
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-realtime-preview-2024-12-17',
      voice: 'alloy',
      tools: [
        {
          type: 'mcp',
          server_label: 'your-mcp-label',
          server_url: 'https://your-mcp-server.com',
          authorization: 'optional-bearer-token',  // If your MCP requires auth
          require_approval: 'never'  // or 'always' for manual approval
        }
      ]
    }),
  }
);
```

### Pros
- ✅ **Zero client-side complexity** - No need to handle function calls in your app
- ✅ **Automatic tool discovery** - MCP protocol auto-discovers available tools
- ✅ **Seamless integration** - OpenAI handles everything after configuration
- ✅ **No data channel monitoring** - No need to listen for function call events
- ✅ **Production-ready** - Officially supported by OpenAI

### Cons
- ❌ **MCP server must be publicly accessible** - Needs HTTPS URL
- ❌ **Less control** - Can't intercept or modify tool calls client-side
- ❌ **Requires hosted MCP server** - Can't use local MCP tools directly

### Security Considerations
- `require_approval: "always"` - Each tool call needs explicit approval (safer)
- `require_approval: "never"` - Automatic execution (faster, but requires trust)
- `authorization` header can be used to secure your MCP server

---

## Approach 2: Client-Side Function Calling (Traditional)

### How It Works

**Your client executes the function calls, not OpenAI.**

1. Configure tools in `session.update` event via WebRTC data channel
2. Listen for `response.output_item.done` events on the data channel
3. When `item.type === 'function_call'`, execute the function client-side
4. Send results back via `conversation.item.create` event
5. Trigger response generation with `response.create` event

### Configuration

```typescript
// Send via WebRTC data channel after connection
dataChannel.send(JSON.stringify({
  type: 'session.update',
  session: {
    tools: [
      {
        type: 'function',
        name: 'webSearch',
        description: 'Performs an internet search',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'The search query'
            }
          },
          required: ['query']
        }
      }
    ],
    tool_choice: 'auto'
  }
}));

// Listen for function calls
dataChannel.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'response.output_item.done') {
    const item = message.item;

    if (item.type === 'function_call') {
      // Execute function locally
      const result = await executeFunction(item.name, JSON.parse(item.arguments));

      // Send result back
      dataChannel.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: item.call_id,
          output: JSON.stringify(result)
        }
      }));

      // Request new response
      dataChannel.send(JSON.stringify({ type: 'response.create' }));
    }
  }
};
```

### Pros
- ✅ **Full control** - Can intercept, modify, or reject function calls
- ✅ **Local execution** - Can use local tools, no server needed
- ✅ **Custom logic** - Can add validation, rate limiting, etc.
- ✅ **Debugging** - Easier to debug function calls

### Cons
- ❌ **Complex implementation** - Need to handle data channel events
- ❌ **Manual tool definition** - Must define every function manually
- ❌ **More code** - Need state management for function call flow
- ❌ **Error handling** - Must handle all failure cases

---

## Recommendation for Your Project

### Use Remote MCP Server (Approach 1)

**Reasons:**
1. **You mentioned having an MCP URL** - This is exactly what remote MCP is designed for
2. **Simpler implementation** - Just add configuration to session creation
3. **Production-ready** - This is the new, recommended approach from OpenAI
4. **Scalable** - Easy to add more MCP servers or change them

### Implementation Plan

#### Phase 1: Update Session Creation (5 minutes)
1. Add MCP configuration to `/api/session/route.ts`
2. Accept MCP URL/config from environment variables or request body

#### Phase 2: Environment Configuration (2 minutes)
1. Add MCP server URL to `.env.local`
2. Optionally add authorization token if needed

#### Phase 3: Testing (10 minutes)
1. Test that session creates successfully
2. Test that AI can discover and use MCP tools
3. Test tool execution and responses

#### Phase 4: UI Updates (Optional, 15 minutes)
1. Add ability to configure MCP URL from UI
2. Show when MCP tools are being used
3. Add approval mechanism if `require_approval: "always"`

---

## Alternative: Client-Side Function Calling

If you need **local tool execution** or **cannot host a public MCP server**, then use Approach 2.

This would require:
1. Updating `use-webrtc-voice.ts` to handle data channel messages
2. Creating a tool registry/executor system
3. Implementing event listeners for function calls
4. Managing function call state and results

**Estimated effort:** 2-3 hours for full implementation

---

## Questions to Clarify

Before implementing, please clarify:

1. **Do you have a publicly accessible MCP server URL?**
   - If yes → Use Remote MCP (Approach 1)
   - If no → Use Client-Side Function Calling (Approach 2)

2. **Does your MCP server require authentication?**
   - If yes → We'll need to include the authorization header

3. **Do you want manual approval for tool calls?**
   - `require_approval: "always"` - Safer, requires UI for approval
   - `require_approval: "never"` - Automatic, simpler implementation

4. **Should MCP configuration be:**
   - Hard-coded in session creation?
   - Configurable via environment variables?
   - Configurable via UI at runtime?

---

## Next Steps

Once you provide:
1. Your MCP server URL
2. Whether it requires authentication
3. Your approval preference

I can implement the integration in approximately 10-20 minutes using the Remote MCP approach.
