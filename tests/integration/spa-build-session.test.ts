import { describe, expect, it } from 'vitest'
import { STATIC_ASSETS } from '../../src/server/static-assets.ts'

/**
 * Persistent Build mode in the SPA (PLUTON 4.1 Phase 4).
 *
 * The first Build asks for the workspace/project name; later Builds dispatch
 * directly. These assertions run against the exact embedded asset the server
 * serves, so a missing binding or a renamed handler fails here.
 */

const html = STATIC_ASSETS['/index.html']?.content ?? ''
const js = STATIC_ASSETS['/app.js']?.content ?? ''

describe('SPA persistent Build mode', () => {
  it('exposes the first-build project name control', () => {
    expect(html).toContain('id="buildConfirmProjectName"')
    expect(html).toContain('id="btnBuildConfirmStart"')
    expect(js).toContain('buildConfirmProjectName')
  })

  it('dispatches later builds without the confirmation panel', () => {
    expect(js).toContain('function shouldConfirmBuild')
    expect(js).toContain('buildCount > 0')
    expect(js).toContain('shouldConfirmBuild()')
    expect(js).toContain('projectSession')
  })

  it('sends the operator name with the first build', () => {
    expect(js).toContain('function startBuild(goal, projectName)')
    expect(js).toContain('projectName: projectName')
    expect(js).toContain("apiFetch('/api/runs'")
  })

  it('exposes the Settings project identity card', () => {
    expect(html).toContain('id="projectNameInput"')
    expect(html).toContain('id="btnSaveProjectName"')
    expect(html).toContain('id="projectIdentityMeta"')
  })

  it('renames through the project API and refreshes the workspace', () => {
    expect(js).toContain('async function saveProjectName')
    expect(js).toContain("method: 'PATCH'")
    expect(js).toContain("'/api/projects/'")
    expect(js).toContain('Build #')
  })
})
