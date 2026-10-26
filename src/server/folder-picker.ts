/**
 * Native folder picker for the local application server.
 *
 * A browser `showDirectoryPicker()` returns a sandboxed handle, not an
 * absolute host path, so it cannot select the workspace the runtime/engine
 * processes actually operate on. The server is a local process with the
 * operator's desktop session: it opens the platform's real directory dialog
 * and returns the absolute path. Cancellation is a normal outcome, never an
 * error the UI has to guess about.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface FolderPickResult {
  cancelled: boolean
  /** Absolute path chosen by the operator; present only when not cancelled. */
  path?: string
}

export interface PickFolderOptions {
  platform?: NodeJS.Platform
  /** Test seam: replaces the platform invocation. */
  exec?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>
  title?: string
}

const DIALOG_TITLE = 'Select a workspace folder for this Pluton session'

/** Exit code used by our Windows dialog script to mean "operator cancelled". */
const CANCELLED_EXIT = 2

function cleanPath(raw: string): string | null {
  // PowerShell/osascript/zenity may add a trailing newline or CR.
  const value = raw.replace(/[\r\n]+$/g, '').trim()
  return value.length > 0 ? value : null
}

function encodePowerShell(script: string): string {
  // -EncodedCommand takes UTF-16LE base64 and avoids every quoting layer
  // between Node and Windows PowerShell.
  return Buffer.from(script, 'utf16le').toString('base64')
}

function windowsScript(title: string): string {
  // The title is a fixed server-side constant (never a request value), so it
  // cannot inject PowerShell. Single quotes are still escaped defensively.
  const safeTitle = title.replace(/'/g, "''")
  return [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${safeTitle}'`,
    '$dialog.UseDescriptionForTitle = $true',
    '$dialog.ShowNewFolderButton = $true',
    '$result = $dialog.ShowDialog()',
    `if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) } else { exit ${CANCELLED_EXIT} }`,
  ].join('; ')
}

interface ExecFailure extends Error {
  code?: number | string
  stderr?: string | Buffer
}

function stderrOf(err: unknown): string {
  const failure = err as ExecFailure
  if (typeof failure?.stderr === 'string') return failure.stderr
  if (Buffer.isBuffer(failure?.stderr)) return failure.stderr.toString('utf8')
  return ''
}

function exitCodeOf(err: unknown): number | string | undefined {
  return (err as ExecFailure)?.code
}

/**
 * Open the platform's native directory dialog and resolve the selection.
 * Throws a plain Error with an explicit message when no dialog backend exists
 * or the dialog fails; cancellation resolves `{ cancelled: true }`.
 */
export async function pickNativeFolder(opts: PickFolderOptions = {}): Promise<FolderPickResult> {
  const platform = opts.platform ?? process.platform
  const title = opts.title ?? DIALOG_TITLE
  const exec = opts.exec ?? ((file: string, args: string[]) => execFileAsync(file, args))

  if (platform === 'win32') {
    const script = windowsScript(title)
    try {
      const { stdout } = await exec('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-EncodedCommand',
        encodePowerShell(script),
      ])
      const path = cleanPath(stdout)
      return path === null ? { cancelled: true } : { cancelled: false, path }
    } catch (err) {
      if (exitCodeOf(err) === CANCELLED_EXIT) return { cancelled: true }
      const detail = stderrOf(err).trim()
      throw new Error(`failed to open the native folder dialog${detail ? `: ${detail}` : ''}`)
    }
  }

  if (platform === 'darwin') {
    const safeTitle = title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const script = `POSIX path of (choose folder with prompt "${safeTitle}")`
    try {
      const { stdout } = await exec('osascript', ['-e', script])
      const path = cleanPath(stdout)
      return path === null ? { cancelled: true } : { cancelled: false, path }
    } catch (err) {
      const stderr = stderrOf(err)
      // AppleScript reports user cancellation as error -128.
      if (exitCodeOf(err) === 1 && /-128|cancel/i.test(stderr)) return { cancelled: true }
      const detail = stderr.trim()
      throw new Error(`failed to open the native folder dialog${detail ? `: ${detail}` : ''}`)
    }
  }

  if (platform === 'linux') {
    const attempts: Array<{ file: string; args: string[] }> = [
      { file: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`] },
      { file: 'kdialog', args: ['--getexistingdirectory', process.env['HOME'] ?? '.', '--title', title] },
    ]
    let missing = true
    for (const attempt of attempts) {
      try {
        const { stdout } = await exec(attempt.file, attempt.args)
        const path = cleanPath(stdout)
        return path === null ? { cancelled: true } : { cancelled: false, path }
      } catch (err) {
        const code = exitCodeOf(err)
        if (code === 'ENOENT') continue
        missing = false
        // Both zenity and kdialog use exit 1 for a cancelled dialog.
        if (code === 1) return { cancelled: true }
        const detail = stderrOf(err).trim()
        throw new Error(`failed to open the native folder dialog${detail ? `: ${detail}` : ''}`)
      }
    }
    if (missing) {
      throw new Error(
        'no native folder dialog is available on this system (install zenity or kdialog)',
      )
    }
  }

  throw new Error(`native folder selection is not supported on platform '${platform}'`)
}
