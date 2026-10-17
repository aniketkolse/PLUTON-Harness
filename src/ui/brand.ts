/**
 * Pirate ship brand identity and PLUTON wordmark terminal art.
 * Provides isolated, deterministic rendering with Unicode and ASCII fallbacks.
 */

import type { UITheme } from './theme.ts'
import { displayWidth } from '../tui/width.ts'

export function getShipArt(unicode: boolean): string[] {
  if (unicode) {
    return [
      '      ☠        ',
      '    __|__      ',
      '   )_) _)   |  ',
      '  )___)___) |_ ',
      ' )____)____)_) ',
      ' \\____________/ ',
    ]
  }
  return [
    '     [X]       ',
    '    __|__      ',
    '   )_) _)   |  ',
    '  )___)___) |_ ',
    ' )____)____)_) ',
    ' \\____________/ ',
  ]
}

export function getWordmarkArt(unicode: boolean): string[] {
  if (unicode) {
    return [
      '█▀█ █   █ █ ▀█▀ █▀█ █▄ █',
      '█▀▀ █   █ █  █  █ █ █ ▀█',
      '▀   ▀▀▀ ▀▀▀  ▀  ▀▀▀ ▀  ▀',
    ]
  }
  return [
    ' ___  _   _   _ _____ ___  _  _',
    '| _ \\| | | | | |_   _/ _ \\| \\| |',
    '|  _/| |_| |_| | | || (_) | .` |',
    '|_|  |____\\___/  |_| \\___/|_|\\_|',
  ]
}

export function renderPirateShipLogo(theme: UITheme): string[] {
  const lines = getShipArt(theme.unicode)
  return lines.map((line, idx) => {
    if (idx === 0) {
      // Skull or flag in accent light
      return theme.paint('accentLight', line)
    }
    if (idx < 5) {
      // Sails in primary accent
      return theme.paint('accent', line)
    }
    // Hull in focus / border
    return theme.paint('accent', line)
  })
}

export function renderBrandBanner(theme: UITheme): string[] {
  const ship = getShipArt(theme.unicode)
  const wordmark = getWordmarkArt(theme.unicode)

  const result: string[] = []
  const shipWidth = Math.max(...ship.map((s) => displayWidth(s)))
  const spacer = '   '

  // Ship has 6 lines (0..5). Wordmark has 3 or 4 lines.
  // Center wordmark vertically around rows 1, 2, 3
  const wordmarkStart = theme.unicode ? 1 : 1

  for (let i = 0; i < ship.length; i++) {
    const shipLine = ship[i] ?? ''
    const shipPad = ' '.repeat(Math.max(0, shipWidth - displayWidth(shipLine)))
    const paintedShip = i === 0 ? theme.paint('accentLight', shipLine) : theme.paint('accent', shipLine)

    const wmIndex = i - wordmarkStart
    let wmLine = ''
    if (wmIndex >= 0 && wmIndex < wordmark.length) {
      wmLine = wordmark[wmIndex] ?? ''
    }

    const paintedWordmark = wmIndex === 0
      ? theme.paint('accentLight', wmLine)
      : theme.paint('accent', wmLine)

    result.push(`${paintedShip}${shipPad}${spacer}${paintedWordmark}`)
  }

  return result
}
