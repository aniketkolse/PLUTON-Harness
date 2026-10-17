import type { PlanRecord } from '../domain/plan.ts'
import type { TaskRecord } from '../domain/models.ts'
import { createTheme, type Theme } from './theme.ts'

export function renderPlanGraph(
  plan: PlanRecord,
  activeTasks: TaskRecord[] = [],
  customTheme?: Theme,
): string {
  const theme = customTheme ?? createTheme()
  const lines: string[] = []

  // State badge styling
  let badge = `[${plan.state}]`
  switch (plan.state) {
    case 'DRAFT':
      badge = theme.paint('warn', `[DRAFT]`)
      break
    case 'REVIEW':
      badge = theme.paint('accent', `[REVIEW]`)
      break
    case 'APPROVED':
      badge = theme.paint('success', `[APPROVED]`)
      break
    case 'RUNNING':
      badge = theme.paint('focus', `[RUNNING]`)
      break
    case 'COMPLETED':
      badge = theme.paint('success', `[COMPLETED]`)
      break
    case 'FAILED':
      badge = theme.paint('error', `[FAILED]`)
      break
    case 'CANCELLED':
      badge = theme.paint('dim', `[CANCELLED]`)
      break
  }

  lines.push(`${theme.paint('header', 'Plan:')} ${theme.paint('focus', plan.id)}  ${badge}`)
  lines.push(`${theme.paint('header', 'Goal:')} ${plan.goal}`)
  if (plan.runId) {
    lines.push(`${theme.paint('dim', 'Linked Run:')} ${theme.paint('focus', plan.runId)}`)
  }
  lines.push('')

  if (plan.tasks.length === 0) {
    lines.push(theme.paint('dim', '  (no tasks added yet — use /plan add <title> to create tasks)'))
  } else {
    lines.push(theme.paint('accent', 'Tasks & Dependencies:'))

    // Map active tasks by title or brief if linked
    const statusByTaskId = new Map<string, string>()
    for (const at of activeTasks) {
      statusByTaskId.set(at.id, at.state)
    }

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i]!
      const isLast = i === plan.tasks.length - 1
      const prefix = isLast ? '└─' : '├─'

      // Check task status
      const taskStatus = statusByTaskId.get(task.id)
      let statusIndicator = ''
      if (taskStatus) {
        if (taskStatus === 'completed') statusIndicator = theme.paint('success', ' ✓')
        else if (taskStatus === 'failed') statusIndicator = theme.paint('error', ' ✗')
        else if (taskStatus === 'running') statusIndicator = theme.paint('focus', ' ⏳')
        else statusIndicator = theme.paint('dim', ` (${taskStatus})`)
      }

      lines.push(`${theme.paint('border', prefix)} ${task.id}: ${task.title}${statusIndicator}`)

      const indent = isLast ? '   ' : '│  '
      if (task.description) {
        lines.push(`${theme.paint('border', indent)}${theme.paint('dim', task.description)}`)
      }

      lines.push(
        `${theme.paint('border', indent)}${theme.paint('dim', 'Assignee:')} ${theme.paint('accent', task.assigneeRole)}`,
      )

      if (task.dependsOn.length > 0) {
        lines.push(
          `${theme.paint('border', indent)}${theme.paint('warn', '↳ needs:')} ${task.dependsOn.join(', ')}`,
        )
      }

      if (task.acceptanceCriteria.length > 0) {
        lines.push(
          `${theme.paint('border', indent)}${theme.paint('dim', 'Acceptance:')} ${task.acceptanceCriteria.map((c) => `[${c}]`).join(' ')}`,
        )
      }
      lines.push(theme.paint('border', indent))
    }
  }

  // Actionable hints based on current state
  lines.push(theme.paint('border', '─'.repeat(50)))
  switch (plan.state) {
    case 'DRAFT':
      lines.push(
        theme.paint('dim', 'Actions: /plan add <title>  •  /plan review  •  /plan cancel'),
      )
      break
    case 'REVIEW':
      lines.push(
        theme.paint('dim', 'Actions: /plan approve  •  /plan edit <id>  •  /plan add <title>  •  /plan cancel'),
      )
      break
    case 'APPROVED':
      lines.push(
        theme.paint('success', 'Plan approved! Run with: /plan run (or /plan confirm)  •  /plan cancel'),
      )
      break
    case 'RUNNING':
      lines.push(
        theme.paint('dim', 'Plan is executing in background run. Use /cancel <run-id> to halt.'),
      )
      break
    case 'COMPLETED':
      lines.push(theme.paint('success', 'Plan execution finished successfully.'))
      break
    case 'FAILED':
      lines.push(theme.paint('error', 'Plan execution failed or encountered blocked tasks.'))
      break
    case 'CANCELLED':
      lines.push(theme.paint('dim', 'Plan was cancelled.'))
      break
  }

  return lines.join('\n')
}
