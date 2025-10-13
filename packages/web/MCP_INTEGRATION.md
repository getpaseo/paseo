# MCP Integration

## Overview

This application now integrates with a Model Context Protocol (MCP) server to extend the AI's capabilities with custom tools.

## How It Works

The integration uses **Remote MCP Server** mode, where OpenAI's servers directly communicate with your MCP server:

1. During session creation, the app sends MCP configuration to OpenAI
2. OpenAI connects to your MCP server and discovers available tools
3. During conversation, when the AI needs to use a tool, it calls your MCP server automatically
4. Your MCP server executes the tool and returns results to OpenAI
5. OpenAI incorporates the results into the conversation and responds to the user

## Configuration

The MCP server is configured in `app/api/session/route.ts`:

```typescript
tools: [
  {
    type: 'mcp',
    server_label: 'local-mcp',
    server_url: 'https://mohameds-macbook-pro.tail8fe838.ts.net/mcp?password=dev-password',
    require_approval: 'never',
  },
]
```

### Configuration Options

- **`type`**: Must be `'mcp'` for MCP server integration
- **`server_label`**: A friendly name for your MCP server (used in logs/debugging)
- **`server_url`**: The HTTPS URL of your MCP server (including query parameters for auth)
- **`require_approval`**: Set to `'never'` for automatic tool execution, or `'always'` for manual approval

## Tool Discovery

The MCP protocol automatically discovers all available tools from your server. You don't need to:
- Manually define each tool
- Handle function call events in the client
- Send results back to OpenAI

Everything is handled automatically by OpenAI's servers.

## Benefits

1. **Zero Client Complexity**: No need to monitor WebRTC data channels or handle function calls
2. **Automatic Tool Discovery**: MCP servers expose their available tools automatically
3. **Scalable**: Easy to add more MCP servers or switch between them
4. **Production Ready**: This is OpenAI's recommended approach for tool integration

## Testing

To test the MCP integration:

1. Start the development server: `npm run dev`
2. Open http://localhost:3000
3. Click "Start Voice Chat"
4. Ask the AI to perform actions that require your MCP tools
5. The AI will automatically use the appropriate tools and respond

Example prompts to test (depending on your MCP tools):
- "What tools do you have access to?"
- "Can you [action that requires your MCP tool]?"

## Changing MCP Configuration

To use a different MCP server or modify settings:

1. Edit `app/api/session/route.ts`
2. Update the `tools` array in the session creation
3. Rebuild: `npm run build`
4. Restart the server

## Security Notes

- The MCP server URL includes authentication in the query string (`?password=dev-password`)
- This is acceptable for development but consider using proper OAuth or API keys for production
- The `require_approval: 'never'` setting means tools execute automatically without confirmation
- For production, consider using `require_approval: 'always'` with a UI approval mechanism

## Troubleshooting

### Tools Not Working
- Verify your MCP server is accessible at the configured URL
- Check that the password/auth is correct
- Ensure your MCP server is returning valid MCP protocol responses

### Session Creation Fails
- Check OpenAI API key is valid
- Verify the MCP server URL is properly formatted
- Check network connectivity to your MCP server

### AI Doesn't Use Tools
- The AI decides when to use tools based on the conversation context
- Try more explicit prompts that clearly require tool usage
- Verify tools are properly exposed by your MCP server
