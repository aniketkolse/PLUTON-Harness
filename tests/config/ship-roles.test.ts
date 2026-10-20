import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../../src/config/load.ts'
import {
  MUSE_ROLES,
  PERSISTENT_MUSE_ROLES,
  ROLE_DEFAULT_WORKSPACE_POLICIES,
} from '../../src/domain/models.ts'
import { ROLE_DEFAULT_PERMISSIONS } from '../../src/domain/permissions.ts'
import { museConfigSchema } from '../../src/config/schema.ts'

describe('Ship Workers Role Registry', () => {
  it('defines all 5 persistent roles in pluton.yaml', () => {
    const { config } = loadConfig('pluton.yaml')
    expect(config.muses['manager']).toBeDefined()
    expect(config.muses['qa']).toBeDefined()
    expect(config.muses['researcher']).toBeDefined()
    expect(config.muses['coder']).toBeDefined()
    expect(config.muses['reviewer']).toBeDefined()

    expect(config.muses['manager']!.role).toBe('supervisor')
    expect(config.muses['qa']!.role).toBe('tester')
    expect(config.muses['researcher']!.role).toBe('researcher')
    expect(config.muses['coder']!.role).toBe('coder')
    expect(config.muses['reviewer']!.role).toBe('reviewer')
  })

  it('enforces validation for all 5 persistent roles in MUSE_ROLES', () => {
    expect(MUSE_ROLES).toContain('supervisor')
    expect(MUSE_ROLES).toContain('tester')
    expect(MUSE_ROLES).toContain('researcher')
    expect(MUSE_ROLES).toContain('coder')
    expect(MUSE_ROLES).toContain('reviewer')

    for (const role of PERSISTENT_MUSE_ROLES) {
      expect(MUSE_ROLES).toContain(role)
    }
  })

  it('verifies expected workspace policies in pluton.yaml for all 5 roles', () => {
    const { config } = loadConfig('pluton.yaml')
    expect(config.muses['manager']!.workspace_policy).toBe('coordinator-read-only')
    expect(config.muses['qa']!.workspace_policy).toBe('isolated-task-checkout')
    expect(config.muses['researcher']!.workspace_policy).toBe('read-only')
    expect(config.muses['coder']!.workspace_policy).toBe('isolated-task-checkout')
    expect(config.muses['reviewer']!.workspace_policy).toBe('read-only')
  })

  it('verifies default workspace policies and default permissions for each role', () => {
    expect(ROLE_DEFAULT_WORKSPACE_POLICIES['supervisor']).toBe('coordinator-read-only')
    expect(ROLE_DEFAULT_WORKSPACE_POLICIES['tester']).toBe('isolated-task-checkout')
    expect(ROLE_DEFAULT_WORKSPACE_POLICIES['researcher']).toBe('read-only')
    expect(ROLE_DEFAULT_WORKSPACE_POLICIES['coder']).toBe('isolated-task-checkout')
    expect(ROLE_DEFAULT_WORKSPACE_POLICIES['reviewer']).toBe('read-only')

    expect(ROLE_DEFAULT_PERMISSIONS['supervisor']).toBeDefined()
    expect(ROLE_DEFAULT_PERMISSIONS['tester']).toBeDefined()
    expect(ROLE_DEFAULT_PERMISSIONS['researcher']).toBeDefined()
    expect(ROLE_DEFAULT_PERMISSIONS['coder']).toBeDefined()
    expect(ROLE_DEFAULT_PERMISSIONS['reviewer']).toBeDefined()
  })

  it('verifies instructions_file exists for each persistent role in pluton.yaml', () => {
    const { config, rootDir } = loadConfig('pluton.yaml')
    const roles = ['manager', 'qa', 'researcher', 'coder', 'reviewer']
    for (const id of roles) {
      const muse = config.muses[id]
      expect(muse).toBeDefined()
      expect(muse!.instructions_file).toBeDefined()
      expect(existsSync(join(rootDir, muse!.instructions_file!))).toBe(true)
    }
  })

  it('preserves backward compatibility for worker-a and worker-b', () => {
    const { config } = loadConfig('pluton.yaml')
    expect(config.muses['worker-a']).toBeDefined()
    expect(config.muses['worker-b']).toBeDefined()
    expect(config.muses['worker-a']!.role).toBe('coder')
    expect(config.muses['worker-b']!.role).toBe('coder')
  })

  it('rejects invalid roles through museConfigSchema', () => {
    const valid = museConfigSchema.safeParse({
      display_name: 'Valid Coder',
      role: 'coder',
      engine: 'opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
    })
    expect(valid.success).toBe(true)

    const invalid = museConfigSchema.safeParse({
      display_name: 'Invalid Role',
      role: 'invalid-role',
      engine: 'opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
    })
    expect(invalid.success).toBe(false)
  })
})
