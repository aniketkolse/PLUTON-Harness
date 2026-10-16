import { describe, expect, it } from 'vitest'
import { keyAction } from '../../src/tui/keys.ts'

describe('keyAction', () => {
  it('maps return to send and newline variants to newline', () => {
    expect(keyAction('\r', { name: 'return' }).action).toBe('send')
    expect(keyAction('\n', { name: 'enter' }).action).toBe('newline')
    expect(keyAction('', { name: 'j', ctrl: true }).action).toBe('newline')
    expect(keyAction('', { name: 'return', shift: true }).action).toBe('newline')
  })

  it('maps escape to interrupt, ctrl+c to clear-input, ctrl+d to exit', () => {
    expect(keyAction('\x1b', { name: 'escape' }).action).toBe('interrupt')
    expect(keyAction('', { name: 'c', ctrl: true }).action).toBe('clear-input')
    expect(keyAction('', { name: 'd', ctrl: true }).action).toBe('exit')
  })

  it('maps backspace, delete, and navigation keys', () => {
    expect(keyAction('\x7f', { name: 'backspace' }).action).toBe('backspace')
    expect(keyAction('', { name: 'delete' }).action).toBe('delete')
    expect(keyAction('\x1b[A', { name: 'up' }).action).toBe('history-prev')
    expect(keyAction('\x1b[B', { name: 'down' }).action).toBe('history-next')
    expect(keyAction('', { name: 'left' }).action).toBe('cursor-left')
    expect(keyAction('', { name: 'right' }).action).toBe('cursor-right')
    expect(keyAction('', { name: 'home' }).action).toBe('home')
    expect(keyAction('', { name: 'end' }).action).toBe('end')
  })

  it('maps editing shortcuts: ctrl+a, ctrl+e, ctrl+k, ctrl+u, ctrl+w, ctrl+o, ctrl+l', () => {
    expect(keyAction('', { name: 'a', ctrl: true }).action).toBe('home')
    expect(keyAction('', { name: 'e', ctrl: true }).action).toBe('end')
    expect(keyAction('', { name: 'k', ctrl: true }).action).toBe('kill-to-end')
    expect(keyAction('', { name: 'u', ctrl: true }).action).toBe('kill-to-start')
    expect(keyAction('', { name: 'w', ctrl: true }).action).toBe('kill-word')
    expect(keyAction('', { name: 'o', ctrl: true }).action).toBe('toggle-tools')
    expect(keyAction('', { name: 'l', ctrl: true }).action).toBe('redraw')
  })

  it('maps printable characters to insert', () => {
    const res = keyAction('a', { name: 'a' })
    expect(res.action).toBe('insert')
    expect(res.text).toBe('a')

    const resSpace = keyAction(' ', { name: 'space' })
    expect(resSpace.action).toBe('insert')
    expect(resSpace.text).toBe(' ')
  })
})
