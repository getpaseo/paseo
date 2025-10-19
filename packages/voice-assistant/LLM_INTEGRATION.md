# LLM Integration Guide

This document describes Phase 4 of the voice-assistant package: LLM Integration with OpenAI GPT-4.

## Overview

The LLM integration enables the voice assistant to understand natural language commands and execute terminal operations using OpenAI's function calling capabilities.

## Components

### 1. System Prompt (`agent-prompt.md`)

The system prompt defines the agent's personality and behavior. It's loaded from the package root and instructs the agent to:
- Acknowledge requests verbally before acting
- Report tool execution results back to the user
- Handle voice-to-text errors gracefully
- Be concise for mobile users
- Use the simplified "terminals" model for all terminal interactions

**Location**: `/packages/voice-assistant/agent-prompt.md`

### 2. System Prompt Loader (`src/server/agent/system-prompt.ts`)

Provides functions to load and cache the system prompt:
- `loadSystemPrompt()`: Loads the prompt from disk
- `getSystemPrompt()`: Returns cached prompt (loads if not cached)

### 3. OpenAI Integration (`src/server/agent/llm-openai.ts`)

Main LLM integration module with the following functions:

#### `initializeOpenAI(apiKey: string)`
Initializes the OpenAI client with your API key.

#### `callLLM(params: CallLLMParams): Promise<LLMResponse>`
Calls OpenAI's chat completions API with:
- Messages (conversation history)
- Tools (terminal operations)
- Optional streaming callback

Returns the LLM's response including any tool calls.

#### `executeToolCall(toolCall: ToolCall): Promise<string>`
Executes a tool call by mapping to terminal manager functions:
- `list_terminals` → `listTerminals()`
- `create_terminal` → `createTerminal(args)`
- `capture_terminal` → `captureTerminal(args.terminalId, args.lines, args.wait)`
- `send_text` → `sendText(args.terminalId, args.text, args.pressEnter, args.return_output)`
- `rename_terminal` → `renameTerminal(args.terminalId, args.newName)`
- `kill_terminal` → `killTerminal(args.terminalId)`

Returns the result as a JSON string.

#### `getTerminalTools(): ChatCompletionTool[]`
Returns the terminal tools in OpenAI's function calling format.

## Usage

### Environment Setup

Create a `.env` file in the package root:

```bash
OPENAI_API_KEY=sk-...
PORT=3000
NODE_ENV=development
```

### Testing the Integration

The package includes a test endpoint at `/api/test-llm` that demonstrates the LLM integration.

#### Manual Testing with curl

```bash
# Test 1: Create a terminal
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "create a terminal called llm-test"}' | jq .

# Test 2: List all terminals
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "list all terminals"}' | jq .

# Test 3: Run a command
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "run echo hello in the llm-test terminal"}' | jq .
```

#### Automated Testing

Run the provided test script:

```bash
./test-llm.sh
```

## API Response Format

The `/api/test-llm` endpoint returns:

```typescript
{
  success: boolean;
  userMessage: string;
  llmResponse: string;           // The LLM's text response
  toolCalls?: Array<{
    tool: string;                // Tool name (e.g., "create_terminal")
    arguments: any;              // Tool arguments
    result: string;              // JSON result from tool execution
  }>;
}
```

## Example Flow

1. **User sends message**: "create a terminal called web-dev at ~/projects/web"

2. **LLM processes request**:
   - System prompt provides context about terminal operations
   - User message is analyzed
   - LLM decides to call `create_terminal` tool

3. **Tool execution**:
   - Arguments: `{name: "web-dev", workingDirectory: "~/projects/web"}`
   - `createTerminal()` is called
   - Result returned as JSON

4. **Response to user**:
   ```json
   {
     "success": true,
     "userMessage": "create a terminal called web-dev at ~/projects/web",
     "llmResponse": "I'll create a terminal for you...",
     "toolCalls": [{
       "tool": "create_terminal",
       "arguments": {"name": "web-dev", "workingDirectory": "~/projects/web"},
       "result": "{\"id\":\"@123\",\"name\":\"web-dev\",\"workingDirectory\":\"/Users/user/projects/web\",...}"
     }]
   }
   ```

## Integration with Voice Assistant

The LLM integration is designed to work with the voice assistant's WebSocket server. Future phases will:

1. Connect WebSocket messages to LLM processing
2. Stream LLM responses back to the client
3. Handle multi-turn conversations
4. Maintain conversation context

## Error Handling

The LLM integration includes comprehensive error handling:

- Missing API key: Returns 500 error with message
- Tool execution failures: Returns error JSON in tool result
- Network errors: Caught and returned as 500 errors
- Invalid tool arguments: Caught by terminal manager functions

## Configuration

### Model Selection

Currently using `gpt-4o` (specified in `llm-openai.ts`). You can change this to:
- `gpt-4-turbo`: Faster, cheaper GPT-4
- `gpt-4`: Standard GPT-4
- `gpt-3.5-turbo`: Cheaper option (may have reduced performance)

### Streaming

Streaming is supported but not enabled by default in the test endpoint. To enable:

```typescript
const response = await callLLM({
  messages,
  tools: getTerminalTools(),
  onChunk: (chunk) => {
    // Handle streaming chunks
    console.log(chunk);
  }
});
```

## Development

### Building

```bash
npm run build
```

### Running in Development

```bash
npm start
```

The server will start on port 3000 (or `PORT` from `.env`).

## Troubleshooting

### "OpenAI client not initialized" error

Make sure you call `initializeOpenAI(apiKey)` before `callLLM()`.

### "OPENAI_API_KEY not set" error

Ensure you have a `.env` file with a valid `OPENAI_API_KEY`.

### Tool execution errors

Check that:
1. The default tmux session is initialized
2. Terminal IDs are valid (get them from `list_terminals`)
3. Arguments match the tool schema

### TypeScript errors

Run `npm run build` to check for compilation errors.

## Next Steps

Phase 5 will integrate the LLM with the WebSocket server to enable real-time voice conversations with terminal control.
