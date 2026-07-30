import { strToU8, zipSync } from 'fflate'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  GifFrameSource,
  ImportedLineart,
  LineartSettings,
  ProcessedArtwork,
  SourceImage,
  VectorLoop,
  VectorPoint,
} from '@/types/generator'
import { clamp, colorDistance, hexToRgb } from '@/utils/color'

const DEFAULT_LINEART_MAX_MM = 40
const PREVIEW_MAX_PX = 900
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

interface BambuModelSettingsObject {
  id: number
  name: string
  extruder?: number
  parts?: Array<{
    id: number
    name: string
    extruder: number
  }>
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
) {
  const bytes = build3mfPackage(artwork, baseplateSettings, extrudeSettings)
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
) {
  const flippedBaseLoops = flipLoopsForModelExport(artwork.baseLoops, artwork.boardHeightMm)
  const flippedLineLoops = flipLoopsForModelExport(artwork.lineLoops, artwork.boardHeightMm)
  const lineMeshPixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 10), 8, 20)
  const baseMesh = extrudeLoopsToMesh(
    keepOuterLoops(flippedBaseLoops),
    0,
    extrudeSettings.baseThicknessMm,
  )
  const lineMesh = extrudeMaskToMesh(
    flippedLineLoops,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
    lineMeshPixelsPerMm,
    extrudeSettings.lineHeightMm,
    extrudeSettings.lineThicknessMm,
    MIN_EXPORTABLE_LINE_WIDTH_MM,
  )
  const modelXml = build3mfModelXml(baseMesh, lineMesh, baseplateSettings)
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
  ])
  const projectSettings = buildBambuProjectSettingsConfig(baseplateSettings)

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
  }, { level: 0 })
}

export function buildCombined3mfPackage(
  items: Array<{
    name: string
    artwork: ProcessedArtwork
  }>,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
) {
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
  const baseColor = `${baseplateSettings.baseColor.toUpperCase()}FF`
  const lineColor = `${baseplateSettings.lineColor.toUpperCase()}FF`
  const gapMm = 8
  let cursorX = 0
  let cursorY = 0
  let rowMaxHeight = 0
  const maxColumns = Math.max(1, Math.ceil(Math.sqrt(items.length)))
  const resourceLines: string[] = [
    '    <basematerials id="1">',
    `      <base name="底板" displaycolor="${baseColor}"/>`,
    `      <base name="线稿" displaycolor="${lineColor}"/>`,
    '    </basematerials>',
  ]
  const buildLines: string[] = []
  let nextObjectId = 2
  const modelSettingsObjects: BambuModelSettingsObject[] = []

  items.forEach((item, index) => {
    const flippedBaseLoops = flipLoopsForModelExport(item.artwork.baseLoops, item.artwork.boardHeightMm)
    const flippedLineLoops = flipLoopsForModelExport(item.artwork.lineLoops, item.artwork.boardHeightMm)
    const lineMeshPixelsPerMm = clamp(Math.max(item.artwork.pixelsPerMm, 10), 8, 20)
    const placedBaseMesh = translateMesh(
      extrudeLoopsToMesh(keepOuterLoops(flippedBaseLoops), 0, extrudeSettings.baseThicknessMm),
      cursorX,
      cursorY,
    )
    const placedLineMesh = translateMesh(
      extrudeMaskToMesh(
        flippedLineLoops,
        item.artwork.boardWidthMm,
        item.artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        extrudeSettings.lineHeightMm,
        extrudeSettings.lineThicknessMm,
        MIN_EXPORTABLE_LINE_WIDTH_MM,
      ),
      cursorX,
      cursorY,
    )
    const baseObjectId = nextObjectId
    const lineObjectId = nextObjectId + 1
    const compositeObjectId = nextObjectId + 2
    nextObjectId += 3

    resourceLines.push(meshTo3mfObject(placedBaseMesh, baseObjectId, `${item.name}-底板`, 0))
    resourceLines.push(meshTo3mfObject(placedLineMesh, lineObjectId, `${item.name}-线稿`, 1))
    resourceLines.push(build3mfCompositeObject(compositeObjectId, item.name, [baseObjectId, lineObjectId]))
    buildLines.push(`    <item objectid="${compositeObjectId}"/>`)
    modelSettingsObjects.push({
      id: compositeObjectId,
      name: item.name,
      parts: [
        { id: baseObjectId, name: `${item.name}-底板`, extruder: 1 },
        { id: lineObjectId, name: `${item.name}-线稿`, extruder: 2 },
      ],
    })

    rowMaxHeight = Math.max(rowMaxHeight, item.artwork.boardHeightMm)
    if ((index + 1) % maxColumns === 0) {
      cursorX = 0
      cursorY += rowMaxHeight + gapMm
      rowMaxHeight = 0
    } else {
      cursorX += item.artwork.boardWidthMm + gapMm
    }
  })

  const modelXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    '  <metadata name="Application">BambuStudio-01.10.00.89</metadata>',
    '  <metadata name="Designer">线稿底板生成器</metadata>',
    '  <metadata name="Title">线稿底板批量 3MF</metadata>',
    '  <resources>',
    ...resourceLines,
    '  </resources>',
    '  <build>',
    ...buildLines,
    '  </build>',
    '</model>',
  ].join('\n')
  const modelSettings = buildBambuModelSettingsConfig(modelSettingsObjects)
  const projectSettings = buildBambuProjectSettingsConfig(baseplateSettings)

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
  }, { level: 0 })
}

export function build3mfModelXml(baseMesh: MeshData, lineMesh: MeshData, settings: BaseplateSettings) {
  const baseColor = `${settings.baseColor.toUpperCase()}FF`
  const lineColor = `${settings.lineColor.toUpperCase()}FF`
  const baseObjectId = 2
  const lineObjectId = 3
  const compositeObjectId = 4

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    '  <metadata name="Application">BambuStudio-01.10.00.89</metadata>',
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

async function buildImageLineart(sourceImage: SourceImage, settings: LineartSettings) {
  const image = await loadHtmlImage(sourceImage.dataUrl)
  const maxDimension = Math.max(320, Math.round(320 + settings.detail * 8))
  const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight))
  const width = Math.max(1, Math.round(image.naturalWidth * scale))
  const height = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    throw new Error('无法初始化图片处理画布')
  }

  context.clearRect(0, 0, width, height)
  context.drawImage(image, 0, 0, width, height)
  const imageData = context.getImageData(0, 0, width, height)
  const targetMask = new Uint8Array(width * height)
  const targetColor = hexToRgb(settings.targetColor)
  const tolerance = Math.max(0, settings.threshold)
  const toleranceSq = tolerance * tolerance

  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4
    const alpha = imageData.data[offset + 3]
    if (alpha < 8) {
      targetMask[index] = settings.invert ? 1 : 0
      continue
    }

    const current = {
      r: imageData.data[offset],
      g: imageData.data[offset + 1],
      b: imageData.data[offset + 2],
    }
    const matches = colorDistance(current, targetColor) <= toleranceSq
    targetMask[index] = settings.invert ? (matches ? 0 : 1) : (matches ? 1 : 0)
  }

  const slimmedEdges = getSlimLineMask(targetMask, width, height)
  const strokeRadius = Math.max(0, Math.round(settings.strokeWidth * 0.75))
  const widened = strokeRadius ? dilateMask(slimmedEdges, width, height, strokeRadius) : slimmedEdges
  const cleaned = settings.despeckle ? removeSmallComponents(widened, width, height, settings.despeckle) : widened
  const loops = smoothLoops(
    traceMaskToLoops(cleaned, width, height)
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 8),
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

function hasFilledPixel(mask: Uint8Array) {
  for (let index = 0; index < mask.length; index += 1) {
    if (mask[index]) {
      return true
    }
  }
  return false
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

  if (isJsDom) {
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
  const iterations = Math.min(2, Math.round(smoothing / 28))
  const minDistance = 0.08 + smoothing * 0.0025

  return loops
    .map((loop) => {
      let points = sanitizeLoop(loop.points)
      for (let index = 0; index < iterations; index += 1) {
        points = chaikin(points)
      }
      points = dedupeByDistance(points, minDistance)
      points = sanitizeLoop(points)
      return {
        ...loop,
        points,
      }
    })
    .filter((loop) => loop.points.length >= 3)
}

function chaikin(points: VectorPoint[]) {
  if (points.length < 3) return points
  const next: VectorPoint[] = []

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const following = points[(index + 1) % points.length]
    next.push({
      x: current.x * 0.75 + following.x * 0.25,
      y: current.y * 0.75 + following.y * 0.25,
    })
    next.push({
      x: current.x * 0.25 + following.x * 0.75,
      y: current.y * 0.25 + following.y * 0.75,
    })
  }

  return next
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
    lineartDataUrl: renderPreviewCanvas(boardWidthMm, boardHeightMm, (context) => {
      context.fillStyle = settings.lineColor
      fillLoops(context, lineLoops)
    }),
    baseplateDataUrl: renderPreviewCanvas(boardWidthMm, boardHeightMm, (context) => {
      context.fillStyle = settings.baseColor
      fillLoops(context, baseLoops)
      context.globalAlpha = 0.22
      context.fillStyle = settings.lineColor
      fillLoops(context, lineLoops)
      context.globalAlpha = 1
    }),
    compositeDataUrl: renderPreviewCanvas(boardWidthMm, boardHeightMm, (context) => {
      context.fillStyle = settings.baseColor
      fillLoops(context, baseLoops)
      context.fillStyle = settings.lineColor
      fillLoops(context, lineLoops)
    }),
  }
}

function renderPreviewCanvas(
  boardWidthMm: number,
  boardHeightMm: number,
  paint: (context: CanvasRenderingContext2D) => void,
) {
  const pixelsPerMm = Math.max(6, Math.floor(PREVIEW_MAX_PX / Math.max(boardWidthMm, boardHeightMm, 1)))
  const paddingPx = 20
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.ceil(boardWidthMm * pixelsPerMm) + paddingPx * 2)
  canvas.height = Math.max(1, Math.ceil(boardHeightMm * pixelsPerMm) + paddingPx * 2)
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('无法初始化预览画布')
  }

  context.clearRect(0, 0, canvas.width, canvas.height)
  context.translate(paddingPx, paddingPx)
  context.scale(pixelsPerMm, pixelsPerMm)
  paint(context)

  return canvas.toDataURL('image/png')
}

function fillLoops(context: CanvasRenderingContext2D, loops: VectorLoop[]) {
  context.beginPath()
  loops.forEach((loop) => {
    const [first, ...rest] = loop.points
    if (!first) return
    context.moveTo(first.x, first.y)
    rest.forEach((point) => context.lineTo(point.x, point.y))
    context.closePath()
  })
  context.fill('nonzero')
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

function buildBambuModelSettingsConfig(objects: BambuModelSettingsObject[]) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<config>',
    ...objects.map((object) => [
      `  <object id="${object.id}">`,
      `    <metadata key="name" value="${escapeXmlAttribute(object.name)}"/>`,
      ...(object.extruder ? [`    <metadata key="extruder" value="${object.extruder}"/>`] : []),
      ...(object.parts ?? []).map((part) => [
        `    <part id="${part.id}" subtype="normal_part">`,
        `      <metadata key="name" value="${escapeXmlAttribute(part.name)}"/>`,
        `      <metadata key="extruder" value="${part.extruder}"/>`,
        `      <metadata key="wall_filament" value="${part.extruder}"/>`,
        `      <metadata key="sparse_infill_filament" value="${part.extruder}"/>`,
        `      <metadata key="solid_infill_filament" value="${part.extruder}"/>`,
        '    </part>',
      ].join('\n')),
      '  </object>',
    ].join('\n')),
    '</config>',
  ].join('\n')
}

function buildBambuProjectSettingsConfig(settings: BaseplateSettings) {
  return JSON.stringify({
    filament_colour: [
      settings.baseColor.toUpperCase(),
      settings.lineColor.toUpperCase(),
    ],
    filament_type: ['PLA', 'PLA'],
    filament_ids: ['LINEART_BASE_SLOT_1', 'LINEART_LINE_SLOT_2'],
    filament_settings_id: ['Generic PLA', 'Generic PLA'],
    filament_density: ['1.24', '1.24'],
    filament_diameter: ['1.75', '1.75'],
    extruder_colour: [
      settings.baseColor.toUpperCase(),
      settings.lineColor.toUpperCase(),
    ],
    support_filament: '0',
    support_interface_filament: '0',
  }, null, 2)
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
