#!/usr/bin/env node

// Display-layer benchmark. Exercises the paths the editor hits while
// rendering: spatial-index population, viewport screen-line building,
// typing, soft wrap, very long lines, folds and coordinate translation.
//
// Usage: node --expose-gc benchmarks/display-layer.js [--out results.json] [--only name,name] [--no-count]
//
// --no-count disables the native-call counters (they wrap every superstring
// method, which adds overhead to the timings).

const fs = require('fs')
const {PerformanceObserver, performance} = require('perf_hooks')
const superstring = require('@pulsar-edit/superstring')
const TextBuffer = require('..')
const {Point, Range} = TextBuffer

const argv = process.argv.slice(2)
const outPath = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : null
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null
const countNativeCalls = !argv.includes('--no-count')

// Deterministic PRNG so every branch benchmarks exactly the same input.
function createRandom (seed) {
  let state = seed >>> 0
  return function random (n) {
    state = (state * 1664525 + 1013904223) >>> 0
    return n == null ? state / 0x100000000 : Math.floor((state / 0x100000000) * n)
  }
}

const WORDS = [
  'const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'this',
  'value', 'result', 'buffer', 'display', 'layer', 'screen', 'line', 'row',
  'column', 'position', 'range', '=', '+', '(', ')', '{', '}', '[', ']', ';',
  '42', '"string"', "'text'", '// comment', '=>', '.', ',', 'callback'
]

function buildCodeText (random, lineCount, maxLineLength) {
  const lines = new Array(lineCount)
  let indent = 0
  for (let row = 0; row < lineCount; row++) {
    if (random(20) === 0) { lines[row] = ''; continue }
    let line = '  '.repeat(indent)
    if (random(15) === 0) line = '\t' + line
    const goal = line.length + random(maxLineLength)
    while (line.length < goal) {
      line += WORDS[random(WORDS.length)]
      if (random(3) > 0) line += ' '
    }
    lines[row] = line
    const r = random(10)
    if (r === 0 && indent < 8) indent++
    else if (r === 1 && indent > 0) indent--
  }
  return lines.join('\n') + '\n'
}

// A language mode that tokenizes each line with a regex, lazily, the way
// TextMate/tree-sitter modes emit boundaries: a root scope spanning the whole
// buffer plus one scope per token, with nested scopes inside strings.
const ROOT_SCOPE = 257
const TOKEN_SCOPES = [259, 261, 263, 265, 267]
const NESTED_SCOPE = 269
const CLASS_NAMES = new Map([
  [ROOT_SCOPE, 'syntax--source syntax--js'],
  [259, 'syntax--keyword'],
  [261, 'syntax--variable'],
  [263, 'syntax--string syntax--quoted'],
  [265, 'syntax--constant syntax--numeric'],
  [267, 'syntax--comment'],
  [NESTED_SCOPE, 'syntax--punctuation']
])
const KEYWORDS = new Set(['const', 'let', 'function', 'return', 'if', 'else', 'for', 'while', 'this'])
const TOKEN_REGEX = /\/\/.*$|"[^"]*"|'[^']*'|\d+|[A-Za-z_]+/g

class BenchmarkLanguageMode {
  constructor (buffer) {
    this.buffer = buffer
    this.boundariesByRow = new Map()
    this.listeners = []
  }

  bufferDidChange ({oldRange, newRange}) {
    // Invalidate cached tokenization for the changed rows (and shift the rest).
    const delta = newRange.end.row - oldRange.end.row
    const next = new Map()
    for (const [row, boundaries] of this.boundariesByRow) {
      if (row < oldRange.start.row) next.set(row, boundaries)
      else if (row > oldRange.end.row) next.set(row + delta, boundaries)
    }
    this.boundariesByRow = next
  }

  bufferDidFinishTransaction () {}

  onDidChangeHighlighting (callback) {
    this.listeners.push(callback)
    return {dispose: () => { this.listeners = this.listeners.filter((l) => l !== callback) }}
  }

  classNameForScopeId (id) { return CLASS_NAMES.get(id) }

  // Returns an array of {column, close: [], open: []} for the row.
  boundariesForRow (row) {
    let boundaries = this.boundariesByRow.get(row)
    if (boundaries) return boundaries
    boundaries = []
    const line = this.buffer.lineForRow(row)
    if (line == null) return boundaries
    TOKEN_REGEX.lastIndex = 0
    let match
    while ((match = TOKEN_REGEX.exec(line))) {
      const text = match[0]
      let scope
      if (text[0] === '/') scope = 267
      else if (text[0] === '"' || text[0] === "'") scope = 263
      else if (text[0] >= '0' && text[0] <= '9') scope = 265
      else if (KEYWORDS.has(text)) scope = 259
      else scope = 261
      const start = match.index
      const end = start + text.length
      if (scope === 263 && text.length > 2) {
        boundaries.push({column: start, close: [], open: [scope, NESTED_SCOPE]})
        boundaries.push({column: start + 1, close: [NESTED_SCOPE], open: []})
        boundaries.push({column: end - 1, close: [], open: [NESTED_SCOPE]})
        boundaries.push({column: end, close: [NESTED_SCOPE, scope], open: []})
      } else {
        boundaries.push({column: start, close: [], open: [scope]})
        boundaries.push({column: end, close: [scope], open: []})
      }
    }
    // Merge boundaries that share a column (close of one token + open of next).
    const merged = []
    for (const b of boundaries) {
      const last = merged[merged.length - 1]
      if (last && last.column === b.column) {
        last.close.push(...b.close)
        last.open.push(...b.open)
      } else {
        merged.push({column: b.column, close: b.close.slice(), open: b.open.slice()})
      }
    }
    this.boundariesByRow.set(row, merged)
    return merged
  }

  buildHighlightIterator () {
    return new BenchmarkHighlightIterator(this)
  }
}

const EMPTY = []

class BenchmarkHighlightIterator {
  constructor (languageMode) {
    this.languageMode = languageMode
  }

  seek (position, endBufferRow) {
    this.endBufferRow = endBufferRow
    this.row = position.row
    this.rootPending = position.row === 0 && position.column === 0
    this.boundaries = this.languageMode.boundariesForRow(this.row)
    this.index = 0
    const containing = this.rootPending ? [] : [ROOT_SCOPE]
    while (this.index < this.boundaries.length && this.boundaries[this.index].column < position.column) {
      const b = this.boundaries[this.index]
      for (const id of b.close) {
        const i = containing.lastIndexOf(id)
        if (i >= 0) containing.splice(i, 1)
      }
      containing.push(...b.open)
      this.index++
    }
    this.skipEmptyRows()
    return containing
  }

  skipEmptyRows () {
    if (this.rootPending) return
    while (this.index >= this.boundaries.length && this.row <= this.endBufferRow) {
      this.row++
      this.boundaries = this.languageMode.boundariesForRow(this.row)
      this.index = 0
      if (this.row >= this.languageMode.buffer.getLineCount()) break
    }
  }

  moveToSuccessor () {
    if (this.rootPending) {
      this.rootPending = false
    } else {
      this.index++
    }
    this.skipEmptyRows()
  }

  getPosition () {
    if (this.rootPending) return {row: 0, column: 0}
    const b = this.boundaries[this.index]
    return b && this.row <= this.endBufferRow ? {row: this.row, column: b.column} : Point.INFINITY
  }

  getCloseScopeIds () {
    if (this.rootPending) return EMPTY
    const b = this.boundaries[this.index]
    return b ? b.close : EMPTY
  }

  getOpenScopeIds () {
    if (this.rootPending) return [ROOT_SCOPE]
    const b = this.boundaries[this.index]
    return b ? b.open : EMPTY
  }
}

// Count calls into superstring's exported classes. Every such call is a
// JS -> native transition (or a thin JS shim around one).
const nativeCallCounts = {count: 0}
function instrumentNativeCalls () {
  for (const exportName of Object.keys(superstring)) {
    const klass = superstring[exportName]
    if (typeof klass !== 'function' || !klass.prototype) continue
    for (const key of Object.getOwnPropertyNames(klass.prototype)) {
      if (key === 'constructor') continue
      const descriptor = Object.getOwnPropertyDescriptor(klass.prototype, key)
      if (!descriptor || typeof descriptor.value !== 'function') continue
      const original = descriptor.value
      klass.prototype[key] = function () {
        nativeCallCounts.count++
        return original.apply(this, arguments)
      }
    }
  }
}
if (countNativeCalls) instrumentNativeCalls()

let gcCount = 0
let gcTime = 0
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount++
    gcTime += entry.duration
  }
})
gcObserver.observe({entryTypes: ['gc']})

const flushObservers = () => new Promise((resolve) => setTimeout(resolve, 0))

async function measure (name, setup, run) {
  if (only && !only.includes(name)) return null
  const context = setup()
  if (global.gc) global.gc()
  await flushObservers()
  const gcCountBefore = gcCount
  const gcTimeBefore = gcTime
  const heapBefore = process.memoryUsage().heapUsed
  const callsBefore = nativeCallCounts.count
  const t0 = performance.now()
  const iterations = run(context)
  const elapsed = performance.now() - t0
  const calls = nativeCallCounts.count - callsBefore
  const heapDelta = process.memoryUsage().heapUsed - heapBefore
  await flushObservers()
  const result = {
    name,
    ms: round(elapsed),
    iterations,
    msPerIteration: iterations ? round(elapsed / iterations, 4) : null,
    nativeCalls: calls,
    heapDeltaKB: Math.round(heapDelta / 1024),
    gcCount: gcCount - gcCountBefore,
    gcMs: round(gcTime - gcTimeBefore)
  }
  if (context && context.buffer) context.buffer.destroy()
  return result
}

function round (n, digits = 2) {
  const f = Math.pow(10, digits)
  return Math.round(n * f) / f
}

function createEditorBuffer (text, displayLayerParams = {}) {
  const buffer = new TextBuffer({text})
  const languageMode = new BenchmarkLanguageMode(buffer)
  buffer.setLanguageMode(languageMode)
  const displayLayer = buffer.addDisplayLayer(Object.assign({
    tabLength: 2,
    invisibles: {},
    showIndentGuides: false,
    atomicSoftTabs: true,
    foldCharacter: '﻿'
  }, displayLayerParams))
  return {buffer, displayLayer, languageMode}
}

const VIEWPORT = 60

async function main () {
  const random = createRandom(42)
  const largeText = buildCodeText(random, 100000, 100)
  const wrappedText = buildCodeText(random, 10000, 400)
  const longLineText = buildCodeText(random, 1, 1024 * 1024).replace(/\n/g, ' ') + '\n'

  const results = []
  const add = (r) => { if (r) results.push(r) }

  add(await measure('index-100k-lines',
    () => createEditorBuffer(largeText),
    ({displayLayer}) => { displayLayer.getScreenLineCount(); return 1 }))

  add(await measure('scroll-cold-jumps',
    () => {
      const ctx = createEditorBuffer(largeText)
      ctx.displayLayer.getScreenLineCount()
      return ctx
    },
    ({displayLayer}) => {
      let n = 0
      for (let row = 0; row < 100000 - VIEWPORT; row += 500) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('scroll-smooth',
    () => {
      const ctx = createEditorBuffer(largeText)
      ctx.displayLayer.getScreenLineCount()
      return ctx
    },
    ({displayLayer}) => {
      let n = 0
      for (let row = 0; row < 20000; row += 3) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('scroll-warm',
    () => {
      const ctx = createEditorBuffer(largeText)
      for (let row = 0; row < 20000; row += VIEWPORT) ctx.displayLayer.getScreenLines(row, row + VIEWPORT)
      return ctx
    },
    ({displayLayer}) => {
      let n = 0
      for (let row = 0; row < 20000; row += 3) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('typing',
    () => {
      const ctx = createEditorBuffer(largeText)
      ctx.displayLayer.getScreenLines(4970, 4970 + VIEWPORT)
      return ctx
    },
    ({buffer, displayLayer}) => {
      const row = 5000
      let column = buffer.lineLengthForRow(row)
      const typed = 'const value = callback(result) + 42; '
      for (let i = 0; i < 1000; i++) {
        const character = typed[i % typed.length]
        buffer.setTextInRange(Range(Point(row, column), Point(row, column)), character)
        column++
        displayLayer.translateBufferPosition(Point(row, column))
        displayLayer.getScreenLines(4970, 4970 + VIEWPORT)
      }
      return 1000
    }))

  add(await measure('typing-newlines',
    () => {
      const ctx = createEditorBuffer(largeText)
      ctx.displayLayer.getScreenLines(4970, 4970 + VIEWPORT)
      return ctx
    },
    ({buffer, displayLayer}) => {
      let row = 5000
      for (let i = 0; i < 300; i++) {
        buffer.setTextInRange(Range(Point(row, 0), Point(row, 0)), 'let x = 1\n')
        row++
        displayLayer.translateBufferPosition(Point(row, 0))
        displayLayer.getScreenLines(row - 30, row + 30)
      }
      return 300
    }))

  add(await measure('soft-wrap-index',
    () => createEditorBuffer(wrappedText, {softWrapColumn: 80, softWrapHangingIndent: 2}),
    ({displayLayer}) => { displayLayer.getScreenLineCount(); return 1 }))

  add(await measure('soft-wrap-scroll',
    () => {
      const ctx = createEditorBuffer(wrappedText, {softWrapColumn: 80, softWrapHangingIndent: 2})
      ctx.displayLayer.getScreenLineCount()
      return ctx
    },
    ({displayLayer}) => {
      const count = displayLayer.getScreenLineCount()
      let n = 0
      for (let row = 0; row < count - VIEWPORT; row += 20) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('long-line-unwrapped',
    () => createEditorBuffer(longLineText),
    ({displayLayer}) => {
      displayLayer.getScreenLines(0, 1)
      return 1
    }))

  add(await measure('long-line-wrapped',
    () => createEditorBuffer(longLineText, {softWrapColumn: 120}),
    ({displayLayer}) => {
      const count = displayLayer.getScreenLineCount()
      let n = 0
      for (let row = 0; row < count - VIEWPORT; row += Math.max(1, Math.floor(count / 50))) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('folds-500',
    () => {
      const ctx = createEditorBuffer(largeText)
      for (let i = 0; i < 500; i++) {
        const start = 100 + i * 190
        ctx.displayLayer.foldBufferRange(Range(Point(start, 5), Point(start + 20, 0)))
      }
      ctx.displayLayer.getScreenLineCount()
      return ctx
    },
    ({displayLayer}) => {
      const count = displayLayer.getScreenLineCount()
      let n = 0
      for (let row = 0; row < count - VIEWPORT; row += 250) {
        displayLayer.getScreenLines(row, row + VIEWPORT)
        n++
      }
      return n
    }))

  add(await measure('translate-positions',
    () => {
      const ctx = createEditorBuffer(wrappedText, {softWrapColumn: 80})
      ctx.displayLayer.getScreenLineCount()
      return ctx
    },
    ({buffer, displayLayer}) => {
      const r = createRandom(7)
      const lineCount = buffer.getLineCount()
      const screenLineCount = displayLayer.getScreenLineCount()
      for (let i = 0; i < 50000; i++) {
        const row = r(lineCount)
        displayLayer.translateBufferPosition(Point(row, r(buffer.lineLengthForRow(row) + 1)))
        displayLayer.translateScreenPosition(Point(r(screenLineCount), r(90)))
      }
      return 100000
    }))

  console.log('Display layer benchmark (node ' + process.version + (global.gc ? ', gc exposed' : ', run with --expose-gc for stable numbers') + ')')
  console.table(results.map((r) => ({
    scenario: r.name,
    'total ms': r.ms,
    iters: r.iterations,
    'ms/iter': r.msPerIteration,
    'native calls': r.nativeCalls,
    'heap Δ KB': r.heapDeltaKB,
    GCs: r.gcCount,
    'GC ms': r.gcMs
  })))

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({node: process.version, date: new Date().toISOString(), results}, null, 2))
    console.log('Wrote ' + outPath)
  }
  gcObserver.disconnect()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
