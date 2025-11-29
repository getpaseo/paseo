import { createServer } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const mcpServer = new McpServer({ name: 'test', version: '0.0.1' });

mcpServer.registerTool(
  'fast_tool',
  {
    title: 'Fast tool',
    description: 'Returns immediately',
    inputSchema: {},
    outputSchema: {
      echo: z.string()
    }
  },
  async () => {
    console.log('[server] fast_tool handler invoked');
    return {
      content: [],
      structuredContent: { echo: 'hello' }
    };
  }
);

mcpServer.registerTool(
  'slow_tool',
  {
    title: 'Slow tool',
    description: 'Waits before responding',
    inputSchema: {
      waitMs: z.number()
    },
    outputSchema: {
      ok: z.boolean()
    }
  },
  async ({ waitMs }) => {
    console.log('[server] slow_tool handler invoked');
    await new Promise(resolve => setTimeout(resolve, waitMs));
    console.log('[server] slow_tool resolving');
    return {
      content: [],
      structuredContent: { ok: true }
    };
  }
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => 'test-session' });
await mcpServer.connect(transport);

const HOST = '127.0.0.1';
const PORT = 6768;

const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  await transport.handleRequest(req, res);
});

server.listen(PORT, HOST, () => {
  console.log(`Test MCP server listening on http://${HOST}:${PORT}`);
});
