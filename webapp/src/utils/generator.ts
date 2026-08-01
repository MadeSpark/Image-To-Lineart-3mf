import { strToU8, zipSync } from 'fflate'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  GifFrameSource,
  ImportedLineart,
  LineartSettings,
  PrintBedLayout,
  PrintBedPlacementItem,
  PrintBedSettings,
  ProcessedArtwork,
  SourceImage,
  ThreeMfTemplateProfile,
  VectorLoop,
  VectorPoint,
} from '@/types/generator'
import { clamp, colorDistance, hexToRgb } from './color'
import {
  buildThreeMfFilamentSequenceJson,
  buildThreeMfProjectSettingsConfig,
  buildThreeMfSliceInfoConfig,
} from './threeMfProfile'

const DEFAULT_LINEART_MAX_MM = 40
const MIN_EXPORTABLE_LINE_WIDTH_MM = 0.42
const MIN_EXPORTABLE_SOLID_DIAMETER_MM = 0.9
const MAX_EXPORTABLE_HOLE_DIAMETER_MM = 0.7

interface ProcessArtworkInput {
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  height: number
}

interface MeshData {
  vertices: Array<[number, number, number]>
  triangles: Array<[number, number, number]>
}

type PreviewModelArtworkInput = Pick<
  ProcessedArtwork,
  'baseLoops' | 'lineLoops' | 'boardWidthMm' | 'boardHeightMm' | 'pixelsPerMm'
>

interface BambuModelSettingsObject {
  id: number
  name: string
  extruder?: number
  faceCount?: number
  parts?: Array<{
    id: number
    name: string
    extruder: number
    matrix?: string
    sourceFile?: string
    sourceObjectId?: number
    sourceVolumeId?: number
    sourceOffsetX?: number
    sourceOffsetY?: number
    sourceOffsetZ?: number
    faceCount?: number
  }>
}

interface BambuPlateAssignment {
  plateIndex: number
  objectIds: number[]
  identifyIds: number[]
}

export async function fileToSourceImage(file: File): Promise<SourceImage> {
  const dataUrl = await fileToDataUrl(file)
  const image = await loadHtmlImage(dataUrl)

  return {
    name: file.name,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dataUrl,
  }
}

export async function fileToImportedLineart(file: File): Promise<ImportedLineart> {
  const text = await file.text()
  return parseDxfText(text, file.name)
}

export async function decodeGifFrames(file: File): Promise<GifFrameSource[]> {
  const Decoder = (globalThis as typeof globalThis & {
    ImageDecoder?: new (options: { data: ArrayBuffer; type: string }) => {
      tracks: {
        ready: Promise<unknown>
        selectedTrack?: { frameCount?: number }
      }
      decode: (options: { frameIndex: number }) => Promise<{ image: VideoFrame | ImageBitmap; complete?: boolean }>
      close?: () => void
    }
  }).ImageDecoder

  if (!Decoder) {
    throw new Error('当前浏览器不支持 GIF 拆帧，请改用新版 Edge 或 Chrome。')
  }

  const data = await file.arrayBuffer()
  const decoder = new Decoder({
    data,
    type: file.type || 'image/gif',
  })
  await decoder.tracks.ready
  const frameCount = decoder.tracks.selectedTrack?.frameCount ?? 1
  const frames: GifFrameSource[] = []
  const baseName = getExportBaseName(file.name, 'gif-frame')

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const result = await decoder.decode({ frameIndex })
    const bitmap = result.image as VideoFrame & { width?: number; height?: number }
    const width = bitmap.displayWidth || bitmap.codedWidth || bitmap.width || 1
    const height = bitmap.displayHeight || bitmap.codedHeight || bitmap.height || 1
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close()
      throw new Error('无法初始化 GIF 帧预览画布')
    }
    context.drawImage(bitmap, 0, 0)
    const dataUrl = canvas.toDataURL('image/png')
    bitmap.close()

    frames.push({
      name: `${baseName}-frame-${String(frameIndex + 1).padStart(3, '0')}.png`,
      width: canvas.width,
      height: canvas.height,
      dataUrl,
      frameIndex,
      totalFrames: frameCount,
      delayMs: 0,
    })
  }

  decoder.close?.()
  return frames
}

export async function processArtwork({
  sourceImage,
  importedLineart,
  lineartSettings,
  baseplateSettings,
  extrudeSettings,
}: ProcessArtworkInput): Promise<ProcessedArtwork> {
  const source = importedLineart
    ? {
        kind: 'dxf' as const,
        width: importedLineart.widthMm,
        height: importedLineart.heightMm,
        loops: normalizeLoops(importedLineart.loops),
      }
    : sourceImage
      ? await buildImageLineart(sourceImage, lineartSettings)
      : null

  if (!source || !source.loops.length) {
    throw new Error('没有可用的线稿轮廓，请尝试调整目标颜色或颜色容差。')
  }

  const sourceLoops = lineartSettings.mirror
    ? mirrorLoopsHorizontally(source.loops)
    : source.loops

  const layout = layoutLineLoops(
    sourceLoops,
    baseplateSettings,
  )
  const pixelsPerMm = choosePixelsPerMm(layout.boardWidthMm, layout.boardHeightMm, lineartSettings.detail)
  const paddingMm = baseplateSettings.template === 'outline'
    ? Math.max(3, baseplateSettings.expandMm + lineartSettings.strokeWidth + 2)
    : Math.max(2, lineartSettings.strokeWidth + 1)

  const lineMask = rasterizeLoopsToMask(
    layout.lineLoops,
    layout.boardWidthMm,
    layout.boardHeightMm,
    pixelsPerMm,
    paddingMm,
  )
  const finalLineLoops = smoothLoops(
    traceMaskToLoops(lineMask.mask, lineMask.width, lineMask.height)
      .map((loop) => pixelsToMm(loop, pixelsPerMm, paddingMm))
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.3),
    lineartSettings.smoothing,
  )

  if (!finalLineLoops.length) {
    throw new Error('线稿在当前参数下被清空了，请降低杂点清理或提高线宽。')
  }

  let boardWidthMm = layout.boardWidthMm
  let boardHeightMm = layout.boardHeightMm
  let baseLoops: VectorLoop[]
  let visibleLineLoops = finalLineLoops

  if (baseplateSettings.template === 'outline') {
    const baseMask = dilateMask(
      lineMask.mask,
      lineMask.width,
      lineMask.height,
      Math.max(1, Math.round(baseplateSettings.expandMm * pixelsPerMm)),
    )
    const tracedBaseLoops = smoothLoops(
      traceMaskToLoops(baseMask, lineMask.width, lineMask.height)
        .map((loop) => pixelsToMm(loop, pixelsPerMm, paddingMm))
        .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.8),
      Math.max(lineartSettings.smoothing - 8, 0),
    )
    const outerBaseLoops = keepOuterLoops(tracedBaseLoops)
    const baseBounds = getLoopBounds(outerBaseLoops)
    baseLoops = translateLoops(outerBaseLoops, -baseBounds.minX, -baseBounds.minY)
    visibleLineLoops = translateLoops(finalLineLoops, -baseBounds.minX, -baseBounds.minY)
    boardWidthMm = baseBounds.width
    boardHeightMm = baseBounds.height
  } else {
    baseLoops = createTemplateBaseLoops(baseplateSettings)
  }

  const previews = buildPreviewAssets(
    visibleLineLoops,
    baseLoops,
    boardWidthMm,
    boardHeightMm,
    baseplateSettings,
  )

  return {
    sourceKind: source.kind,
    sourceWidth: source.width,
    sourceHeight: source.height,
    lineLoops: visibleLineLoops,
    baseLoops,
    boardWidthMm,
    boardHeightMm,
    pixelsPerMm,
    previews,
    stats: {
      sourceKind: source.kind,
      sourceWidth: source.width,
      sourceHeight: source.height,
      lineLoopCount: visibleLineLoops.length,
      baseLoopCount: baseLoops.length,
      lineSegments: visibleLineLoops.reduce((sum, loop) => sum + loop.points.length, 0),
      baseSegments: baseLoops.reduce((sum, loop) => sum + loop.points.length, 0),
      boardWidthMm,
      boardHeightMm,
    },
  }
}

export function exportLineartSvg(filename: string, artwork: ProcessedArtwork, settings: BaseplateSettings) {
  downloadText(filename, buildLineartSvgDocument(artwork, settings), 'image/svg+xml;charset=utf-8')
}

export function exportLineartDxf(filename: string, artwork: ProcessedArtwork) {
  downloadText(filename, buildLoopDxf(artwork.lineLoops, 'LINEART'), 'application/dxf;charset=utf-8')
}

export function export3mf(
  filename: string,
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
) {
  const bytes = build3mfPackage(artwork, baseplateSettings, extrudeSettings, printBedSettings, threeMfProfile)
  downloadBlob(filename, new Blob([bytes], { type: 'model/3mf' }))
}

export function buildLineartSvgDocument(artwork: ProcessedArtwork, settings: BaseplateSettings) {
  const basePaths = loopsToSvgPath(artwork.baseLoops)
  const linePaths = loopsToSvgPath(artwork.lineLoops)

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.boardWidthMm}mm" height="${artwork.boardHeightMm}mm" viewBox="0 0 ${formatNumber(artwork.boardWidthMm)} ${formatNumber(artwork.boardHeightMm)}">`,
    '  <title>线稿底板图层</title>',
    '  <desc>包含底板与线稿两个图层的可编辑 SVG。</desc>',
    `  <g id="baseplate" fill="${settings.baseColor}">`,
    `    <path d="${basePaths}" />`,
    '  </g>',
    `  <g id="lineart" fill="${settings.lineColor}">`,
    `    <path d="${linePaths}" />`,
    '  </g>',
    '</svg>',
  ].join('\n')
}

export function buildLoopDxf(loops: VectorLoop[], layerName = 'LINEART') {
  const layer = sanitizeLayerName(layerName)
  const entities = loops.flatMap((loop) => {
    const points = sanitizeLoop(loop.points)
    if (points.length < 3) return []

    return [
      dxfPair(0, 'LWPOLYLINE'),
      dxfPair(8, layer),
      dxfPair(90, String(points.length)),
      dxfPair(70, loop.closed ? '1' : '0'),
      ...points.flatMap((point) => [
        dxfPair(10, formatNumber(point.x)),
        dxfPair(20, formatNumber(point.y)),
      ]),
    ]
  })

  return [
    dxfPair(0, 'SECTION'),
    dxfPair(2, 'HEADER'),
    dxfPair(9, '$ACADVER'),
    dxfPair(1, 'AC1009'),
    dxfPair(9, '$INSUNITS'),
    dxfPair(70, '4'),
    dxfPair(0, 'ENDSEC'),
    dxfPair(0, 'SECTION'),
    dxfPair(2, 'TABLES'),
    dxfPair(0, 'TABLE'),
    dxfPair(2, 'LTYPE'),
    dxfPair(70, '1'),
    dxfPair(0, 'LTYPE'),
    dxfPair(2, 'CONTINUOUS'),
    dxfPair(70, '0'),
    dxfPair(3, 'Solid line'),
    dxfPair(72, '65'),
    dxfPair(73, '0'),
    dxfPair(40, '0'),
    dxfPair(0, 'ENDTAB'),
    dxfPair(0, 'TABLE'),
    dxfPair(2, 'LAYER'),
    dxfPair(70, '2'),
    dxfPair(0, 'LAYER'),
    dxfPair(2, '0'),
    dxfPair(70, '0'),
    dxfPair(62, '7'),
    dxfPair(6, 'CONTINUOUS'),
    dxfPair(0, 'LAYER'),
    dxfPair(2, layer),
    dxfPair(70, '0'),
    dxfPair(62, '7'),
    dxfPair(6, 'CONTINUOUS'),
    dxfPair(0, 'ENDTAB'),
    dxfPair(0, 'ENDSEC'),
    dxfPair(0, 'SECTION'),
    dxfPair(2, 'ENTITIES'),
    ...entities,
    dxfPair(0, 'ENDSEC'),
    dxfPair(0, 'EOF'),
  ].join('\n')
}

export function parseDxfText(text: string, name = 'imported.dxf'): ImportedLineart {
  const pairs = splitDxfPairs(text)
  const loops: VectorLoop[] = []

  for (let index = 0; index < pairs.length; index += 1) {
    const [code, value] = pairs[index]
    if (code !== 0) continue

    if (value === 'LWPOLYLINE') {
      const points: VectorPoint[] = []
      let closed = false
      let currentX: number | null = null

      while (index + 1 < pairs.length && pairs[index + 1]?.[0] !== 0) {
        index += 1
        const [nextCode, nextValue] = pairs[index]
        if (nextCode === 70) {
          closed = (Number(nextValue) & 1) === 1
        } else if (nextCode === 10) {
          currentX = Number(nextValue)
        } else if (nextCode === 20 && currentX !== null) {
          points.push({ x: currentX, y: Number(nextValue) })
          currentX = null
        }
      }

      if (points.length >= 3) {
        loops.push({ points, closed })
      }
      continue
    }

    if (value === 'POLYLINE') {
      const points: VectorPoint[] = []
      let closed = false

      while (index + 1 < pairs.length) {
        index += 1
        const [nextCode, nextValue] = pairs[index]
        if (nextCode === 70) {
          closed = (Number(nextValue) & 1) === 1
        }
        if (nextCode === 0 && nextValue === 'VERTEX') {
          let vertexX = 0
          let vertexY = 0
          while (index + 1 < pairs.length && pairs[index + 1]?.[0] !== 0) {
            index += 1
            const [vertexCode, vertexValue] = pairs[index]
            if (vertexCode === 10) vertexX = Number(vertexValue)
            if (vertexCode === 20) vertexY = Number(vertexValue)
          }
          points.push({ x: vertexX, y: vertexY })
          continue
        }
        if (nextCode === 0 && nextValue === 'SEQEND') {
          break
        }
      }

      if (points.length >= 3) {
        loops.push({ points, closed })
      }
    }
  }

  if (!loops.length) {
    throw new Error('该 DXF 没有检测到闭合 polyline 轮廓。')
  }

  const normalized = normalizeLoops(loops)
  const bounds = getLoopBounds(normalized)

  return {
    name,
    loops: normalized,
    widthMm: bounds.width,
    heightMm: bounds.height,
  }
}

export function build3mfPackage(
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
) {
  // #region debug-point B:build-3mf-package
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'B', location: 'generator.ts:build3mfPackage:start', msg: '[DEBUG] start build3mfPackage', data: { boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm, pixelsPerMm: artwork.pixelsPerMm, baseLoopCount: artwork.baseLoops.length, lineLoopCount: artwork.lineLoops.length }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const flippedBaseLoops = flipLoopsForModelExport(artwork.baseLoops, artwork.boardHeightMm)
  const flippedLineLoops = flipLoopsForModelExport(artwork.lineLoops, artwork.boardHeightMm)
  const lineMeshPixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 10), 8, 20)
  const singlePlacement = planPrintBedLayout([{
    id: 'single-artwork',
    label: '单文件导出',
    widthMm: artwork.boardWidthMm,
    heightMm: artwork.boardHeightMm,
  }], printBedSettings).placements[0]
  const offsetX = singlePlacement?.xMm ?? 0
  const offsetY = singlePlacement?.yMm ?? 0
  const baseMesh = translateMesh(
    extrudeLoopsToMesh(
      keepOuterLoops(flippedBaseLoops),
      0,
      extrudeSettings.baseThicknessMm,
    ),
    offsetX,
    offsetY,
  )
  const lineMesh = translateMesh(
    extrudeMaskToMesh(
      flippedLineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      extrudeSettings.lineHeightMm,
      extrudeSettings.lineThicknessMm,
      MIN_EXPORTABLE_LINE_WIDTH_MM,
    ),
    offsetX,
    offsetY,
  )
  const applicationName = threeMfProfile?.applicationName ?? 'BambuStudio-01.10.00.89'
  const modelXml = build3mfModelXml(baseMesh, lineMesh, baseplateSettings, applicationName)
  // #region debug-point B:build-3mf-model-xml
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'B', location: 'generator.ts:build3mfPackage:modelXml', msg: '[DEBUG] built single 3mf model xml', data: { modelXmlLength: modelXml.length, baseVertices: baseMesh.vertices.length, baseTriangles: baseMesh.triangles.length, lineVertices: lineMesh.vertices.length, lineTriangles: lineMesh.triangles.length }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '</Types>',
  ].join('\n')
  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
    '</Relationships>',
  ].join('\n')
  const modelSettings = buildBambuModelSettingsConfig([
    {
      id: 4,
      name: '线稿底板组合',
      parts: [
        { id: 2, name: '底板', extruder: 1 },
        { id: 3, name: '线稿', extruder: 2 },
      ],
    },
  ], [{
    plateIndex: 0,
    objectIds: [4],
    identifyIds: [1],
  }])
  const projectSettings = buildThreeMfProjectSettingsConfig(threeMfProfile, baseplateSettings, printBedSettings)
  const sliceInfoConfig = buildThreeMfSliceInfoConfig(threeMfProfile)
  const filamentSequence = buildThreeMfFilamentSequenceJson(threeMfProfile, 1)

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
    'Metadata/slice_info.config': strToU8(sliceInfoConfig),
    'Metadata/filament_sequence.json': strToU8(filamentSequence),
  }, { level: 0 })
}

export function buildPreviewModelGltfBlob(
  artwork: PreviewModelArtworkInput,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
) {
  const lineMeshPixelsPerMm = choosePreviewModelPixelsPerMm(artwork)
  // #region debug-point A:build-preview-model
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'A', location: 'generator.ts:buildPreviewModelGltfBlob:start', msg: '[DEBUG] start buildPreviewModelGltfBlob', data: { boardWidthMm: artwork.boardWidthMm, boardHeightMm: artwork.boardHeightMm, sourcePixelsPerMm: artwork.pixelsPerMm, previewPixelsPerMm: lineMeshPixelsPerMm, baseLoopCount: artwork.baseLoops.length, lineLoopCount: artwork.lineLoops.length }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const baseMesh = extrudeLoopsToMesh(
    keepOuterLoops(artwork.baseLoops),
    0,
    extrudeSettings.baseThicknessMm,
  )
  const lineMesh = extrudeMaskToMesh(
    artwork.lineLoops,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
    lineMeshPixelsPerMm,
    extrudeSettings.lineHeightMm,
    extrudeSettings.lineThicknessMm,
    MIN_EXPORTABLE_LINE_WIDTH_MM,
  )

  return buildGltfPreviewBlob(
    [
      { mesh: baseMesh, name: '底板', color: baseplateSettings.baseColor },
      { mesh: lineMesh, name: '线稿', color: baseplateSettings.lineColor },
    ],
    artwork.boardWidthMm,
    artwork.boardHeightMm,
  )
}

function choosePreviewModelPixelsPerMm(artwork: PreviewModelArtworkInput) {
  const sourcePixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 8), 4, 12)
  const longestSideMm = Math.max(artwork.boardWidthMm, artwork.boardHeightMm, 1)
  const areaMm = Math.max(artwork.boardWidthMm * artwork.boardHeightMm, 1)
  const maxPreviewDimensionPx = 960
  const maxPreviewAreaPx = 520_000
  const byDimension = maxPreviewDimensionPx / longestSideMm
  const byArea = Math.sqrt(maxPreviewAreaPx / areaMm)

  return clamp(Math.min(sourcePixelsPerMm, byDimension, byArea), 2.5, 8)
}

function chooseCombinedExportPixelsPerMm(
  artwork: ProcessedArtwork,
  itemCount: number,
  totalAreaMm: number,
) {
  const sourcePixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 10), 8, 20)
  const longestSideMm = Math.max(artwork.boardWidthMm, artwork.boardHeightMm, 1)
  const safeTotalAreaMm = Math.max(totalAreaMm, artwork.boardWidthMm * artwork.boardHeightMm, 1)
  const maxCombinedDimensionPx = itemCount >= 16 ? 520 : itemCount >= 8 ? 720 : 960
  const maxCombinedAreaPx = itemCount >= 16 ? 1_250_000 : itemCount >= 8 ? 1_900_000 : 2_800_000
  const byDimension = maxCombinedDimensionPx / longestSideMm
  const byArea = Math.sqrt(maxCombinedAreaPx / safeTotalAreaMm)

  return clamp(Math.min(sourcePixelsPerMm, byDimension, byArea), 2.5, 12)
}

export function buildCombined3mfPackage(
  items: Array<{
    id: string
    name: string
    artwork: ProcessedArtwork
  }>,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
) {
  // #region debug-point D:build-combined-3mf-package
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'D', location: 'generator.ts:buildCombined3mfPackage:start', msg: '[DEBUG] start buildCombined3mfPackage', data: { itemCount: items.length, printBedWidthMm: printBedSettings.widthMm, printBedDepthMm: printBedSettings.depthMm }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const totalAreaMm = items.reduce((sum, item) => sum + (item.artwork.boardWidthMm * item.artwork.boardHeightMm), 0)
  const contentTypes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>',
    '</Types>',
  ].join('\n')
  const rootRels = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    '  <Relationship Id="rel0" Target="/3D/3dmodel.model" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>',
    '</Relationships>',
  ].join('\n')
  const modelRels = build3mfModelRelationships(items.length)
  const printBedLayout = planPrintBedLayout(
    items.map((item) => ({
      id: item.id,
      label: item.name,
      widthMm: item.artwork.boardWidthMm,
      heightMm: item.artwork.boardHeightMm,
      previewDataUrl: item.artwork.previews.compositeDataUrl,
    })),
    printBedSettings,
  )
  if (printBedLayout.overflowCount > 0) {
    throw new Error('存在单个素材尺寸超过打印盘可用范围，请增大打印盘尺寸或缩小底板。')
  }
  const resourceLines: string[] = []
  const buildLines: string[] = []
  let nextObjectId = 1
  const modelSettingsObjects: BambuModelSettingsObject[] = []
  const plateAssignments = new Map<number, { objectIds: number[]; identifyIds: number[] }>()
  const applicationName = threeMfProfile?.applicationName ?? 'BambuStudio-01.10.00.89'
  let nextIdentifyId = 1
  const packageEntries: Record<string, Uint8Array> = {}
  const sourceFileName = 'lineart-baseplate-batch.3mf'

  items.forEach((item, itemIndex) => {
    const placement = printBedLayout.placements.find((entry) => entry.id === item.id)
    if (!placement) {
      throw new Error(`缺少素材 ${item.name} 的摆盘位置`)
    }
    const flippedBaseLoops = flipLoopsForModelExport(item.artwork.baseLoops, item.artwork.boardHeightMm)
    const flippedLineLoops = flipLoopsForModelExport(item.artwork.lineLoops, item.artwork.boardHeightMm)
    const lineMeshPixelsPerMm = chooseCombinedExportPixelsPerMm(item.artwork, items.length, totalAreaMm)
    const baseMesh = extrudeLoopsToMesh(keepOuterLoops(flippedBaseLoops), 0, extrudeSettings.baseThicknessMm)
    const lineMesh = extrudeMaskToMesh(
      flippedLineLoops,
      item.artwork.boardWidthMm,
      item.artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      extrudeSettings.lineHeightMm,
      extrudeSettings.lineThicknessMm,
      MIN_EXPORTABLE_LINE_WIDTH_MM,
    )
    const localBaseMesh = translateMesh(
      baseMesh,
      -(item.artwork.boardWidthMm * 0.5),
      -(item.artwork.boardHeightMm * 0.5),
      -(extrudeSettings.baseThicknessMm * 0.5),
    )
    const localLineMesh = translateMesh(
      lineMesh,
      -(item.artwork.boardWidthMm * 0.5),
      -(item.artwork.boardHeightMm * 0.5),
      -(extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm * 0.5),
    )
    const baseObjectId = nextObjectId
    const lineObjectId = nextObjectId + 1
    const compositeObjectId = nextObjectId + 2
    nextObjectId += 3
    const objectFilePath = `/3D/Objects/object_${itemIndex + 1}.model`
    const centerX = placement.xMm + item.artwork.boardWidthMm * 0.5
    const centerY = placement.yMm + item.artwork.boardHeightMm * 0.5
    const baseCenterZ = extrudeSettings.baseThicknessMm * 0.5
    const lineCenterZ = extrudeSettings.lineHeightMm + extrudeSettings.lineThicknessMm * 0.5
    const buildOffset = getCombinedPlateBuildOffset(placement.plateIndex, printBedSettings)
    const baseTransform = format3mfTransform(centerX, centerY, baseCenterZ)
    const lineTransform = format3mfTransform(centerX, centerY, lineCenterZ)
    const baseMatrix = format4x4Matrix(centerX, centerY, baseCenterZ)
    const lineMatrix = format4x4Matrix(centerX, centerY, lineCenterZ)
    // #region debug-point D:combined-item-mesh
    typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'D', location: 'generator.ts:buildCombined3mfPackage:item', msg: '[DEBUG] prepared combined 3mf item meshes', data: { itemId: item.id, itemName: item.name, plateIndex: placement.plateIndex, buildOffsetX: buildOffset.xMm, buildOffsetY: buildOffset.yMm, boardWidthMm: item.artwork.boardWidthMm, boardHeightMm: item.artwork.boardHeightMm, lineMeshPixelsPerMm, baseVertices: localBaseMesh.vertices.length, baseTriangles: localBaseMesh.triangles.length, lineVertices: localLineMesh.vertices.length, lineTriangles: localLineMesh.triangles.length }, ts: Date.now() }) }).catch(() => {})
    // #endregion

    packageEntries[`3D/Objects/object_${itemIndex + 1}.model`] = strToU8(
      buildStandalone3mfObjectModel(localBaseMesh, localLineMesh, baseObjectId, lineObjectId),
    )
    resourceLines.push(
      build3mfExternalCompositeObject(
        compositeObjectId,
        item.name,
        objectFilePath,
        baseObjectId,
        lineObjectId,
        baseTransform,
        lineTransform,
        itemIndex,
      ),
    )
    buildLines.push(`  <item objectid="${compositeObjectId}" p:UUID="${buildPseudoUuid(compositeObjectId, itemIndex + 1, 0, 0, 0xb1ec4553aec9)}" transform="${format3mfTransform(buildOffset.xMm, buildOffset.yMm, 0)}" printable="1"/>`)
    modelSettingsObjects.push({
      id: compositeObjectId,
      name: item.name,
      extruder: 1,
      faceCount: baseMesh.triangles.length + lineMesh.triangles.length,
      parts: [
        {
          id: baseObjectId,
          name: `${item.name}-底板`,
          extruder: 1,
          matrix: baseMatrix,
          sourceFile: sourceFileName,
          sourceObjectId: itemIndex,
          sourceVolumeId: 0,
          sourceOffsetX: centerX,
          sourceOffsetY: centerY,
          sourceOffsetZ: baseCenterZ,
          faceCount: baseMesh.triangles.length,
        },
        {
          id: lineObjectId,
          name: `${item.name}-线稿`,
          extruder: 2,
          matrix: lineMatrix,
          sourceFile: sourceFileName,
          sourceObjectId: itemIndex,
          sourceVolumeId: 1,
          sourceOffsetX: centerX,
          sourceOffsetY: centerY,
          sourceOffsetZ: lineCenterZ,
          faceCount: lineMesh.triangles.length,
        },
      ],
    })
    const currentPlateAssignment = plateAssignments.get(placement.plateIndex) ?? { objectIds: [], identifyIds: [] }
    currentPlateAssignment.objectIds.push(compositeObjectId)
    currentPlateAssignment.identifyIds.push(nextIdentifyId)
    nextIdentifyId += 1
    plateAssignments.set(placement.plateIndex, currentPlateAssignment)
  })

  const modelXml = buildCombined3mfModelXml(applicationName, resourceLines, buildLines)
  // #region debug-point D:combined-model-xml
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'D', location: 'generator.ts:buildCombined3mfPackage:modelXml', msg: '[DEBUG] built combined 3mf model xml', data: { modelXmlLength: modelXml.length, resourceCount: resourceLines.length, buildItemCount: buildLines.length, plateCount: printBedLayout.plates.length }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const modelSettings = buildBambuModelSettingsConfig(
    modelSettingsObjects,
    Array.from(plateAssignments.entries())
      .sort(([left], [right]) => left - right)
      .map(([plateIndex, assignment]) => ({ plateIndex, objectIds: assignment.objectIds, identifyIds: assignment.identifyIds })),
  )
  // #region debug-point D:combined-model-settings
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'D', location: 'generator.ts:buildCombined3mfPackage:modelSettings', msg: '[DEBUG] built combined 3mf model settings', data: { modelSettingsLength: modelSettings.length, plateAssignments: Array.from(plateAssignments.entries()).sort(([left], [right]) => left - right).map(([plateIndex, assignment]) => ({ plateIndex, objectCount: assignment.objectIds.length, firstIdentifyId: assignment.identifyIds[0] ?? null, lastIdentifyId: assignment.identifyIds[assignment.identifyIds.length - 1] ?? null })) }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const projectSettings = buildThreeMfProjectSettingsConfig(threeMfProfile, baseplateSettings, printBedSettings)
  const sliceInfoConfig = buildThreeMfSliceInfoConfig(threeMfProfile)
  const filamentSequence = buildThreeMfFilamentSequenceJson(threeMfProfile, printBedLayout.plates.length)

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/_rels/3dmodel.model.rels': strToU8(modelRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
    'Metadata/slice_info.config': strToU8(sliceInfoConfig),
    'Metadata/filament_sequence.json': strToU8(filamentSequence),
    ...packageEntries,
  }, { level: 0 })
}

function buildGltfPreviewBlob(
  parts: Array<{ mesh: MeshData; name: string; color: string }>,
  boardWidthMm: number,
  boardHeightMm: number,
) {
  const centerX = boardWidthMm * 0.5
  const centerY = boardHeightMm * 0.5
  const chunks: Uint8Array[] = []
  const bufferViews: Array<{ buffer: number; byteOffset: number; byteLength: number; target: number }> = []
  const accessors: Array<Record<string, unknown>> = []
  const meshes: Array<Record<string, unknown>> = []
  const materials: Array<Record<string, unknown>> = []
  const nodes: Array<Record<string, unknown>> = []
  let byteOffset = 0

  const appendChunk = (chunk: Uint8Array, target: number) => {
    const padding = (4 - (byteOffset % 4)) % 4
    if (padding > 0) {
      chunks.push(new Uint8Array(padding))
      byteOffset += padding
    }

    const offset = byteOffset
    chunks.push(chunk)
    byteOffset += chunk.byteLength
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: chunk.byteLength,
      target,
    })
    return bufferViews.length - 1
  }

  parts.forEach((part) => {
    if (!part.mesh.vertices.length || !part.mesh.triangles.length) {
      return
    }

    const positions = new Float32Array(part.mesh.vertices.length * 3)
    const mins = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]
    const maxs = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY]

    part.mesh.vertices.forEach(([x, y, z], index) => {
      const gltfX = x - centerX
      const gltfY = z
      const gltfZ = y - centerY
      const baseIndex = index * 3
      positions[baseIndex] = gltfX
      positions[baseIndex + 1] = gltfY
      positions[baseIndex + 2] = gltfZ

      mins[0] = Math.min(mins[0], gltfX)
      mins[1] = Math.min(mins[1], gltfY)
      mins[2] = Math.min(mins[2], gltfZ)
      maxs[0] = Math.max(maxs[0], gltfX)
      maxs[1] = Math.max(maxs[1], gltfY)
      maxs[2] = Math.max(maxs[2], gltfZ)
    })

    const indices = new Uint32Array(part.mesh.triangles.length * 3)
    part.mesh.triangles.forEach(([a, b, c], index) => {
      const baseIndex = index * 3
      indices[baseIndex] = a
      indices[baseIndex + 1] = b
      indices[baseIndex + 2] = c
    })

    const positionView = appendChunk(new Uint8Array(positions.buffer), 34962)
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: part.mesh.vertices.length,
      type: 'VEC3',
      min: mins,
      max: maxs,
    })
    const positionAccessor = accessors.length - 1

    const indexView = appendChunk(new Uint8Array(indices.buffer), 34963)
    accessors.push({
      bufferView: indexView,
      componentType: 5125,
      count: indices.length,
      type: 'SCALAR',
      min: [0],
      max: [part.mesh.vertices.length - 1],
    })
    const indexAccessor = accessors.length - 1

    materials.push({
      name: part.name,
      doubleSided: true,
      pbrMetallicRoughness: {
        baseColorFactor: [...hexColorToLinearFactor(part.color), 1],
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      extensions: {
        KHR_materials_unlit: {},
      },
    })
    const materialIndex = materials.length - 1

    meshes.push({
      name: part.name,
      primitives: [{
        attributes: { POSITION: positionAccessor },
        indices: indexAccessor,
        material: materialIndex,
        mode: 4,
      }],
    })
    nodes.push({
      name: part.name,
      mesh: meshes.length - 1,
    })
  })

  const combinedBuffer = concatUint8Arrays(chunks)
  // #region debug-point A:gltf-buffer-ready
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'A', location: 'generator.ts:buildGltfPreviewBlob:bufferReady', msg: '[DEBUG] gltf buffer ready', data: { partCount: parts.length, combinedBufferBytes: combinedBuffer.byteLength, meshVertices: parts.map((part) => ({ name: part.name, vertices: part.mesh.vertices.length, triangles: part.mesh.triangles.length })) }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  const gltf = {
    asset: {
      version: '2.0',
      generator: 'image-to-lineart-3mf',
    },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0,
    scenes: [{
      nodes: nodes.map((_, index) => index),
    }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{
      byteLength: combinedBuffer.byteLength,
      uri: `data:application/octet-stream;base64,${bytesToBase64(combinedBuffer)}`,
    }],
  }

  return new Blob([JSON.stringify(gltf)], { type: 'model/gltf+json' })
}

export function build3mfModelXml(
  baseMesh: MeshData,
  lineMesh: MeshData,
  settings: BaseplateSettings,
  applicationName = 'BambuStudio-01.10.00.89',
) {
  const baseColor = `${settings.baseColor.toUpperCase()}FF`
  const lineColor = `${settings.lineColor.toUpperCase()}FF`
  const baseObjectId = 2
  const lineObjectId = 3
  const compositeObjectId = 4

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    `  <metadata name="Application">${applicationName}</metadata>`,
    '  <metadata name="Designer">线稿底板生成器</metadata>',
    '  <metadata name="Title">线稿底板 3MF</metadata>',
    '  <resources>',
    '    <basematerials id="1">',
    `      <base name="底板" displaycolor="${baseColor}"/>`,
    `      <base name="线稿" displaycolor="${lineColor}"/>`,
    '    </basematerials>',
    `    ${meshTo3mfObject(baseMesh, baseObjectId, '底板', 0)}`,
    `    ${meshTo3mfObject(lineMesh, lineObjectId, '线稿', 1)}`,
    `    ${build3mfCompositeObject(compositeObjectId, '线稿底板组合', [baseObjectId, lineObjectId])}`,
    '  </resources>',
    '  <build>',
    `    <item objectid="${compositeObjectId}"/>`,
    '  </build>',
    '</model>',
  ].join('\n')
}

export function rebuildArtworkWithLineLoops(
  artwork: ProcessedArtwork,
  lineLoops: VectorLoop[],
  settings: BaseplateSettings,
) {
  const nextLineLoops = lineLoops.map((loop) => ({
    ...loop,
    points: sanitizeLoop(loop.points),
  })).filter((loop) => loop.points.length >= 3)

  return {
    ...artwork,
    lineLoops: nextLineLoops,
    previews: buildPreviewAssets(
      nextLineLoops,
      artwork.baseLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      settings,
    ),
    stats: {
      ...artwork.stats,
      lineLoopCount: nextLineLoops.length,
      lineSegments: nextLineLoops.reduce((sum, loop) => sum + loop.points.length, 0),
    },
  }
}

export function applyLineartStrokeEdit(
  artwork: ProcessedArtwork,
  settings: BaseplateSettings,
  points: VectorPoint[],
  radiusMm: number,
  mode: 'brush' | 'eraser',
) {
  if (!points.length) {
    return artwork
  }

  const pixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 12), 10, 32)
  const raster = rasterizeLoopsToMask(
    artwork.lineLoops,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
    pixelsPerMm,
    0,
  )
  paintMaskStroke(
    raster.mask,
    raster.width,
    raster.height,
    pixelsPerMm,
    points,
    Math.max(0.2, radiusMm),
    mode === 'brush' ? 1 : 0,
  )
  const editedLoops = traceMaskToLoops(raster.mask, raster.width, raster.height)
    .map((loop) => pixelsToMm(loop, pixelsPerMm, 0))
    .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.02)

  return rebuildArtworkWithLineLoops(artwork, editedLoops, settings)
}

export function layoutLineLoops(
  sourceLoops: VectorLoop[],
  settings: BaseplateSettings,
) {
  const bounds = getLoopBounds(sourceLoops)
  if (settings.template === 'outline') {
    return {
      boardWidthMm: bounds.width,
      boardHeightMm: bounds.height,
      lineLoops: sourceLoops,
    }
  }

  const boardWidthMm = settings.template === 'circle' ? settings.diameterMm : settings.widthMm
  const boardHeightMm = settings.template === 'circle' ? settings.diameterMm : settings.heightMm
  const margin = settings.marginMm + 0.6
  const safeWidth = Math.max(2, boardWidthMm - margin * 2)
  const safeHeight = Math.max(2, boardHeightMm - margin * 2)
  const scale = Math.min(
    safeWidth / Math.max(bounds.width, 0.001),
    safeHeight / Math.max(bounds.height, 0.001),
  )

  const scaled = scaleLoops(sourceLoops, scale)
  const scaledBounds = getLoopBounds(scaled)
  const offsetX = (boardWidthMm - scaledBounds.width) * 0.5 - scaledBounds.minX
  const offsetY = (boardHeightMm - scaledBounds.height) * 0.5 - scaledBounds.minY

  return {
    boardWidthMm,
    boardHeightMm,
    lineLoops: translateLoops(scaled, offsetX, offsetY),
  }
}

export function planPrintBedLayout(
  items: PrintBedPlacementItem[],
  settings: PrintBedSettings,
): PrintBedLayout {
  const widthMm = Math.max(10, settings.widthMm)
  const depthMm = Math.max(10, settings.depthMm)
  const spacingMm = Math.max(0, settings.spacingMm)
  const edgeMarginMm = Math.max(4, spacingMm * 0.5)

  if (!items.length) {
    return {
      widthMm,
      depthMm,
      spacingMm,
      edgeMarginMm,
      plates: [],
      placements: [],
      overflowCount: 0,
    }
  }

  if (items.length === 1) {
    const [item] = items
    const xMm = (widthMm - item.widthMm) * 0.5
    const yMm = (depthMm - item.heightMm) * 0.5
    const fits = xMm >= 0 && yMm >= 0

    return {
      widthMm,
      depthMm,
      spacingMm,
      edgeMarginMm,
      plates: [{
        plateIndex: 0,
        placements: [{
          id: item.id,
          label: item.label,
          xMm,
          yMm,
          widthMm: item.widthMm,
          heightMm: item.heightMm,
          previewDataUrl: item.previewDataUrl,
          fits,
          plateIndex: 0,
        }],
      }],
      placements: [{
        id: item.id,
        label: item.label,
        xMm,
        yMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        previewDataUrl: item.previewDataUrl,
        fits,
        plateIndex: 0,
      }],
      overflowCount: fits ? 0 : 1,
    }
  }

  const placements: PrintBedLayout['placements'] = []
  const usableWidthMm = Math.max(0, widthMm - edgeMarginMm * 2)
  const usableDepthMm = Math.max(0, depthMm - edgeMarginMm * 2)
  const plates: PrintBedLayout['plates'] = []
  let overflowCount = 0

  const createPlateCursor = (plateIndex: number) => ({
    plateIndex,
    cursorX: edgeMarginMm,
    cursorY: edgeMarginMm,
    rowMaxHeight: 0,
    placements: [] as PrintBedLayout['placements'],
  })

  let currentPlate = createPlateCursor(0)
  plates.push({
    plateIndex: currentPlate.plateIndex,
    placements: currentPlate.placements,
  })

  items.forEach((item) => {
    const fitsStandalone = item.widthMm <= usableWidthMm && item.heightMm <= usableDepthMm
    if (!fitsStandalone) {
      overflowCount += 1
      const placement = {
        id: item.id,
        label: item.label,
        xMm: edgeMarginMm,
        yMm: edgeMarginMm,
        widthMm: item.widthMm,
        heightMm: item.heightMm,
        previewDataUrl: item.previewDataUrl,
        fits: false,
        plateIndex: currentPlate.plateIndex,
      }
      placements.push(placement)
      currentPlate.placements.push(placement)
      return
    }

    if (currentPlate.cursorX + item.widthMm > widthMm - edgeMarginMm + 1e-6) {
      currentPlate.cursorX = edgeMarginMm
      currentPlate.cursorY += currentPlate.rowMaxHeight + spacingMm
      currentPlate.rowMaxHeight = 0
    }

    if (currentPlate.cursorY + item.heightMm > depthMm - edgeMarginMm + 1e-6) {
      currentPlate = createPlateCursor(plates.length)
      plates.push({
        plateIndex: currentPlate.plateIndex,
        placements: currentPlate.placements,
      })
    }

    const placement = {
      id: item.id,
      label: item.label,
      xMm: currentPlate.cursorX,
      yMm: currentPlate.cursorY,
      widthMm: item.widthMm,
      heightMm: item.heightMm,
      previewDataUrl: item.previewDataUrl,
      fits: true,
      plateIndex: currentPlate.plateIndex,
    }

    placements.push(placement)
    currentPlate.placements.push(placement)
    currentPlate.rowMaxHeight = Math.max(currentPlate.rowMaxHeight, item.heightMm)
    currentPlate.cursorX += item.widthMm + spacingMm
  })

  plates.forEach((plate) => {
    const fittedPlacements = plate.placements.filter((placement) => placement.fits)
    if (!fittedPlacements.length) {
      return
    }

    const minX = Math.min(...fittedPlacements.map((placement) => placement.xMm))
    const minY = Math.min(...fittedPlacements.map((placement) => placement.yMm))
    const maxX = Math.max(...fittedPlacements.map((placement) => placement.xMm + placement.widthMm))
    const maxY = Math.max(...fittedPlacements.map((placement) => placement.yMm + placement.heightMm))
    const targetMinX = Math.max(edgeMarginMm, (widthMm - (maxX - minX)) * 0.5)
    const targetMinY = Math.max(edgeMarginMm, (depthMm - (maxY - minY)) * 0.5)
    const deltaX = clamp(targetMinX - minX, edgeMarginMm - minX, widthMm - edgeMarginMm - maxX)
    const deltaY = clamp(targetMinY - minY, edgeMarginMm - minY, depthMm - edgeMarginMm - maxY)

    fittedPlacements.forEach((placement) => {
      placement.xMm += deltaX
      placement.yMm += deltaY
    })
  })

  return {
    widthMm,
    depthMm,
    spacingMm,
    edgeMarginMm,
    plates,
    placements,
    overflowCount,
  }
}

export function mirrorLoopsHorizontally(loops: VectorLoop[]) {
  const bounds = getLoopBounds(loops)
  const centerX = bounds.minX + bounds.width * 0.5

  return loops.map((loop) => ({
    ...loop,
    points: loop.points.map((point) => ({
      x: centerX * 2 - point.x,
      y: point.y,
    })),
  }))
}

export function getExportBaseName(name: string | undefined, fallback: string) {
  if (!name) return fallback
  return name.replace(/\.[^.]+$/, '') || fallback
}

async function buildImageLineart(
  sourceImage: SourceImage,
  settings: LineartSettings,
) {
  const image = await loadHtmlImage(sourceImage.dataUrl)
  const maxDimension = Math.max(320, Math.round(480 + settings.detail * 12))
  const processingScale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * processingScale))
  const height = Math.max(1, Math.round(image.naturalHeight * processingScale))
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('无法初始化图片处理画布')
  }

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  const imageData = context.getImageData(0, 0, canvas.width, canvas.height)
  const targetColor = hexToRgb(settings.targetColor)
  const tolerance = Math.max(0, settings.threshold)
  const toleranceSq = tolerance * tolerance
  const targetMask = buildTargetMaskFromOriginalPixels(
    imageData.data,
    canvas.width,
    canvas.height,
    width,
    height,
    targetColor,
    tolerance,
    toleranceSq,
    settings.invert,
  )
  const bridgedMask = getAdaptivePreservedMask(targetMask, width, height)
  const slimmedEdges = getAdaptiveLineMask(bridgedMask, width, height)
  const strokeRadius = Math.max(0, Math.round(settings.strokeWidth * 0.75))
  const widened = strokeRadius ? dilateMask(slimmedEdges, width, height, strokeRadius) : slimmedEdges
  const fillRatio = getFilledPixelCount(widened) / Math.max(1, width * height)
  const despeckleStrength = fillRatio < 0.12
    ? Math.round(settings.despeckle * 0.3)
    : fillRatio < 0.2
      ? Math.round(settings.despeckle * 0.55)
      : settings.despeckle
  const cleaned = despeckleStrength ? removeSmallComponents(widened, width, height, despeckleStrength) : widened
  const loops = smoothLoops(
    traceMaskToLoops(cleaned, width, height)
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 3),
    settings.smoothing,
  )
  const scaled = scaleLoopsToMaxDimension(normalizeLoops(loops), DEFAULT_LINEART_MAX_MM)

  return {
    kind: 'image' as const,
    width: sourceImage.width,
    height: sourceImage.height,
    loops: scaled,
  }
}

function buildTargetMaskFromOriginalPixels(
  pixels: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  outputWidth: number,
  outputHeight: number,
  targetColor: { r: number; g: number; b: number },
  tolerance: number,
  toleranceSq: number,
  invert: boolean,
) {
  const hitCounts = new Uint32Array(outputWidth * outputHeight)
  const totalCounts = new Uint32Array(outputWidth * outputHeight)
  const targetLuminance = getColorLuminance(targetColor)
  const useDarkTargetFallback = targetLuminance <= 28

  for (let y = 0; y < sourceHeight; y += 1) {
    const outputY = Math.min(outputHeight - 1, Math.floor((y * outputHeight) / sourceHeight))

    for (let x = 0; x < sourceWidth; x += 1) {
      const outputX = Math.min(outputWidth - 1, Math.floor((x * outputWidth) / sourceWidth))
      const outputIndex = outputY * outputWidth + outputX
      const offset = (y * sourceWidth + x) * 4
      const alpha = pixels[offset + 3]

      totalCounts[outputIndex] += 1

      if (alpha < 8) {
        if (invert) {
          hitCounts[outputIndex] += 1
        }
        continue
      }

      const current = {
        r: pixels[offset],
        g: pixels[offset + 1],
        b: pixels[offset + 2],
      }
      const matches = pixelMatchesTargetColor(
        current,
        targetColor,
        tolerance,
        toleranceSq,
        targetLuminance,
        useDarkTargetFallback,
      )
      if (invert ? !matches : matches) {
        hitCounts[outputIndex] += 1
      }
    }
  }

  const mask = new Uint8Array(outputWidth * outputHeight)
  for (let index = 0; index < mask.length; index += 1) {
    const total = totalCounts[index]
    if (!total) continue

    const hits = hitCounts[index]
    const threshold = invert
      ? Math.max(1, Math.ceil(total * 0.35))
      : Math.max(1, Math.ceil(total * 0.02))
    mask[index] = hits >= threshold ? 1 : 0
  }

  return mask
}

function pixelMatchesTargetColor(
  current: { r: number; g: number; b: number },
  targetColor: { r: number; g: number; b: number },
  tolerance: number,
  toleranceSq: number,
  targetLuminance: number,
  useDarkTargetFallback: boolean,
) {
  if (colorDistance(current, targetColor) <= toleranceSq) {
    return true
  }

  if (!useDarkTargetFallback) {
    return false
  }

  const luminance = getColorLuminance(current)
  const chromaSpread = Math.max(current.r, current.g, current.b) - Math.min(current.r, current.g, current.b)
  return luminance <= targetLuminance + tolerance && chromaSpread <= Math.max(18, tolerance * 0.45)
}

function removeSmallComponents(mask: Uint8Array, width: number, height: number, minArea: number) {
  const output = mask.slice()
  const visited = new Uint8Array(mask.length)
  const stack: number[] = []

  for (let start = 0; start < output.length; start += 1) {
    if (!output[start] || visited[start]) continue

    const component: number[] = []
    visited[start] = 1
    stack.push(start)

    while (stack.length) {
      const current = stack.pop()!
      component.push(current)
      const x = current % width
      const y = Math.floor(current / width)
      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ]

      neighbors.forEach((next, neighborIndex) => {
        const outOfRange = neighborIndex === 0 && x === 0
          || neighborIndex === 1 && x === width - 1
          || neighborIndex === 2 && y === 0
          || neighborIndex === 3 && y === height - 1
        if (outOfRange || next < 0 || next >= output.length || visited[next] || !output[next]) {
          return
        }
        visited[next] = 1
        stack.push(next)
      })
    }

    if (component.length < minArea) {
      component.forEach((index) => {
        output[index] = 0
      })
    }
  }

  return output
}

function dilateMask(mask: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return mask.slice()

  const output = new Uint8Array(mask.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let filled = 0
      for (let offsetY = -radius; offsetY <= radius && !filled; offsetY += 1) {
        const sampleY = y + offsetY
        if (sampleY < 0 || sampleY >= height) continue
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = x + offsetX
          if (sampleX < 0 || sampleX >= width) continue
          if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue
          if (mask[sampleY * width + sampleX]) {
            filled = 1
            break
          }
        }
      }
      output[y * width + x] = filled
    }
  }

  return output
}

function erodeMask(mask: Uint8Array, width: number, height: number, radius: number) {
  if (radius <= 0) return mask.slice()

  const output = new Uint8Array(mask.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let keep = 1
      for (let offsetY = -radius; offsetY <= radius && keep; offsetY += 1) {
        const sampleY = y + offsetY
        if (sampleY < 0 || sampleY >= height) {
          keep = 0
          break
        }
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          const sampleX = x + offsetX
          if (sampleX < 0 || sampleX >= width) {
            keep = 0
            break
          }
          if (offsetX * offsetX + offsetY * offsetY > radius * radius) continue
          if (!mask[sampleY * width + sampleX]) {
            keep = 0
            break
          }
        }
      }
      output[y * width + x] = keep
    }
  }

  return output
}

function getSlimLineMask(mask: Uint8Array, width: number, height: number) {
  const eroded = erodeMask(mask, width, height, 1)
  return hasFilledPixel(eroded) ? eroded : mask
}

function getAdaptivePreservedMask(mask: Uint8Array, width: number, height: number) {
  const fillRatio = getFilledPixelCount(mask) / Math.max(1, width * height)

  if (fillRatio >= 0.18) {
    return mask.slice()
  }

  const closed = erodeMask(dilateMask(mask, width, height, 1), width, height, 1)
  const retainedRatio = getFilledPixelCount(closed) / Math.max(1, getFilledPixelCount(mask))

  return retainedRatio >= 0.78 ? closed : mask.slice()
}

function getAdaptiveLineMask(mask: Uint8Array, width: number, height: number) {
  const fillRatio = getFilledPixelCount(mask) / Math.max(1, width * height)

  // Low coverage images are usually already line art; shrinking them drops major details.
  if (fillRatio < 0.12) {
    return mask.slice()
  }

  const slimmed = getSlimLineMask(mask, width, height)
  const retainedRatio = getFilledPixelCount(slimmed) / Math.max(1, getFilledPixelCount(mask))

  return retainedRatio >= 0.72 ? slimmed : mask.slice()
}

function hasFilledPixel(mask: Uint8Array) {
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      return true
    }
  }
  return false
}


function getFilledPixelCount(mask: Uint8Array) {
  let count = 0
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      count += 1
    }
  }
  return count
}

function getColorLuminance(color: { r: number; g: number; b: number }) {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722
}

function rasterizeLoopsToMask(
  loops: VectorLoop[],
  widthMm: number,
  heightMm: number,
  pixelsPerMm: number,
  paddingMm: number,
) {
  const width = Math.max(1, Math.ceil((widthMm + paddingMm * 2) * pixelsPerMm))
  const height = Math.max(1, Math.ceil((heightMm + paddingMm * 2) * pixelsPerMm))
  const isJsDom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)
  const hasDocumentCanvas = typeof document !== 'undefined' && typeof document.createElement === 'function'

  if (isJsDom || !hasDocumentCanvas) {
    return rasterizeLoopsWithoutCanvas(loops, width, height, pixelsPerMm, paddingMm)
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  let context: CanvasRenderingContext2D | null = null

  try {
    context = canvas.getContext('2d', { willReadFrequently: true })
  } catch {
    context = null
  }

  if (!context) {
    return rasterizeLoopsWithoutCanvas(loops, width, height, pixelsPerMm, paddingMm)
  }

  context.clearRect(0, 0, width, height)
  context.fillStyle = '#000000'
  context.beginPath()

  loops.forEach((loop) => {
    const [first, ...rest] = loop.points
    if (!first) return
    context.moveTo((first.x + paddingMm) * pixelsPerMm, (first.y + paddingMm) * pixelsPerMm)
    rest.forEach((point) => {
      context.lineTo((point.x + paddingMm) * pixelsPerMm, (point.y + paddingMm) * pixelsPerMm)
    })
    context.closePath()
  })

  context.fill('nonzero')
  const imageData = context.getImageData(0, 0, width, height)
  const mask = new Uint8Array(width * height)
  for (let index = 0; index < mask.length; index += 1) {
    mask[index] = imageData.data[index * 4 + 3] >= 8 ? 1 : 0
  }

  return {
    mask,
    width,
    height,
  }
}

function rasterizeLoopsWithoutCanvas(
  loops: VectorLoop[],
  width: number,
  height: number,
  pixelsPerMm: number,
  paddingMm: number,
) {
  const mask = new Uint8Array(width * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const samplePoint = {
        x: (x + 0.5) / pixelsPerMm - paddingMm,
        y: (y + 0.5) / pixelsPerMm - paddingMm,
      }

      let winding = 0
      for (const loop of loops) {
        winding += computeWindingNumber(samplePoint, loop.points)
      }

      mask[y * width + x] = winding !== 0 ? 1 : 0
    }
  }

  return {
    mask,
    width,
    height,
  }
}

export function traceMaskToLoops(mask: Uint8Array, width: number, height: number): VectorLoop[] {
  const edges: Array<{ start: VectorPoint; end: VectorPoint; dir: number }> = []
  const outgoing = new Map<string, number[]>()

  const addEdge = (start: VectorPoint, end: VectorPoint, dir: number) => {
    const index = edges.push({ start, end, dir }) - 1
    const key = pointKey(start)
    const list = outgoing.get(key) ?? []
    list.push(index)
    outgoing.set(key, list)
  }

  const isFilled = (x: number, y: number) => (
    x >= 0 && y >= 0 && x < width && y < height ? mask[y * width + x] === 1 : false
  )

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!isFilled(x, y)) continue
      if (!isFilled(x, y - 1)) addEdge({ x, y }, { x: x + 1, y }, 0)
      if (!isFilled(x + 1, y)) addEdge({ x: x + 1, y }, { x: x + 1, y: y + 1 }, 1)
      if (!isFilled(x, y + 1)) addEdge({ x: x + 1, y: y + 1 }, { x, y: y + 1 }, 2)
      if (!isFilled(x - 1, y)) addEdge({ x, y: y + 1 }, { x, y }, 3)
    }
  }

  const used = new Uint8Array(edges.length)
  const loops: VectorLoop[] = []

  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    if (used[edgeIndex]) continue

    const loopPoints: VectorPoint[] = []
    let currentEdgeIndex = edgeIndex
    let guard = 0

    while (!used[currentEdgeIndex] && guard < edges.length + 1) {
      guard += 1
      const edge = edges[currentEdgeIndex]
      used[currentEdgeIndex] = 1
      if (!loopPoints.length) {
        loopPoints.push(edge.start)
      }
      loopPoints.push(edge.end)

      const candidates = (outgoing.get(pointKey(edge.end)) ?? [])
        .filter((nextIndex) => !used[nextIndex])
      if (!candidates.length) {
        break
      }

      currentEdgeIndex = chooseNextEdge(edge.dir, candidates, edges)
      if (samePoint(edges[currentEdgeIndex].start, loopPoints[0])) {
        if (!used[currentEdgeIndex]) {
          const closingEdge = edges[currentEdgeIndex]
          used[currentEdgeIndex] = 1
          loopPoints.push(closingEdge.end)
        }
        break
      }
    }

    const cleanedPoints = sanitizeLoop(loopPoints)
    if (cleanedPoints.length >= 3) {
      loops.push({ points: cleanedPoints, closed: true })
    }
  }

  return loops
}

function chooseNextEdge(previousDir: number, candidates: number[], edges: Array<{ dir: number }>) {
  const preferences = [
    (previousDir + 1) % 4,
    previousDir,
    (previousDir + 3) % 4,
    (previousDir + 2) % 4,
  ]

  for (const direction of preferences) {
    const match = candidates.find((candidate) => edges[candidate].dir === direction)
    if (match !== undefined) {
      return match
    }
  }

  return candidates[0]
}

function smoothLoops(loops: VectorLoop[], smoothing: number) {
  const normalized = clamp(smoothing / 100, 0, 1)
  const smoothingPasses = Math.min(4, Math.round(smoothing / 18))
  const cornerPrunePasses = Math.min(3, Math.round(smoothing / 30))
  const blend = 0.16 + normalized * 0.22
  const wrinkleTolerance = 0.05 + normalized * 0.4
  const simplifyTolerance = normalized > 0.08 ? 0.04 + normalized * normalized * 0.7 : 0
  const minDistance = 0.08 + smoothing * 0.003

  return loops
    .map((loop) => {
      const originalPoints = sanitizeLoop(loop.points)
      const originalMetrics = measureLoopGeometry(originalPoints)
      const shapeGuard = getLoopShapeGuard(originalMetrics)
      const isThinLineLoop = originalMetrics.minDimension <= 0.9 || originalMetrics.aspectRatio >= 5
      let points = originalPoints
      for (let index = 0; index < smoothingPasses; index += 1) {
        points = preserveLoopShape(
          points,
          smoothRing(points, blend),
          originalMetrics,
          shapeGuard,
        )
      }
      for (let index = 0; index < cornerPrunePasses; index += 1) {
        points = preserveLoopShape(
          points,
          pruneWrinkles(points, wrinkleTolerance),
          originalMetrics,
          shapeGuard,
        )
      }
      if (simplifyTolerance > 0) {
        points = preserveLoopShape(
          points,
          simplifyClosedLoop(points, isThinLineLoop ? simplifyTolerance * 0.15 : simplifyTolerance),
          originalMetrics,
          shapeGuard,
        )
      }
      points = preserveLoopShape(
        points,
        dedupeByDistance(points, isThinLineLoop ? minDistance * 0.4 : minDistance),
        originalMetrics,
        shapeGuard,
      )
      points = sanitizeLoop(points)
      return {
        ...loop,
        points,
      }
    })
    .filter((loop) => loop.points.length >= 3)
}

function smoothRing(points: VectorPoint[], blend: number) {
  if (points.length < 3) return points
  const next: VectorPoint[] = []

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const following = points[(index + 1) % points.length]
    const midpointX = (previous.x + following.x) * 0.5
    const midpointY = (previous.y + following.y) * 0.5
    next.push({
      x: current.x * (1 - blend) + midpointX * blend,
      y: current.y * (1 - blend) + midpointY * blend,
    })
  }

  return next
}

function measureLoopGeometry(points: VectorPoint[]) {
  const bounds = getLoopBounds([{ points, closed: true }])
  const area = Math.abs(loopArea(points))
  let perimeter = 0

  for (let index = 0; index < points.length; index += 1) {
    perimeter += distance(points[index], points[(index + 1) % points.length])
  }

  const minDimension = Math.max(Math.min(bounds.width, bounds.height), 0.001)
  const maxDimension = Math.max(bounds.width, bounds.height, 0.001)

  return {
    area,
    perimeter,
    width: bounds.width,
    height: bounds.height,
    minDimension,
    maxDimension,
    aspectRatio: maxDimension / minDimension,
  }
}

function getLoopShapeGuard(metrics: ReturnType<typeof measureLoopGeometry>) {
  const isThinLineLoop = metrics.minDimension <= 0.9 || metrics.aspectRatio >= 5

  return {
    areaRatio: isThinLineLoop ? 0.82 : 0.68,
    perimeterRatio: isThinLineLoop ? 0.78 : 0.58,
    widthRatio: metrics.width <= 0.9 ? 0.78 : 0.62,
    heightRatio: metrics.height <= 0.9 ? 0.78 : 0.62,
    dominantRatio: isThinLineLoop ? 0.92 : 0.82,
  }
}

function preserveLoopShape(
  currentPoints: VectorPoint[],
  candidatePoints: VectorPoint[],
  originalMetrics: ReturnType<typeof measureLoopGeometry>,
  shapeGuard: ReturnType<typeof getLoopShapeGuard>,
) {
  const sanitizedCandidate = sanitizeLoop(candidatePoints)
  if (sanitizedCandidate.length < 3) {
    return currentPoints
  }

  const candidateMetrics = measureLoopGeometry(sanitizedCandidate)
  if (candidateMetrics.area < originalMetrics.area * shapeGuard.areaRatio) {
    return currentPoints
  }
  if (candidateMetrics.perimeter < originalMetrics.perimeter * shapeGuard.perimeterRatio) {
    return currentPoints
  }
  if (originalMetrics.width > 0 && candidateMetrics.width < originalMetrics.width * shapeGuard.widthRatio) {
    return currentPoints
  }
  if (originalMetrics.height > 0 && candidateMetrics.height < originalMetrics.height * shapeGuard.heightRatio) {
    return currentPoints
  }
  if (candidateMetrics.maxDimension < originalMetrics.maxDimension * shapeGuard.dominantRatio) {
    return currentPoints
  }

  return sanitizedCandidate
}

function pruneWrinkles(points: VectorPoint[], tolerance: number) {
  if (points.length < 4) return points
  const pruned: VectorPoint[] = []

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length]
    const current = points[index]
    const next = points[(index + 1) % points.length]
    const span = distance(previous, next)
    const legA = distance(previous, current)
    const legB = distance(current, next)
    const deviation = pointToSegmentDistance(current, previous, next)

    if (
      span > 0
      && legA <= tolerance * 1.8
      && legB <= tolerance * 1.8
      && deviation <= tolerance
    ) {
      continue
    }

    pruned.push(current)
  }

  return pruned.length >= 3 ? pruned : points
}

function simplifyClosedLoop(points: VectorPoint[], tolerance: number) {
  if (points.length < 4) return points
  const center = points.reduce((accumulator, point) => ({
    x: accumulator.x + point.x / points.length,
    y: accumulator.y + point.y / points.length,
  }), { x: 0, y: 0 })
  let anchorIndex = 0
  let maxDistanceFromCenter = -1

  points.forEach((point, index) => {
    const currentDistance = distance(point, center)
    if (currentDistance > maxDistanceFromCenter) {
      maxDistanceFromCenter = currentDistance
      anchorIndex = index
    }
  })

  const rotated = points.slice(anchorIndex).concat(points.slice(0, anchorIndex))
  const simplified = simplifyPolyline(
    [...rotated, rotated[0]],
    tolerance,
  ).slice(0, -1)

  return simplified.length >= 3 ? sanitizeLoop(simplified) : points
}

function simplifyPolyline(points: VectorPoint[], tolerance: number) {
  if (points.length <= 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  let maxDistance = -1
  let splitIndex = -1

  for (let index = 1; index < points.length - 1; index += 1) {
    const currentDistance = pointToSegmentDistance(points[index], first, last)
    if (currentDistance > maxDistance) {
      maxDistance = currentDistance
      splitIndex = index
    }
  }

  if (maxDistance <= tolerance || splitIndex === -1) {
    return [first, last]
  }

  const left = simplifyPolyline(points.slice(0, splitIndex + 1), tolerance)
  const right = simplifyPolyline(points.slice(splitIndex), tolerance)
  return [...left.slice(0, -1), ...right]
}

function pointToSegmentDistance(point: VectorPoint, start: VectorPoint, end: VectorPoint) {
  const segmentX = end.x - start.x
  const segmentY = end.y - start.y
  const lengthSquared = segmentX * segmentX + segmentY * segmentY

  if (lengthSquared <= 1e-12) {
    return distance(point, start)
  }

  const projection = clamp(
    ((point.x - start.x) * segmentX + (point.y - start.y) * segmentY) / lengthSquared,
    0,
    1,
  )
  const projectedPoint = {
    x: start.x + segmentX * projection,
    y: start.y + segmentY * projection,
  }

  return distance(point, projectedPoint)
}

function dedupeByDistance(points: VectorPoint[], minDistance: number) {
  if (points.length < 3) return points
  const result: VectorPoint[] = []

  points.forEach((point) => {
    const previous = result[result.length - 1]
    if (!previous || distance(previous, point) >= minDistance) {
      result.push(point)
    }
  })

  if (result.length >= 3 && distance(result[0], result[result.length - 1]) < minDistance) {
    result.pop()
  }

  return result
}

function scaleLoopsToMaxDimension(loops: VectorLoop[], maxMm: number) {
  const bounds = getLoopBounds(loops)
  const scale = maxMm / Math.max(bounds.width, bounds.height, 0.001)
  return scaleLoops(loops, scale)
}

function normalizeLoops(loops: VectorLoop[]) {
  const bounds = getLoopBounds(loops)
  return translateLoops(loops, -bounds.minX, -bounds.minY)
}

function translateLoops(loops: VectorLoop[], offsetX: number, offsetY: number) {
  return loops.map((loop) => ({
    ...loop,
    points: loop.points.map((point) => ({
      x: point.x + offsetX,
      y: point.y + offsetY,
    })),
  }))
}

function flipLoopsForModelExport(loops: VectorLoop[], boardHeightMm: number) {
  return loops.map((loop) => ({
    ...loop,
    points: loop.points.map((point) => ({
      x: point.x,
      y: boardHeightMm - point.y,
    })),
  }))
}

function scaleLoops(loops: VectorLoop[], factor: number) {
  return loops.map((loop) => ({
    ...loop,
    points: loop.points.map((point) => ({
      x: point.x * factor,
      y: point.y * factor,
    })),
  }))
}

function pixelsToMm(loop: VectorLoop, pixelsPerMm: number, paddingMm: number) {
  return {
    ...loop,
    points: loop.points.map((point) => ({
      x: point.x / pixelsPerMm - paddingMm,
      y: point.y / pixelsPerMm - paddingMm,
    })),
  }
}

function createTemplateBaseLoops(settings: BaseplateSettings): VectorLoop[] {
  if (settings.template === 'circle') {
    return [createCircleLoop(settings.diameterMm)]
  }

  return [createRectangleLoop(settings.widthMm, settings.heightMm)]
}

function createRectangleLoop(widthMm: number, heightMm: number): VectorLoop {
  return {
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: widthMm, y: 0 },
      { x: widthMm, y: heightMm },
      { x: 0, y: heightMm },
    ],
  }
}

function createCircleLoop(diameterMm: number): VectorLoop {
  const radius = diameterMm * 0.5
  const center = diameterMm * 0.5
  const points: VectorPoint[] = []

  for (let step = 0; step < 64; step += 1) {
    const angle = (step / 64) * Math.PI * 2
    points.push({
      x: center + Math.cos(angle) * radius,
      y: center + Math.sin(angle) * radius,
    })
  }

  return {
    closed: true,
    points,
  }
}

function buildPreviewAssets(
  lineLoops: VectorLoop[],
  baseLoops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  settings: BaseplateSettings,
) {
  return {
    lineartDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'lineart', fill: settings.lineColor, loops: lineLoops },
    ]),
    baseplateDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
      { id: 'lineart-ghost', fill: settings.lineColor, loops: lineLoops, opacity: 0.22 },
    ]),
    compositeDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
      { id: 'lineart', fill: settings.lineColor, loops: lineLoops },
    ]),
  }
}

function buildPreviewSvgDataUrl(
  boardWidthMm: number,
  boardHeightMm: number,
  layers: Array<{
    id: string
    fill: string
    loops: VectorLoop[]
    opacity?: number
  }>,
) {
  const svg = buildPreviewSvgDocument(boardWidthMm, boardHeightMm, layers)
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
}

function buildPreviewSvgDocument(
  boardWidthMm: number,
  boardHeightMm: number,
  layers: Array<{
    id: string
    fill: string
    loops: VectorLoop[]
    opacity?: number
  }>,
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boardWidthMm}mm" height="${boardHeightMm}mm" viewBox="0 0 ${formatNumber(boardWidthMm)} ${formatNumber(boardHeightMm)}">`,
    ...layers
      .map((layer) => {
        const path = loopsToSvgPath(layer.loops)
        if (!path) return ''
        const opacityAttribute = layer.opacity === undefined ? '' : ` opacity="${formatNumber(layer.opacity)}"`
        return `  <g id="${layer.id}" fill="${layer.fill}"${opacityAttribute}><path d="${path}" /></g>`
      })
      .filter(Boolean),
    '</svg>',
  ].join('\n')
}

function getLoopBounds(loops: VectorLoop[]): Bounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  loops.forEach((loop) => {
    loop.points.forEach((point) => {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    })
  })

  if (!Number.isFinite(minX)) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 }
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function keepOuterLoops(loops: VectorLoop[]) {
  const normalized = loops
    .map((loop) => ({
      loop,
      area: Math.abs(loopArea(loop.points)),
      center: centroid(loop.points),
    }))
    .sort((a, b) => b.area - a.area)

  return normalized
    .filter((candidate, index) => {
      for (let compare = 0; compare < index; compare += 1) {
        if (pointInPolygon(candidate.center, normalized[compare].loop.points)) {
          return false
        }
      }
      return true
    })
    .map((entry) => entry.loop)
}

function centroid(points: VectorPoint[]) {
  const total = points.reduce((sum, point) => ({
    x: sum.x + point.x,
    y: sum.y + point.y,
  }), { x: 0, y: 0 })

  return {
    x: total.x / Math.max(points.length, 1),
    y: total.y / Math.max(points.length, 1),
  }
}

function pointInPolygon(point: VectorPoint, polygon: VectorPoint[]) {
  let inside = false

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    const intersect = ((a.y > point.y) !== (b.y > point.y))
      && (point.x < ((b.x - a.x) * (point.y - a.y)) / Math.max(b.y - a.y, 1e-9) + a.x)
    if (intersect) inside = !inside
  }

  return inside
}

function computeWindingNumber(point: VectorPoint, polygon: VectorPoint[]) {
  let winding = 0

  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]

    if (current.y <= point.y) {
      if (next.y > point.y && cross(current, next, point) > 0) {
        winding += 1
      }
    } else if (next.y <= point.y && cross(current, next, point) < 0) {
      winding -= 1
    }
  }

  return winding
}

function loopsToSvgPath(loops: VectorLoop[]) {
  return loops
    .map((loop) => {
      const [first, ...rest] = loop.points
      if (!first) return ''
      const parts = [`M ${formatNumber(first.x)} ${formatNumber(first.y)}`]
      rest.forEach((point) => {
        parts.push(`L ${formatNumber(point.x)} ${formatNumber(point.y)}`)
      })
      parts.push('Z')
      return parts.join(' ')
    })
    .filter(Boolean)
    .join(' ')
}

function paintMaskStroke(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelsPerMm: number,
  points: VectorPoint[],
  radiusMm: number,
  fillValue: 0 | 1,
) {
  if (!points.length) {
    return
  }

  const radiusPx = Math.max(1, Math.round(radiusMm * pixelsPerMm))
  const pixelPoints = points.map((point) => ({
    x: point.x * pixelsPerMm,
    y: point.y * pixelsPerMm,
  }))
  const samples: VectorPoint[] = []

  pixelPoints.forEach((point, index) => {
    samples.push(point)
    const next = pixelPoints[index + 1]
    if (!next) return

    const distancePx = distance(point, next)
    const stepPx = Math.max(1, radiusPx * 0.35)
    const steps = Math.max(1, Math.ceil(distancePx / stepPx))
    for (let step = 1; step < steps; step += 1) {
      const ratio = step / steps
      samples.push({
        x: point.x + (next.x - point.x) * ratio,
        y: point.y + (next.y - point.y) * ratio,
      })
    }
  })

  samples.forEach((point) => {
    const centerX = point.x
    const centerY = point.y
    const minX = Math.max(0, Math.floor(centerX - radiusPx))
    const maxX = Math.min(width - 1, Math.ceil(centerX + radiusPx))
    const minY = Math.max(0, Math.floor(centerY - radiusPx))
    const maxY = Math.min(height - 1, Math.ceil(centerY + radiusPx))

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        const deltaX = x + 0.5 - centerX
        const deltaY = y + 0.5 - centerY
        if (deltaX * deltaX + deltaY * deltaY > radiusPx * radiusPx) {
          continue
        }
        mask[y * width + x] = fillValue
      }
    }
  })
}

function extrudeLoopsToMesh(loops: VectorLoop[], zStart: number, height: number): MeshData {
  const mesh: MeshData = {
    vertices: [],
    triangles: [],
  }

  if (height <= 0 || !loops.length) {
    return mesh
  }

  loops.forEach((loop) => {
    const points = sanitizeLoop(loop.points)
    if (points.length < 3) return

    const baseIndex = mesh.vertices.length
    points.forEach((point) => {
      mesh.vertices.push([point.x, point.y, zStart])
    })
    points.forEach((point) => {
      mesh.vertices.push([point.x, point.y, zStart + height])
    })

    const topTriangles = triangulatePolygon(points)
    const count = points.length

    topTriangles.forEach(([a, b, c]) => {
      mesh.triangles.push([baseIndex + c, baseIndex + b, baseIndex + a])
      mesh.triangles.push([baseIndex + count + a, baseIndex + count + b, baseIndex + count + c])
    })

    for (let index = 0; index < count; index += 1) {
      const next = (index + 1) % count
      const a = baseIndex + index
      const b = baseIndex + next
      const c = baseIndex + count + next
      const d = baseIndex + count + index
      mesh.triangles.push([a, b, c])
      mesh.triangles.push([a, c, d])
    }
  })

  return mesh
}

function extrudeMaskToMesh(
  loops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  pixelsPerMm: number,
  zStart: number,
  height: number,
  minimumLineWidthMm = 0,
): MeshData {
  const raster = rasterizeLoopsToMask(loops, boardWidthMm, boardHeightMm, pixelsPerMm, 0)
  const mesh: MeshData = {
    vertices: [],
    triangles: [],
  }

  if (height <= 0 || !loops.length) {
    return mesh
  }
  const enforcedMask = applyMinimumLineWidth(
    raster.mask,
    raster.width,
    raster.height,
    pixelsPerMm,
    minimumLineWidthMm,
  )
  const printSafeMask = applyPrintSafeSolidFeatures(
    enforcedMask,
    raster.width,
    raster.height,
    pixelsPerMm,
    MIN_EXPORTABLE_SOLID_DIAMETER_MM,
    MAX_EXPORTABLE_HOLE_DIAMETER_MM,
  )
  const vertexIndexMap = new Map<string, number>()
  const cellWidthMm = 1 / pixelsPerMm

  const getVertexIndex = (x: number, y: number, z: number) => {
    const key = `${x.toFixed(5)},${y.toFixed(5)},${z.toFixed(5)}`
    const existing = vertexIndexMap.get(key)
    if (existing !== undefined) {
      return existing
    }
    const index = mesh.vertices.length
    mesh.vertices.push([x, y, z])
    vertexIndexMap.set(key, index)
    return index
  }

  const addTriangle = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
  ) => {
    mesh.triangles.push([
      getVertexIndex(...a),
      getVertexIndex(...b),
      getVertexIndex(...c),
    ])
  }

  const addQuad = (
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
  ) => {
    addTriangle(a, b, c)
    addTriangle(a, c, d)
  }

  const isFilled = (x: number, y: number) => (
    x >= 0 && y >= 0 && x < raster.width && y < raster.height ? printSafeMask[y * raster.width + x] === 1 : false
  )

  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!isFilled(x, y)) continue

      const x0 = x * cellWidthMm
      const x1 = (x + 1) * cellWidthMm
      const y0 = y * cellWidthMm
      const y1 = (y + 1) * cellWidthMm
      const z0 = zStart
      const z1 = zStart + height

      addQuad(
        [x0, y0, z1],
        [x1, y0, z1],
        [x1, y1, z1],
        [x0, y1, z1],
      )
      addQuad(
        [x0, y1, z0],
        [x1, y1, z0],
        [x1, y0, z0],
        [x0, y0, z0],
      )

      if (!isFilled(x, y - 1)) {
        addQuad(
          [x0, y0, z0],
          [x1, y0, z0],
          [x1, y0, z1],
          [x0, y0, z1],
        )
      }
      if (!isFilled(x + 1, y)) {
        addQuad(
          [x1, y0, z0],
          [x1, y1, z0],
          [x1, y1, z1],
          [x1, y0, z1],
        )
      }
      if (!isFilled(x, y + 1)) {
        addQuad(
          [x1, y1, z0],
          [x0, y1, z0],
          [x0, y1, z1],
          [x1, y1, z1],
        )
      }
      if (!isFilled(x - 1, y)) {
        addQuad(
          [x0, y1, z0],
          [x0, y0, z0],
          [x0, y0, z1],
          [x0, y1, z1],
        )
      }
    }
  }

  return mesh
}

function applyMinimumLineWidth(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelsPerMm: number,
  minimumLineWidthMm: number,
) {
  if (minimumLineWidthMm <= 0) {
    return mask
  }

  const minimumRadius = Math.max(0, Math.ceil((minimumLineWidthMm * pixelsPerMm - 1) * 0.5))
  if (minimumRadius <= 0) {
    return mask
  }

  return dilateMask(mask, width, height, minimumRadius)
}

function applyPrintSafeSolidFeatures(
  mask: Uint8Array,
  width: number,
  height: number,
  pixelsPerMm: number,
  minimumSolidDiameterMm: number,
  maximumHoleDiameterMm: number,
) {
  const holeFilledMask = fillSmallHoles(
    mask,
    width,
    height,
    Math.max(1, Math.round(Math.PI * ((maximumHoleDiameterMm * pixelsPerMm) * 0.5) ** 2)),
  )

  return enlargeSmallSolidComponents(
    holeFilledMask,
    width,
    height,
    Math.max(1, Math.ceil(minimumSolidDiameterMm * pixelsPerMm)),
  )
}

function fillSmallHoles(mask: Uint8Array, width: number, height: number, maxHoleAreaPx: number) {
  const output = mask.slice()
  const visited = new Uint8Array(mask.length)
  const stack: number[] = []

  for (let start = 0; start < output.length; start += 1) {
    if (output[start] || visited[start]) continue

    const component: number[] = []
    let touchesBorder = false
    visited[start] = 1
    stack.push(start)

    while (stack.length) {
      const current = stack.pop()!
      component.push(current)
      const x = current % width
      const y = Math.floor(current / width)

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        touchesBorder = true
      }

      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ]

      neighbors.forEach((next, neighborIndex) => {
        const outOfRange = neighborIndex === 0 && x === 0
          || neighborIndex === 1 && x === width - 1
          || neighborIndex === 2 && y === 0
          || neighborIndex === 3 && y === height - 1
        if (outOfRange || next < 0 || next >= output.length || visited[next] || output[next]) {
          return
        }
        visited[next] = 1
        stack.push(next)
      })
    }

    if (!touchesBorder && component.length <= maxHoleAreaPx) {
      component.forEach((index) => {
        output[index] = 1
      })
    }
  }

  return output
}

function enlargeSmallSolidComponents(
  mask: Uint8Array,
  width: number,
  height: number,
  minimumDiameterPx: number,
) {
  if (minimumDiameterPx <= 1) {
    return mask
  }

  const output = mask.slice()
  const visited = new Uint8Array(mask.length)
  const stack: number[] = []

  for (let start = 0; start < output.length; start += 1) {
    if (!output[start] || visited[start]) continue

    const component: number[] = []
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    visited[start] = 1
    stack.push(start)

    while (stack.length) {
      const current = stack.pop()!
      component.push(current)
      const x = current % width
      const y = Math.floor(current / width)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)

      const neighbors = [
        current - 1,
        current + 1,
        current - width,
        current + width,
      ]

      neighbors.forEach((next, neighborIndex) => {
        const outOfRange = neighborIndex === 0 && x === 0
          || neighborIndex === 1 && x === width - 1
          || neighborIndex === 2 && y === 0
          || neighborIndex === 3 && y === height - 1
        if (outOfRange || next < 0 || next >= output.length || visited[next] || !output[next]) {
          return
        }
        visited[next] = 1
        stack.push(next)
      })
    }

    const componentWidth = maxX - minX + 1
    const componentHeight = maxY - minY + 1
    if (componentWidth >= minimumDiameterPx || componentHeight >= minimumDiameterPx) {
      continue
    }

    const expandRadius = Math.max(
      0,
      Math.ceil((minimumDiameterPx - Math.max(componentWidth, componentHeight)) * 0.5),
    )
    if (expandRadius <= 0) {
      continue
    }

    component.forEach((index) => {
      const x = index % width
      const y = Math.floor(index / width)
      for (let offsetY = -expandRadius; offsetY <= expandRadius; offsetY += 1) {
        const sampleY = y + offsetY
        if (sampleY < 0 || sampleY >= height) continue
        for (let offsetX = -expandRadius; offsetX <= expandRadius; offsetX += 1) {
          const sampleX = x + offsetX
          if (sampleX < 0 || sampleX >= width) continue
          if (offsetX * offsetX + offsetY * offsetY > expandRadius * expandRadius) continue
          output[sampleY * width + sampleX] = 1
        }
      }
    })
  }

  return output
}

function triangulatePolygon(points: VectorPoint[]) {
  const polygon = loopArea(points) < 0 ? [...points].reverse() : [...points]
  const indices = polygon.map((_, index) => index)
  const triangles: Array<[number, number, number]> = []
  let guard = 0

  while (indices.length > 3 && guard < polygon.length * polygon.length) {
    guard += 1
    let clipped = false

    for (let offset = 0; offset < indices.length; offset += 1) {
      const prevIndex = indices[(offset - 1 + indices.length) % indices.length]
      const currentIndex = indices[offset]
      const nextIndex = indices[(offset + 1) % indices.length]
      const prev = polygon[prevIndex]
      const current = polygon[currentIndex]
      const next = polygon[nextIndex]

      if (cross(prev, current, next) <= 0) continue

      const containsPoint = indices.some((testIndex) => {
        if (testIndex === prevIndex || testIndex === currentIndex || testIndex === nextIndex) {
          return false
        }
        return pointInTriangle(polygon[testIndex], prev, current, next)
      })

      if (containsPoint) continue

      triangles.push([prevIndex, currentIndex, nextIndex])
      indices.splice(offset, 1)
      clipped = true
      break
    }

    if (!clipped) {
      break
    }
  }

  if (indices.length === 3) {
    triangles.push([indices[0], indices[1], indices[2]])
  }

  return triangles
}

function meshTo3mfObject(mesh: MeshData, objectId: number, name: string, materialIndex: number) {
  return [
    `    <object id="${objectId}" type="model" pid="1" pindex="${materialIndex}" name="${name}">`,
    '      <mesh>',
    '        <vertices>',
    ...mesh.vertices.map(([x, y, z]) => `          <vertex x="${formatNumber(x)}" y="${formatNumber(y)}" z="${formatNumber(z)}"/>`),
    '        </vertices>',
    '        <triangles>',
    ...mesh.triangles.map(([v1, v2, v3]) => `          <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`),
    '        </triangles>',
    '      </mesh>',
    '    </object>',
  ].join('\n')
}

function translateMesh(mesh: MeshData, offsetX: number, offsetY: number, offsetZ = 0): MeshData {
  return {
    vertices: mesh.vertices.map(([x, y, z]) => [x + offsetX, y + offsetY, z + offsetZ]),
    triangles: [...mesh.triangles],
  }
}

function build3mfCompositeObject(objectId: number, name: string, componentIds: number[]) {
  return [
    `    <object id="${objectId}" type="model" name="${name}">`,
    '      <components>',
    ...componentIds.map((componentId) => `        <component objectid="${componentId}"/>`),
    '      </components>',
    '    </object>',
  ].join('\n')
}

function build3mfExternalCompositeObject(
  objectId: number,
  name: string,
  objectFilePath: string,
  baseObjectId: number,
  lineObjectId: number,
  baseTransform: string,
  lineTransform: string,
  itemIndex: number,
) {
  return [
    `  <object id="${objectId}" p:UUID="${buildPseudoUuid(itemIndex + 1, 0, 0, 0, 0x61cb4c039d28)}" type="model">`,
    '   <components>',
    `    <component p:path="${objectFilePath}" objectid="${baseObjectId}" p:UUID="${buildPseudoUuid(itemIndex + 1, 1, 0, 0, 0xb20640ff9872)}" transform="${baseTransform}"/>`,
    `    <component p:path="${objectFilePath}" objectid="${lineObjectId}" p:UUID="${buildPseudoUuid(itemIndex + 1, 1, 1, 0, 0xb20640ff9872)}" transform="${lineTransform}"/>`,
    '   </components>',
    '  </object>',
  ].join('\n')
}

function buildStandalone3mfObjectModel(
  baseMesh: MeshData,
  lineMesh: MeshData,
  baseObjectId: number,
  lineObjectId: number,
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <resources>',
    `  ${meshToStandalone3mfObject(baseMesh, baseObjectId)}`,
    `  ${meshToStandalone3mfObject(lineMesh, lineObjectId)}`,
    ' </resources>',
    ' <build/>',
    '</model>',
  ].join('\n')
}

function buildCombined3mfModelXml(
  applicationName: string,
  resourceObjects: string[],
  buildLines: string[],
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">',
    ` <metadata name="Application">${applicationName}</metadata>`,
    ' <metadata name="BambuStudio:3mfVersion">1</metadata>',
    ' <metadata name="Designer">线稿底板生成器</metadata>',
    ' <metadata name="Title">线稿底板批量 3MF</metadata>',
    ' <resources>',
    ...resourceObjects,
    ' </resources>',
    ` <build p:UUID="${buildPseudoUuid(resourceObjects.length, buildLines.length, 0, 0, 0x22b54d848835)}">`,
    ...buildLines,
    ' </build>',
    '</model>',
  ].join('\n')
}

function getCombinedPlateBuildOffset(plateIndex: number, printBedSettings: PrintBedSettings) {
  const spacing = Math.max(printBedSettings.spacingMm, 8)
  const stepX = printBedSettings.widthMm + spacing * 6
  const stepY = printBedSettings.depthMm + spacing * 6
  const column = plateIndex % 2
  const row = Math.floor(plateIndex / 2)

  return {
    xMm: column * stepX,
    yMm: row * stepY,
  }
}

function build3mfModelRelationships(objectFileCount: number) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">',
    ...Array.from({ length: objectFileCount }, (_, index) =>
      ` <Relationship Target="/3D/Objects/object_${index + 1}.model" Id="rel-${index + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`),
    '</Relationships>',
  ].join('\n')
}

function meshToStandalone3mfObject(mesh: MeshData, objectId: number) {
  return [
    `<object id="${objectId}" type="model">`,
    '   <mesh>',
    '    <vertices>',
    ...mesh.vertices.map(([x, y, z]) => `     <vertex x="${formatNumber(x)}" y="${formatNumber(y)}" z="${formatNumber(z)}"/>`),
    '    </vertices>',
    '    <triangles>',
    ...mesh.triangles.map(([v1, v2, v3]) => `     <triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`),
    '    </triangles>',
    '   </mesh>',
    '  </object>',
  ].join('\n')
}

function format3mfTransform(x: number, y: number, z: number) {
  return `1 0 0 0 1 0 0 0 1 ${formatNumber(x)} ${formatNumber(y)} ${formatNumber(z)}`
}

function format4x4Matrix(x: number, y: number, z: number) {
  return `1 0 0 ${formatNumber(x)} 0 1 0 ${formatNumber(y)} 0 0 1 ${formatNumber(z)} 0 0 0 1`
}

function buildPseudoUuid(part1: number, part2: number, part3: number, part4: number, tail: number) {
  const a = (part1 >>> 0).toString(16).padStart(8, '0').slice(-8)
  const b = (part2 >>> 0).toString(16).padStart(4, '0').slice(-4)
  const c = (0x4000 | (part3 & 0x0fff)).toString(16).padStart(4, '0').slice(-4)
  const d = (0x8000 | (part4 & 0x0fff)).toString(16).padStart(4, '0').slice(-4)
  const e = Math.abs(tail).toString(16).padStart(12, '0').slice(-12)
  return `${a}-${b}-${c}-${d}-${e}`
}

function buildBambuModelSettingsConfig(
  objects: BambuModelSettingsObject[],
  plates: BambuPlateAssignment[] = [],
) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    ...objects.map((object) => [
      `  <object id="${object.id}">`,
      `    <metadata key="name" value="${escapeXmlAttribute(object.name)}"/>`,
      ...(object.extruder ? [`    <metadata key="extruder" value="${object.extruder}"/>`] : []),
      ...(object.faceCount != null ? [`    <metadata face_count="${object.faceCount}"/>`] : []),
      ...(object.parts ?? []).map((part) => [
        `    <part id="${part.id}" subtype="normal_part">`,
        `      <metadata key="name" value="${escapeXmlAttribute(part.name)}"/>`,
        ...(part.matrix ? [`      <metadata key="matrix" value="${part.matrix}"/>`] : []),
        ...(part.sourceFile ? [`      <metadata key="source_file" value="${escapeXmlAttribute(part.sourceFile)}"/>`] : []),
        ...(part.sourceObjectId != null ? [`      <metadata key="source_object_id" value="${part.sourceObjectId}"/>`] : []),
        ...(part.sourceVolumeId != null ? [`      <metadata key="source_volume_id" value="${part.sourceVolumeId}"/>`] : []),
        ...(part.sourceOffsetX != null ? [`      <metadata key="source_offset_x" value="${formatNumber(part.sourceOffsetX)}"/>`] : []),
        ...(part.sourceOffsetY != null ? [`      <metadata key="source_offset_y" value="${formatNumber(part.sourceOffsetY)}"/>`] : []),
        ...(part.sourceOffsetZ != null ? [`      <metadata key="source_offset_z" value="${formatNumber(part.sourceOffsetZ)}"/>`] : []),
        `      <metadata key="extruder" value="${part.extruder}"/>`,
        `      <metadata key="wall_filament" value="${part.extruder}"/>`,
        `      <metadata key="sparse_infill_filament" value="${part.extruder}"/>`,
        `      <metadata key="solid_infill_filament" value="${part.extruder}"/>`,
        ...(part.faceCount != null ? [`      <mesh_stat face_count="${part.faceCount}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>`] : []),
        '    </part>',
      ].join('\n')),
      '  </object>',
    ].join('\n')),
    ...plates.map((plate) => [
      '  <plate>',
      `    <metadata key="plater_id" value="${plate.plateIndex + 1}"/>`,
      `    <metadata key="plater_name" value="打印板 ${plate.plateIndex + 1}"/>`,
      '    <metadata key="locked" value="false"/>',
      '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
      '    <metadata key="filament_maps" value="1 1"/>',
      '    <metadata key="filament_volume_maps" value="0 0"/>',
      ...plate.objectIds.map((objectId, objectIndex) => [
        '    <model_instance>',
        `      <metadata key="object_id" value="${objectId}"/>`,
        '      <metadata key="instance_id" value="0"/>',
        `      <metadata key="identify_id" value="${plate.identifyIds[objectIndex] ?? (objectIndex + 1)}"/>`,
        '    </model_instance>',
      ].join('\n')),
      '  </plate>',
    ].join('\n')),
    '  <assemble>',
    '  </assemble>',
    '</config>',
  ].join('\n')
}

function choosePixelsPerMm(boardWidthMm: number, boardHeightMm: number, detail: number) {
  const desired = clamp(Math.round(5 + detail / 9), 6, 16)
  const maxAllowed = Math.max(4, Math.floor(1200 / Math.max(boardWidthMm, boardHeightMm, 1)))
  return clamp(Math.min(desired, maxAllowed), 4, 16)
}

function sanitizeLoop(points: VectorPoint[]) {
  const compact: VectorPoint[] = []

  points.forEach((point) => {
    const previous = compact[compact.length - 1]
    if (!previous || !samePoint(previous, point)) {
      compact.push(point)
    }
  })

  if (compact.length >= 2 && samePoint(compact[0], compact[compact.length - 1])) {
    compact.pop()
  }

  if (compact.length < 3) return compact

  const simplified: VectorPoint[] = []

  for (let index = 0; index < compact.length; index += 1) {
    const previous = compact[(index - 1 + compact.length) % compact.length]
    const current = compact[index]
    const next = compact[(index + 1) % compact.length]
    if (Math.abs(cross(previous, current, next)) < 1e-6) {
      continue
    }
    simplified.push(current)
  }

  return simplified.length >= 3 ? simplified : compact
}

function pointInTriangle(point: VectorPoint, a: VectorPoint, b: VectorPoint, c: VectorPoint) {
  const area = Math.abs(cross(a, b, c))
  const area1 = Math.abs(cross(point, a, b))
  const area2 = Math.abs(cross(point, b, c))
  const area3 = Math.abs(cross(point, c, a))
  return Math.abs(area - (area1 + area2 + area3)) <= 1e-6
}

function cross(a: VectorPoint, b: VectorPoint, c: VectorPoint) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)
}

function loopArea(points: VectorPoint[]) {
  let area = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    area += current.x * next.y - next.x * current.y
  }
  return area * 0.5
}

function distance(a: VectorPoint, b: VectorPoint) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function samePoint(a: VectorPoint, b: VectorPoint) {
  return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6
}

function pointKey(point: VectorPoint) {
  return `${point.x},${point.y}`
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadHtmlImage(dataUrl: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('图片解码失败'))
    image.src = dataUrl
  })
}

function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

function downloadText(filename: string, text: string, type: string) {
  downloadBlob(filename, new Blob([text], { type }))
}

function splitDxfPairs(text: string) {
  const lines = text.replace(/\r/g, '').split('\n')
  const pairs: Array<[number, string]> = []

  for (let index = 0; index < lines.length - 1; index += 2) {
    const code = Number(lines[index].trim())
    if (Number.isNaN(code)) continue
    pairs.push([code, lines[index + 1].trim()])
  }

  return pairs
}

function sanitizeLayerName(layerName: string) {
  return layerName.replace(/[^0-9A-Z_]/gi, '_').toUpperCase()
}

function dxfPair(code: number, value: string) {
  return `${String(code).padStart(3, ' ')}\n${value}`
}

function concatUint8Arrays(chunks: Uint8Array[]) {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  const combined = new Uint8Array(totalLength)
  let offset = 0
  chunks.forEach((chunk) => {
    combined.set(chunk, offset)
    offset += chunk.byteLength
  })
  return combined
}

function bytesToBase64(bytes: Uint8Array) {
  // #region debug-point C:bytes-to-base64-start
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'C', location: 'generator.ts:bytesToBase64:start', msg: '[DEBUG] start bytesToBase64', data: { byteLength: bytes.byteLength }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  let binary = ''
  bytes.forEach((value) => {
    binary += String.fromCharCode(value)
  })
  // #region debug-point C:bytes-to-base64-finish
  typeof fetch === 'function' && fetch('http://127.0.0.1:7777/event', { method: 'POST', body: JSON.stringify({ sessionId: 'invalid-string-length', runId: 'post-fix', hypothesisId: 'C', location: 'generator.ts:bytesToBase64:finish', msg: '[DEBUG] finish bytesToBase64 string accumulation', data: { binaryLength: binary.length }, ts: Date.now() }) }).catch(() => {})
  // #endregion
  return btoa(binary)
}

function hexColorToLinearFactor(color: string) {
  const rgb = hexToRgb(color) ?? { r: 255, g: 255, b: 255 }
  return [rgb.r, rgb.g, rgb.b].map((channel) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  })
}

function formatNumber(value: number) {
  return Number(value.toFixed(4)).toString()
}

function escapeXmlAttribute(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}
