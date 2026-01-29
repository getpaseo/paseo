# Output Architecture Design

This document describes the output abstraction layer for the Paseo CLI, enabling structured data output with multiple format options.

## Overview

Commands should return **structured data objects**, not formatted strings. A separate rendering layer transforms this data into the requested output format. This separation enables:

1. **Testability** - Tests verify structured data without parsing strings
2. **Flexibility** - Easy to add new output formats
3. **Consistency** - Uniform formatting across all commands

### Inspiration from Existing CLIs

This design draws from patterns in established CLIs:

- **Docker CLI** - Uses Go templates with `--format` flag, provides `table` and `json` directives
- **kubectl** - Supports `-o json`, `-o yaml`, `-o wide`, and custom columns
- **GitHub CLI** - Uses `--json` with field selection, plus `--jq` and `--template` post-processors

Sources:
- [Docker CLI Formatting](https://docs.docker.com/engine/cli/formatting/)
- [kubectl Output Formatting](https://www.baeldung.com/ops/kubectl-output-format)
- [GitHub CLI Formatting](https://cli.github.com/manual/gh_help_formatting)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Command Execution                        │
│                                                             │
│   parseArgs() → executeCommand() → CommandResult<T>         │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                     Output Renderer                          │
│                                                             │
│   CommandResult<T> + OutputOptions → formatted string       │
│                                                             │
│   Renderers:                                                │
│   - TableRenderer (default, human-readable)                 │
│   - JsonRenderer (machine-readable)                         │
│   - YamlRenderer (machine-readable)                         │
│   - QuietRenderer (minimal, IDs only)                       │
└─────────────────────────────────┬───────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                        stdout/stderr                         │
└─────────────────────────────────────────────────────────────┘
```

## Type Definitions

### Output Options

```typescript
type OutputFormat = 'table' | 'json' | 'yaml'

interface OutputOptions {
  format: OutputFormat
  quiet: boolean       // Minimal output (IDs only)
  noHeaders: boolean   // Omit table headers
  noColor: boolean     // Disable color output
}
```

### Command Result

Commands return a `CommandResult<T>` that contains structured data plus metadata for formatting:

```typescript
interface CommandResult<T> {
  /** The structured data to render */
  data: T

  /** Schema describing how to render this data */
  schema: OutputSchema<T>
}

interface OutputSchema<T> {
  /** Field to use for quiet mode (--quiet outputs just this) */
  idField: keyof T | ((item: T) => string)

  /** Column definitions for table output */
  columns: ColumnDef<T>[]

  /** Optional: transform data before JSON/YAML output */
  serialize?: (data: T) => unknown
}

interface ColumnDef<T> {
  /** Header text for the column */
  header: string

  /** Field key or accessor function */
  field: keyof T | ((item: T) => unknown)

  /** Optional width hint (characters) */
  width?: number

  /** Optional alignment */
  align?: 'left' | 'right' | 'center'

  /** Optional color function */
  color?: (value: unknown, item: T) => string | undefined
}
```

### Single vs List Results

Commands may return either a single item or a list:

```typescript
// For commands returning a single item (e.g., `agent show <id>`)
interface SingleResult<T> extends CommandResult<T> {
  type: 'single'
  data: T
}

// For commands returning a list (e.g., `agent list`)
interface ListResult<T> extends CommandResult<T[]> {
  type: 'list'
  data: T[]
}

// Union type for command handlers
type AnyCommandResult<T> = SingleResult<T> | ListResult<T>
```

## Example: Agent List Command

### Data Type

```typescript
interface AgentListItem {
  id: string
  title: string
  status: 'running' | 'idle' | 'error'
  provider: string
  cwd: string
  createdAt: string
}
```

### Schema Definition

```typescript
const agentListSchema: OutputSchema<AgentListItem> = {
  idField: 'id',

  columns: [
    {
      header: 'ID',
      field: 'id',
      width: 8,
    },
    {
      header: 'TITLE',
      field: 'title',
      width: 30,
    },
    {
      header: 'STATUS',
      field: 'status',
      color: (value) => {
        switch (value) {
          case 'running': return 'green'
          case 'idle': return 'dim'
          case 'error': return 'red'
          default: return undefined
        }
      },
    },
    {
      header: 'PROVIDER',
      field: 'provider',
    },
    {
      header: 'CWD',
      field: 'cwd',
    },
  ],
}
```

### Command Implementation

```typescript
async function agentListCommand(options: CommandOptions): Promise<ListResult<AgentListItem>> {
  const client = await connectToDaemon(options)
  const agents = client.listAgents()

  const data = agents.map(agent => ({
    id: agent.agentId,
    title: agent.title ?? '(untitled)',
    status: mapLifecycleStatus(agent.lifecycle),
    provider: agent.agentType,
    cwd: agent.cwd,
    createdAt: agent.createdAt,
  }))

  return {
    type: 'list',
    data,
    schema: agentListSchema,
  }
}
```

## Renderer Implementations

### Table Renderer

The default renderer for human-readable output:

```typescript
function renderTable<T>(result: ListResult<T>, options: OutputOptions): string {
  const { data, schema } = result

  if (data.length === 0) {
    return '' // Or a "no items" message
  }

  const rows: string[][] = []

  // Add header row (unless noHeaders)
  if (!options.noHeaders) {
    rows.push(schema.columns.map(col => col.header))
  }

  // Add data rows
  for (const item of data) {
    const row = schema.columns.map(col => {
      const value = typeof col.field === 'function'
        ? col.field(item)
        : item[col.field]
      return String(value ?? '')
    })
    rows.push(row)
  }

  // Calculate column widths
  const widths = schema.columns.map((col, i) => {
    const maxContent = Math.max(...rows.map(row => stripAnsi(row[i]).length))
    return col.width ? Math.max(col.width, maxContent) : maxContent
  })

  // Format and join
  return rows.map((row, rowIndex) => {
    return row.map((cell, colIndex) => {
      const col = schema.columns[colIndex]
      const width = widths[colIndex]
      let formatted = padCell(cell, width, col.align ?? 'left')

      // Apply color (skip header row)
      if (rowIndex > 0 && col.color && !options.noColor) {
        const colorName = col.color(cell, data[rowIndex - 1])
        if (colorName) {
          formatted = applyColor(formatted, colorName)
        }
      }

      return formatted
    }).join('  ')
  }).join('\n')
}
```

### JSON Renderer

```typescript
function renderJson<T>(result: AnyCommandResult<T>, options: OutputOptions): string {
  const { data, schema } = result
  const output = schema.serialize ? schema.serialize(data) : data
  return JSON.stringify(output, null, 2)
}
```

### YAML Renderer

```typescript
import YAML from 'yaml'

function renderYaml<T>(result: AnyCommandResult<T>, options: OutputOptions): string {
  const { data, schema } = result
  const output = schema.serialize ? schema.serialize(data) : data
  return YAML.stringify(output)
}
```

### Quiet Renderer

Returns only the ID field(s):

```typescript
function renderQuiet<T>(result: AnyCommandResult<T>, options: OutputOptions): string {
  const { data, schema } = result
  const getId = typeof schema.idField === 'function'
    ? schema.idField
    : (item: T) => String(item[schema.idField as keyof T])

  if (result.type === 'single') {
    return getId(data as T)
  }

  return (data as T[]).map(getId).join('\n')
}
```

## Error Output

Errors are handled separately from success output and always go to stderr:

```typescript
interface CommandError {
  code: string           // Machine-readable error code
  message: string        // Human-readable message
  details?: unknown      // Additional context
}

function renderError(error: CommandError, options: OutputOptions): string {
  if (options.format === 'json') {
    return JSON.stringify({ error }, null, 2)
  }

  if (options.format === 'yaml') {
    return YAML.stringify({ error })
  }

  // Table/default format
  return chalk.red(`Error: ${error.message}`)
}
```

## Streaming Output

For commands like `logs -f` and `attach`, streaming requires a different approach:

```typescript
interface StreamingResult<T> {
  type: 'stream'
  schema: OutputSchema<T>

  /** Async iterator yielding items as they arrive */
  stream: AsyncIterable<T>
}
```

### Streaming Renderer

```typescript
async function renderStream<T>(
  result: StreamingResult<T>,
  options: OutputOptions,
  write: (chunk: string) => void
): Promise<void> {
  const { stream, schema } = result

  // For JSON, output newline-delimited JSON (NDJSON)
  if (options.format === 'json') {
    for await (const item of stream) {
      write(JSON.stringify(item) + '\n')
    }
    return
  }

  // For table format, render each item as a row
  let headerWritten = false
  for await (const item of stream) {
    if (!headerWritten && !options.noHeaders) {
      write(renderTableHeader(schema) + '\n')
      headerWritten = true
    }
    write(renderTableRow(item, schema, options) + '\n')
  }
}
```

### NDJSON for Streaming

When `--format json` is used with streaming commands, output is newline-delimited JSON (NDJSON) for easy parsing:

```
{"timestamp":"2024-01-15T10:30:00Z","type":"stdout","content":"Hello"}
{"timestamp":"2024-01-15T10:30:01Z","type":"stdout","content":"World"}
```

This allows consumers to process output line-by-line without buffering the entire stream.

## Testing

### Testing Structured Data

Tests can directly verify the structured data without parsing formatted output:

```typescript
describe('agent list', () => {
  it('returns agents with correct structure', async () => {
    const result = await agentListCommand({ host: testHost })

    expect(result.type).toBe('list')
    expect(result.data).toHaveLength(2)
    expect(result.data[0]).toMatchObject({
      id: expect.any(String),
      title: 'Test Agent',
      status: 'running',
    })
  })

  it('uses correct schema for table output', async () => {
    const result = await agentListCommand({ host: testHost })

    expect(result.schema.idField).toBe('id')
    expect(result.schema.columns.map(c => c.header)).toEqual([
      'ID', 'TITLE', 'STATUS', 'PROVIDER', 'CWD'
    ])
  })
})
```

### Testing Renderers

Renderer tests verify formatting independently:

```typescript
describe('table renderer', () => {
  it('formats data as aligned table', () => {
    const result: ListResult<AgentListItem> = {
      type: 'list',
      data: [
        { id: 'abc123', title: 'Agent 1', status: 'running', ... },
        { id: 'def456', title: 'Agent 2', status: 'idle', ... },
      ],
      schema: agentListSchema,
    }

    const output = renderTable(result, { format: 'table', quiet: false, ... })

    expect(output).toContain('ID')
    expect(output).toContain('abc123')
    expect(output).toContain('Agent 1')
  })
})
```

### E2E Tests

E2E tests can verify both structured data (for correctness) and formatted output (for UX):

```typescript
// Verify JSON output is valid and contains expected data
test('agent list --format json', async () => {
  const output = await ctx.paseo('agent list --format json')
  const data = JSON.parse(output.stdout)

  expect(data).toBeInstanceOf(Array)
  expect(data[0]).toHaveProperty('id')
})

// Verify table output looks correct
test('agent list shows table headers', async () => {
  const output = await ctx.paseo('agent list')

  expect(output.stdout).toMatch(/ID\s+TITLE\s+STATUS/)
})
```

## Integration with Command Framework

### Global Options

Add output options to the root command:

```typescript
program
  .option('-f, --format <format>', 'Output format: table, json, yaml', 'table')
  .option('-q, --quiet', 'Minimal output (IDs only)')
  .option('--no-headers', 'Omit table headers')
  .option('--no-color', 'Disable colored output')
```

### Command Handler Wrapper

A wrapper function handles the rendering:

```typescript
function withOutput<T>(
  handler: (options: CommandOptions) => Promise<AnyCommandResult<T>>
) {
  return async (options: CommandOptions) => {
    try {
      const result = await handler(options)
      const output = render(result, options)
      process.stdout.write(output + '\n')
    } catch (error) {
      const errorOutput = renderError(toCommandError(error), options)
      process.stderr.write(errorOutput + '\n')
      process.exit(1)
    }
  }
}

// Usage
program
  .command('list')
  .description('List agents')
  .action(withOutput(agentListCommand))
```

## Implementation Plan

1. **Phase 1: Core Types**
   - Define `CommandResult`, `OutputSchema`, `ColumnDef` types
   - Implement basic table renderer
   - Implement JSON renderer

2. **Phase 2: Integration**
   - Add global output options to CLI
   - Create `withOutput` wrapper
   - Migrate `daemon status` command as proof of concept

3. **Phase 3: Full Coverage**
   - Add YAML renderer
   - Add quiet renderer
   - Migrate all existing commands

4. **Phase 4: Streaming**
   - Implement `StreamingResult` type
   - Add streaming renderers
   - Apply to `logs` and `attach` commands

## Open Questions

1. **Should we support Go templates like Docker/gh?** This adds flexibility but also complexity. For v1, predefined formats are likely sufficient.

2. **How to handle nested data in tables?** Options:
   - Flatten (e.g., `config.timeout` becomes `TIMEOUT` column)
   - Skip in table, include in JSON/YAML
   - Use nested tables for detail views

3. **Should quiet mode support custom fields?** e.g., `--quiet=title` to output titles instead of IDs.
