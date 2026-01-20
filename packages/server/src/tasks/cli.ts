#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FileTaskStore } from "./task-store.js";
import {
  computeExecutionOrder,
  buildSortedChildrenMap,
} from "./execution-order.js";
import type { AgentType, ModelName, Task } from "./types.js";

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

Body vs Notes:
  The BODY is the task's markdown document - edit it while grooming/defining the task.
  NOTES are timestamped entries added during implementation to document progress.

  - While defining a task: edit the body with "task update <id> --body ..."
  - While implementing: add notes with "task note <id> ..."
  - When done: add a final note explaining what was done, then close

---

The Run Command (task run):

  The run command executes an agent loop that works until acceptance criteria are met.
  This can run for hours, days, or weeks for large epics.

  Basic usage:
    task run <scope-id>              # Run without planner (task must be well-defined)
    task run <scope-id> --plan       # Run with planner (for larger epics)

  Without --plan: The scoped task runs in a worker/judge loop. The worker implements,
  the judge verifies. If not done, it loops. No breakdown happens - the task must be
  atomic and well-defined from the start.

  With --plan: The planner first breaks down the scope into subtasks, then workers
  execute leaf tasks while the planner can reorganize as needed. Use this for epics
  where you define WHAT you want but not HOW to achieve it.

  When replanning happens:
    - At the start (initial breakdown)
    - When a task fails 5+ times (something is wrong with the approach)
    - When you add a steering note (task steer <scope-id> "new direction")

  Monitoring a running loop:
    task plan <scope-id>             # See execution timeline and progress
    task show <task-id>              # Check specific task details
    tail -f task-run.*.log           # Follow the live log

  Steering mid-run:
    task steer <scope-id> "focus on X first"
    task steer <scope-id> "skip Y, it's not needed"
    task steer <scope-id> "run e2e tests every iteration"

  Steering triggers an immediate replan. Use it to course-correct without stopping.

Writing Good Acceptance Criteria:

  Acceptance criteria determine when a task is DONE. They must be specific enough
  that agents cannot "cheat" by taking shortcuts.

  Bad (agents can game these):
    - "tests pass"              → could delete tests, skip them, or weaken assertions
    - "code works"              → subjective, unverifiable
    - "feature complete"        → vague

  Good (specific and non-gameable):
    - "npm test exits 0 with 0 failures and 0 skipped"
    - "test count >= 150 (no deleting tests)"
    - "coverage does not decrease from baseline"
    - "npm run typecheck exits 0"
    - "GET /api/users returns 200 with JSON array"

  Philosophy: Specify the floor (minimum requirements) without capping the ceiling.
  "Zero failures, zero skipped" is strict but doesn't prevent adding more tests.

  For test-related tasks, consider:
    --accept "npm test exits 0"
    --accept "no test files deleted"
    --accept "no .skip or test.todo added"
    --accept "no assertions removed or weakened"

Acceptance Criteria vs Body Guidance:

  Acceptance criteria = required OUTPUT (must-haves, verified at the end)
  Body guidance = HOW to approach the work (instructions for the planner)

  Acceptance criteria examples (verifiable end-state):
    - "PR created with description and test plan"
    - "Branch name follows convention: feat/<name>"
    - "npm run typecheck exits 0"

  Body guidance examples (process instructions):
    - "Split work by module"
    - "Commit after each subtask"
    - "Run typecheck after each change"

  The planner reads body guidance and propagates it into subtask acceptance criteria.
  For example, if the body says "commit after each chunk of work", the planner adds
  "git status shows clean working tree" to each subtask's criteria.

  This makes process requirements verifiable at each step, not just at the end.
`
  );

program
  .command("create <title>")
  .alias("add")
  .description("Create a new task")
  .option("-b, --body <text>", "Task body (use '-' to read from stdin)")
  .option("--deps <ids>", "Comma-separated dependency IDs")
  .option("--parent <id>", "Parent task ID (for hierarchy)")
  .option("--assignee <agent>", "Agent to assign (claude or codex)")
  .option("--draft", "Create as draft (not actionable)")
  .option("-p, --priority <n>", "Priority (lower number = higher priority)")
  .option("-a, --accept <criterion>", "Acceptance criterion (repeatable)", (val: string, prev: string[]) => prev.concat(val), [] as string[])
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
      acceptanceCriteria: opts.accept,
      priority: opts.priority ? parseInt(opts.priority, 10) : undefined,
    });

    process.stdout.write(`${task.id}\n`);
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
      const priority = t.priority !== undefined ? ` !${t.priority}` : "";
      process.stdout.write(`${t.id}  [${t.status}]  ${t.title}${priority}${assignee}${parent}${deps}\n`);
    }
  });

program
  .command("show <id>")
  .description("Show task details with parent context")
  .action(async (id) => {
    const task = await store.get(id);
    if (!task) {
      process.stderr.write(`Task not found: ${id}\n`);
      process.exit(1);
    }

    // Get ancestors (parent chain from immediate to root)
    const ancestors = await store.getAncestors(id);

    // Print ancestors first (root to immediate parent)
    if (ancestors.length > 0) {
      process.stdout.write("# Parent Context\n\n");
      for (const ancestor of ancestors.reverse()) {
        process.stdout.write(`## ${ancestor.title} (${ancestor.id}) [${ancestor.status}]\n`);
        if (ancestor.body) {
          process.stdout.write(`\n${ancestor.body}\n`);
        }
        process.stdout.write("\n");
      }
      process.stdout.write("---\n\n");
    }

    // Print current task
    process.stdout.write(`# ${task.title}\n\n`);
    process.stdout.write(`id: ${task.id}\n`);
    process.stdout.write(`status: ${task.status}\n`);
    process.stdout.write(`created: ${task.created}\n`);
    if (task.priority !== undefined) {
      process.stdout.write(`priority: ${task.priority}\n`);
    }
    if (task.assignee) {
      process.stdout.write(`assignee: ${task.assignee}\n`);
    }
    if (task.parentId) {
      process.stdout.write(`parent: ${task.parentId}\n`);
    }
    if (task.deps.length) {
      process.stdout.write(`deps: [${task.deps.join(", ")}]\n`);
    }
    if (task.body) {
      process.stdout.write(`\n${task.body}\n`);
    }
    if (task.acceptanceCriteria.length) {
      process.stdout.write("\n## Acceptance Criteria\n\n");
      for (const criterion of task.acceptanceCriteria) {
        process.stdout.write(`- [ ] ${criterion}\n`);
      }
    }
    if (task.notes.length) {
      process.stdout.write("\n## Notes\n");
      for (const note of task.notes) {
        process.stdout.write(`\n**${note.timestamp}**\n${note.content}\n`);
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
      const priority = t.priority !== undefined ? ` !${t.priority}` : "";
      process.stdout.write(`${t.id}  ${t.title}${priority}${assignee}\n`);
    }
  });

program
  .command("blocked")
  .description("List tasks blocked by unresolved deps")
  .option("--scope <id>", "Scope to epic/task dep tree")
  .action(async (opts) => {
    const tasks = await store.getBlocked(opts.scope);
    for (const t of tasks) {
      process.stdout.write(`${t.id}  ${t.title}  <- [${t.deps.join(", ")}]\n`);
    }
  });

program
  .command("closed")
  .description("List completed tasks")
  .option("--scope <id>", "Scope to epic/task dep tree")
  .action(async (opts) => {
    const tasks = await store.getClosed(opts.scope);
    for (const t of tasks) {
      process.stdout.write(`${t.id}  ${t.title}\n`);
    }
  });

program
  .command("plan [scope]")
  .alias("tree")
  .description("Show execution timeline (tree view by default)")
  .option("--flat", "Show flat list instead of tree")
  .option("-d, --depth <n>", "Limit tree depth (0 = root only)")
  .action(async (scopeId: string | undefined, opts) => {
    const { timeline, orderMap, blocked } = await computeExecutionOrder(
      store,
      scopeId
    );
    const allTasks = await store.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));
    const maxDepth = opts.depth !== undefined ? parseInt(opts.depth, 10) : Infinity;

    const formatDeps = (task: Task): string => {
      if (task.deps.length === 0) return "";
      return ` (deps: ${task.deps.join(", ")})`;
    };

    if (opts.flat) {
      // Flat list view
      const printTask = (t: Task, idx: number) => {
        const priority = t.priority !== undefined ? `!${t.priority} ` : "";
        const assignee = t.assignee ? ` @${t.assignee}` : "";
        const num = String(idx + 1).padStart(3, " ");
        const mark = t.status === "done" ? "✓" : " ";
        const deps = formatDeps(t);
        process.stdout.write(
          `${mark}${num}. ${priority}${t.id}  ${t.title}${assignee}${deps}\n`
        );
      };

      for (let i = 0; i < timeline.length; i++) {
        printTask(timeline[i], i);
      }
    } else {
      // Tree view (default)
      if (!scopeId) {
        process.stderr.write("Tree view requires a scope ID\n");
        process.exit(1);
      }

      const root = await store.get(scopeId);
      if (!root) {
        process.stderr.write(`Task not found: ${scopeId}\n`);
        process.exit(1);
      }

      const sortedChildrenMap = buildSortedChildrenMap(allTasks, orderMap);

      const printTask = (
        task: Task,
        prefix: string,
        connector: string,
        depth: number
      ) => {
        const assignee = task.assignee ? ` @${task.assignee}` : "";
        const priority =
          task.priority !== undefined ? ` !${task.priority}` : "";
        const mark = task.status === "done" ? "✓ " : "  ";
        const deps = formatDeps(task);
        process.stdout.write(
          `${mark}${prefix}${connector}${task.id} [${task.status}] ${task.title}${priority}${assignee}${deps}\n`
        );
      };

      // Print root
      const rootAssignee = root.assignee ? ` @${root.assignee}` : "";
      const rootPriority =
        root.priority !== undefined ? ` !${root.priority}` : "";
      const rootMark = root.status === "done" ? "✓ " : "  ";
      const rootDeps = formatDeps(root);
      process.stdout.write(
        `${rootMark}${root.id} [${root.status}] ${root.title}${rootPriority}${rootAssignee}${rootDeps}\n`
      );

      // Recursively print children in execution order
      const printChildren = (parentId: string, prefix: string, depth: number) => {
        if (depth >= maxDepth) return;
        const children = sortedChildrenMap.get(parentId) ?? [];
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          const isLast = i === children.length - 1;
          const connector = isLast ? "└── " : "├── ";
          const childPrefix = prefix + (isLast ? "    " : "│   ");

          printTask(child, prefix, connector, depth);
          printChildren(child.id, childPrefix, depth + 1);
        }
      };

      printChildren(scopeId, "", 0);
    }

    if (blocked.size > 0) {
      process.stdout.write(`\n... +${blocked.size} blocked/unreachable\n`);
    }
    if (timeline.length === 0) {
      process.stdout.write("No tasks.\n");
    }
  });

program
  .command("dep <id> <dep-id>")
  .description("Add dependency (id depends on dep-id)")
  .action(async (id, depId) => {
    await store.addDep(id, depId);
    process.stdout.write(`Added: ${id} -> ${depId}\n`);
  });

program
  .command("undep <id> <dep-id>")
  .description("Remove dependency")
  .action(async (id, depId) => {
    await store.removeDep(id, depId);
    process.stdout.write(`Removed: ${id} -> ${depId}\n`);
  });

const VALID_STATUSES = ["draft", "open", "in_progress", "done", "failed"] as const;

program
  .command("update <id>")
  .alias("edit")
  .description("Update task properties")
  .option("-t, --title <text>", "New title")
  .option("-b, --body <text>", "New body (use '-' to read from stdin)")
  .option("--assignee <agent>", "New assignee (claude or codex)")
  .option("-p, --priority <n>", "Priority (lower number = higher priority)")
  .option("-s, --status <status>", "Set status (draft, open, in_progress, done, failed)")
  .option("--clear-acceptance", "Clear all acceptance criteria (combine with -a to replace)")
  .option("-a, --accept <criterion>", "Add acceptance criterion (repeatable)", (val: string, prev: string[]) => prev.concat(val), [] as string[])
  .action(async (id, opts) => {
    const task = await store.get(id);
    if (!task) {
      process.stderr.write(`Task not found: ${id}\n`);
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

    if (opts.priority !== undefined) {
      changes.priority = parseInt(opts.priority, 10);
    }

    if (opts.status) {
      if (!VALID_STATUSES.includes(opts.status)) {
        process.stderr.write(`Invalid status: ${opts.status}. Must be one of: ${VALID_STATUSES.join(", ")}\n`);
        process.exit(1);
      }
      changes.status = opts.status as Task["status"];
    }

    // Handle acceptance criteria: --clear-acceptance clears, -a adds
    if (opts.clearAcceptance) {
      changes.acceptanceCriteria = [...opts.accept];
    } else {
      for (const criterion of opts.accept) {
        await store.addAcceptanceCriteria(id, criterion);
      }
    }

    if (Object.keys(changes).length === 0 && opts.accept.length === 0 && !opts.clearAcceptance) {
      process.stderr.write("No changes specified\n");
      process.exit(1);
    }

    if (Object.keys(changes).length > 0) {
      await store.update(id, changes);
    }
    process.stdout.write(`Updated: ${id}\n`);
  });

program
  .command("move <id>")
  .description("Move task to a different parent")
  .option("--parent <id>", "New parent task ID")
  .option("--root", "Make this a root task (remove parent)")
  .action(async (id, opts) => {
    if (!opts.parent && !opts.root) {
      process.stderr.write("Must specify --parent <id> or --root\n");
      process.exit(1);
    }

    if (opts.parent && opts.root) {
      process.stderr.write("Cannot specify both --parent and --root\n");
      process.exit(1);
    }

    await store.setParent(id, opts.root ? null : opts.parent);
    if (opts.root) {
      process.stdout.write(`${id} is now a root task\n`);
    } else {
      process.stdout.write(`${id} moved to parent ${opts.parent}\n`);
    }
  });

program
  .command("children <id>")
  .description("List direct children of a task")
  .action(async (id) => {
    const task = await store.get(id);
    if (!task) {
      process.stderr.write(`Task not found: ${id}\n`);
      process.exit(1);
    }

    const children = await store.getChildren(id);
    if (children.length === 0) {
      process.stdout.write("No children\n");
      return;
    }

    for (const child of children) {
      const assignee = child.assignee ? ` @${child.assignee}` : "";
      const priority = child.priority !== undefined ? ` !${child.priority}` : "";
      process.stdout.write(`${child.id}  [${child.status}]  ${child.title}${priority}${assignee}\n`);
    }
  });

program
  .command("delete <id>")
  .alias("rm")
  .description("Delete a task")
  .action(async (id) => {
    await store.delete(id);
    process.stdout.write(`Deleted: ${id}\n`);
  });

program
  .command("note <id> <content>")
  .description("Add a timestamped note (timestamp is automatic, don't include one)")
  .action(async (id, content) => {
    await store.addNote(id, content);
    process.stdout.write("Note added\n");
  });

program
  .command("steer <id> <content>")
  .description("Add a steering note to guide the agent loop (triggers replan)")
  .action(async (id, content) => {
    await store.addNote(id, `STEER: ${content}`);
    process.stdout.write("Steering note added\n");
  });

program
  .command("open <id>")
  .description("Mark draft as open (actionable)")
  .action(async (id) => {
    await store.open(id);
    process.stdout.write(`${id} -> open\n`);
  });

program
  .command("start <id>")
  .description("Mark as in progress")
  .action(async (id) => {
    await store.start(id);
    process.stdout.write(`${id} -> in_progress\n`);
  });

program
  .command("close <id>")
  .alias("done")
  .description("Mark as done")
  .action(async (id) => {
    await store.close(id);
    process.stdout.write(`${id} -> done\n`);
  });

program
  .command("fail <id>")
  .description("Mark as failed (catastrophically stuck)")
  .action(async (id) => {
    await store.fail(id);
    process.stdout.write(`${id} -> failed\n`);
  });

// Agent runner

interface AgentConfig {
  cli: "claude" | "codex";
  model?: string;
  effort?: string;
}

// Parse model string like "gpt-5.2-xhigh" into model and effort
function parseModelString(modelStr: string): { model: string; effort?: string } {
  // GPT models with effort: gpt-5.2-low, gpt-5.2-medium, gpt-5.2-high, gpt-5.2-xhigh
  const effortLevels = ["low", "medium", "high", "xhigh"];
  for (const effort of effortLevels) {
    if (modelStr.endsWith(`-${effort}`)) {
      return {
        model: modelStr.slice(0, -(effort.length + 1)),
        effort,
      };
    }
  }
  return { model: modelStr };
}

function getAgentConfig(modelStr: string): AgentConfig {
  const { model, effort } = parseModelString(modelStr);
  if (model.startsWith("gpt-")) {
    return { cli: "codex", model, effort };
  }
  // Claude CLI accepts aliases directly: haiku, sonnet, opus
  return { cli: "claude", model };
}

function runAgentWithModel(
  prompt: string,
  modelStr: string,
  logFile: string
): { success: boolean; output: string } {
  const config = getAgentConfig(modelStr);
  let args: string[];

  if (config.cli === "claude") {
    args = ["--dangerously-skip-permissions"];
    if (config.model) {
      args.push("--model", config.model);
    }
    args.push("-p", prompt);
  } else {
    const effort = config.effort ?? "medium";
    args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c",
      `model_reasoning_effort="${effort}"`,
    ];
    if (config.model) {
      args.push("--model", config.model);
    }
    args.push(prompt);
  }

  const result = spawnSync(config.cli, args, {
    stdio: ["inherit", "pipe", "pipe"],
    cwd: process.cwd(),
    maxBuffer: 50 * 1024 * 1024,
  });

  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  const output = stdout + stderr;

  // Append to log file for history
  appendFileSync(logFile, output);

  return { success: result.status === 0, output };
}

async function buildTaskContext(task: Task, scopeId?: string): Promise<string> {
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
      scopeContext = `Scope: ${scope.title} (${scopeId})\n${scope.body ? `\n${scope.body}\n` : ""}`;
    }
  }

  return `Working directory: ${process.cwd()}
${scopeContext}${parentContext}
${task.raw}`;
}

function makePlannerPrompt(task: Task, context: string, reason: string): string {
  return `${context}

---

You are a PLANNER agent. You ORCHESTRATE work - you do NOT do the work yourself.

Your job is to organize tasks so that WORKER agents can accomplish the top-level acceptance criteria.

## Why you were called

${reason}

## Planning vs Working

As a planner you MAY:
- Look at file structure and test patterns to write good acceptance criteria
- Read the task tree to understand what's been done and what needs reorganizing
- Check naming conventions to make specific, verifiable criteria

As a planner you must NOT:
- Investigate WHY bugs happen (workers will do this)
- Debug or trace through code (workers will do this)
- Try to understand root causes (workers will do this)
- Fix or implement anything (workers will do this)

Take the task descriptions AS GIVEN and create well-organized subtasks for workers to investigate and implement.

## Task CLI Commands

### Understanding the plan
- \`task plan ${task.id}\` - **START HERE**: shows full execution timeline (done ✓ then pending in order)
- \`task tree ${task.id}\` - see task hierarchy with dependencies (parent → children)
- \`task show <id>\` - view task details, body, acceptance criteria, and notes
- \`task children <id>\` - list direct children of a task
- \`task ready --scope ${task.id}\` - see what's ready to work on right now
- \`task blocked --scope ${task.id}\` - see what's blocked and why

### Navigating the task tree

The tree has two relationships:
1. **Parent/children** (hierarchy): \`--parent <id>\` groups tasks. Use \`task tree\` and \`task children\`.
2. **Dependencies** (ordering): \`--deps <id>\` blocks execution. Shown as \`← [dep1, dep2]\` in tree output.

To understand what workers will actually implement, find the **leaf tasks** (tasks with no children).
Parent tasks are just containers - workers execute leaf tasks.

**Always navigate down to leaves:**
\`\`\`
task tree ${task.id}      # see full structure
task children <parent>    # drill into a branch
task show <leaf>          # read the actual work item
\`\`\`

When planning, ensure leaf tasks have:
- Clear acceptance criteria (verifiable by judge)
- Correct dependencies (won't run until deps are done)
- Appropriate priority (controls order among siblings)

### Modifying tasks
- \`task create "title" --parent <id> --body "..." --accept "criterion" -p <priority>\` - create task
- \`task update <id> --title "..." --body "..." -p <priority>\` - update task properties
- \`task update <id> --accept "criterion"\` - add acceptance criterion
- \`task update <id> --clear-acceptance -a "new criterion"\` - replace all acceptance criteria
- \`task delete <id>\` - remove a task permanently
- \`task note <id> "content"\` - add planning notes
- \`task fail <id>\` - mark task as failed if catastrophically stuck

### Priority (-p flag)
Priority controls execution order. **Lower number = higher priority** (executed first).
- \`-p 0\` - critical/urgent, do immediately
- \`-p 1\` - high priority
- \`-p 2\` - normal priority
- (no priority) - lowest, done after all prioritized tasks

When user steers with urgent changes, set priority on new tasks to ensure they run BEFORE existing tasks.
Example: \`task create "Fix critical bug" --parent ${task.id} -p 0 --accept "..."\`
Example: \`task update <id> -p 0\` - bump existing task to run next

## Your Scope

You can reorganize ANY task under this scope. The TOP-LEVEL task's acceptance criteria are IMMUTABLE - they are the north star. Everything else can be:

- **Deleted** if no longer relevant (use \`task delete <id>\`)
- **Reprioritized** to change execution order (use \`task update <id> -p <n>\`)
- **Broken down** into subtasks
- **Updated** with better acceptance criteria

**You are FREE to delete tasks and start over.** If the plan isn't working, throw it away. If user steers in a new direction, delete obsolete tasks rather than leaving them in the queue.

User steering notes (STEER:) override the task body - follow them immediately by:
1. Creating new tasks with high priority (-p 0 or -p 1)
2. Deleting tasks that are now obsolete
3. Adjusting priorities on existing tasks if needed

## Writing Good Acceptance Criteria

Acceptance criteria MUST be:
- **Verifiable**: Can be checked programmatically or with a clear command (e.g., "npm run test passes", "file X exists", "API returns 200")
- **Objective**: No subjective judgments like "code is clean" or "good performance" - use measurable thresholds
- **Specific**: Reference exact files, functions, endpoints, or behaviors
- **Complete**: Cover edge cases, error handling, and integration points

Bad examples:
- "Code is well-written" (subjective)
- "Feature works" (vague)
- "Tests pass" (which tests?)

Good examples:
- "npm run test passes with 0 failures"
- "GET /api/users returns 200 with JSON array"
- "File src/utils/parser.ts exports parseConfig function"
- "Running \`node cli.js --help\` prints usage information"

## Propagating Requirements to Subtasks

Both body guidance AND acceptance criteria must be propagated to subtasks. Break them
down so requirements are verified at each step, not deferred until the end.

**Propagate body guidance** (process instructions → subtask criteria):

Example: Body says "commit after each chunk of work"
  → Add to EACH subtask: --accept "git status shows clean working tree"

Example: Body says "run typecheck after each change"
  → Add to EACH subtask: --accept "npm run typecheck exits 0"

**Propagate acceptance criteria** (scope them to the subtask's module/area):

Example: Top-level says "no test.skip added"
  → Subtask for module X: --accept "no test.skip in src/modules/X/**"

Example: Top-level says "npm test passes with 0 failures"
  → Subtask for auth module: --accept "npm test src/auth passes with 0 failures"

Example: Top-level says "coverage >= 80%"
  → Subtask for utils: --accept "coverage for src/utils >= 80%"

This ensures requirements are enforced incrementally. Don't wait until the end to
verify - by then it's too late to fix without rework.

## TDD Pattern

When the top-level task mentions "TDD" or "test-driven", you MUST structure subtasks as test-first pairs:

1. **Write failing test** task (comes first)
   - Acceptance criteria: test file exists AND test fails for the RIGHT reason
   - The "right reason" means the test fails because the feature doesn't exist yet, NOT because of syntax errors, import errors, or unrelated failures

2. **Make test pass** task (depends on the failing test task)
   - Acceptance criteria: the specific test passes AND overall test suite passes

Example breakdown for "Add user login endpoint (TDD)":

\`\`\`
task create "Write failing test for POST /api/login" --parent {parent_id} \\
  --body "Write a test that calls POST /api/login with valid credentials and expects a JWT token response" \\
  --accept "File src/auth/login.test.ts exists" \\
  --accept "npm test fails with error message containing 'login' or 'api/login'" \\
  --accept "Test failure is due to missing endpoint (404 or 'not found'), NOT syntax/import errors"

task create "Implement login endpoint to pass test" --parent {parent_id} --deps {previous_task_id} \\
  --body "Implement POST /api/login to make the test pass" \\
  --accept "npm test -- src/auth/login.test.ts passes" \\
  --accept "POST /api/login with valid credentials returns 200 with JWT token"
\`\`\`

Key points:
- The failing test task MUST verify the test fails for the correct reason (missing feature, not broken code)
- The implementation task depends on the test task (enforced ordering)
- Each pair focuses on ONE specific behavior

## Your Options

1. If the current task is simple enough to implement directly, add a note explaining why and exit
2. If it needs breakdown, create subtasks with clear, verifiable acceptance criteria
3. If TDD is requested, use the test-first pair pattern above
4. If other tasks in the tree need reorganization based on what's been learned, do that
5. If a task is catastrophically stuck with no clear path forward (repeated failures WITHOUT progress), mark it failed

Note: Multiple iterations are fine if there's progress. Only mark failed if truly stuck with no way forward.

## Before You Exit - Sanity Check

ALWAYS run these checks before finishing:

1. **Run \`task plan ${task.id}\`** - verify the execution order makes sense
2. **Check priorities** - are urgent/steering tasks at the top (low priority numbers)?
3. **Check acceptance criteria** - does every pending task have clear, verifiable criteria?
4. **Clean up obsolete tasks** - delete anything that's no longer relevant

If something looks wrong, fix it before exiting.

DO NOT implement tasks. Only plan and organize.
When done planning, simply exit. Do not mark tasks as done.
`;
}

function makeWorkerPrompt(task: Task, context: string, iteration: number): string {
  return `${context}

---

You are a WORKER agent implementing this task.

Current iteration: ${iteration}

## How to Work

Make MEANINGFUL progress toward the acceptance criteria:
- If the task can be completed in one iteration, do it all
- If it's too large, make the largest meaningful chunk of progress you can
- Read the notes from previous iterations - don't repeat work, BUILD on it
- A judge will verify your work against the acceptance criteria and leave feedback

The judge's feedback (in notes) tells you exactly what's still failing. Address it.

## Rules

- You CANNOT mark this task as done (a judge verifies completion)
- You MUST add a note documenting what you did: \`task note ${task.id} "WORKER: what you did"\`
- You CAN use \`task show ${task.id}\` to refresh context

When you've made meaningful progress, add a note explaining what you did and exit.
`;
}

function makeJudgePrompt(task: Task): string {
  return `You are a JUDGE agent. Your ONLY job is to verify if acceptance criteria are met.

${task.raw}

## Your Instructions

1. For EACH criterion, verify if it is satisfied by running commands and checking actual state
2. You may run commands to check (e.g., \`npm run test\`, \`npm run typecheck\`, check file existence, run the code)
3. After checking all criteria, output your verdict

## FAIL EARLY for NOT_DONE

For large tasks, the worker may yield after implementing incremental progress. Don't waste time
checking every criterion if it's obvious the task isn't complete.

**Fail early strategy:**
- Start with a quick smoke test (e.g., does \`npm run typecheck\` or \`npm test\` pass?)
- If the smoke test fails badly, you can immediately return NOT_DONE
- If you find ANY failing criterion, you can immediately return NOT_DONE
- No need to check all criteria if you already know the verdict is NOT_DONE

**Example:** If you run \`npm test\` and see 15 failures, don't methodically check each acceptance
criterion - just note the failures and return NOT_DONE.

## For DONE: Full Verification Required

Unlike NOT_DONE, you CANNOT shortcut DONE. To mark something DONE:
- You MUST verify EVERY acceptance criterion explicitly
- You MUST run the actual commands to check (not assume from context)
- You MUST confirm each criterion passes before concluding DONE
- No shortcuts, no assumptions, no "it probably works"

## CRITICAL: No Excuses Policy

You are evaluating RESULTS, not effort or intent. The following are NOT acceptable reasons to mark something DONE:

- "The agent tried their best" - IRRELEVANT
- "It mostly works" - NOT_DONE
- "The environment wasn't set up correctly" - NOT_DONE (setup is part of the task)
- "This feature requires X which isn't available" - NOT_DONE (making it available is part of the task)
- "The agent documented why it couldn't complete" - NOT_DONE
- "It's a good start" - NOT_DONE
- "The core functionality works" - Check ALL criteria, not just "core"
- "This is blocked by external factors" - NOT_DONE

The ONLY question: Does the acceptance criterion pass when verified? Yes or No.

If an agent left notes explaining why something couldn't be done, IGNORE THE EXPLANATION. Just check: is the criterion met?

## REQUIRED: Provide Feedback to the Worker

After verifying, you MUST leave feedback for the worker by adding a note. The worker will read
this note in the next iteration - it's their ONLY way to know what went wrong and what's missing.

\`\`\`
task note ${task.id} "JUDGE: [verdict] - [observed facts only]"
\`\`\`

**CRITICAL: State ONLY observed facts. Do NOT provide solutions or debugging advice.**

You are a verification agent, not a debugging assistant. The worker has access to the task body
which contains the full context and instructions. Your job is to report WHAT failed, not HOW to fix it.

DO:
- State which tests failed and their error messages
- State which commands returned non-zero exit codes
- State which files are missing or have wrong content
- Quote exact error output

DO NOT:
- Suggest fixes or solutions
- Explain why something might have failed
- Offer debugging strategies
- Recommend approaches or alternatives

BAD: "3 tests fail - try mocking the database connection"
BAD: "typecheck fails - you need to add the missing type annotation"
GOOD: "3 tests fail: auth.test.ts:42 'expected 200, got 401', user.test.ts:15 'timeout after 5000ms'"
GOOD: "npm run typecheck exit 1: src/api.ts:23 - Property 'foo' does not exist on type 'Bar'"

For non-test criteria, state observable facts about the code:
GOOD: "validateUser() in auth.ts:45-72 duplicates validateAdmin() in admin.ts:23-50 (criterion: no code duplication)"
GOOD: "processOrder() is 187 lines (criterion: functions under 50 lines)"
GOOD: "UserService calls database directly at line 34 (criterion: all DB access via repository layer)"
GOOD: "auth module exports JWT secret at line 12 (criterion: secrets not exported from modules)"

The worker has the task body with full instructions. Just tell them what's broken.

## Output Format - CRITICAL

You MUST output one of these XML tags at the END of your response:

If ALL criteria pass:
<VERDICT>DONE</VERDICT>

If ANY criterion fails:
<VERDICT>NOT_DONE</VERDICT>

If you do not include this exact XML tag, your verdict will not be recorded.
`;
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
  process.stdout.write(`[${timestamp}] ${message}\n`);
}

function parseJudgeVerdict(output: string): "DONE" | "NOT_DONE" | null {
  // Find all matches and return the last one (in case reasoning mentions verdict earlier)
  const matches = [...output.matchAll(/<VERDICT>(DONE|NOT_DONE)<\/VERDICT>/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1] as "DONE" | "NOT_DONE";
}

program
  .command("run [scope]")
  .description("Run agent loop on tasks with planner/worker/judge")
  .option("--plan", "Enable planner agent")
  .option("--planner <model>", "Planner model (default: gpt-5.2)", "gpt-5.2")
  .option("--worker-model <model>", "Worker model (default: sonnet). For GPT models, append effort: gpt-5.2-high", "sonnet")
  .option("--judge-model <model>", "Judge model (default: haiku)", "haiku")
  .option("--max-iterations <n>", "Max worker/judge iterations per task (0 = no limit)", "0")
  .option("-w, --watch", "Keep running and wait for new tasks")
  .action(async (scopeId: string | undefined, opts) => {
    const enablePlanner = opts.plan;
    const plannerModel = opts.planner as string;
    const baseWorkerModel = opts.workerModel as string;
    const judgeModel = opts.judgeModel as string;
    const maxIterations = parseInt(opts.maxIterations, 10);
    const watchMode = opts.watch;
    const logFile = getLogFile();

    process.stdout.write("Task Runner started (planner/worker/judge loop)\n");
    process.stdout.write(`Planner: ${enablePlanner ? plannerModel : "disabled"}\n`);
    process.stdout.write(`Worker: ${baseWorkerModel}\n`);
    process.stdout.write(`Judge: ${judgeModel}\n`);
    process.stdout.write(`Max iterations: ${maxIterations === 0 ? "unlimited" : maxIterations}\n`);
    if (scopeId) process.stdout.write(`Scope: ${scopeId}\n`);
    process.stdout.write(`Log: ${logFile}\n`);
    process.stdout.write("\n");

    log(logFile, `Started with planner=${enablePlanner ? plannerModel : "disabled"} worker=${baseWorkerModel} judge=${judgeModel} maxIter=${maxIterations} scope=${scopeId || "all"}`);

    const runPlanner = async (task: Task, reason: string): Promise<boolean> => {
      log(logFile, `[PLANNER] Running ${plannerModel} (${reason})...`);
      const context = await buildTaskContext(task, scopeId);
      const plannerPrompt = makePlannerPrompt(task, context, reason);
      runAgentWithModel(plannerPrompt, plannerModel, logFile);

      // Check if planner created subtasks for this task
      const children = await store.getChildren(task.id);
      if (children.some((c) => c.status !== "done")) {
        log(logFile, `[PLANNER] Task has pending children, will process those first`);
        return true; // Signal to restart loop
      }

      // Check if planner marked task as failed
      const updatedTask = await store.get(task.id);
      if (updatedTask?.status === "failed") {
        log(logFile, `[PLANNER] Marked task as failed`);
        return true; // Signal to continue to next task
      }

      return false;
    };

    const runTaskLoop = async (): Promise<void> => {
      // First check for in_progress tasks (resuming from crash)
      const allTasks = await store.list();
      let candidates = scopeId
        ? [await store.get(scopeId), ...(await store.getDescendants(scopeId))].filter(Boolean) as Task[]
        : allTasks;

      const inProgress = candidates.filter((t) => t.status === "in_progress");
      if (inProgress.length > 0) {
        log(logFile, `Found ${inProgress.length} in_progress task(s) from previous run, resuming...`);
        for (const t of inProgress) {
          await store.update(t.id, { status: "open" });
          log(logFile, `Reset ${t.id} to open`);
        }
      }

      // Step 1: Initial planner run on scope root (if enabled)
      if (enablePlanner && scopeId) {
        const scopeTask = await store.get(scopeId);
        if (scopeTask) {
          log(logFile, `[PLANNER] Initial planning on scope root...`);
          await runPlanner(scopeTask, "initial planning");
          log(logFile, `[DEBUG] Planner finished, continuing to worker loop`);
        }
      }

      log(logFile, `[DEBUG] Entering worker loop`);

      // Step 2: Worker/Judge loop on ready tasks
      while (true) {
        log(logFile, `[DEBUG] Checking for ready tasks...`);
        const ready = await store.getReady(scopeId);
        log(logFile, `[DEBUG] Found ${ready.length} ready tasks`);
        if (ready.length === 0) {
          log(logFile, `[DEBUG] No ready tasks, exiting loop`);
          break;
        }

        const task = ready[0];
        // CLI --worker-model takes precedence, then task assignee, then default
        let workerModel = baseWorkerModel;
        if (!workerModel && task.assignee) {
          workerModel = task.assignee === "codex" ? "gpt-5.2-codex" : task.assignee;
        }
        const canUpgrade = workerModel === "sonnet"; // Only upgrade if starting from sonnet

        log(logFile, `\n=== Starting task: ${task.id} - ${task.title} ===`);
        await store.start(task.id);

        // Worker/Judge loop
        let iteration = 1;
        let taskDone = false;
        let consecutiveNotDone = 0;
        // Track steering notes on scope (not leaf task) since that's where user adds them
        const scopeTaskForSteer = scopeId ? await store.get(scopeId) : null;
        let lastSeenSteerCount = scopeTaskForSteer?.notes.filter(n => n.content.startsWith("STEER:")).length ?? 0;

        while ((maxIterations === 0 || iteration <= maxIterations) && !taskDone) {
          const iterLabel = maxIterations === 0 ? `${iteration}` : `${iteration}/${maxIterations}`;
          log(logFile, `[WORKER] Iteration ${iterLabel} with ${workerModel}...`);

          // Check for new steering notes on scope before worker runs
          if (enablePlanner && scopeId) {
            const freshScope = await store.get(scopeId);
            if (freshScope) {
              const currentSteerCount = freshScope.notes.filter(n => n.content.startsWith("STEER:")).length;
              if (currentSteerCount > lastSeenSteerCount) {
                const newSteers = freshScope.notes
                  .filter(n => n.content.startsWith("STEER:"))
                  .slice(lastSeenSteerCount)
                  .map(n => n.content.replace(/^STEER:\s*/, ""));
                log(logFile, `[STEER] New steering note detected - triggering planner`);
                lastSeenSteerCount = currentSteerCount;
                const reason = `User steering: ${newSteers.join("; ")}`;
                const shouldRestart = await runPlanner(freshScope, reason);
                if (shouldRestart) {
                  const updatedTask = await store.get(task.id);
                  if (updatedTask && updatedTask.status === "in_progress") {
                    await store.update(task.id, { status: "open" });
                  }
                  break;
                }
              }
            }
          }

          // Refresh task context (notes may have been added)
          const freshTask = await store.get(task.id);
          if (!freshTask) break;

          const freshContext = await buildTaskContext(freshTask, scopeId);
          const workerPrompt = makeWorkerPrompt(freshTask, freshContext, iteration);
          runAgentWithModel(workerPrompt, workerModel, logFile);

          // Step 3: Judge
          log(logFile, `[JUDGE] Verifying with ${judgeModel}...`);
          const judgeTask = await store.get(task.id);
          if (!judgeTask) break;

          const judgePrompt = makeJudgePrompt(judgeTask);
          const judgeResult = runAgentWithModel(judgePrompt, judgeModel, logFile);

          const verdict = parseJudgeVerdict(judgeResult.output);
          log(logFile, `[JUDGE] Verdict: ${verdict || "UNKNOWN"}`);

          if (verdict === "DONE") {
            await store.close(task.id);
            log(logFile, `✅ Task ${task.id} completed`);
            taskDone = true;
            consecutiveNotDone = 0;
          } else {
            consecutiveNotDone++;
            // Upgrade to opus on first NOT_DONE (if not already using opus)
            if (canUpgrade && workerModel === "sonnet") {
              workerModel = "opus";
              log(logFile, `[WORKER] Upgrading to opus after NOT_DONE`);
            }
            // Only replan after 5 consecutive NOT_DONEs - use scope for bird's eye view
            if (enablePlanner && consecutiveNotDone >= 5 && scopeId) {
              log(logFile, `[JUDGE] ${consecutiveNotDone} consecutive NOT_DONE on ${task.id} - triggering planner`);
              const scopeTask = await store.get(scopeId);
              if (scopeTask) {
                const reason = `task ${task.id} "${task.title}" got ${consecutiveNotDone} consecutive NOT_DONE`;
                const shouldRestart = await runPlanner(scopeTask, reason);
                consecutiveNotDone = 0;
                if (shouldRestart) {
                  // Planner created subtasks or marked failed, restart the main loop
                  const updatedTask = await store.get(task.id);
                  if (updatedTask && updatedTask.status === "in_progress") {
                    await store.update(task.id, { status: "open" });
                  }
                  break;
                }
              }
            }
            iteration++;
          }
        }

        if (!taskDone && maxIterations > 0) {
          const finalTask = await store.get(task.id);
          if (finalTask && finalTask.status === "in_progress") {
            log(logFile, `⚠️  Task ${task.id} not completed after ${maxIterations} iterations`);
            // Reset to open so it can be picked up again (planner may have adjusted things)
            await store.update(task.id, { status: "open" });
          }
        }
      }
    };

    await runTaskLoop();

    if (watchMode) {
      process.stdout.write("💤 Waiting for new tasks...\n");
      while (true) {
        await new Promise((r) => setTimeout(r, 5000));
        const ready = await store.getReady(scopeId);
        if (ready.length > 0) {
          await runTaskLoop();
          process.stdout.write("💤 Waiting for new tasks...\n");
        }
      }
    }

    process.stdout.write("\n");
    process.stdout.write(`All tasks complete. (${new Date().toISOString()})\n`);
    log(logFile, "All tasks complete");
  });

program.parse();
