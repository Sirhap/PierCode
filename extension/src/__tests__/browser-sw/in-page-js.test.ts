import { describe, it, expect } from 'vitest'
import {
  getContentExpr, waitSelectorExpr, getAttributesExpr, storageExpr,
  formInputExpr, clipboardReadExpr, selectExpr, uploadDataTransferExpr,
} from '../../background/browser/in-page-js'

describe('in-page JS builders', () => {
  it('getContentExpr: text mode reads innerText; html mode outerHTML', () => {
    expect(getContentExpr('text')).toContain('innerText')
    expect(getContentExpr('html')).toContain('outerHTML')
    expect(getContentExpr('structured')).toContain('JSON.stringify')
  })
  it('getContentExpr: selector targets querySelector + JSON-escaped', () => {
    expect(getContentExpr('text', '.foo')).toContain(JSON.stringify('.foo'))
  })
  it('waitSelectorExpr JSON-escapes the selector', () => {
    expect(waitSelectorExpr('a[href="x"]')).toContain(JSON.stringify('a[href="x"]'))
  })
  it('getAttributesExpr targets the selector + computed styles', () => {
    const e = getAttributesExpr('#id')
    expect(e).toContain(JSON.stringify('#id'))
    expect(e).toContain('getComputedStyle')
  })
  it('storageExpr: get/set/remove/clear/keys for local|session', () => {
    expect(storageExpr('local', 'get', 'k')).toContain('localStorage')
    expect(storageExpr('session', 'set', 'k', 'v')).toContain('sessionStorage')
    expect(storageExpr('local', 'keys')).toContain('Object.keys')
  })
  it('formInputExpr: uses native value setter (React-safe)', () => {
    expect(formInputExpr('#in', 'text', 'hi')).toContain('nativeInputValueSetter')
    expect(formInputExpr('#in', 'checkbox', 'true')).toContain('el.checked')
  })
  it('selectExpr handles value/label/index', () => {
    expect(selectExpr('#s', 'index', '2')).toContain('parseInt')
  })
  it('clipboardReadExpr: navigator.clipboard.readText', () => {
    expect(clipboardReadExpr()).toContain('navigator.clipboard')
  })
  it('uploadDataTransferExpr builds a File from base64 + DataTransfer', () => {
    const e = uploadDataTransferExpr('#f', 'a.png', 'AAAA', 'image/png')
    expect(e).toContain('DataTransfer')
    expect(e).toContain('atob')
  })
})
