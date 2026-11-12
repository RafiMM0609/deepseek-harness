/**
 * Model-facing Pi-style multi-edit: one call carries a list of exact literal
 * replacements, all matched against the original file and applied atomically.
 * The tool name stays `edit` so a Pi preset can opt into Pi's schema without
 * changing the tool the model calls.
 *
 * @module @deepseek-ai/dsh-tool-fs/edit-pi
 */

import type { Context } from '@deepseek-ai/cordis'
import { ToolArgsError, defineTool } from '@deepseek-ai/dsh-tools'
import type { DiffCallView, DiffResultView, ToolResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import { computeHunkDiffs, diffsFromMeta } from './diff.ts'
import { remediateFsError } from './error.ts'
import { mutationResult } from './mutation-result.ts'
import { sessionResolveOptions } from './session-cwd.ts'
import type { FsSandboxController } from './sandbox.ts'

/** One Pi `edit` replacement. */
interface PiEdit {
  oldText: string
  newText: string
}

/** Validated Pi-style `edit` arguments. */
interface PiEditInput {
  filePath: string
  edits: PiEdit[]
}

/** The raw Pi-style `edit` arguments, plus the optional sandbox escalation fields. */
interface PiEditArgs {
  path: string
  edits: PiEdit[]
  sandbox_permissions?: string
  justification?: string
}

interface Replacement {
  matchIndex: number
  matchLength: number
  newText: string
}

/**
 * Validate the Pi schema constraints the schema DSL cannot express.
 * @param args - schema-validated Pi-style arguments.
 * @returns the validated file path and edit list.
 */
export function parsePiEditArgs(args: PiEditArgs): PiEditInput {
  if (args.path.trim().length === 0) throw new ToolArgsError(['path must be a non-empty string'])
  if (!Array.isArray(args.edits) || args.edits.length === 0) {
    throw new ToolArgsError(['edits must contain at least one replacement'])
  }
  for (const [index, edit] of args.edits.entries()) {
    if (typeof edit.oldText !== 'string' || edit.oldText.length === 0) {
      throw new ToolArgsError([`edits[${index}].oldText must be a non-empty string`])
    }
    if (typeof edit.newText !== 'string') {
      throw new ToolArgsError([`edits[${index}].newText must be a string`])
    }
  }
  return { filePath: args.path, edits: args.edits }
}

/** Split a leading UTF-8 BOM from decoded text. */
function splitBom(content: string): { bom: string; text: string } {
  return content.startsWith('\uFEFF')
    ? { bom: '\uFEFF', text: content.slice(1) }
    : { bom: '', text: content }
}

/** Normalize CRLF and lone CR line endings to LF for matching. */
export function normalizeToLf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Line ending of the line containing `offset`, used to restore inserted line breaks. */
function lineEndingAt(content: string, offset: number): '\r\n' | '\n' | '\r' {
  let lineFeed = content.indexOf('\n', offset)
  if (lineFeed === -1) lineFeed = content.lastIndexOf('\n', offset)
  if (lineFeed === -1) return content.includes('\r') ? '\r' : '\n'
  return content[lineFeed - 1] === '\r' ? '\r\n' : '\n'
}

/**
 * Apply replacements matched against the LF-normalized text back to the
 * original text, keeping untouched line endings byte-for-byte.
 * @param originalContent - the file text as read.
 * @param replacements - sorted, non-overlapping replacements in normalized offsets.
 * @returns the original text with every replacement applied.
 */
function applyReplacementsToOriginal(originalContent: string, replacements: readonly Replacement[]): string {
  let crlfBefore = 0
  let nextCrlf = originalContent.indexOf('\r\n')
  const toOriginal = (offset: number): number => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++
      nextCrlf = originalContent.indexOf('\r\n', nextCrlf + 2)
    }
    return offset + crlfBefore
  }

  const parts: string[] = []
  let endsWithCr = false
  const push = (part: string): void => {
    if (part.length === 0) return
    if (endsWithCr && part[0] === '\n') parts.push('\n')
    parts.push(part)
    endsWithCr = part[part.length - 1] === '\r'
  }
  let position = 0
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex)
    push(originalContent.slice(position, start))
    const ending = lineEndingAt(originalContent, start)
    push(ending === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', ending))
    position = toOriginal(replacement.matchIndex + replacement.matchLength)
  }
  push(originalContent.slice(position))
  return parts.join('')
}

/**
 * Match one `oldText` exactly once in the normalized content.
 * @param content - the normalized file text.
 * @param oldText - the normalized search text.
 * @param index - the edit's position in the call, for diagnostics.
 * @param total - how many edits the call carries.
 * @param path - the model-facing path, for diagnostics.
 * @returns the match offset and length.
 */
function uniqueMatch(content: string, oldText: string, index: number, total: number, path: string): { index: number; length: number } {
  const first = content.indexOf(oldText)
  if (first === -1) {
    throw new ToolArgsError([total === 1
      ? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
      : `Could not find edits[${index}] in ${path}. The oldText must match exactly including all whitespace and newlines.`])
  }
  if (content.indexOf(oldText, first + oldText.length) !== -1) {
    throw new ToolArgsError([total === 1
      ? `Found more than one occurrence of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
      : `Found more than one occurrence of edits[${index}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`])
  }
  return { index: first, length: oldText.length }
}

/**
 * Apply Pi's multi-edit contract to one file text: every replacement is
 * matched against the original file, must be unique, and must not overlap.
 * @param content - the file text as read.
 * @param edits - the validated replacement list.
 * @param path - the model-facing path, for diagnostics.
 * @returns the original text with edits applied, plus the normalized before/after diff basis.
 */
export function applyPiEdits(content: string, edits: readonly PiEdit[], path: string): {
  finalContent: string
  before: string
  after: string
} {
  const { bom, text } = splitBom(content)
  const before = normalizeToLf(text)
  const normalized = edits.map(edit => ({
    oldText: normalizeToLf(edit.oldText),
    newText: normalizeToLf(edit.newText),
  }))
  const matched: Array<Replacement & { editIndex: number }> = []
  for (const [index, edit] of normalized.entries()) {
    const { index: matchIndex, length } = uniqueMatch(before, edit.oldText, index, normalized.length, path)
    matched.push({ editIndex: index, matchIndex, matchLength: length, newText: edit.newText })
  }
  matched.sort((a, b) => a.matchIndex - b.matchIndex)
  for (let index = 1; index < matched.length; index++) {
    const previous = matched[index - 1]
    const current = matched[index]
    if (previous === undefined || current === undefined) continue
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      throw new ToolArgsError([
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. `
          + 'Merge them into one edit or target disjoint regions.',
      ])
    }
  }
  const replacements: Replacement[] = matched.map(({ matchIndex, matchLength, newText }) => ({ matchIndex, matchLength, newText }))
  let after = before
  for (let index = replacements.length - 1; index >= 0; index--) {
    const replacement = replacements[index]
    if (replacement === undefined) continue
    after = after.slice(0, replacement.matchIndex) + replacement.newText + after.slice(replacement.matchIndex + replacement.matchLength)
  }
  if (before === after) throw new ToolArgsError(['edits produced no change'])
  const finalContent = bom + (text === before ? after : applyReplacementsToOriginal(text, replacements))
  return { finalContent, before, after }
}

/**
 * Register the Pi-style `edit` tool and its scope-aware guidance.
 * @param ctx - the plugin context; execution uses its `fs` service.
 * @param sandbox - the shared sandbox-escalation API.
 */
export function applyPiEditTool(ctx: Context, sandbox: FsSandboxController): void {
  ctx.systemPrompt.section({
    name: 'tool:edit',
    order: ctx.systemPrompt.getSectionOrder('TOOL_EDIT'),
    text: ({ scope }) => ctx.tools.get('edit', scope) === undefined
      ? ''
      : 'Use edit for targeted changes. Batch changes to one file in a single call. '
        + 'Each edits[].oldText must exactly and uniquely match the original file; keep matches short and non-overlapping.',
  })

  ctx.tools.register(defineTool({
    name: 'edit',
    description: 'Edit an existing UTF-8 text file by replacing one or more exact literal text blocks in a single call.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to edit (relative or absolute).' },
      edits: {
        type: 'array',
        required: true,
        description: 'One or more targeted replacements. Each edit is matched against the original file, not incrementally. '
          + 'Do not include overlapping or nested edits; merge nearby changes into one edit instead.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            oldText: {
              type: 'string',
              required: true,
              description: 'Exact text for one targeted replacement. It must be unique in the original file and must not overlap any other edits[].oldText in the same call.',
            },
            newText: { type: 'string', required: true, description: 'Replacement text for this targeted edit.' },
          },
        },
      },
      ...sandbox.escalationModes.length > 0 ? sandbox.schemaFields() : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true, description: 'Canonical absolute path in the filesystem execution world.' },
          before: { type: 'string', required: true },
          after: { type: 'string', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: `Successfully replaced ${String(args.edits.length)} block(s) in ${value.path}.` }],
      presentationMeta: (_args, value) => ({
        path: value.path,
        diffs: computeHunkDiffs(value.path, value.before, value.after)
          .map(({ path, oldText, newText }) => ({ path, oldText, newText })),
      }),
    },
    async execute(args: PiEditArgs, exec) {
      const input = parsePiEditArgs(args)
      const sandboxPolicy = await sandbox.resolvePolicy('edit', args, exec)
      const target = await ctx.fs.resolve(input.filePath, await sessionResolveOptions(ctx, exec))
      let outcome
      try {
        const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
        const content = await ctx.fs.readText(target, exec.signal)
        const applied = applyPiEdits(content, input.edits, target.displayPath)
        const expected = intent !== undefined
          ? { kind: 'replaceIfVersion' as const, version: intent.version }
          : await ctx.fs.stat(target, exec.signal).then(info => info === undefined
            ? undefined
            : { kind: 'replaceIfVersion' as const, version: info.version })
        const write = await ctx.fs.writeText(target, applied.finalContent, expected, exec.signal, sandboxPolicy)
        outcome = { version: write.version, before: applied.before, after: applied.after }
      } catch (error: unknown) {
        throw remediateFsError(sandbox.mapError(error, sandboxPolicy), target.displayPath)
      }
      return mutationResult(ctx, target, outcome, exec)
    },
    presentCall(args): DiffCallView {
      return {
        card: 'diff',
        title: `Edit ${args.path}`,
        diffs: args.edits.map(edit => ({ path: args.path, oldText: edit.oldText || null, newText: edit.newText })),
        locations: [{ path: args.path }],
      }
    },
    presentResult(args, result: ToolResult): DiffResultView | undefined {
      if (result.isError) return undefined
      const diffs = diffsFromMeta(result.meta)
      if (diffs === undefined) return undefined
      return { card: 'diff', title: `Edit ${args.path}`, diffs }
    },
  }))
}
