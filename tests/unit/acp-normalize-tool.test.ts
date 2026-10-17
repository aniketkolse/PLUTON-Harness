import { describe, expect, it } from 'vitest'
import { normalizeSessionUpdate } from '../../src/engines/acp/normalize.ts'

describe('ACP normalize tool call refinement', () => {
  it('extracts callId, precise tool name from _meta, and input from rawInput', () => {
    const frame = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_123',
      name: 'write_file',
      status: 'pending',
      title: 'WriteFile',
      kind: 'edit',
      rawInput: { file_path: 'src/main.ts', content: 'console.log("hello")' },
    }

    const res = normalizeSessionUpdate(frame)
    expect(res.events).toHaveLength(1)
    const ev = res.events[0]
    expect(ev?.kind).toBe('tool')
    if (ev?.kind === 'tool') {
      expect(ev.name).toBe('write_file')
      expect(ev.callId).toBe('call_123')
      expect(ev.summary).toContain('src/main.ts')
      expect(ev.input).toEqual(frame.rawInput)
    }
  })

  it('extracts output and preserves callId on tool_call_update', () => {
    const frame = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_123',
      status: 'completed',
      kind: 'edit',
      title: 'WriteFile',
      content: [
        {
          type: 'content',
          content: { type: 'text', text: 'Wrote 15 bytes to src/main.ts' },
        },
      ],
    }

    const res = normalizeSessionUpdate(frame)
    expect(res.events).toHaveLength(1)
    const ev = res.events[0]
    expect(ev?.kind).toBe('tool')
    if (ev?.kind === 'tool') {
      expect(ev.callId).toBe('call_123')
      expect(ev.phase).toBe('end')
      expect(ev.output).toContain('Wrote 15 bytes to src/main.ts')
      expect(ev.isError).toBe(false)
    }
  })
})
