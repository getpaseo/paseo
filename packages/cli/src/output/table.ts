/**
 * Table renderer for CLI output.
 *
 * Renders structured data as aligned ASCII tables with optional color support.
 */

import chalk, { type ChalkInstance } from 'chalk'
import type {
  AnyCommandResult,
  ColumnDef,
  OutputOptions,
  OutputSchema,
} from './types.js'

// ANSI escape code regex for stripping colors when measuring width
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g

/** Strip ANSI escape codes from a string */
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '')
}

/** Get visible string length (excluding ANSI codes) */
function visibleLength(str: string): number {
  return stripAnsi(str).length
}

/** Pad a cell to the specified width with alignment */
function padCell(
  cell: string,
  width: number,
  align: 'left' | 'right' | 'center'
): string {
  const visible = visibleLength(cell)
  const padding = Math.max(0, width - visible)

  switch (align) {
    case 'right':
      return ' '.repeat(padding) + cell
    case 'center': {
      const left = Math.floor(padding / 2)
      const right = padding - left
      return ' '.repeat(left) + cell + ' '.repeat(right)
    }
    case 'left':
    default:
      return cell + ' '.repeat(padding)
  }
}

/** Apply a chalk color to a string */
function applyColor(str: string, colorName: string): string {
  // Map color names to chalk methods
  const colorMap: Record<string, ChalkInstance> = {
    red: chalk.red,
    green: chalk.green,
    blue: chalk.blue,
    yellow: chalk.yellow,
    cyan: chalk.cyan,
    magenta: chalk.magenta,
    white: chalk.white,
    gray: chalk.gray,
    grey: chalk.grey,
    dim: chalk.dim,
    bold: chalk.bold,
  }

  const colorFn = colorMap[colorName]
  return colorFn ? colorFn(str) : str
}

/** Extract value from item using field definition */
function getValue<T>(item: T, field: keyof T | ((item: T) => unknown)): unknown {
  return typeof field === 'function' ? field(item) : item[field]
}

/** Render a single table row */
function renderRow<T>(
  item: T,
  columns: ColumnDef<T>[],
  widths: number[],
  options: OutputOptions
): string {
  return columns
    .map((col, colIndex) => {
      const value = getValue(item, col.field)
      let cell = String(value ?? '')
      const width = widths[colIndex]

      // Apply color if enabled
      if (col.color && !options.noColor) {
        const colorName = col.color(value, item)
        if (colorName) {
          cell = applyColor(cell, colorName)
        }
      }

      return padCell(cell, width, col.align ?? 'left')
    })
    .join('  ')
}

/** Render header row */
function renderHeader<T>(
  columns: ColumnDef<T>[],
  widths: number[],
  options: OutputOptions
): string {
  const headerRow = columns
    .map((col, i) => padCell(col.header, widths[i], col.align ?? 'left'))
    .join('  ')

  return options.noColor ? headerRow : chalk.bold(headerRow)
}

/** Calculate column widths based on content and hints */
function calculateWidths<T>(
  data: T[],
  columns: ColumnDef<T>[],
  includeHeaders: boolean
): number[] {
  return columns.map((col) => {
    // Start with header width if including headers
    let maxWidth = includeHeaders ? col.header.length : 0

    // Check all data values
    for (const item of data) {
      const value = getValue(item, col.field)
      const str = String(value ?? '')
      maxWidth = Math.max(maxWidth, visibleLength(str))
    }

    // Apply width hint if specified (minimum width)
    if (col.width) {
      maxWidth = Math.max(maxWidth, col.width)
    }

    return maxWidth
  })
}

/** Render a list result as a table */
export function renderTable<T>(
  result: AnyCommandResult<T>,
  options: OutputOptions
): string {
  const { schema } = result
  const data = result.type === 'list' ? result.data : [result.data]

  if (data.length === 0) {
    return ''
  }

  const columns = schema.columns as ColumnDef<T>[]
  const includeHeaders = !options.noHeaders
  const widths = calculateWidths(data, columns, includeHeaders)

  const lines: string[] = []

  // Add header row
  if (includeHeaders) {
    lines.push(renderHeader(columns, widths, options))
  }

  // Add data rows
  for (const item of data) {
    lines.push(renderRow(item, columns, widths, options))
  }

  return lines.join('\n')
}

/** Render just a table header (for streaming) */
export function renderTableHeader<T>(
  schema: OutputSchema<T>,
  options: OutputOptions,
  widths?: number[]
): string {
  const columns = schema.columns
  const actualWidths = widths ?? columns.map((col) => col.width ?? col.header.length)
  return renderHeader(columns, actualWidths, options)
}

/** Render just a table row (for streaming) */
export function renderTableRow<T>(
  item: T,
  schema: OutputSchema<T>,
  options: OutputOptions,
  widths?: number[]
): string {
  const columns = schema.columns
  const actualWidths = widths ?? columns.map((col) => col.width ?? col.header.length)
  return renderRow(item, columns, actualWidths, options)
}
