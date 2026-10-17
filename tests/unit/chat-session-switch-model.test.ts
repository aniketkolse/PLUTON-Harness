import { describe, expect, it, vi } from 'vitest'
import { ChatSession } from '../../src/chat/session.ts'
import {
  defaultCapabilities,
  type EngineAdapter,
  type EngineSession,
} from '../../src/engines/contract/types.ts'

describe('ChatSession model switching', () => {
  it('switches model, restarts engine session, and updates store', async () => {
    let currentModel = 'initial-model'
    const closeSpy = vi.fn(async () => {})
    const mockEngineSession: EngineSession = {
      info: {
        id: 'eng_1',
        nativeSessionId: 'nat_1',
        resumeToken: null,
      },
      sendPrompt: vi.fn(async function* () {}),
      interrupt: vi.fn(async () => {}),
      close: closeSpy,
    }

    const startSessionSpy = vi.fn(async (spec: any) => {
      currentModel = spec.muse.model
      return {
        ...mockEngineSession,
        info: {
          ...mockEngineSession.info,
          id: `eng_${currentModel}`,
        },
      }
    })

    const mockAdapter: EngineAdapter = {
      kind: 'mock',
      capabilities: () => ({ ...defaultCapabilities(), modelList: true }),
      discover: async () => ({
        engineKind: 'mock',
        installed: true,
        binaryPath: '/bin/mock',
        version: '1.0.0',
        fix: '',
      }),
      authStatus: async () => ({ configured: true, hint: '' }),
      listModels: async () => [
        { id: 'initial-model', source: 'engine' },
        { id: 'next-model', source: 'engine' },
      ],
      startSession: startSessionSpy,
    }

    const mockStore: any = {
      updateChatSession: vi.fn(),
      listChatMessages: vi.fn(() => []),
      getProject: vi.fn(() => ({ name: 'test-project' })),
      listMuses: vi.fn(() => []),
      listApprovalsByProject: vi.fn(() => []),
      listTasks: vi.fn(() => []),
      listEdges: vi.fn(() => []),
      getApprovalOrNull: vi.fn(() => null),
    }

    const mockIo: any = {
      start: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      commit: vi.fn(),
      redraw: vi.fn(),
      size: () => ({ columns: 80, rows: 24 }),
      onKey: vi.fn(),
      onResize: vi.fn(),
      close: vi.fn(),
    }

    const sessionRecord: any = {
      id: 'chat_1',
      projectId: 'proj_1',
      museId: 'muse_1',
      title: 'test',
      state: 'active',
      engineSessionId: null,
      nativeSessionId: null,
      resumeToken: null,
      createdAt: '2026-01-01',
      updatedAt: '2026-01-01',
    }

    const session = new ChatSession({
      store: mockStore,
      projectId: 'proj_1',
      rootDir: '/workspace',
      session: sessionRecord,
      muse: {
        id: 'muse_1',
        projectId: 'proj_1',
        slug: 'operator',
        displayName: 'Operator',
        role: 'supervisor',
        model: 'initial-model',
        instructionsFile: null,
        workspacePolicy: 'coordinator-read-only',
        permissions: [],
        approvalMode: 'autonomous-bounded',
        engineKind: 'mock',
        engineHome: '/home',
        enabled: true,
        createdAt: '2026-01-01',
        updatedAt: '2026-01-01',
      },
      adapter: mockAdapter,
      io: mockIo,
      mcpServers: [],
    })

    await session.start()
    expect(currentModel).toBe('initial-model')

    await session.switchModel('next-model')
    expect(closeSpy).toHaveBeenCalled()
    expect(session.museModel).toBe('next-model')
    expect(mockStore.updateChatSession).toHaveBeenCalledWith('chat_1', {
      engineSessionId: 'eng_next-model',
      nativeSessionId: 'nat_1',
      resumeToken: null,
    })
  })
})
