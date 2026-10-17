/**
 * Interactive chat slash commands handler (ADR-0012).
 * Intercepts `/...` commands in the TUI input before sending prompts to the engine.
 * Provides command metadata, autocomplete suggestions, and closest typo matching.
 */

export interface SlashCommandDef {
  name: string
  aliases?: string[]
  syntax: string
  description: string
  argHint?: string
}

export const COMMAND_REGISTRY: SlashCommandDef[] = [
  {
    name: 'help',
    syntax: '/help',
    description: 'Show this help message and keyboard shortcuts',
  },
  {
    name: 'status',
    syntax: '/status',
    description: 'Show project status, active run, and pending approvals',
  },
  {
    name: 'runs',
    syntax: '/runs',
    description: 'List recent orchestration runs',
  },
  {
    name: 'run',
    syntax: '/run <goal>',
    description: 'Start a new supervised run in the background',
    argHint: '<goal>',
  },
  {
    name: 'approvals',
    syntax: '/approvals',
    description: 'List pending operator approval requests',
  },
  {
    name: 'approve',
    syntax: '/approve <ref>',
    description: 'Approve a pending action by approval ID or prefix',
    argHint: '<ref>',
  },
  {
    name: 'deny',
    syntax: '/deny <ref>',
    description: 'Deny a pending action by approval ID or prefix',
    argHint: '<ref>',
  },
  {
    name: 'new',
    syntax: '/new',
    description: 'Start a fresh chat session with this Muse',
  },
  {
    name: 'inspector',
    syntax: '/inspector',
    description: 'Toggle Orchestra inspector panel visibility',
  },
  {
    name: 'clear',
    syntax: '/clear',
    description: 'Clear transcript viewport',
  },
  {
    name: 'exit',
    aliases: ['quit'],
    syntax: '/exit',
    description: 'Exit Pluton chat',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    syntax: '/quit',
    description: 'Exit Pluton chat',
  },
]

export interface SlashContext {
  session: { id: string }
  muse: { id: string; slug: string }
  status(): Promise<string>
  runs(limit: number): Promise<string>
  approvalsList(): Promise<string>
  approve(ref: string): Promise<string>
  deny(ref: string): Promise<string>
  startRun(goal: string): Promise<string>
  newSession(): Promise<string>
  help(): string
}

export function defaultSlashHelp(): string {
  const lines: string[] = ['Available slash commands:']
  for (const cmd of COMMAND_REGISTRY) {
    if (cmd.name === 'quit') continue // omit duplicate
    lines.push(`  ${cmd.syntax.padEnd(20)} ${cmd.description}`)
  }
  return lines.join('\n')
}

export function parseSlash(text: string): { command: string; args: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const withoutSlash = trimmed.slice(1).trim()
  if (withoutSlash.length === 0) return null
  const spaceIdx = withoutSlash.search(/\s/)
  if (spaceIdx === -1) {
    return { command: withoutSlash.toLowerCase(), args: '' }
  }
  const command = withoutSlash.slice(0, spaceIdx).toLowerCase()
  const args = withoutSlash.slice(spaceIdx).trim()
  return { command, args }
}

export function getCommandSuggestions(input: string, limit = 12): SlashCommandDef[] {
  const clean = input.startsWith('/') ? input.slice(1).toLowerCase().trim() : input.toLowerCase().trim()
  if (!clean) {
    return COMMAND_REGISTRY.filter((c) => c.name !== 'quit').slice(0, limit)
  }

  const matches = COMMAND_REGISTRY.filter(
    (c) =>
      c.name.startsWith(clean) ||
      (c.aliases && c.aliases.some((a) => a.startsWith(clean))),
  )

  // Deduplicate by primary syntax
  const seen = new Set<string>()
  const result: SlashCommandDef[] = []
  for (const m of matches) {
    if (!seen.has(m.name)) {
      seen.add(m.name)
      result.push(m)
    }
  }

  return result.slice(0, limit)
}

export function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
    }
  }
  return dp[m]![n]!
}

export function getUnknownCommandSuggestions(unknownCmd: string, limit = 3): string[] {
  const clean = unknownCmd.toLowerCase().trim()
  const candidates: Array<{ name: string; dist: number }> = []

  for (const cmd of COMMAND_REGISTRY) {
    if (cmd.name === 'quit') continue
    let dist = levenshteinDistance(clean, cmd.name)
    if (cmd.name.startsWith(clean)) {
      dist = 0
    }
    candidates.push({ name: `/${cmd.name}`, dist })
  }

  candidates.sort((a, b) => a.dist - b.dist)
  return candidates.slice(0, limit).map((c) => c.name)
}

export async function executeSlash(
  ctx: SlashContext,
  text: string,
): Promise<{ output: string; exit?: boolean; newSession?: boolean; toggleInspector?: boolean } | null> {
  const parsed = parseSlash(text)
  if (parsed === null) return null

  switch (parsed.command) {
    case 'help':
      return { output: ctx.help() }

    case 'status':
      return { output: await ctx.status() }

    case 'runs':
      return { output: await ctx.runs(10) }

    case 'run':
      if (!parsed.args) {
        return { output: 'usage: /run <goal>' }
      }
      return { output: await ctx.startRun(parsed.args) }

    case 'approvals':
      return { output: await ctx.approvalsList() }

    case 'approve':
      if (!parsed.args) {
        return { output: 'usage: /approve <ref>' }
      }
      return { output: await ctx.approve(parsed.args) }

    case 'deny':
      if (!parsed.args) {
        return { output: 'usage: /deny <ref>' }
      }
      return { output: await ctx.deny(parsed.args) }

    case 'new': {
      const msg = await ctx.newSession()
      return { output: msg, newSession: true }
    }

    case 'inspector':
      return { output: 'Toggled Orchestra inspector', toggleInspector: true }

    case 'clear':
      return { output: 'Viewport cleared' }

    case 'exit':
    case 'quit':
      return { output: 'Goodbye.', exit: true }

    default: {
      const suggestions = getUnknownCommandSuggestions(parsed.command)
      const didYouMean =
        suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : ''
      return {
        output: `unknown command '/${parsed.command}'.${didYouMean} Type /help for available commands.`,
      }
    }
  }
}
