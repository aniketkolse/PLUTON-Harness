/**
 * Interactive chat slash commands handler (ADR-0012).
 * Intercepts `/...` commands in the TUI input before sending prompts to the engine.
 */

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
  return [
    'Available slash commands:',
    '  /help              Show this help message',
    '  /status            Show project status and current/latest run',
    '  /runs              List recent runs',
    '  /run <goal>        Start a new supervised run in the background',
    '  /approvals         List pending approvals',
    '  /approve <ref>     Approve a pending approval',
    '  /deny <ref>        Deny a pending approval',
    '  /new               Start a fresh chat session with this Muse',
    '  /exit, /quit       Exit chat',
  ].join('\n')
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

export async function executeSlash(
  ctx: SlashContext,
  text: string,
): Promise<{ output: string; exit?: boolean; newSession?: boolean } | null> {
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

    case 'exit':
    case 'quit':
      return { output: 'Goodbye.', exit: true }

    default:
      return {
        output: `unknown command '/${parsed.command}' — type /help for available commands`,
      }
  }
}
