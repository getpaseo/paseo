# Voice Dev

Voice-controlled development environment powered by OpenAI Realtime API.

## Packages

- **`@voice-dev/mcp-server`** - MCP server for terminal control
  - Located in `packages/mcp-server/`
  - Provides terminal session management via MCP protocol
  - Can run as HTTP server or stdio mode

- **`@voice-dev/web`** - Next.js web interface
  - Located in `packages/web/`
  - Voice interaction with OpenAI Realtime API
  - Password authentication
  - Agent activity transparency (debug panel)
  - Real-time status display

## Quick Start

```bash
# Install all dependencies
npm install

# Run web app in dev mode
npm run dev

# Run MCP server in dev mode
npm run dev:mcp

# Build everything
npm run build

# Type check all packages
npm run typecheck
```

## Development

### Web App

```bash
# Development
npm run dev              # Start Next.js dev server (port 3000)

# Production
npm run build:web        # Build for production
npm run start            # Start production server
```

### MCP Server

```bash
# Development
npm run dev:mcp          # Start with HTTP server and dev-password

# Production
npm run build:mcp        # Build TypeScript
npm run start:mcp        # Run built server
```

## Environment Variables

Create `.env.local` in `packages/web/`:

```bash
OPENAI_API_KEY=sk-your-api-key-here
AUTH_PASSWORD=your-secure-password-here
MCP_SERVER_URL=https://your-mcp-server-url
```

See `packages/web/.env.local.example` for template.

## Project Structure

```
voice-dev/
├── packages/
│   ├── mcp-server/              # MCP Server Package
│   │   ├── src/
│   │   │   ├── index.ts         # CLI entry point
│   │   │   ├── http-server.ts   # HTTP server mode
│   │   │   └── tmux.ts          # Terminal operations
│   │   ├── build/               # Compiled output
│   │   ├── package.json
│   │   └── tsconfig.json
│   │
│   └── web/                     # Web App Package
│       ├── app/
│       │   ├── api/             # API routes
│       │   ├── components/      # React components
│       │   ├── hooks/           # Custom hooks
│       │   ├── types/           # TypeScript types
│       │   └── voice-client.tsx # Main voice UI
│       ├── package.json
│       └── next.config.js
│
├── package.json                 # Root workspace config
├── tsconfig.base.json          # Shared TypeScript config
└── README.md                   # This file
```

## Features

### Web App
- Real-time voice interaction with OpenAI
- WebRTC-based low-latency audio streaming
- Live audio level visualization
- Mute/unmute controls
- Password authentication
- Agent activity transparency (debug log panel)
- Real-time agent status display
- Tool call visibility

### MCP Server
- Full terminal session control
- List sessions, windows, and panes
- Send keystrokes and text
- Create and kill sessions/windows/panes
- Capture pane output
- HTTP server mode with password auth
- stdio mode for Claude Desktop integration

## Deployment

### Web App (Vercel)

Deploy from the web package directory:

```bash
# Deploy to Vercel
cd ~/dev/voice-dev/packages/web
vercel --prod

# Set environment variables
vercel env add OPENAI_API_KEY production
vercel env add AUTH_PASSWORD production
vercel env add MCP_SERVER_URL production
```

### MCP Server

The MCP server typically runs locally:

```bash
# Build and run
npm run build:mcp
npm run start:mcp -- --http --password your-password
```

## Scripts Reference

### Root Level

| Script | Description |
|--------|-------------|
| `npm run dev` | Start web app dev server |
| `npm run dev:mcp` | Start MCP server dev server |
| `npm run build` | Build all packages |
| `npm run build:mcp` | Build MCP server only |
| `npm run build:web` | Build web app only |
| `npm run typecheck` | Type check all packages |
| `npm run start` | Start web app production server |
| `npm run start:mcp` | Start MCP server production |

### Package Level

Run commands in specific packages:

```bash
# Run command in web package
npm run <script> --workspace=web

# Run command in mcp-server package
npm run <script> --workspace=mcp-server
```

## Tech Stack

- **Architecture**: npm workspaces
- **Web**: Next.js 15, React 19, TypeScript, Tailwind CSS
- **MCP Server**: TypeScript, Express, MCP SDK
- **Voice**: OpenAI Realtime API, WebRTC
- **Build**: TypeScript compiler, Next.js build

## License

MIT
