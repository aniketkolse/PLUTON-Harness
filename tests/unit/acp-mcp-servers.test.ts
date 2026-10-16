import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/domain/errors.ts'
import { toAcpMcpServers } from '../../src/engines/acp/options.ts'
import type { McpServerSpec } from '../../src/engines/contract/types.ts'

describe('toAcpMcpServers', () => {
  it('maps a stdio spec to the ACP stdio wire shape', () => {
    const specs: McpServerSpec[] = [
      {
        kind: 'stdio',
        name: 'pluton-tools',
        command: ['node', 'server.js', '--flag'],
        env: { TOKEN_X: 'not-a-secret' },
      },
    ]
    expect(toAcpMcpServers(specs)).toEqual([
      {
        name: 'pluton-tools',
        command: 'node',
        args: ['server.js', '--flag'],
        env: [{ name: 'TOKEN_X', value: 'not-a-secret' }],
      },
    ])
  })

  it('maps an http spec to the ACP McpServerHttp wire shape', () => {
    const specs: McpServerSpec[] = [
      {
        kind: 'http',
        name: 'pluton',
        url: 'http://127.0.0.1:41234/mcp',
        headers: { Authorization: 'Bearer t' },
      },
    ]
    expect(toAcpMcpServers(specs)).toEqual([
      {
        type: 'http',
        name: 'pluton',
        url: 'http://127.0.0.1:41234/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer t' }],
      },
    ])
  })

  it('emits an empty headers array for an http spec without headers', () => {
    const specs: McpServerSpec[] = [{ kind: 'http', name: 'pluton', url: 'http://127.0.0.1:1/mcp' }]
    expect(toAcpMcpServers(specs)).toEqual([
      { type: 'http', name: 'pluton', url: 'http://127.0.0.1:1/mcp', headers: [] },
    ])
  })

  it('throws ValidationError for an empty stdio command argv', () => {
    expect(() => toAcpMcpServers([{ kind: 'stdio', name: 'broken', command: [] }])).toThrow(ValidationError)
  })

  it('returns an empty array when no specs are given', () => {
    expect(toAcpMcpServers(undefined)).toEqual([])
    expect(toAcpMcpServers([])).toEqual([])
  })
})
