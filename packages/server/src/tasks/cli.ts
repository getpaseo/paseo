#!/usr/bin/env node
import { Command } from "commander";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, openSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { FileTaskStore } from "./task-store.js";
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
  .command("tree <id>")
  .description("Show task hierarchy with dependencies")
  .action(async (id) => {
    const root = await store.get(id);
    if (!root) {
      process.stderr.write(`Task not found: ${id}\n`);
      process.exit(1);
    }

    // Build a map of all tasks for dependency lookups
    const allTasks = await store.list();
    const taskMap = new Map(allTasks.map((t) => [t.id, t]));

    // Print a task line with optional dependency info
    const printTask = (task: Task, prefix: string, connector: string) => {
      const assignee = task.assignee ? ` @${task.assignee}` : "";
      const priority = task.priority !== undefined ? ` !${task.priority}` : "";
      process.stdout.write(
        `${prefix}${connector}${task.id} [${task.status}] ${task.title}${priority}${assignee}\n`
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
        process.stdout.write(`${depPrefix}→ depends on: ${depNames}\n`);
      }
    };

    // Print root task
    const rootAssignee = root.assignee ? ` @${root.assignee}` : "";
    const rootPriority = root.priority !== undefined ? ` !${root.priority}` : "";
    process.stdout.write(`${root.id} [${root.status}] ${root.title}${rootPriority}${rootAssignee}\n`);
    if (root.deps.length > 0) {
      const depNames = root.deps
        .map((depId) => {
          const dep = taskMap.get(depId);
          return dep ? `${dep.title} (${depId})` : depId;
        })
        .join(", ");
      process.stdout.write(`→ depends on: ${depNames}\n`);
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
}

function getAgentConfig(model: ModelName): AgentConfig {
  if (model.startsWith("gpt-")) {
    return { cli: "codex", model };
  }
  // Claude CLI accepts aliases directly: haiku, sonnet, opus
  return { cli: "claude", model };
}

function runAgentWithModel(
  prompt: string,
  model: ModelName,
  logFile: string
): { success: boolean; output: string } {
  const config = getAgentConfig(model);
  let args: string[];

  if (config.cli === "claude") {
    args = ["--dangerously-skip-permissions"];
    if (config.model) {
      args.push("--model", config.model);
    }
    args.push("-p", prompt);
  } else {
    args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      "-c",
      "model_reasoning_effort=\"medium\"",
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

  let acceptanceCriteriaText = "";
  if (task.acceptanceCriteria.length > 0) {
    acceptanceCriteriaText = "\n## Acceptance Criteria\n\n";
    for (const criterion of task.acceptanceCriteria) {
      acceptanceCriteriaText += `- [ ] ${criterion}\n`;
    }
  }

  let notesText = "";
  if (task.notes.length > 0) {
    notesText = "\n## Notes\n";
    for (const note of task.notes) {
      notesText += `\n**${note.timestamp}**\n${note.content}\n`;
    }
  }

  return `Working directory: ${process.cwd()}
${scopeContext}${parentContext}
# Task: ${task.title}

${task.body || "(no body)"}
${acceptanceCriteriaText}${notesText}`;
}

function makePlannerPrompt(task: Task, context: string, iteration: number): string {
  return `${context}

---

You are a PLANNER agent. You ORCHESTRATE work - you do NOT do the work yourself.

Your job is to organize tasks so that WORKER agents can accomplish the top-level acceptance criteria.

Current iteration: ${iteration}

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
- \`task show ${task.id}\` - view task details with parent context
- \`task list\` - see all tasks
- \`task tree ${task.id}\` - see full task hierarchy
- \`task children ${task.id}\` - list subtasks
- \`task ready\` - see what's ready to work on
- \`task create "title" --parent <id> --body "..." --accept "criterion"\` - create task (any level)
- \`task update <id> --title "..." --body "..." --accept "criterion"\` - update task
- \`task note <id> "content"\` - add planning notes
- \`task delete <id>\` - remove a task that's no longer needed
- \`task fail <id>\` - mark task as failed if catastrophically stuck

## Your Scope

You can reorganize ANY task under this scope. The TOP-LEVEL task's acceptance criteria are IMMUTABLE - they are the north star. Everything else can be:

- Broken down into subtasks
- Deleted if no longer relevant
- Reordered/reprioritized
- Updated with better acceptance criteria

User steering notes override the task body - follow them.

Always keep the top-level goal in mind when reorganizing.

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

DO NOT implement tasks. Only plan and organize.
When done planning, simply exit. Do not mark tasks as done.
`;
}

function makeWorkerPrompt(task: Task, context: string, iteration: number): string {
  return `${context}

---

You are a WORKER agent implementing this task.

Current iteration: ${iteration}

IMPORTANT RULES:
- You CANNOT mark this task as done (task close is forbidden for you)
- You MUST add a note documenting what you did: \`task note ${task.id} "WORKER: what you did"\`
- You CAN use \`task show ${task.id}\` to see full context
- You CAN use \`task children ${task.id}\` to see subtasks

Focus on implementing the task. The acceptance criteria will be verified by a separate judge agent.

When you've done your best work, add a note explaining what you did and exit.
`;
}

function makeJudgePrompt(task: Task): string {
  let criteriaText = "";
  if (task.acceptanceCriteria.length > 0) {
    criteriaText = "## Acceptance Criteria to Verify\n\n";
    for (let i = 0; i < task.acceptanceCriteria.length; i++) {
      criteriaText += `${i + 1}. ${task.acceptanceCriteria[i]}\n`;
    }
  } else {
    criteriaText = "No explicit acceptance criteria defined. Verify the task is reasonably complete based on the title and body.\n";
  }

  return `You are a JUDGE agent. Your ONLY job is to verify if acceptance criteria are met.

# Task: ${task.title}

${task.body || "(no body)"}

${criteriaText}

## Your Instructions

1. For EACH criterion, verify if it is satisfied by running commands and checking actual state
2. You may run commands to check (e.g., \`npm run test\`, \`npm run typecheck\`, check file existence, run the code)
3. After checking all criteria, output your verdict

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

## Output Format - CRITICAL

You MUST output one of these XML tags at the END of your response. This is REQUIRED for the system to parse your verdict:

If ALL criteria pass:
<VERDICT>DONE</VERDICT>

If ANY criterion fails:
<VERDICT>NOT_DONE</VERDICT>

If you do not include this exact XML tag, your verdict will not be recorded and the task will retry.

Then add a note to the task with your findings:
\`task note ${task.id} "JUDGE: [DONE/NOT_DONE] - details..."\`
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
  .option("--judge <model>", "Judge model (default: haiku)", "haiku")
  .option("--max-iterations <n>", "Max worker/judge iterations per task (0 = no limit)", "0")
  .option("-w, --watch", "Keep running and wait for new tasks")
  .action(async (scopeId: string | undefined, opts) => {
    const enablePlanner = opts.plan;
    const plannerModel = opts.planner as ModelName;
    const judgeModel = opts.judge as ModelName;
    const maxIterations = parseInt(opts.maxIterations, 10);
    const watchMode = opts.watch;
    const logFile = getLogFile();

    process.stdout.write("Task Runner started (planner/worker/judge loop)\n");
    process.stdout.write(`Planner: ${enablePlanner ? plannerModel : "disabled"}\n`);
    process.stdout.write(`Judge: ${judgeModel}\n`);
    process.stdout.write(`Max iterations: ${maxIterations === 0 ? "unlimited" : maxIterations}\n`);
    if (scopeId) process.stdout.write(`Scope: ${scopeId}\n`);
    process.stdout.write(`Log: ${logFile}\n`);
    process.stdout.write("\n");

    log(logFile, `Started with planner=${enablePlanner ? plannerModel : "disabled"} judge=${judgeModel} maxIter=${maxIterations} scope=${scopeId || "all"}`);

    const runPlanner = async (task: Task, reason: string): Promise<boolean> => {
      log(logFile, `[PLANNER] Running ${plannerModel} (${reason})...`);
      const context = await buildTaskContext(task, scopeId);
      const plannerPrompt = makePlannerPrompt(task, context, 1);
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
        const workerModel = (task.assignee === "codex" ? "gpt-5.2" : "sonnet") as ModelName;

        log(logFile, `\n=== Starting task: ${task.id} - ${task.title} ===`);
        await store.start(task.id);

        // Worker/Judge loop
        let iteration = 1;
        let taskDone = false;
        let consecutiveNotDone = 0;
        let lastSeenSteerCount = task.notes.filter(n => n.content.startsWith("STEER:")).length;

        while ((maxIterations === 0 || iteration <= maxIterations) && !taskDone) {
          const iterLabel = maxIterations === 0 ? `${iteration}` : `${iteration}/${maxIterations}`;
          log(logFile, `[WORKER] Iteration ${iterLabel} with ${workerModel}...`);

          // Check for new steering notes before worker runs
          const preTask = await store.get(task.id);
          if (!preTask) break;
          const currentSteerCount = preTask.notes.filter(n => n.content.startsWith("STEER:")).length;
          if (enablePlanner && currentSteerCount > lastSeenSteerCount) {
            const newSteers = preTask.notes.filter(n => n.content.startsWith("STEER:")).slice(lastSeenSteerCount);
            log(logFile, `[STEER] New steering note detected - triggering planner`);
            lastSeenSteerCount = currentSteerCount;
            const shouldRestart = await runPlanner(preTask, `steering: ${newSteers.map(n => n.content).join("; ")}`);
            if (shouldRestart) {
              const updatedTask = await store.get(task.id);
              if (updatedTask && updatedTask.status === "in_progress") {
                await store.update(task.id, { status: "open" });
              }
              break;
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
            // Only replan after 5 consecutive NOT_DONEs
            if (enablePlanner && consecutiveNotDone >= 5) {
              log(logFile, `[JUDGE] ${consecutiveNotDone} consecutive NOT_DONE - triggering planner`);
              const currentTask = await store.get(task.id);
              if (currentTask) {
                const shouldRestart = await runPlanner(currentTask, `${consecutiveNotDone} consecutive NOT_DONE`);
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
