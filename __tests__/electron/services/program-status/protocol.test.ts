/**
 * The Program Status Protocol (OSC 7501, revision 0.4: https://www.superlogical.com/rex/docs/build/program-status),
 * its grammar and its stream scanner, as electron/services/program-status/ reads them from an agent's terminal.
 * Ported with the code from Orca (github.com/stablyai/orca, src/shared/program-status/*.test.ts, MIT, Copyright (c)
 * 2026 Lovecast Inc.); the cases are theirs, kept as they wrote them.
 *
 * How it fails, written before the code:
 * 1. The probe `OSC 7501 ; ?` is not recognised, or the reply names other states or kinds than Tars reads.
 * 2. A report is misread: its state, kind, progress, app, msg or title, base64 and UTF-8 included.
 * 3. A hostile report is taken: no state, a bad id, an over-long key, text over its limits, control characters,
 *    bad base64; or a malformed pair voids a report that should stand.
 * 4. The scanner misses a report split across chunks, a query, a prompt start or a full reset, or reports them out
 *    of byte order; or a frame past the size cap, or cancelled by CAN/SUB, is taken; or ordinary output costs more
 *    than a check for ESC.
 */
import { describe, expect, it } from 'vitest'
import { PROGRAM_STATUS_QUERY_REPLY, parseProgramStatusBody } from '../../../../electron/services/program-status/protocol'

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')

describe('parseProgramStatusBody', () => {
  it('recognizes the feature-detection query', () => {
    expect(parseProgramStatusBody('?')).toEqual({ type: 'query' })
    expect(PROGRAM_STATUS_QUERY_REPLY).toBe(
      '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
    )
  })

  it('parses the spec example with a base64 message', () => {
    const msg = 'Apply 3 to add, 1 to change, 0 to destroy?'
    expect(
      parseProgramStatusBody(`state=blocked:kind=permission:app=terraform:msg=${b64(msg)}`)
    ).toEqual({
      type: 'report',
      report: { id: null, state: 'blocked', kind: 'permission', app: 'terraform', msg }
    })
  })

  it('decodes unpadded base64 and UTF-8 text', () => {
    const encoded = b64('déjà vu ✓').replace(/=+$/, '')
    expect(parseProgramStatusBody(`state=done:msg=${encoded}`)).toMatchObject({
      report: { msg: 'déjà vu ✓' }
    })
  })

  it('ignores reports without a recognized state or with a malformed id', () => {
    expect(parseProgramStatusBody('app=x')).toBeNull()
    expect(parseProgramStatusBody('state=paused')).toBeNull()
    expect(parseProgramStatusBody('state=working:id=a//b')).toBeNull()
    expect(parseProgramStatusBody(`state=working:id=${'a/'.repeat(8)}a`)).toBeNull()
  })

  it('discards a report with an over-long key or any over-limit text occurrence', () => {
    expect(parseProgramStatusBody(`state=working:${'k'.repeat(17)}=v`)).toBeNull()
    const oversized = b64('x'.repeat(2049))
    expect(parseProgramStatusBody(`state=done:msg=${oversized}:msg=${b64('ok')}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(193))}:title=e`)).toBeNull()
    expect(parseProgramStatusBody(`state=clear:app=${'a'.repeat(33)}`)).toBeNull()
    expect(parseProgramStatusBody(`state=clear:id=${'a'.repeat(129)}:id=ok`)).toBeNull()
  })

  it('skips malformed pairs, trims whitespace, and lets the last repeat win', () => {
    expect(parseProgramStatusBody(' state = idle :junk:K=v:app=a:app=b:x=has space')).toEqual({
      type: 'report',
      report: { id: null, state: 'idle', app: 'b' }
    })
  })

  it('keeps kind only on blocked and progress only on working/blocked within 0-100', () => {
    expect(parseProgramStatusBody('state=working:kind=permission:progress=40')).toMatchObject({
      report: { state: 'working', progress: 40 }
    })
    expect(parseProgramStatusBody('state=working:progress=101')).toEqual({
      type: 'report',
      report: { id: null, state: 'working' }
    })
    expect(parseProgramStatusBody('state=done:progress=50')).toEqual({
      type: 'report',
      report: { id: null, state: 'done' }
    })
    expect(parseProgramStatusBody('state=blocked:kind=unknown')).toEqual({
      type: 'report',
      report: { id: null, state: 'blocked' }
    })
  })

  it('treats an out-of-charset app as absent', () => {
    expect(parseProgramStatusBody('state=idle:app=a,b')).toEqual({
      type: 'report',
      report: { id: null, state: 'idle' }
    })
  })

  it('discards the whole report when text has a control character or bad base64', () => {
    expect(parseProgramStatusBody(`state=done:msg=${b64('two\nlines')}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('\u0085')}`)).toBeNull()
    expect(parseProgramStatusBody('state=done:msg=a-b_')).toBeNull()
    expect(parseProgramStatusBody('state=done:msg=abcde')).toBeNull()
    // Out-of-charset bytes make a malformed pair, which is skipped rather than fatal.
    expect(parseProgramStatusBody('state=done:msg=@@@@')).toEqual({
      type: 'report',
      report: { id: null, state: 'done' }
    })
    expect(
      parseProgramStatusBody(`state=done:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`)
    ).toBeNull()
  })

  it('enforces the encoded and decoded text limits', () => {
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(192))}`)).not.toBeNull()
    expect(parseProgramStatusBody(`state=done:title=${b64('t'.repeat(193))}`)).toBeNull()
    expect(parseProgramStatusBody(`state=done:msg=${b64('m'.repeat(2048))}`)).not.toBeNull()
    expect(parseProgramStatusBody(`state=done:msg=${b64('m'.repeat(2049))}`)).toBeNull()
  })

  it('accepts clear with and without an id', () => {
    expect(parseProgramStatusBody('state=clear')).toEqual({
      type: 'report',
      report: { id: null, state: 'clear' }
    })
    expect(parseProgramStatusBody('state=clear:id=build/test')).toEqual({
      type: 'report',
      report: { id: 'build/test', state: 'clear' }
    })
  })
})

import { createProgramStatusOscScanner } from '../../../../electron/services/program-status/osc-scanner'

describe('createProgramStatusOscScanner', () => {
  it('stays on the fast path for ordinary output', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b[31mred\x1b[0m plain\r\n')).toEqual([])
  })

  it('reads BEL- and ST-terminated reports with their end offsets', () => {
    const scan = createProgramStatusOscScanner()
    const data = 'a\x1b]7501;state=working\x07b\x1b]7501;state=done\x1b\\c'
    expect(scan(data)).toEqual([
      { type: 'report', report: { id: null, state: 'working' }, offset: data.indexOf('b') },
      { type: 'report', report: { id: null, state: 'done' }, offset: data.indexOf('c') }
    ])
  })

  it('reassembles a report and its introducer split across chunks', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('out\x1b]75')).toEqual([])
    expect(scan('01;state=blo')).toEqual([])
    expect(scan('cked:kind=question\x1b')).toEqual([])
    expect(scan('\\tail')).toEqual([
      { type: 'report', report: { id: null, state: 'blocked', kind: 'question' }, offset: 1 }
    ])
  })

  it('reports queries, shell prompt starts and full resets in byte order', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b]7501;?\x1b\\\x1b[c\x1b]133;A\x07\x1bc').map((event) => event.type)).toEqual([
      'query',
      'prompt-start',
      'full-reset'
    ])
  })

  it('carries a split prompt marker', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('$ \x1b]13')).toEqual([])
    expect(scan('3;A\x07')).toEqual([{ type: 'prompt-start', offset: 4 }])
  })

  it('reads a prompt start only once its whole frame arrives', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('$ \x1b]133;A')).toEqual([])
    expect(scan(';cl=m\x1b')).toEqual([])
    expect(scan('\\')).toEqual([{ type: 'prompt-start', offset: 1 }])
    expect(scan('\x1b]133;AB\x07\x1b]133;B\x07')).toEqual([])
  })

  it('drops frames CAN/SUB cancel, and ends one at the next sequence as xterm does', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan('\x1b]133;A;x\x18y\x07\x1b]7501;state=working\x1ax\x07')).toEqual([])
    expect(scan('\x1b]133;A\x1b]7501;state=working\x1b[0m')).toMatchObject([
      { type: 'prompt-start' },
      { type: 'report', report: { state: 'working' } }
    ])
  })

  it('discards a frame past the sequence cap and keeps scanning', () => {
    const scan = createProgramStatusOscScanner()
    const oversized = `\x1b]7501;state=working:junk=${'x'.repeat(5000)}\x07`
    expect(scan(`${oversized}\x1b]7501;state=idle\x07`)).toMatchObject([
      { type: 'report', report: { state: 'idle' } }
    ])
  })

  it('drops an unterminated frame once it outgrows the cap', () => {
    const scan = createProgramStatusOscScanner()
    expect(scan(`\x1b]7501;state=working:junk=${'x'.repeat(5000)}`)).toEqual([])
    expect(scan('\x07\x1b]7501;state=done\x07')).toMatchObject([{ report: { state: 'done' } }])
  })
})
