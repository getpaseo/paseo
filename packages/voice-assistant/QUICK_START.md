# Quick Start: LLM Integration

## Setup

1. **Install dependencies** (if not already done):
   ```bash
   npm install
   ```

2. **Create `.env` file**:
   ```bash
   cp .env.example .env
   # Edit .env and add your OPENAI_API_KEY
   ```

3. **Build the project**:
   ```bash
   npm run build
   ```

4. **Start the server**:
   ```bash
   npm start
   ```

## Testing

### Quick Test

```bash
# Make sure server is running on http://localhost:3000
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "list all terminals"}' | jq .
```

### Run All Tests

```bash
./test-llm.sh
```

## Example Commands

Try these natural language commands:

```bash
# Create a terminal
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "create a terminal called web-dev at ~/projects/web"}' | jq .

# List terminals
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "show me all terminals"}' | jq .

# Run a command
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "run npm install in the web-dev terminal"}' | jq .

# Get terminal output
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "show me the output from web-dev terminal"}' | jq .

# Kill a terminal
curl -X POST http://localhost:3000/api/test-llm \
  -H "Content-Type: application/json" \
  -d '{"message": "close the web-dev terminal"}' | jq .
```

## What's Next?

Phase 5 will integrate this LLM functionality with the WebSocket server to enable:
- Real-time voice conversations
- Streaming responses
- Multi-turn context
- Voice-to-terminal control

## Files Created

- `/agent-prompt.md` - System prompt defining agent behavior
- `/src/server/agent/system-prompt.ts` - Loads and caches system prompt
- `/src/server/agent/llm-openai.ts` - OpenAI integration with tool execution
- `/src/server/index.ts` - Added `/api/test-llm` endpoint
- `/LLM_INTEGRATION.md` - Comprehensive integration guide
- `/QUICK_START.md` - This file
- `/test-llm.sh` - Automated test script

## Troubleshooting

**Q: "OPENAI_API_KEY not set" error**
A: Create a `.env` file with `OPENAI_API_KEY=sk-...`

**Q: Server won't start**
A: Make sure tmux is installed and running

**Q: Tool calls failing**
A: Check that the default tmux session is initialized (happens automatically on server start)

**Q: Build errors**
A: Run `npm run build` and check the error messages

For more details, see `LLM_INTEGRATION.md`.
