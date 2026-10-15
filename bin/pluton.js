#!/usr/bin/env node
// Pluton CLI entry. Uses the built dist when present; otherwise runs the TypeScript
// source directly (Node >= 24 strips types natively — see ADR-0001).
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', 'dist', 'cli', 'main.js')
const src = join(here, '..', 'src', 'cli', 'main.ts')

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href)
} else if (existsSync(src)) {
  await import(pathToFileURL(src).href)
} else {
  console.error('pluton: no runnable entry found (build with `npm run build`)')
  process.exit(1)
}
