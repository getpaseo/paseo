#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FileTaskStore } from "./task-store.js";
import type { AgentType, Task } from "./types.js";

const TASKS_DIR = resolve(process.cwd(), ".tasks");
const store = new FileTaskStore(TASKS_DIR);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf-8").trim();
}

const program = new Command()
  .name("task")
  .description("Minimal task management with dependency tracking")
  .version("0.1.0")
  .addHelpText(
    "after",
    `
Examples:
  # Create an epic with subtasks (hierarchical)
  task create "Build auth system"
  task create "Add login endpoint" --parent abc123
  task create "Add logout endpoint" --parent abc123

  # Create with body from stdin (use "-" for body)
  cat spec.md | task create "Implement feature" --body -

  # Update task body
  task update abc123 --body "New body content"
  cat updated-spec.md | task update abc123 --body -

  # Move task to different parent
  task move abc123 --parent def456
  task move abc123 --root  # make it a root task

  # Create with dependencies (separate from hierarchy)
  task create "Setup database"
  task create "Add user model" --deps def456

  # Assign to specific agent
  task create "Complex refactor" --assignee codex

  # Create as draft (not actionable until opened)
  task create "Future feature" --draft
  task open abc123  # make it actionable

  # View task with parent context
  task show abc123

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

Body vs Notes:
  The BODY is the task's markdown document - edit it while grooming/defining the task.
  NOTES are timestamped entries added during implementation to document progress.

  - While defining a task: edit the body with "task update <id> --body ..."
  - While implementing: add notes with "task note <id> ..."
  - When done: add a final note explaining what was done, then close
`
  );

program
  .command("create <title>")
  .description("Create a new task")
  .option("-b, --body <text>", "Task body (use '-' to read from stdin)")
  .option("--deps <ids>", "Comma-separated dependency IDs")
  .option("--parent <id>", "Parent task ID (for hierarchy)")
  .option("--assignee <agent>", "Agent to assign (claude or codex)")
  .option("--draft", "Create as draft (not actionable)")
  .action(async (title, opts) => {
    let body = opts.body ?? "";
    if (body === "-") {
      body = await readStdin();
    }

    const task = await store.create(title, {
      body,
      deps: opts.deps
        ? opts.deps.split(",").map((s: string) => s.trim())
        : [],
      parentId: opts.parent,
      status: opts.draft ? "draft" : "open",
      assignee: opts.assignee as AgentType | undefined,
    });

    console.log(task.id);
  });

program
  .command("list")
  .alias("ls")
  .description("List all tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("--roots", "Show only root tasks (no parent)")
  .action(async (opts) => {
    const tasks = await store.list();
    let filtered = opts.status
      ? tasks.filter((t) => t.status === opts.status)
      : tasks;

    if (opts.roots) {
      filtered = filtered.filter((t) => !t.parentId);
    }

    for (const t of filtered) {
      const deps = t.deps.length ? ` <- [${t.deps.join(", ")}]` : "";
      const assignee = t.assignee ? ` @${t.assignee}` : "";
      const parent = t.parentId ? ` ^${t.parentId}` : "";
      console.log(`${t.id}  [${t.status}]  ${t.title}${assignee}${parent}${deps}`);
    }
  });

program
  .command("show <id>")
  .description("Show task details with parent context")
  .action(async (id) => {
    const task = await store.get(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }

    // Get ancestors (parent chain from immediate to root)
    const ancestors = await store.getAncestors(id);

    // Print ancestors first (root to immediate parent)
    if (ancestors.length > 0) {
      console.log("# Parent Context\n");
      for (const ancestor of ancestors.reverse()) {
        console.log(`## ${ancestor.title} (${ancestor.id}) [${ancestor.status}]`);
        if (ancestor.body) {
          console.log(`\n${ancestor.body}`);
        }
        console.log("");
      }
      console.log("---\n");
    }

    // Print current task
    console.log(`# ${task.title}\n`);
    console.log(`id: ${task.id}`);
    console.log(`status: ${task.status}`);
    console.log(`created: ${task.created}`);
    if (task.assignee) {
      console.log(`assignee: ${task.assignee}`);
    }
    if (task.parentId) {
      console.log(`parent: ${task.parentId}`);
    }
    if (task.deps.length) {
      console.log(`deps: [${task.deps.join(", ")}]`);
    }
    if (task.body) {
      console.log(`\n${task.body}`);
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
  .description("Show task hierarchy with dependencies")
  .action(async (id) => {
    const root = await store.get(id);
    if (!root) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }

    // Build a map of all tasks for dependency lookups
    const allTasks = await store.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    // Print a task line with optional dependency info
    const printTask = (task: Task, prefix: string, connector: string) => {
      const assignee = task.assignee ? ` @${task.assignee}` : "";
      console.log(
        `${prefix}${connector}${task.id} [${task.status}] ${task.title}${assignee}`
      );
      // Print dependencies on next line with arrow
      if (task.deps.length > 0) {
        const depNames = task.deps
          .map((depId) => {
            const dep = taskMap.get(depId);
            return dep ? `${dep.title} (${depId})` : depId;
          })
          .join(", ");
        const depPrefix = prefix + (connector === "└── " ? "    " : "│   ");
        console.log(`${depPrefix}→ depends on: ${depNames}`);
      }
    };

    // Print root task
    const rootAssignee = root.assignee ? ` @${root.assignee}` : "";
    console.log(`${root.id} [${root.status}] ${root.title}${rootAssignee}`);
    if (root.deps.length > 0) {
      const depNames = root.deps
        .map((depId) => {
          const dep = taskMap.get(depId);
          return dep ? `${dep.title} (${depId})` : depId;
        })
        .join(", ");
      console.log(`→ depends on: ${depNames}`);
    }

    // Recursively print children (hierarchy)
    const printChildren = async (parentId: string, prefix: string) => {
      const children = await store.getChildren(parentId);
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const isLast = i === children.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const childPrefix = prefix + (isLast ? "    " : "│   ");

        printTask(child, prefix, connector);
        await printChildren(child.id, childPrefix);
      }
    };

    await printChildren(id, "");
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
  .command("update <id>")
  .description("Update task properties")
  .option("-t, --title <text>", "New title")
  .option("-b, --body <text>", "New body (use '-' to read from stdin)")
  .option("--assignee <agent>", "New assignee (claude or codex)")
  .action(async (id, opts) => {
    const task = await store.get(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }

    const changes: Partial<Task> = {};

    if (opts.title) {
      changes.title = opts.title;
    }

    if (opts.body !== undefined) {
      changes.body = opts.body === "-" ? await readStdin() : opts.body;
    }

    if (opts.assignee) {
      changes.assignee = opts.assignee as AgentType;
    }

    if (Object.keys(changes).length === 0) {
      console.error("No changes specified");
      process.exit(1);
    }

    await store.update(id, changes);
    console.log(`Updated: ${id}`);
  });

program
  .command("move <id>")
  .description("Move task to a different parent")
  .option("--parent <id>", "New parent task ID")
  .option("--root", "Make this a root task (remove parent)")
  .action(async (id, opts) => {
    if (!opts.parent && !opts.root) {
      console.error("Must specify --parent <id> or --root");
      process.exit(1);
    }

    if (opts.parent && opts.root) {
      console.error("Cannot specify both --parent and --root");
      process.exit(1);
    }

    await store.setParent(id, opts.root ? null : opts.parent);
    if (opts.root) {
      console.log(`${id} is now a root task`);
    } else {
      console.log(`${id} moved to parent ${opts.parent}`);
    }
  });

program
  .command("children <id>")
  .description("List direct children of a task")
  .action(async (id) => {
    const task = await store.get(id);
    if (!task) {
      console.error(`Task not found: ${id}`);
      process.exit(1);
    }

    const children = await store.getChildren(id);
    if (children.length === 0) {
      console.log("No children");
      return;
    }

    for (const child of children) {
      const assignee = child.assignee ? ` @${child.assignee}` : "";
      console.log(`${child.id}  [${child.status}]  ${child.title}${assignee}`);
    }
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

  // Build parent context from ancestor chain
  const ancestors = await store.getAncestors(task.id);
  let parentContext = "";
  if (ancestors.length > 0) {
    parentContext = "# Parent Context\n\n";
    for (const ancestor of ancestors.reverse()) {
      parentContext += `## ${ancestor.title} (${ancestor.id})\n`;
      if (ancestor.body) {
        parentContext += `\n${ancestor.body}\n`;
      }
      parentContext += "\n";
    }
    parentContext += "---\n\n";
  }

  let scopeContext = "";
  if (scopeId && !ancestors.some((a) => a.id === scopeId)) {
    const scope = await store.get(scopeId);
    if (scope) {
      scopeContext = `Scope: ${scope.title} (${scopeId})
${scope.body ? `\n${scope.body}\n` : ""}`;
    }
  }

  return `Working directory: ${process.cwd()}
${scopeContext}${parentContext}
# YOUR TASK (${task.id}): ${task.title}

${task.body || "(no body)"}

---

STEPS:
1. UNDERSTAND CONTEXT FIRST - Before any implementation:
   - Run \`task show ${task.id}\` to see full context with parent chain
   - Run \`task children ${task.id}\` to see subtasks if any
   - Run \`task closed${scopeArg}\` to see completed sibling tasks
   - Understand what's been done, what decisions were made, what's planned
2. Implement the task described above
3. Add a note documenting what you did: \`task note ${task.id} "what you did"\`
4. Mark complete: \`task close ${task.id}\`

COMMANDS:
- \`task show <id>\` - view task details with parent context
- \`task children <id>\` - list subtasks
- \`task update <id> --body "..."\` - update task body (for grooming/clarifying)
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
