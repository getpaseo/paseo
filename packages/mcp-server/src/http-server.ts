import express, { Request, Response, NextFunction } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

interface HttpServerOptions {
  port: number;
  password: string;
  server: McpServer;
}

interface AuthenticatedRequest extends Request {
  isAuthenticated?: boolean;
}

export function startHttpServer({ port, password, server }: HttpServerOptions): void {
  const app = express();

  app.use(express.json());

  // Password authentication middleware
  function authenticate(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
    const providedPassword = req.query.password as string;

    if (!providedPassword || providedPassword !== password) {
      res.status(401).json({ error: 'Unauthorized: Invalid or missing password' });
      return;
    }

    req.isAuthenticated = true;
    next();
  }

  // Health check endpoint
  app.get('/', (req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'tmux-mcp',
      transport: 'streamable-http'
    });
  });

  // Streamable HTTP endpoint (modern MCP transport)
  app.post('/mcp', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
      // Create a new transport for each request to prevent request ID collisions
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true
      });

      res.on('close', () => {
        transport.close();
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error'
          },
          id: null
        });
      }
    }
  });

  const httpServer = app.listen(port, () => {
    console.error(`MCP HTTP server listening on port ${port}`);
    console.error(`Streamable HTTP endpoint: http://localhost:${port}/mcp?password=****`);
  });

  httpServer.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Error: Port ${port} is already in use`);
      process.exit(1);
    } else {
      console.error(`Server error:`, error);
      process.exit(1);
    }
  });
}
