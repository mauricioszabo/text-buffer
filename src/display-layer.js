const {Patch, DisplayLayer: NativeDisplayLayer} = require('@pulsar-edit/superstring')
const {Emitter} = require('event-kit')
const Point = require('./point')
const Range = require('./range')
const DisplayMarkerLayer = require('./display-marker-layer')
const {max} = require('./point-helpers')
const {spliceArray} = require('./helpers')
const {MAX_BUILT_IN_SCOPE_ID} = require('./constants')

// Built-in decoration flags (must match superstring's display-layer.cc).
const HARD_TAB = 1 << 0
const LEADING_WHITESPACE = 1 << 2
const TRAILING_WHITESPACE = 1 << 3
const INVISIBLE_CHARACTER = 1 << 4
const INDENT_GUIDE = 1 << 5
const LINE_ENDING = 1 << 6
const FOLD = 1 << 7

const CLIP_DIRECTION_CODES = {closest: 0, backward: 1, forward: 2}

// The spatial index, soft wrapping, folds, coordinate translation and
// screen-line building all live in superstring's native `DisplayLayer`. This
// class owns the public API, events, fold markers and the JS screen-line
// objects handed to the editor.
class DisplayLayer {
  constructor (id, buffer, params = {}) {
    this.id = id
    this.buffer = buffer
    this.emitter = new Emitter()
    this.cachedScreenLines = []
    this.builtInClassNamesByScopeId = new Map()
    this.displayMarkerLayersById = new Map()
    this.destroyed = false
    this.changesSinceLastEvent = new Patch()
    this.scratch = new Float64Array(4)

    this.invisibles = params.invisibles != null ? params.invisibles : {}
    this.tabLength = params.tabLength != null ? params.tabLength : 4
    this.softWrapColumn = params.softWrapColumn != null ? Math.max(1, params.softWrapColumn) : Infinity
    this.softWrapHangingIndent = params.softWrapHangingIndent != null ? params.softWrapHangingIndent : 0
    this.showIndentGuides = params.showIndentGuides != null ? params.showIndentGuides : false
    this.ratioForCharacter = params.ratioForCharacter != null ? params.ratioForCharacter : unitRatio
    this.isWrapBoundary = params.isWrapBoundary != null ? params.isWrapBoundary : isWordStart
    this.characterWidthRatios = params.characterWidthRatios != null ? params.characterWidthRatios : null
    this.wrapBoundaryMode = params.wrapBoundaryMode != null ? params.wrapBoundaryMode : null
    this.foldCharacter = params.foldCharacter != null ? params.foldCharacter : '⋯'
    this.atomicSoftTabs = params.atomicSoftTabs != null ? params.atomicSoftTabs : true

    this.eolInvisibles = {
      '\r': this.invisibles.cr,
      '\n': this.invisibles.eol,
      '\r\n': this.invisibles.cr + this.invisibles.eol
    }

    this.foldsMarkerLayer = params.foldsMarkerLayer || buffer.addMarkerLayer({
      maintainHistory: false,
      persistent: true,
      destroyInvalidatedMarkers: true
    })
    this.foldIdCounter = params.foldIdCounter || 1

    this.nativeDisplayLayer = new NativeDisplayLayer(
      buffer.buffer,
      this.foldsMarkerLayer,
      this.getNativeParams(),
      this.scratch,
      params.nativeSource
    )

    this.bufferDidChangeLanguageMode()
  }

  static deserialize (buffer, params) {
    const foldsMarkerLayer = buffer.getMarkerLayer(params.foldsMarkerLayerId)
    return new DisplayLayer(params.id, buffer, {foldsMarkerLayer})
  }

  serialize () {
    return {
      id: this.id,
      foldsMarkerLayerId: this.foldsMarkerLayer.id,
      foldIdCounter: this.foldIdCounter
    }
  }

  getNativeParams () {
    return {
      tabLength: this.tabLength,
      softWrapColumn: this.softWrapColumn,
      softWrapHangingIndent: this.softWrapHangingIndent,
      showIndentGuides: this.showIndentGuides,
      atomicSoftTabs: this.atomicSoftTabs,
      invisibleSpace: this.invisibles.space,
      invisibleTab: this.invisibles.tab,
      eolInvisibleLf: this.eolInvisibles['\n'],
      eolInvisibleCrlf: this.eolInvisibles['\r\n'],
      foldCharacter: this.foldCharacter,
      // Measured width ratios and a named wrap-boundary rule are evaluated
      // natively; arbitrary JS functions are supported, but slower.
      characterWidthRatios: this.characterWidthRatios || undefined,
      ratioForCharacter: this.ratioForCharacter === unitRatio ? undefined : this.ratioForCharacter,
      wrapBoundaryMode: this.wrapBoundaryMode || (this.isWrapBoundary === isWordStart ? 'default' : undefined),
      isWrapBoundary: this.isWrapBoundary === isWordStart ? undefined : this.isWrapBoundary
    }
  }

  reset (params) {
    if (!this.isDestroyed() && this.setParams(params)) {
      this.clearSpatialIndex()
      this.emitter.emit('did-reset')
      this.notifyObserversIfMarkerScreenPositionsChanged()
    }
  }

  copy () {
    const copyId = this.buffer.nextDisplayLayerId++
    const copy = new DisplayLayer(copyId, this.buffer, {
      foldsMarkerLayer: this.foldsMarkerLayer.copy(),
      foldIdCounter: this.foldIdCounter,
      nativeSource: this.nativeDisplayLayer,
      invisibles: this.invisibles,
      tabLength: this.tabLength,
      softWrapColumn: this.softWrapColumn,
      softWrapHangingIndent: this.softWrapHangingIndent,
      showIndentGuides: this.showIndentGuides,
      ratioForCharacter: this.ratioForCharacter,
      isWrapBoundary: this.isWrapBoundary,
      characterWidthRatios: this.characterWidthRatios,
      wrapBoundaryMode: this.wrapBoundaryMode,
      foldCharacter: this.foldCharacter,
      atomicSoftTabs: this.atomicSoftTabs
    })
    this.buffer.displayLayers[copyId] = copy
    return copy
  }

  destroy () {
    if (this.destroyed) return
    this.destroyed = true
    this.clearSpatialIndex()
    this.foldsMarkerLayer.destroy()
    this.displayMarkerLayersById.forEach((layer) => layer.destroy())
    if (this.languageModeDisposable) this.languageModeDisposable.dispose()
    delete this.buffer.displayLayers[this.id]
  }

  isDestroyed () {
    return this.destroyed
  }

  clearSpatialIndex () {
    this.nativeDisplayLayer.clearSpatialIndex()
    this.cachedScreenLines.length = 0
  }

  get indexedBufferRowCount () {
    return this.nativeDisplayLayer.getIndexedBufferRowCount()
  }

  doBackgroundWork (deadline) {
    return this.nativeDisplayLayer.doBackgroundWork(deadline)
  }

  bufferDidChangeLanguageMode () {
    this.cachedScreenLines.length = 0
    this.nativeDisplayLayer.clearScreenLineCache()
    if (this.languageModeDisposable) this.languageModeDisposable.dispose()
    this.languageModeDisposable = this.buffer.languageMode.onDidChangeHighlighting((bufferRange) => {
      bufferRange = Range.fromObject(bufferRange)
      this.nativeDisplayLayer.invalidateHighlighting(bufferRange.start.row, bufferRange.end.row)
      const startRow = this.scratch[0]
      const rowCount = this.scratch[1]
      spliceArray(this.cachedScreenLines, startRow, rowCount, new Array(rowCount))
      const extent = Point(rowCount, 0)
      this.didChange({
        start: Point(startRow, 0),
        oldExtent: extent,
        newExtent: extent
      })
    })
  }

  addMarkerLayer (options) {
    const markerLayer = new DisplayMarkerLayer(this, this.buffer.addMarkerLayer(options), true)
    this.displayMarkerLayersById.set(markerLayer.id, markerLayer)
    return markerLayer
  }

  getMarkerLayer (id) {
    if (this.displayMarkerLayersById.has(id)) {
      return this.displayMarkerLayersById.get(id)
    } else {
      const bufferMarkerLayer = this.buffer.getMarkerLayer(id)
      if (bufferMarkerLayer) {
        const displayMarkerLayer = new DisplayMarkerLayer(this, bufferMarkerLayer, false)
        this.displayMarkerLayersById.set(id, displayMarkerLayer)
        return displayMarkerLayer
      }
    }
  }

  didDestroyMarkerLayer (id) {
    this.displayMarkerLayersById.delete(id)
  }

  onDidChange (callback) {
    return this.emitter.on('did-change', callback)
  }

  onDidReset (callback) {
    return this.emitter.on('did-reset', callback)
  }

  bufferRangeForFold (foldId) {
    return this.foldsMarkerLayer.getMarkerRange(foldId)
  }

  foldBufferRange (bufferRange) {
    bufferRange = Range.fromObject(bufferRange)
    const containingFoldMarkers = this.foldsMarkerLayer.findMarkers({containsRange: bufferRange})
    if (containingFoldMarkers.length === 0) {
      this.populateSpatialIndexIfNeeded(bufferRange.end.row + 1, Infinity)
    }
    const foldId = this.foldsMarkerLayer.markRange(bufferRange, {invalidate: 'overlap', exclusive: true}).id
    if (containingFoldMarkers.length === 0) {
      const foldStartRow = bufferRange.start.row
      const foldEndRow = bufferRange.end.row + 1
      this.didChange(this.updateSpatialIndex(foldStartRow, foldEndRow, foldEndRow, Infinity))
      this.notifyObserversIfMarkerScreenPositionsChanged()
    }
    return foldId
  }

  destroyFold (foldId) {
    const foldMarker = this.foldsMarkerLayer.getMarker(foldId)
    if (foldMarker) {
      this.destroyFoldMarkers([foldMarker])
    }
  }

  destroyAllFolds () {
    return this.destroyFoldMarkers(this.foldsMarkerLayer.findMarkers({}))
  }

  destroyFoldsIntersectingBufferRange (bufferRange) {
    return this.destroyFoldMarkers(
      this.foldsMarkerLayer.findMarkers({
        intersectsRange: this.buffer.clipRange(bufferRange)
      })
    )
  }

  destroyFoldsContainingBufferPositions (bufferPositions, excludeEndpoints) {
    const markersContainingPositions = new Set()
    for (const position of bufferPositions) {
      const clippedPosition = this.buffer.clipPosition(position)
      const foundMarkers = this.foldsMarkerLayer.findMarkers({
        containsPosition: clippedPosition
      })
      for (const marker of foundMarkers) {
        if (!excludeEndpoints || marker.getRange().containsPoint(clippedPosition, true)) {
          markersContainingPositions.add(marker)
        }
      }
    }
    const sortedMarkers = Array.from(markersContainingPositions).sort((a, b) => a.compare(b))
    return this.destroyFoldMarkers(sortedMarkers)
  }

  destroyFoldMarkers (foldMarkers) {
    const foldedRanges = []
    if (foldMarkers.length === 0) return foldedRanges

    const combinedRangeStart = foldMarkers[0].getStartPosition()
    let combinedRangeEnd = combinedRangeStart
    for (const foldMarker of foldMarkers) {
      const foldedRange = foldMarker.getRange()
      foldedRanges.push(foldedRange)
      combinedRangeEnd = max(combinedRangeEnd, foldedRange.end)
    }

    this.populateSpatialIndexIfNeeded(combinedRangeEnd.row + 1, Infinity)

    for (const foldMarker of foldMarkers) {
      foldMarker.destroy()
    }

    this.didChange(this.updateSpatialIndex(
      combinedRangeStart.row,
      combinedRangeEnd.row + 1,
      combinedRangeEnd.row + 1,
      Infinity
    ))
    this.notifyObserversIfMarkerScreenPositionsChanged()

    return foldedRanges
  }

  foldsIntersectingBufferRange (bufferRange) {
    return this.foldsMarkerLayer.findMarkers({
      intersectsRange: this.buffer.clipRange(bufferRange)
    }).map((marker) => marker.id)
  }

  translateBufferPosition (bufferPosition, options) {
    bufferPosition = Point.fromObject(bufferPosition)
    Point.assertValid(bufferPosition)
    this.nativeDisplayLayer.translateBufferPosition(
      bufferPosition.row,
      bufferPosition.column,
      clipDirectionCode(options)
    )
    return Point(this.scratch[0], this.scratch[1])
  }

  translateBufferRange (bufferRange, options) {
    bufferRange = Range.fromObject(bufferRange)
    return Range(
      this.translateBufferPosition(bufferRange.start, options),
      this.translateBufferPosition(bufferRange.end, options)
    )
  }

  translateScreenPosition (screenPosition, options) {
    screenPosition = Point.fromObject(screenPosition)
    Point.assertValid(screenPosition)
    this.nativeDisplayLayer.translateScreenPosition(
      screenPosition.row,
      screenPosition.column,
      clipDirectionCode(options),
      Boolean(options && options.skipSoftWrapIndentation)
    )
    const bufferPosition = Point(this.scratch[0], this.scratch[1])

    if (this.scratch[2] && global.atom) {
      global.atom.assert(false, 'Invalid translated buffer row', {
        bufferPosition, bufferLineCount: this.buffer.getLineCount()
      })
    }

    return bufferPosition
  }

  translateScreenRange (screenRange, options) {
    screenRange = Range.fromObject(screenRange)
    return Range(
      this.translateScreenPosition(screenRange.start, options),
      this.translateScreenPosition(screenRange.end, options)
    )
  }

  clipScreenPosition (screenPosition, options) {
    return this.translateBufferPosition(
      this.translateScreenPosition(screenPosition, options),
      options
    )
  }

  getText (startRow, endRow) {
    return this.getScreenLines(startRow, endRow).map((line) => line.lineText).join('\n')
  }

  lineLengthForScreenRow (screenRow) {
    return this.nativeDisplayLayer.lineLengthForScreenRow(screenRow)
  }

  getLastScreenRow () {
    return this.getScreenLineCount() - 1
  }

  getScreenLineCount () {
    return this.nativeDisplayLayer.getScreenLineCount()
  }

  getApproximateScreenLineCount () {
    return this.nativeDisplayLayer.getApproximateScreenLineCount()
  }

  getRightmostScreenPosition () {
    this.nativeDisplayLayer.getRightmostScreenPosition()
    return Point(this.scratch[0], this.scratch[1])
  }

  getApproximateRightmostScreenPosition () {
    this.nativeDisplayLayer.getApproximateRightmostScreenPosition()
    return Point(this.scratch[0], this.scratch[1])
  }

  getScreenLine (screenRow) {
    return this.cachedScreenLines[screenRow] || this.getScreenLines(screenRow, screenRow + 1)[0]
  }

  getScreenLines (screenStartRow = 0, screenEndRow = this.getScreenLineCount()) {
    const result = this.buildScreenLinesWith(screenStartRow, screenEndRow, (highlightBatch, knownIds, strict) =>
      this.nativeDisplayLayer.buildScreenLines(screenStartRow, screenEndRow, highlightBatch, knownIds, strict)
    )
    return this.decodeScreenLines(screenStartRow, result)
  }

  // Creates a planner that tracks what one viewer rendered, so that
  // `buildRenderPlan` can report only the lines that changed.
  createRenderPlanner () {
    return new RenderPlanner(this)
  }

  // Runs a native screen-line build, collecting highlighting first. The
  // build may ask to be retried when highlighting was invalidated while we
  // collected it (a language mode may tokenize lazily), or when class names
  // for new scopes must be registered first.
  buildScreenLinesWith (screenStartRow, screenEndRow, build) {
    let result
    for (let attempt = 0; attempt < 3;) {
      const segments = this.nativeDisplayLayer.prepareScreenLines(screenStartRow, screenEndRow)
      const highlightBatch = segments ? this.collectHighlightBatch(segments) : null
      result = build(
        highlightBatch,
        this.getKnownScreenLineIds(screenStartRow, screenEndRow),
        attempt < 2
      )
      if (result instanceof Int32Array) {
        this.registerClassNames(result)
      } else if (result) {
        return result
      } else {
        attempt++
      }
    }
    return result
  }

  registerClassNames (scopeIds) {
    const classNames = new Array(scopeIds.length)
    for (let i = 0; i < scopeIds.length; i++) {
      classNames[i] = this.classNameForScopeId(scopeIds[i]) || ''
    }
    this.nativeDisplayLayer.setClassNames(scopeIds, classNames)
  }

  decodeScreenLines (screenStartRow, result) {
    const [ids, dataIndexes, texts, tagOffsets, tags, softWrapIndents, newBuiltInScopes] = result
    if (newBuiltInScopes) this.registerBuiltInScopes(newBuiltInScopes)

    const screenLines = new Array(ids.length)
    let dataIndex = 0
    for (let i = 0; i < ids.length; i++) {
      let screenLine
      if (dataIndex < dataIndexes.length && dataIndexes[dataIndex] === i) {
        screenLine = {
          id: ids[i],
          lineText: texts[dataIndex],
          tags: Array.from(tags.subarray(tagOffsets[dataIndex], tagOffsets[dataIndex + 1])),
          softWrapIndent: softWrapIndents[dataIndex]
        }
        this.cachedScreenLines[screenStartRow + i] = screenLine
        dataIndex++
      } else {
        screenLine = this.cachedScreenLines[screenStartRow + i]
      }
      screenLines[i] = screenLine
    }
    return screenLines
  }

  // Ids of the screen lines we already hold objects for, so the native side
  // only sends the contents of new lines.
  getKnownScreenLineIds (startRow, endRow) {
    const count = Math.max(0, Math.min(endRow, this.cachedScreenLines.length) - startRow)
    const ids = new Uint32Array(count)
    for (let i = 0; i < count; i++) {
      const screenLine = this.cachedScreenLines[startRow + i]
      if (screenLine) ids[i] = screenLine.id
    }
    return ids
  }

  // Drives the language mode's highlight iterator over the segments the
  // native builder needs, encoding the boundaries into one Int32Array (see
  // `decode_highlight_batch` in superstring's display-layer-wrapper.cc).
  //
  // A boundary past the end of its line can never be reached by the
  // builder; the iterator stays stuck on it and gets re-seeked at the start
  // of the next row, so we record a "reseek" segment there.
  collectHighlightBatch (segments) {
    const endBufferRow = segments[0]
    const iterator = this.buffer.languageMode.buildHighlightIterator()
    const data = [0]
    let segmentCount = 0
    for (let i = 1; i < segments.length; i += 3) {
      let startRow = segments[i]
      let startColumn = segments[i + 1]
      const segmentEndRow = segments[i + 2]
      let isReseek = 0

      while (true) {
        segmentCount++
        const containingScopeIds = iterator.seek(Point(startRow, startColumn), endBufferRow) || []
        data.push(startRow, startColumn, isReseek, containingScopeIds.length)
        for (let j = 0; j < containingScopeIds.length; j++) data.push(containingScopeIds[j])

        const nextPositionIndex = data.length
        data.push(-1, -1, 0)
        let boundaryCount = 0
        let lineLengthRow = -1
        let lineLength = 0
        let stuckRow = -1
        let repeatedPositionCount = 0
        let position = iterator.getPosition()
        while (position.row <= segmentEndRow) {
          if (position.row !== lineLengthRow) {
            lineLengthRow = position.row
            lineLength = this.buffer.lineLengthForRow(position.row)
          }
          if (position.column > lineLength) {
            stuckRow = position.row
            break
          }
          const closeScopeIds = iterator.getCloseScopeIds()
          const openScopeIds = iterator.getOpenScopeIds()
          data.push(position.row, position.column, closeScopeIds.length)
          for (let j = 0; j < closeScopeIds.length; j++) data.push(closeScopeIds[j])
          data.push(openScopeIds.length)
          for (let j = 0; j < openScopeIds.length; j++) data.push(openScopeIds[j])
          boundaryCount++
          // Iterators may report several boundaries at the same position (and
          // may reuse one mutable point), so compare copied coordinates, and
          // only bail out if an iterator never advances.
          const previousRow = position.row
          const previousColumn = position.column
          iterator.moveToSuccessor()
          position = iterator.getPosition()
          if (position.row === previousRow && position.column === previousColumn) {
            if (++repeatedPositionCount > 10000) break
          } else {
            repeatedPositionCount = 0
          }
        }
        data[nextPositionIndex] = encodeCoordinate(position.row)
        data[nextPositionIndex + 1] = encodeCoordinate(position.column)
        data[nextPositionIndex + 2] = boundaryCount

        if (stuckRow === -1 || stuckRow + 1 > segmentEndRow) break
        startRow = stuckRow + 1
        startColumn = 0
        isReseek = 1
      }
    }
    data[0] = segmentCount
    return new Int32Array(data)
  }

  bufferRowsForScreenRows (startRow, endRow) {
    return Array.from(this.nativeDisplayLayer.bufferRowsForScreenRows(startRow, endRow))
  }

  registerBuiltInScopes (scopes) {
    for (let i = 0; i < scopes.length; i += 2) {
      this.builtInClassNamesByScopeId.set(scopes[i], classNameForBuiltInFlags(scopes[i + 1]))
    }
  }

  classNameForScopeId (scopeId) {
    if (scopeId <= MAX_BUILT_IN_SCOPE_ID) {
      return this.builtInClassNamesByScopeId.get(scopeId)
    } else {
      return this.buffer.languageMode.classNameForScopeId(scopeId)
    }
  }

  scopeIdForTag (tag) {
    if (this.isCloseTag(tag)) tag++
    return -tag
  }

  classNameForTag (tag) {
    return this.classNameForScopeId(this.scopeIdForTag(tag))
  }

  openTagForScopeId (scopeId) {
    return -scopeId
  }

  closeTagForScopeId (scopeId) {
    return -scopeId - 1
  }

  isOpenTag (tag) {
    return tag < 0 && (tag & 1) === 1
  }

  isCloseTag (tag) {
    return tag < 0 && (tag & 1) === 0
  }

  bufferWillChange (change) {
    this.nativeDisplayLayer.bufferWillChange(change.oldRange.end.row)
  }

  bufferDidChange ({oldRange, newRange}) {
    this.nativeDisplayLayer.bufferDidChange(
      oldRange.start.row, oldRange.start.column,
      oldRange.end.row, oldRange.end.column,
      newRange.end.row, newRange.end.column
    )
    this.didChange(this.readScreenChange())
  }

  didChange ({start, oldExtent, newExtent}) {
    this.changesSinceLastEvent.splice(start, oldExtent, newExtent)
    if (this.buffer.transactCallDepth === 0) this.emitDeferredChangeEvents()
  }

  emitDeferredChangeEvents () {
    if (this.changesSinceLastEvent.getChangeCount() > 0) {
      this.emitter.emit('did-change', this.changesSinceLastEvent.getChanges().map((change) => {
        return {
          oldRange: new Range(change.oldStart, change.oldEnd),
          newRange: new Range(change.newStart, change.newEnd)
        }
      }))
      this.changesSinceLastEvent = new Patch()
    }
  }

  notifyObserversIfMarkerScreenPositionsChanged () {
    this.displayMarkerLayersById.forEach((layer) => {
      layer.notifyObserversIfMarkerScreenPositionsChanged()
    })
  }

  updateSpatialIndex (startBufferRow, oldEndBufferRow, newEndBufferRow, endScreenRow) {
    this.nativeDisplayLayer.updateSpatialIndex(startBufferRow, oldEndBufferRow, newEndBufferRow, endScreenRow)
    return this.readScreenChange()
  }

  // Reads a screen-row change written to the scratch array by the native
  // layer and applies it to our screen line objects.
  readScreenChange () {
    const start = this.scratch[0]
    const oldRowCount = this.scratch[1]
    const newRowCount = this.scratch[2]
    spliceArray(this.cachedScreenLines, start, oldRowCount, new Array(newRowCount))
    return {
      start: Point(start, 0),
      oldExtent: Point(oldRowCount, 0),
      newExtent: Point(newRowCount, 0)
    }
  }

  populateSpatialIndexIfNeeded (endBufferRow, endScreenRow) {
    this.nativeDisplayLayer.populateSpatialIndexIfNeeded(endBufferRow, endScreenRow)
  }

  findBoundaryPrecedingBufferRow (bufferRow) {
    return this.nativeDisplayLayer.findBoundaryPrecedingBufferRow(bufferRow)
  }

  findBoundaryFollowingBufferRow (bufferRow) {
    return this.nativeDisplayLayer.findBoundaryFollowingBufferRow(bufferRow)
  }

  findBoundaryFollowingScreenRow (screenRow) {
    this.nativeDisplayLayer.findBoundaryFollowingScreenRow(screenRow)
    return [this.scratch[0], this.scratch[1]]
  }

  setParams (params) {
    let paramsChanged = false
    if (params.hasOwnProperty('tabLength') && params.tabLength !== this.tabLength) {
      paramsChanged = true
      this.tabLength = params.tabLength
    }
    if (params.hasOwnProperty('invisibles') && !invisiblesEqual(params.invisibles, this.invisibles)) {
      paramsChanged = true
      this.invisibles = params.invisibles
      this.eolInvisibles = {
        '\r': this.invisibles.cr,
        '\n': this.invisibles.eol,
        '\r\n': this.invisibles.cr + this.invisibles.eol
      }
    }
    if (params.hasOwnProperty('showIndentGuides') && params.showIndentGuides !== this.showIndentGuides) {
      paramsChanged = true
      this.showIndentGuides = params.showIndentGuides
    }
    if (params.hasOwnProperty('softWrapColumn')) {
      let softWrapColumn = params.softWrapColumn != null
        ? Math.max(1, params.softWrapColumn)
        : Infinity
      if (softWrapColumn !== this.softWrapColumn) {
        paramsChanged = true
        this.softWrapColumn = softWrapColumn
      }
    }
    if (params.hasOwnProperty('softWrapHangingIndent') && params.softWrapHangingIndent !== this.softWrapHangingIndent) {
      paramsChanged = true
      this.softWrapHangingIndent = params.softWrapHangingIndent
    }
    if (params.hasOwnProperty('ratioForCharacter') && params.ratioForCharacter !== this.ratioForCharacter) {
      paramsChanged = true
      this.ratioForCharacter = params.ratioForCharacter
    }
    if (params.hasOwnProperty('isWrapBoundary') && params.isWrapBoundary !== this.isWrapBoundary) {
      paramsChanged = true
      this.isWrapBoundary = params.isWrapBoundary
    }
    if (params.hasOwnProperty('characterWidthRatios') &&
        !characterWidthRatiosEqual(params.characterWidthRatios, this.characterWidthRatios)) {
      paramsChanged = true
      this.characterWidthRatios = params.characterWidthRatios
    }
    if (params.hasOwnProperty('wrapBoundaryMode') && params.wrapBoundaryMode !== this.wrapBoundaryMode) {
      paramsChanged = true
      this.wrapBoundaryMode = params.wrapBoundaryMode
    }
    if (params.hasOwnProperty('foldCharacter') && params.foldCharacter !== this.foldCharacter) {
      paramsChanged = true
      this.foldCharacter = params.foldCharacter
    }
    if (params.hasOwnProperty('atomicSoftTabs') && params.atomicSoftTabs !== this.atomicSoftTabs) {
      paramsChanged = true
      this.atomicSoftTabs = params.atomicSoftTabs
    }
    if (paramsChanged) this.nativeDisplayLayer.setParams(this.getNativeParams())
    return paramsChanged
  }
}

// Tracks the screen lines one viewer rendered and describes, for each new
// viewport, how to get there from the previous one.
class RenderPlanner {
  constructor (displayLayer) {
    this.displayLayer = displayLayer
    this.id = displayLayer.nativeDisplayLayer.createRenderPlanner()
  }

  // Returns {screenLines, ops, htmlByScreenLineId}:
  //
  // * `screenLines` are the screen lines for the rows, as `getScreenLines`
  //   returns them.
  // * `ops` is a Uint32Array of (op, screenLineId, screenRow, oldScreenLineId)
  //   quadruples, where op is one of RenderPlanner.KEEP, INSERT, REPLACE (the
  //   new line takes the place of `oldScreenLineId`), MOVE or REMOVE.
  // * `htmlByScreenLineId` holds the contents of the line element for every
  //   inserted or replaced line.
  buildRenderPlan (screenStartRow, screenEndRow) {
    const displayLayer = this.displayLayer
    const result = displayLayer.buildScreenLinesWith(screenStartRow, screenEndRow, (highlightBatch, knownIds, strict) =>
      displayLayer.nativeDisplayLayer.buildRenderPlan(this.id, screenStartRow, screenEndRow, highlightBatch, knownIds, strict)
    )
    const screenLines = displayLayer.decodeScreenLines(screenStartRow, result)
    const htmlLineIds = result[8]
    const html = result[9]
    const htmlByScreenLineId = new Map()
    for (let i = 0; i < htmlLineIds.length; i++) htmlByScreenLineId.set(htmlLineIds[i], html[i])
    return {screenLines, ops: result[7], htmlByScreenLineId}
  }

  // Forget what was rendered, so the next plan inserts every line.
  reset () {
    this.displayLayer.nativeDisplayLayer.destroyRenderPlanner(this.id)
    this.id = this.displayLayer.nativeDisplayLayer.createRenderPlanner()
  }

  destroy () {
    this.displayLayer.nativeDisplayLayer.destroyRenderPlanner(this.id)
  }
}

RenderPlanner.KEEP = 0
RenderPlanner.INSERT = 1
RenderPlanner.REPLACE = 2
RenderPlanner.MOVE = 3
RenderPlanner.REMOVE = 4

function clipDirectionCode (options) {
  const code = options && CLIP_DIRECTION_CODES[options.clipDirection]
  return code != null ? code : 0
}

function encodeCoordinate (value) {
  return Number.isFinite(value) ? value : -1
}

function classNameForBuiltInFlags (flags) {
  let className = ''
  if (flags & INVISIBLE_CHARACTER) className += 'invisible-character '
  if (flags & HARD_TAB) className += 'hard-tab '
  if (flags & LEADING_WHITESPACE) className += 'leading-whitespace '
  if (flags & TRAILING_WHITESPACE) className += 'trailing-whitespace '
  if (flags & LINE_ENDING) className += 'eol '
  if (flags & INDENT_GUIDE) className += 'indent-guide '
  if (flags & FOLD) className += 'fold-marker '
  return className.trim()
}

function invisiblesEqual (left, right) {
  let leftKeys = Object.keys(left)
  let rightKeys = Object.keys(right)
  if (leftKeys.length !== rightKeys.length) return false
  for (let key of leftKeys) {
    if (left[key] !== right[key]) return false
  }
  return true
}

function characterWidthRatiosEqual (left, right) {
  if (left == null || right == null) return left == right
  return left.doubleWidth === right.doubleWidth &&
    left.halfWidth === right.halfWidth &&
    left.korean === right.korean
}

function isWordStart (previousCharacter, character) {
  return (previousCharacter === ' ' || previousCharacter === '\t') &&
    (character !== ' ' && character !== '\t')
}

function unitRatio () {
  return 1
}

DisplayLayer.RenderPlanner = RenderPlanner

module.exports = DisplayLayer
