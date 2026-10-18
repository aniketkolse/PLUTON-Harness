import { describe, expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import {
  generateServerToken,
  isLoopbackRequest,
  safeResolvePath,
  validateOriginAndHost,
  verifyToken,
} from '../../src/server/security.ts'

describe('server security', () => {
  it('generates a 64-character hex token', () => {
    const token = generateServerToken()
    expect(token).toMatch(/^[a-f0-9]{64}$/)
  })

  it('verifies loopback addresses', () => {
    const makeReq = (addr: string | undefined): IncomingMessage =>
      ({ socket: { remoteAddress: addr } } as unknown as IncomingMessage)

    expect(isLoopbackRequest(makeReq('127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(makeReq('::1'))).toBe(true)
    expect(isLoopbackRequest(makeReq('::ffff:127.0.0.1'))).toBe(true)
    expect(isLoopbackRequest(makeReq('localhost'))).toBe(true)
    expect(isLoopbackRequest(makeReq('192.168.1.10'))).toBe(false)
    expect(isLoopbackRequest(makeReq(undefined))).toBe(false)
  })

  it('validates tokens via header and query parameter', () => {
    const token = 'abcdef123456abcdef123456abcdef123456abcdef123456abcdef123456abcdef12'
    const validHeaderReq = {
      headers: { 'x-pluton-token': token },
    } as unknown as IncomingMessage

    const validQueryReq = {
      headers: {},
      url: `/api/health?token=${token}`,
    } as unknown as IncomingMessage

    const invalidTokenReq = {
      headers: { 'x-pluton-token': 'wrong-token' },
    } as unknown as IncomingMessage

    const missingTokenReq = {
      headers: {},
      url: '/api/health',
    } as unknown as IncomingMessage

    expect(verifyToken(validHeaderReq, token)).toBe(true)
    expect(verifyToken(validQueryReq, token)).toBe(true)
    expect(verifyToken(invalidTokenReq, token)).toBe(false)
    expect(verifyToken(missingTokenReq, token)).toBe(false)
  })

  it('validates Origin and Host headers strictly to prevent DNS rebinding', () => {
    const validOriginReq = {
      headers: {
        origin: 'http://127.0.0.1:41234',
        host: '127.0.0.1:41234',
      },
    } as unknown as IncomingMessage

    const invalidOriginReq = {
      headers: {
        origin: 'http://malicious-site.com',
        host: '127.0.0.1:41234',
      },
    } as unknown as IncomingMessage

    const mismatchedPortReq = {
      headers: {
        origin: 'http://127.0.0.1:9999',
        host: '127.0.0.1:41234',
      },
    } as unknown as IncomingMessage

    expect(validateOriginAndHost(validOriginReq, 41234)).toBe(true)
    expect(validateOriginAndHost(invalidOriginReq, 41234)).toBe(false)
    expect(validateOriginAndHost(mismatchedPortReq, 41234)).toBe(false)
  })

  it('prevents path traversal escapes outside rootDir', () => {
    const root = 'Y:\\Pluton'
    expect(safeResolvePath(root, 'src/main.ts')).toBe('Y:\\Pluton\\src\\main.ts')
    expect(safeResolvePath(root, 'package.json')).toBe('Y:\\Pluton\\package.json')
    expect(safeResolvePath(root, '../../windows/system32/cmd.exe')).toBeNull()
    expect(safeResolvePath(root, '..\\..\\secret.env')).toBeNull()
    // Windows case insensitivity safety
    if (process.platform === 'win32') {
      const lowerRoot = 'y:\\pluton'
      expect(safeResolvePath(lowerRoot, 'src/main.ts')).not.toBeNull()
    }
  })
})
