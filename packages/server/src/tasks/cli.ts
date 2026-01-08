#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync } from "node:fs";
import { resolve } from "node:path";
import { FileTaskStore } from "./task-store.js";
import type { AgentType, Task } from "./types.js";

const TASKS_DIR = resolve(process.cwd(), ".tasks");
const store = new FileTaskStore(TASKS_DIR);

const program = new Command()
  .name("task")
  .description("Minimal task management with dependency tracking")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
Examples:
  # Create an epic with subtasks (top-down)
  task create "Build auth system"
  task create "Add login endpoint" --parent abc123
  task create "Add logout endpoint" --parent abc123

  # Create with dependencies (bottom-up)
  task create "Setup database"
  task create "Add user model" --deps def456

  # Assign to specific agent
  task create "Complex refactor" --assignee codex

  # Create as draft (not actionable until opened)
  task create "Future feature" --draft
  task open abc123  # make it actionable

  # View the work breakdown
  task tree abc123

  # See what's ready to work on
  task ready
  task ready --scope abc123

  # See completed work
  task closed --scope abc123

  # Run agent loop on an epic
  task run abc123
  task run abc123 --agent codex
  task run --watch
`
  );

program
  .command("create <title>")
  .description("Create a new task")
  .option("-d, --description <text>", "Task description")
  .option("--deps <ids>", "Comma-separated dependency IDs")
  .option("--parent <id>", "Parent task (parent will depend on this new task)")
  .option("--assignee <agent>", "Agent to assign (claude or codex)")
  .option("--draft", "Create as draft (not actionable)")
  .action(async (title, opts) => {
    const task = await store.create(title, {
      description: opts.description,
      deps: opts.deps
        ? opts.deps.split(",").map((s: string) => s.trim())
        : [],
      status: opts.draft ? "draft" : "open",
      assignee: opts.assignee as AgentType | undefined,
    });

    if (opts.parent) {
      await store.addDep(opts.parent, task.id);
    }

    console.log(task.id);
  });

program
  .command("list")
  .alias("ls")
  .description("List all tasks")
  .option("-s, --status <status>", "Filter by status")
  .action(async (opts) => {
    const tasks = await store.list();
    const filtered = opts.status
      ? tasks.filter((t) => t.status === opts.status)
      : tasks;

    for (const t of filtered) {
      const deps = t.deps.length ? ` <- [${t.deps.join(", ")}]` : "";
      const assignee = t.assignee ? ` @${t.assignee}` : "";
      console.log(`${t.id}  [${t.status}]  ${t.title}${assignee}${deps}`);
    }
  });

program
  .command("show <id>")
  .description("Show task details")
  .action(async (id) => {
    const task = await store.get(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
    console.log(`id: ${task.id}`);
    console.log(`title: ${task.title}`);
    console.log(`status: ${task.status}`);
    console.log(`created: ${task.created}`);
    if (task.assignee) {
      console.log(`assignee: ${task.assignee}`);
    }
    console.log(`deps: [${task.deps.join(", ")}]`);
    if (task.description) {
      console.log(`\n${task.description}`);
    }
    if (task.notes.length) {
      console.log("\n## Notes");
      for (const note of task.notes) {
        console.log(`\n**${note.timestamp}**\n${note.content}`);
      }
    }
  });

program
  .command("ready")
  .description("List tasks ready to work on (open + deps resolved)")
  .option("--scope <id>", "Scope to epic/task dep tree")
  .action(async (opts) => {
    const tasks = await store.getReady(opts.scope);
    for (const t of tasks) {
      const assignee = t.assignee ? ` @${t.assignee}` : "";
      console.log(`${t.id}  ${t.title}${assignee}`);
    }
  });

program
  .command("blocked")
  .description("List tasks blocked by unresolved deps")
  .option("--scope <id>", "Scope to epic/task dep tree")
  .action(async (opts) => {
    const tasks = await store.getBlocked(opts.scope);
    for (const t of tasks) {
      console.log(`${t.id}  ${t.title}  <- [${t.deps.join(", ")}]`);
    }
  });

program
  .command("closed")
  .description("List completed tasks")
  .option("--scope <id>", "Scope to epic/task dep tree")
  .action(async (opts) => {
    const tasks = await store.getClosed(opts.scope);
    for (const t of tasks) {
      console.log(`${t.id}  ${t.title}`);
    }
  });

program
  .command("tree <id>")
  .description("Show dependency tree")
  .action(async (id) => {
    const root = await store.get(id);
    if (!root) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }
    console.log(`${root.id} [${root.status}] ${root.title}`);

    const tree = await store.getDepTree(id);
    const taskMap = new Map(tree.map((t) => [t.id, t]));

    const printed = new Set<string>();
    const printDeps = async (taskId: string, prefix: string) => {
      const task = await store.get(taskId);
      if (!task) return;

      const deps = task.deps.filter((d) => !printed.has(d));
      for (let i = 0; i < deps.length; i++) {
        const depId = deps[i];
        const dep = taskMap.get(depId);
        if (!dep) continue;

        printed.add(depId);
        const isLast = i === deps.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = isLast ? "    " : "│   ";

        console.log(
          `${prefix}${connector}${dep.id} [${dep.status}] ${dep.title}`
        );
        await printDeps(depId, prefix + childPrefix);
      }
    };

    await printDeps(id, "");
  });

program
  .command("dep <id> <dep-id>")
  .description("Add dependency (id depends on dep-id)")
  .action(async (id, depId) => {
    await store.addDep(id, depId);
    console.log(`Added: ${id} -> ${depId}`);
  });

program
  .command("undep <id> <dep-id>")
  .description("Remove dependency")
  .action(async (id, depId) => {
    await store.removeDep(id, depId);
    console.log(`Removed: ${id} -> ${depId}`);
  });

program
  .command("note <id> <content>")
  .description("Add a timestamped note")
  .action(async (id, content) => {
    await store.addNote(id, content);
    console.log("Note added");
  });

program
  .command("open <id>")
  .description("Mark draft as open (actionable)")
  .action(async (id) => {
    await store.open(id);
    console.log(`${id} -> open`);
  });

program
  .command("start <id>")
  .description("Mark as in progress")
  .action(async (id) => {
    await store.start(id);
    console.log(`${id} -> in_progress`);
  });

program
  .command("close <id>")
  .alias("done")
  .description("Mark as done")
  .action(async (id) => {
    await store.close(id);
    console.log(`${id} -> done`);
  });

// Agent runner
async function makePrompt(
  task: Task,
  scopeId: string | undefined
): Promise<string> {
  const scopeArg = scopeId ? ` --scope ${scopeId}` : "";

  let scopeContext = "";
  if (scopeId) {
    const scope = await store.get(scopeId);
    if (scope) {
      scopeContext = `Scope: ${scope.title} (${scopeId})
${scope.description ? `\n${scope.description}\n` : ""}`;
    }
  }

  return `Working directory: ${process.cwd()}
${scopeContext}
---

YOUR TASK (${task.id}): ${task.title}

${task.description || "(no description)"}

---

STEPS:
1. UNDERSTAND CONTEXT FIRST - Before any implementation:
   - Run \`task tree ${task.id}\` to see the full dependency graph
   - Run \`task closed${scopeArg}\` to see completed sibling tasks
   - Run \`task show <id>\` on completed tasks to read their notes
   - Understand what's been done, what decisions were made, what's planned
2. Implement the task described above
3. Add a note documenting what you did: \`task note ${task.id} "what you did"\`
4. Mark complete: \`task close ${task.id}\`

COMMANDS:
- \`task tree <id>\` - see dependency graph from any task
- \`task show <id>\` - view task details and notes
- \`task closed${scopeArg}\` - list completed tasks in scope
- \`task note ${task.id} "content"\` - add a note to your task
- \`task close ${task.id}\` - mark your task done

You MUST run \`task close ${task.id}\` when finished.
`;
}

function runAgent(prompt: string, agent: AgentType, logFile: string): boolean {
  const args =
    agent === "claude"
      ? ["--dangerously-skip-permissions", "-p", prompt]
      : ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt];

  const fd = openSync(logFile, "a");
  const result = spawnSync(agent, args, {
    stdio: ["inherit", fd, fd],
    cwd: process.cwd(),
  });

  return result.status === 0;
}

function getLogFile(): string {
  let num = 0;
  while (existsSync(`task-run.${num}.log`)) {
    num++;
  }
  return `task-run.${num}.log`;
}

function log(logFile: string, message: string): void {
  const timestamp = new Date().toISOString();
  appendFileSync(logFile, `[${timestamp}] ${message}\n`);
}

program
  .command("run [scope]")
  .description("Run agent loop on tasks")
  .option("--agent <type>", "Agent to use (claude or codex)", "claude")
  .option("-w, --watch", "Keep running and wait for new tasks")
  .action(async (scopeId: string | undefined, opts) => {
    const defaultAgent = opts.agent as AgentType;
    const watchMode = opts.watch;
    const logFile = getLogFile();

    console.log("Task Runner started");
    console.log(`Agent: ${defaultAgent}`);
    if (scopeId) console.log(`Scope: ${scopeId}`);
    console.log(`Log: ${logFile}`);
    console.log("");

    log(logFile, `Started with agent=${defaultAgent} scope=${scopeId || "all"}`);

    const MAX_RETRIES = 3;

    const runLoop = async (): Promise<void> => {
      while (true) {
        const ready = await store.getReady(scopeId);
        if (ready.length === 0) break;

        const task = ready[0];
        const agent = task.assignee || defaultAgent;

        console.log(`⏳ ${task.title} [${agent}]`);
        log(logFile, `Starting: ${task.id} - ${task.title} [${agent}]`);

        await store.start(task.id);
        const prompt = await makePrompt(task, scopeId);

        let attempt = 1;
        let success = false;

        while (attempt <= MAX_RETRIES) {
          success = runAgent(prompt, agent, logFile);
          if (success) break;

          if (attempt < MAX_RETRIES) {
            const backoff = attempt * 10;
            console.log(`⚠️  Attempt ${attempt} failed, retrying in ${backoff}s...`);
            log(logFile, `Attempt ${attempt} failed, retrying in ${backoff}s`);
            await new Promise((r) => setTimeout(r, backoff * 1000));
          }
          attempt++;
        }

        if (!success) {
          console.log(`❌ ${task.title} (failed after ${MAX_RETRIES} attempts)`);
          log(logFile, `Failed: ${task.id} after ${MAX_RETRIES} attempts`);
          process.exit(1);
        }

        // Check if agent closed the task
        const updated = await store.get(task.id);
        if (updated?.status !== "done") {
          console.log(`⚠️  Agent did not close task ${task.id}`);
          log(logFile, `Warning: agent did not close task ${task.id}`);
        }

        console.log(`✅ ${task.title}`);
        log(logFile, `Completed: ${task.id}`);
      }
    };

    await runLoop();

    if (watchMode) {
      console.log("💤 Waiting for new tasks...");
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        const ready = await store.getReady(scopeId);
        if (ready.length > 0) {
          await runLoop();
          console.log("💤 Waiting for new tasks...");
        }
      }
    }

    console.log("");
    console.log(`All tasks complete. (${new Date().toISOString()})`);
    log(logFile, "All tasks complete");
  });

program.parse();
