/**
 * The model-facing `find` tool: Pi-compatible file discovery by glob. It uses
 * the packaged ripgrep binary through the subprocess seam, includes hidden
 * files, respects `.gitignore`, and excludes VCS metadata.
 *
 * @module @deepseek-ai/dsh-tool-fs-search/find
 */

import { sep } from 'node:path'
import { minimatch } from 'minimatch'
import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, SearchResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import { GLOB_VCS_EXCLUDES } from './glob.ts'
import { runRipgrep, toWorkdirRelative } from './search-core.ts'
import { globSearchMeta, searchViewFromMeta } from './presentation.ts'

/** Default number of paths one `find` call returns. */
export const FIND_MAX_RESULTS = 1000

/** Resolved `find`-tool caps. */
export interface FindToolCaps {
  /** Max paths one call returns. */
  maxResults: number
  /** Max bytes of serialized `presentationMeta`. */
  maxMetaBytes: number
  /** Cap on the complete raw `rg` stdout the tool parses. */
  rawOutputMaxBytes: number
  /** Terminate-escalation grace period (ms). */
  graceMs: number
  /** Cap on the retained stderr diagnostic tail. */
  stderrMaxBytes: number
  /** Cooperative tool-call budget (ms). */
  timeoutMs: number
}

/** Validated `find` arguments. */
export interface FindInput {
  pattern: string
  path?: string
  limit: number
}

/**
 * Validate the `find` arguments.
 * @param args - schema-validated arguments.
 * @returns the accepted input with the per-call limit clamped to the tool cap.
 */
export function parseFindArgs(args: { pattern: string; path?: string; limit?: number }): FindInput {
  if (args.pattern.trim().length === 0) throw new ToolArgsError(['pattern must be a non-empty string'])
  if (args.path !== undefined && args.path.trim().length === 0) throw new ToolArgsError(['path must be a non-empty string when given'])
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1)) {
    throw new ToolArgsError(['limit must be a positive integer when given'])
  }
  return {
    pattern: args.pattern,
    ...args.path !== undefined ? { path: args.path } : {},
    limit: Math.min(args.limit ?? FIND_MAX_RESULTS, FIND_MAX_RESULTS),
  }
}

/**
 * Build the `rg --files` argv for one `find` call. `.gitignore` is respected
 * (no `--no-ignore`), hidden files are included, and VCS metadata is excluded.
 * The positive pattern is applied in-process: ripgrep's own `--glob` would
 * re-include ignored paths.
 * @param input - validated arguments.
 * @returns the ripgrep arguments (without the executable).
 */
export function buildFindCommand(input: FindInput): string[] {
  const parts = [
    '--files',
    '--hidden',
    '--no-require-git',
    '--sort=path',
    ...GLOB_VCS_EXCLUDES.flatMap(name => [
      `--glob=!**/${name}`,
      `--glob=!**/${name}/**`,
    ]),
  ]
  if (input.path !== undefined) parts.push('--', input.path)
  return parts
}

/**
 * Format a completed `find` result for the model.
 * @param paths - the returned paths.
 * @param total - how many paths matched before the per-call limit.
 * @returns the model-facing text.
 */
export function formatFindOutput(paths: readonly string[], total: number): string {
  if (paths.length === 0) return 'No files found'
  const body = paths.join('\n')
  if (total <= paths.length) return body
  return `${body}\n\n(Showing ${paths.length} of ${total} paths. Narrow pattern or path to see more.)`
}

/**
 * Register the `find` tool.
 * @param ctx - the plugin context; execution uses its subprocess service.
 * @param caps - resolved caps.
 */
export function applyFindTool(ctx: Context, caps: FindToolCaps): void {
  const tool = defineTool({
    name: 'find',
    description: 'Search for files by glob pattern. Returns matching file paths relative to the search directory. '
      + 'Respects .gitignore. Output is truncated to the requested limit or the tool cap.',
    parameters: {
      pattern: {
        type: 'string',
        required: true,
        description: 'Glob pattern to match files, e.g. "*.ts", "**/*.json", or "src/**/*.spec.ts".',
      },
      path: { type: 'string', description: 'Directory to search in. Defaults to the session workspace; a relative path resolves against it.' },
      limit: { type: 'number', description: `Maximum number of results. Defaults to ${String(FIND_MAX_RESULTS)}.` },
    },
    timeoutMs: caps.timeoutMs,
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatFindOutput(value.paths, value.total) }],
      presentationMeta: (_args, value) => {
        const retained = {
          items: value.paths,
          seen: value.total,
          truncated: value.total > value.paths.length,
        }
        return globSearchMeta(retained, caps.maxMetaBytes)
      },
    },
    async execute(args, exec) {
      const input = parseFindArgs(args)
      const run = await runRipgrep(ctx, exec, 'find', buildFindCommand(input), caps.rawOutputMaxBytes, caps.graceMs, caps.stderrMaxBytes)
      if (run.noMatches) return { paths: [], total: 0 }
      const root = input.path === undefined ? '.' : toWorkdirRelative(input.path, run.workdir)
      const relativeToRoot = (path: string): string => {
        if (root === '.' || root === '') return path
        if (path === root) return '.'
        return path.startsWith(`${root}${sep}`) ? path.slice(root.length + 1) : path
      }
      const all = run.stdout
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => relativeToRoot(toWorkdirRelative(line, run.workdir)))
        .filter(path => minimatch(path.split('\\').join('/'), input.pattern, {
          dot: true,
          matchBase: !input.pattern.includes('/'),
        }))
      return { paths: all.slice(0, input.limit), total: all.length }
    },
    presentCall(args): GenericCallView {
      const where = args.path !== undefined ? ` in ${args.path}` : ''
      return { card: 'generic', title: `Find ${args.pattern}${where}`, kind: 'search', rawInput: args.pattern }
    },
    presentResult(_args, result: ToolResult): SearchResultView | undefined {
      if (result.isError) return undefined
      const view = searchViewFromMeta(result.meta)
      return view?.shape === 'paths' ? view : undefined
    },
  })
  ctx.tools.register(tool)
}
