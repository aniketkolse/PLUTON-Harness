import { bootstrapStore } from '../../bootstrap.ts'
import type { SearchEventResult, SearchMessageResult } from '../../store/store.ts'
import type { ProjectContext } from '../context.ts'

export interface SearchCommandOptions {
  session?: string
  run?: string
  limit?: number
}

export interface SearchReport {
  query: string
  messages: SearchMessageResult[]
  events: SearchEventResult[]
}

export function searchStore(
  ctx: ProjectContext,
  query: string,
  opts: SearchCommandOptions = {},
): SearchReport {
  const { store } = bootstrapStore(ctx.loaded)
  try {
    const limit = opts.limit !== undefined ? Number(opts.limit) : 20
    let messages: SearchMessageResult[] = []
    let events: SearchEventResult[] = []

    const queryMessages = opts.session !== undefined || opts.run === undefined
    const queryEvents = opts.run !== undefined || opts.session === undefined

    if (queryMessages) {
      messages = store.searchChatMessages(query, {
        limit,
        sessionId: opts.session,
      })
    }
    if (queryEvents) {
      events = store.searchEvents(query, {
        limit,
        runId: opts.run,
      })
    }

    return {
      query,
      messages,
      events,
    }
  } finally {
    store.close()
  }
}

export function formatSearchHuman(report: SearchReport): string {
  const lines: string[] = []
  if (report.messages.length === 0 && report.events.length === 0) {
    return `No results found for "${report.query}"`
  }

  if (report.messages.length > 0) {
    lines.push(`Chat Messages (${report.messages.length}):`)
    for (const m of report.messages) {
      lines.push(`  [${m.sessionId}] <${m.role}>: ${m.snippet ?? m.text}`)
    }
  }

  if (report.events.length > 0) {
    if (lines.length > 0) lines.push('')
    lines.push(`Events (${report.events.length}):`)
    for (const e of report.events) {
      const target = e.runId !== '' ? e.runId : 'project'
      lines.push(`  [${target}] ${e.type}: ${e.snippet ?? ''}`)
    }
  }

  return lines.join('\n')
}
