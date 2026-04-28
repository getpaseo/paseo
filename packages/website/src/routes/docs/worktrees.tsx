import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/worktrees")({
  head: () => ({
    meta: pageMeta(
      "Git Worktrees - Paseo Docs",
      "Run agents in isolated git worktrees with setup hooks, scripts, and long-running services.",
    ),
  }),
  component: Worktrees,
});

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto">
      {children}
    </div>
  );
}

function Worktrees() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Git Worktrees</h1>
        <p className="text-white/60 leading-relaxed">
          Each agent runs in its own git worktree — a separate directory on a separate branch — so
          parallel agents never step on each other. You configure setup, scripts, and long-running
          services through a <code className="font-mono">paseo.json</code> file at your repo root.
        </p>
      </div>

      {/* Layout & workflow */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Layout and workflow</h2>
        <p className="text-white/60 leading-relaxed">
          Worktrees live under <code className="font-mono">$PASEO_HOME/worktrees/</code>, grouped by
          a hash of the source checkout path. Each worktree gets a random slug; the branch name is
          chosen when you first launch an agent.
        </p>
        <Code>
          <pre className="text-white/80">{`~/.paseo/worktrees/
└── 1vnnm9k3/               # hash of source checkout path
    ├── tidy-fox/           # worktree slug (branch set on first agent)
    └── bold-owl/`}</pre>
        </Code>
        <ol className="text-white/60 space-y-2 list-decimal list-inside">
          <li>Create a worktree — Paseo runs your setup hooks</li>
          <li>Launch an agent — a branch is created or assigned</li>
          <li>Review the diff against the base branch</li>
          <li>Merge or archive — archive runs teardown and removes the directory</li>
        </ol>
      </section>

      {/* paseo.json */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">paseo.json</h2>
        <p className="text-white/60 leading-relaxed">
          Drop a <code className="font-mono">paseo.json</code> in your repo root. Paseo reads it
          from the committed version of the base branch you picked, so uncommitted changes in other
          branches don&apos;t apply.
        </p>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup":    "npm ci",
    "teardown": "rm -rf .cache"
  },
  "scripts": {
    "test": { "command": "npm test" },
    "web":  { "command": "npm run dev", "type": "service", "port": 3000 }
  }
}`}</pre>
        </Code>
      </section>

      {/* Setup & teardown */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Setup and teardown</h2>
        <p className="text-white/60 leading-relaxed">
          <code className="font-mono">setup</code> runs once after the worktree is created. A fresh
          worktree has no installed dependencies and no ignored files (like{" "}
          <code className="font-mono">.env</code>), so use setup to install and copy what you need.
          <code className="font-mono">teardown</code> runs during archive, before the directory is
          removed.
        </p>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": "npm ci\\ncp \\"$PASEO_SOURCE_CHECKOUT_PATH/.env\\" .env\\nnpm run db:migrate",
    "teardown": "npm run db:drop || true"
  }
}`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Both fields accept a multiline shell script or an array of commands; commands run
          sequentially either way.
        </p>
        <p className="text-white/60 leading-relaxed">
          Commands run with the worktree as <code className="font-mono">cwd</code>. Use{" "}
          <code className="font-mono">$PASEO_SOURCE_CHECKOUT_PATH</code> to reach files in the
          original checkout (untracked config, local caches, etc).
        </p>
      </section>

      {/* Scripts & services */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Scripts and services</h2>
        <p className="text-white/60 leading-relaxed">
          <code className="font-mono">scripts</code> are named commands you can run inside a
          worktree on demand. Mark one as a <em>service</em> and Paseo supervises it as a
          long-running process, assigns it a port, and routes HTTP traffic to it through the
          daemon&apos;s reverse proxy.
        </p>

        <h3 className="text-lg font-medium mt-4">Plain scripts</h3>
        <Code>
          <pre className="text-white/80">{`{
  "scripts": {
    "test":     { "command": "npm test" },
    "lint":     { "command": "npm run lint" },
    "generate": { "command": "npm run codegen" }
  }
}`}</pre>
        </Code>

        <h3 className="text-lg font-medium mt-6">Services</h3>
        <Code>
          <pre className="text-white/80">{`{
  "scripts": {
    "web": {
      "type": "service",
      "command": "npm run dev -- --port $PASEO_PORT",
      "port": 3000
    },
    "api": {
      "type": "service",
      "command": "npm run api -- --port $PASEO_PORT"
    }
  }
}`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Omit <code className="font-mono">port</code> to let Paseo auto-assign one. Bind your
          process to <code className="font-mono">$PASEO_PORT</code> rather than hard-coding — each
          worktree gets a distinct port so multiple copies of the same service coexist.
        </p>

        <h3 className="text-lg font-medium mt-6">Reverse proxy</h3>
        <p className="text-white/60 leading-relaxed">
          Every service is reachable through the daemon at a deterministic hostname:
        </p>
        <Code>
          <pre className="text-white/80">{`http://<script>.<branch>.<project>.localhost:<daemon-port>

# on the default branch, the branch label is dropped:
http://<script>.<project>.localhost:<daemon-port>`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          <code className="font-mono">*.localhost</code> resolves to{" "}
          <code className="font-mono">127.0.0.1</code> on modern systems, so these URLs work out of
          the box. The proxy supports WebSocket upgrades.
        </p>

        <h3 className="text-lg font-medium mt-6">Service-to-service</h3>
        <p className="text-white/60 leading-relaxed">
          Services launched from the same workspace see each other&apos;s ports and proxy URLs.
          Given <code className="font-mono">web</code> and <code className="font-mono">api</code>{" "}
          above, each process gets:
        </p>
        <Code>
          <pre className="text-white/80">{`PASEO_PORT=3000                         # this service's port
PASEO_URL=http://web.my-app.localhost:6767  # this service's proxy URL
PASEO_SERVICE_API_PORT=51732
PASEO_SERVICE_API_URL=http://api.my-app.localhost:6767
PASEO_SERVICE_WEB_PORT=3000
PASEO_SERVICE_WEB_URL=http://web.my-app.localhost:6767`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Script names are upper-cased and non-alphanumerics become{" "}
          <code className="font-mono">_</code>. Point your frontend at{" "}
          <code className="font-mono">$PASEO_SERVICE_API_URL</code> instead of hard-coding a port.
        </p>
      </section>

      {/* Terminals */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Terminals</h2>
        <p className="text-white/60 leading-relaxed">
          Open terminals automatically when a worktree is created. Useful for tailing logs or
          leaving a REPL ready to go.
        </p>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "terminals": [
      { "name": "logs", "command": "tail -f dev.log" },
      { "name": "shell", "command": "bash" }
    ]
  }
}`}</pre>
        </Code>
      </section>

      {/* Env vars */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Environment variables</h2>
        <p className="text-white/60 leading-relaxed">
          Setup, teardown, scripts, and services all see:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <code className="font-mono">$PASEO_SOURCE_CHECKOUT_PATH</code> — the original repo root
          </li>
          <li>
            <code className="font-mono">$PASEO_WORKTREE_PATH</code> — the worktree directory
          </li>
          <li>
            <code className="font-mono">$PASEO_BRANCH_NAME</code> — the worktree&apos;s branch
          </li>
          <li>
            <code className="font-mono">$PASEO_WORKTREE_PORT</code> — legacy per-worktree port
            (prefer <code className="font-mono">$PASEO_PORT</code> inside services)
          </li>
        </ul>
        <p className="text-white/60 leading-relaxed">Services additionally get:</p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <code className="font-mono">$PASEO_PORT</code> — this service&apos;s assigned port
          </li>
          <li>
            <code className="font-mono">$PASEO_URL</code> — this service&apos;s proxy URL
          </li>
          <li>
            <code className="font-mono">$PASEO_SERVICE_&lt;NAME&gt;_PORT</code> /{" "}
            <code className="font-mono">_URL</code> — peer service ports and URLs
          </li>
          <li>
            <code className="font-mono">$HOST</code> — <code className="font-mono">127.0.0.1</code>{" "}
            for local-only daemons, <code className="font-mono">0.0.0.0</code> when the daemon binds
            all interfaces
          </li>
        </ul>
      </section>

      {/* CLI */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">CLI</h2>
        <Code>
          <pre className="text-white/80">{`paseo run --worktree feature-auth --base main "implement auth"
paseo worktree ls
paseo worktree archive feature-auth`}</pre>
        </Code>
      </section>
    </div>
  );
}
