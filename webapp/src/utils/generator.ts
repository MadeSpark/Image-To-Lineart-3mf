import { strToU8, zipSync } from 'fflate'
import { IMPORT_LIMITS, assertDxfFile, assertImageDimensions, assertImageFile } from './importLimits'
import type {
  BaseplateSettings,
  ExtrudeSettings,
  GifFrameSource,
  ImagePlacement,
  ImportedLineart,
  LightReliefSettings,
  LineartSettings,
  NumberingSettings,
  PrintBedLayout,
  PrintBedPlacementItem,
  PrintBedSettings,
  ProcessedArtwork,
  PreviewAssets,
  SealSettings,
  SourceImage,
  ThreeMfTemplateProfile,
  VectorLoop,
  VectorPoint,
  WorkMode,
} from '@/types/generator'
import { clamp, colorDistance, hexToRgb } from './color'
import {
  buildThreeMfFilamentSequenceJson,
  buildThreeMfProjectSettingsConfig,
  buildThreeMfSliceInfoConfig,
} from './threeMfProfile'

const DEFAULT_LINEART_MAX_MM = 40
const MIN_EXPORTABLE_LINE_WIDTH_MM = 0.24

// 2026-08-27：用户反馈"被自动覆盖 smoothing 不可接受"。
// 彻底删除了 calculateAutoLineartParams；所有参数严格使用用户在 UI 上设置的值。

interface ProcessArtworkInput {
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  extrudeSettings: ExtrudeSettings
  sealSettings?: SealSettings
  workMode?: WorkMode
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
  'baseLoops' | 'lineLoops' | 'lineLoopsB' | 'bFaceHeightMap' | 'boardWidthMm' | 'boardHeightMm' | 'pixelsPerMm'
>

/**
 * 打印等效的线稿光栅掩码：以与 3MF 导出完全一致的分辨率、最小线宽处理的 0/1 像素掩码。
 * 与 extrudeMaskToMesh（mesh 也是逐像素 mesh）逐像素对应，所以可作为
 * 2D SVG 预览的"位图真相"，彻底绕开 trace→smooth→矢量路径的细节损失。
 */
interface PrintPreviewMask {
  mask: Uint8Array
  width: number
  height: number
  pixelsPerMm: number
}

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
  assertImageFile(file)
  const dataUrl = await fileToDataUrl(file)
  const image = await loadHtmlImage(dataUrl)
  assertImageDimensions(image.naturalWidth, image.naturalHeight)

  return {
    name: file.name,
    width: image.naturalWidth,
    height: image.naturalHeight,
    dataUrl,
  }
}

export async function fileToImportedLineart(file: File): Promise<ImportedLineart> {
  assertDxfFile(file)
  const text = await file.text()
  return parseDxfText(text, file.name)
}

export async function decodeGifFrames(file: File): Promise<GifFrameSource[]> {
  assertImageFile(file)
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
  if (frameCount > IMPORT_LIMITS.maxGifFrames) {
    decoder.close?.()
    throw new Error(`GIF exceeds the ${IMPORT_LIMITS.maxGifFrames} frame limit.`)
  }
  const frames: GifFrameSource[] = []
  const baseName = getExportBaseName(file.name, 'gif-frame')

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    const result = await decoder.decode({ frameIndex })
    const bitmap = result.image as VideoFrame & { width?: number; height?: number }
    const width = bitmap.displayWidth || bitmap.codedWidth || bitmap.width || 1
    const height = bitmap.displayHeight || bitmap.codedHeight || bitmap.height || 1
    assertImageDimensions(width, height)
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
  sealSettings,
  workMode,
}: ProcessArtworkInput): Promise<ProcessedArtwork> {
  const source = importedLineart
    ? (() => {
      const loops = normalizeLoops(importedLineart.loops)
      const bounds = getLoopBounds(loops)
      return {
        kind: 'dxf' as const,
        width: importedLineart.widthMm,
        height: importedLineart.heightMm,
        loops,
        canvasBounds: { minX: 0, minY: 0, width: bounds.width, height: bounds.height },
      }
    })()
    : sourceImage
      ? await buildImageLineart(sourceImage, lineartSettings)
      : null

  if (!source || !source.loops.length) {
    throw new Error('没有可用的线稿轮廓，请尝试调整目标颜色或颜色容差。')
  }

  const sourceLoops = lineartSettings.mirror
    ? mirrorLoopsHorizontally(source.loops)
    : source.loops
  const srcBounds = lineartSettings.mirror
    ? mirrorCanvasBoundsHorizontally(source.loops, source.canvasBounds)
    : source.canvasBounds

  const layout = layoutLineLoops(
    sourceLoops,
    baseplateSettings,
    srcBounds,
  )
  const pixelsPerMm = choosePixelsPerMm(layout.boardWidthMm, layout.boardHeightMm, lineartSettings.detail)
  // 安全边距以 UI 设置的 marginMm 为准；outline 模板（没有 marginMm 概念）或缺失时回退 expandStrokeMm+1
  const paddingMm = baseplateSettings.template === 'outline'
    ? lineartSettings.expandStrokeMm + 1
    : Math.max(0, baseplateSettings.marginMm ?? lineartSettings.expandStrokeMm + 1)

  const finalLineLoops = finalizeLineLoops(
    layout.lineLoops,
    layout.boardWidthMm,
    layout.boardHeightMm,
    pixelsPerMm,
    paddingMm,
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
    const lineMask = rasterizeLoopsToMask(
      finalLineLoops,
      layout.boardWidthMm,
      layout.boardHeightMm,
      pixelsPerMm,
      paddingMm,
    )
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

  let strokeLoops: VectorLoop[] | undefined
  if (workMode === 'seal' && sealSettings?.strokeEnabled) {
    strokeLoops = buildSealStrokeLoops(
      baseLoops,
      sealSettings.strokeWidthMm,
      pixelsPerMm,
      paddingMm,
    )
  }

  // 2D 预览渲染"打印等效"位图：用与 3MF 导出完全相同的光栅化 + 最小线宽
  // 处理 visibleLineLoops 得到 0/1 mask，再生成 PNG 嵌入 SVG 预览。
  // 注意 lineLoops 字段仍保留原始矢量，3MF 导出继续走 extrudeMaskToMesh 完整流程。
  const printPreviewMask = shapeLoopsForPrintPreview(
    visibleLineLoops,
    boardWidthMm,
    boardHeightMm,
    chooseSingleExportPixelsPerMm({ pixelsPerMm, boardWidthMm, boardHeightMm }),
    extrudeSettings?.minLineWidthMm ?? 0.24,
    lineartSettings.expandStrokeMm,
    lineartSettings.shrinkStrokeMm,
  )
  const previews = buildPreviewAssets(
    printPreviewMask,
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
    strokeLoops,
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

/**
 * 线稿构建助手：将已布局到画板上的线稿回路光栅化 → 描边 → 平滑 → 过滤退化多边形。
 * 抽取出来供掐丝模式（processArtwork）与光映浮雕模式（processLightReliefArtwork）共用，
 * 保证 A/B 两面与单面线稿走完全一致的处理管线。
 *
 * 0.005 mm² ≈ 直径 0.08 mm 的圆，只剔除完全退化的多边形或真正的像素噪点。
 * 前面的 despeckle 已经清掉了小连通域噪点，因此这里不做激进过滤。
 */
function finalizeLineLoops(
  laidOutLoops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  pixelsPerMm: number,
  paddingMm: number,
  smoothing: number,
): VectorLoop[] {
  const lineMask = rasterizeLoopsToMask(
    laidOutLoops,
    boardWidthMm,
    boardHeightMm,
    pixelsPerMm,
    paddingMm,
  )
  const MIN_LOOP_AREA_MM2 = 0.005
  return smoothLoops(
    traceMaskToLoops(lineMask.mask, lineMask.width, lineMask.height)
      .map((loop) => pixelsToMm(loop, pixelsPerMm, paddingMm))
      .filter((loop) => Math.abs(loopArea(loop.points)) >= MIN_LOOP_AREA_MM2),
    smoothing,
  )
}

/**
 * 打印等效线稿光栅掩码：用与 3MF 导出（extrudeMaskToMesh）完全相同的光栅化 +
 * 最小线宽保底处理矢量线稿，返回与 3MF 网格**逐像素一致**的 0/1 掩码。
 * 由 buildLineMaskPngDataUrl 转为 PNG，再嵌入 SVG 预览，
 * 保证"预览所见 = 3MF 实际打印所得"，彻底消除 trace→smooth 矢量化链路对细线/眼睛等
 * 细节的侵蚀（之前会导致预览比 3MF 更糊）。
 *
 * 与 extrudeMaskToMesh 共用同一导出分辨率 chooseSingleExportPixelsPerMm，
 * 因此轮廓边界与 3MF 网格逐像素对齐。
 *
 * 2026-08-27：移除 print-safe（fill holes + enlarge solid components），
 * 旧版在低分辨率下把眼睛等小细节当成"小斑块"填实或放大成黑块。现在只过最小线宽保底。
 *
 * 2026-08-27：进一步改为返回**位图掩码**而非矢量化回路——traceMaskToLoops
 * 对 2-3 像素宽的细线会产生肉眼可见的台阶+塌陷，dedupeByDistance 还会把细线特征点合并掉，
 * 导致预览比 3MF 仍糊一截。直接用位图作为预览的"真相"，WYSIWYG 才有保证。
 */
function shapeLoopsForPrintPreview(
  loops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  pixelsPerMm: number,
  minLineWidthMm: number,
  expandStrokeMm = 0,
  shrinkStrokeMm = 0,
): PrintPreviewMask | null {
  if (!loops.length || pixelsPerMm <= 0) {
    return null
  }
  // 2026-08-28：与 extrudeMaskToMesh 共用 buildExportLineMask 统一管线（光栅化 →
  // 缩小/加粗描边 → 最小线宽），保证预览位图与 3MF 网格**逐像素一致**——
  // 包括用户设置了加粗/缩小描边的情况（此前预览漏掉这两个步骤导致所见非所得）。
  const raster = buildExportLineMask(
    loops,
    boardWidthMm,
    boardHeightMm,
    pixelsPerMm,
    minLineWidthMm,
    expandStrokeMm,
    shrinkStrokeMm,
  )
  return {
    mask: raster.mask,
    width: raster.width,
    height: raster.height,
    pixelsPerMm,
  }
}

interface ProcessLightReliefArtworkInput {
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  /** halftone 模式下 B 面独立图片源（lineart 模式忽略） */
  sourceImageB: SourceImage | null
  lineartSettings: LineartSettings
  baseplateSettings: BaseplateSettings
  lightReliefSettings: LightReliefSettings
}

interface ResolvedLineartSource {
  kind: 'image' | 'dxf'
  width: number
  height: number
  loops: VectorLoop[]
  /**
   * loops 所属的"完整画布（含空白边）"在 loops 同一坐标空间下的包围盒。
   * - 对于 image 管线：canvasBounds 是源图矩形 (0,0,srcW,srcH) 经与 loops 相同的 normalizeLoops+scaleLoopsToMaxDimension 后得到。
   * - 对于 dxf 管线：canvasBounds 与 loops 紧 bbox 相同（DXF 本身无空白画布概念）。
   * 用于 layoutLineLoops 按"完整画布"缩放，保留源图空白边比例。
   */
  canvasBounds: { minX: number; minY: number; width: number; height: number }
}

async function resolveLineartSource(
  sourceImage: SourceImage | null,
  importedLineart: ImportedLineart | null,
  settings: LineartSettings,
): Promise<ResolvedLineartSource | null> {
  if (importedLineart) {
    const loops = normalizeLoops(importedLineart.loops)
    const bounds = getLoopBounds(loops)
    return {
      kind: 'dxf',
      width: importedLineart.widthMm,
      height: importedLineart.heightMm,
      loops,
      canvasBounds: { ...bounds, minX: 0, minY: 0 },
    }
  }
  if (sourceImage) {
    return await buildImageLineart(sourceImage, settings)
  }
  return null
}

/** 黑色/红色像素检测容差：接近纯黑或纯红即视为该色元素存在。 */
const LIGHT_RELIEF_COLOR_DETECT_TOLERANCE = 48

/**
 * 检测图片是否包含黑色(0,0,0)与红色(255,0,0)像素。
 * - hasBlack: 存在接近纯黑的像素
 * - hasRed: 存在接近纯红（R 高、G/B 低）的像素
 * 用于光映浮雕自动判断走 lineart 模式还是 halftone 模式。
 */
export async function detectImageColors(sourceImage: SourceImage): Promise<{ hasBlack: boolean; hasRed: boolean }> {
  const image = await loadHtmlImage(sourceImage.dataUrl)
  const maxDim = 320
  const scale = Math.min(1, maxDim / Math.max(image.naturalWidth, image.naturalHeight))
  const w = Math.max(1, Math.round(image.naturalWidth * scale))
  const h = Math.max(1, Math.round(image.naturalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) {
    return { hasBlack: false, hasRed: false }
  }
  ctx.drawImage(image, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const tol = LIGHT_RELIEF_COLOR_DETECT_TOLERANCE
  let hasBlack = false
  let hasRed = false
  // 采样步长，大图加速
  const step = Math.max(1, Math.floor((w * h) / 40000))
  for (let i = 0; i < data.length; i += 4 * step) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (!hasBlack && r <= tol && g <= tol && b <= tol) {
      hasBlack = true
    }
    if (!hasRed && r >= 255 - tol && g <= tol && b <= tol) {
      hasRed = true
    }
    if (hasBlack && hasRed) break
  }
  return { hasBlack, hasRed }
}

/**
 * 从已加载的 ImageData 构建灰度高度图，应用曝光与反相。
 * - 深色 → 高度（厚），浅色 → 低高度（薄）
 * - 输出归一化 [0,1]
 */
function buildHalftoneHeightMapFromImageData(
  pixels: Uint8ClampedArray,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  exposure: number,
  invert: boolean,
  placement: ImagePlacement = 'fit',
): { width: number; height: number; data: Float32Array } {
  const w = Math.max(1, targetWidth)
  const h = Math.max(1, targetHeight)
  const data = new Float32Array(w * h)
  // 默认所有像素高度为 0（画布外 / 无图像区域视为最薄）
  const exposureFactor = Math.pow(2, (exposure - 100) / 100)

  // 计算源图在目标画布内的绘制尺寸与偏移，按放置规则区分：
  // - fit / center: 等比 contain 居中（center 在调用处以整个画板为目标，忽略安全边距）
  // - stretch: 非等比拉伸铺满画布
  // - crop: 等比 cover 居中裁剪铺满画布
  const srcRatio = sourceWidth / sourceHeight
  const dstRatio = w / h
  let drawW: number
  let drawH: number
  let offsetX: number
  let offsetY: number
  if (placement === 'stretch') {
    drawW = w
    drawH = h
    offsetX = 0
    offsetY = 0
  } else if (placement === 'crop') {
    if (srcRatio > dstRatio) {
      drawH = h
      drawW = Math.max(1, Math.round(h * srcRatio))
      offsetY = 0
      offsetX = Math.floor((w - drawW) / 2)
    } else {
      drawW = w
      drawH = Math.max(1, Math.round(w / srcRatio))
      offsetX = 0
      offsetY = Math.floor((h - drawH) / 2)
    }
  } else if (srcRatio > dstRatio) {
    drawW = w
    drawH = Math.max(1, Math.round(w / srcRatio))
    offsetX = 0
    offsetY = Math.max(0, Math.floor((h - drawH) / 2))
  } else {
    drawH = h
    drawW = Math.max(1, Math.round(h * srcRatio))
    offsetY = 0
    offsetX = Math.max(0, Math.floor((w - drawW) / 2))
  }

  // data[y * w + x] 的坐标语义（与 internal loops 一致）：
  // y=0 → 画面顶部（对应 loops 内部 y=0=顶），y=h-1 → 画面底部（对应 loops 内部 y=BH=底）
  // canvas 源图像：srcY=0 也是顶行。所以 dy=0 → srcY=0（顶），dy=drawH-1 → srcY=sourceHeight-1（底）
  // 3MF 导出时会在 buildHalftoneReliefMesh(flipY=true) 里再做 Y 翻转，使其与 flipLoopsForModelExport 的 A 面线稿对齐。
  for (let dy = 0; dy < drawH; dy += 1) {
    const y = offsetY + dy
    if (y < 0 || y >= h) continue
    const srcY = Math.min(sourceHeight - 1, Math.floor((dy * sourceHeight) / drawH))
    const rowStart = y * w
    for (let dx = 0; dx < drawW; dx += 1) {
      const x = offsetX + dx
      if (x < 0 || x >= w) continue
      const srcX = Math.min(sourceWidth - 1, Math.floor((dx * sourceWidth) / drawW))
      const srcOffset = (srcY * sourceWidth + srcX) * 4
      const r = pixels[srcOffset]
      const g = pixels[srcOffset + 1]
      const b = pixels[srcOffset + 2]
      const a = pixels[srcOffset + 3] / 255
      // 灰度（0~1）
      let luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      luminance *= exposureFactor
      luminance = Math.max(0, Math.min(1, luminance))
      if (a < 0.5) luminance = 1
      // 深色 → 厚（高），浅色 → 薄（低）
      let pv = 1 - luminance
      if (invert) pv = 1 - pv
      data[rowStart + x] = pv
    }
  }
  return { width: w, height: h, data }
}

/**
 * 根据高度图生成透光浮雕 B 面闭合网格（拓竹式结构）。
 *
 * - 厚度沿 Z 轴方向：zStart（底，固定）→ zStart + 高度图*maxHeightMm（顶面，随灰度变化）。
 * - reverseStack 参数保留但当前调用方始终传 false——浮雕保持正向朝向（bumpy 顶面朝上），
 *   以确保透光浮雕表面暴露在模型顶部，提升透光率。
 * - 生成完整闭合体（顶面 + 底面 + 四周边墙），保证切片器识别为水密模型。
 * - flipY=true 时：对 Y 轴应用翻转（y' = boardHeightMm - y），使 halftone 与 3MF 导出时经过 flipLoopsForModelExport 的线稿对齐。
 *   flipY=false 时：Y 不翻转，直接使用 heightMap 的原始方向（y=0 对应 worldY=0），用于内部预览。
 */
function buildHalftoneReliefMesh(
  heightMap: { width: number; height: number; data: Float32Array },
  pixelsPerMm: number,
  zStart: number,
  maxHeightMm: number,
  boardWidthMm: number,
  boardHeightMm: number,
  flipY: boolean,
  reverseStack: boolean = false,
): MeshData {
  const mesh: MeshData = { vertices: [], triangles: [] }
  if (maxHeightMm <= 0) return mesh
  const { width: W, height: H, data } = heightMap
  if (W <= 0 || H <= 0) return mesh
  // 严格贴合画板外框：W 个像素对应 boardWidthMm，H 个像素对应 boardHeightMm
  // （不使用 1/pixelsPerMm，因为 ceil(...) 会让网格略大于画板）
  const cellMmX = boardWidthMm / W
  const cellMmY = boardHeightMm / H

  const minThick = Math.max(0.05, maxHeightMm * 0.02)
  const heights = new Float32Array(W * H)
  for (let i = 0; i < data.length; i += 1) {
    heights[i] = minThick + data[i] * (maxHeightMm - minThick)
  }
  const getH = (x: number, y: number): number => (
    x >= 0 && y >= 0 && x < W && y < H ? heights[y * W + x] : minThick
  )

  const numX = W + 1
  const numY = H + 1
  const bottomIndex = (x: number, y: number) => (y * numX + x) * 2
  const topIndex = (x: number, y: number) => (y * numX + x) * 2 + 1
  const totalVerts = numX * numY * 2
  mesh.vertices = new Array(totalVerts) as MeshData['vertices']
  for (let y = 0; y < numY; y += 1) {
    // flipY=true 时：y_idx=0（画面顶部，loops语义y=0）→ worldY = boardHeightMm（3MF 导出大Y=视觉上顶）
    // flipY=false 时：y_idx=0 → worldY = 0
    const worldY = flipY
      ? boardHeightMm - y * cellMmY
      : y * cellMmY
    for (let x = 0; x < numX; x += 1) {
      const worldX = x * cellMmX
      let hSum = 0
      let hCount = 0
      for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
        const px = x + dx
        const py = y + dy
        if (px >= 0 && py >= 0 && px < W && py < H) {
          hSum += getH(px, py)
          hCount += 1
        }
      }
      const avgH = hCount > 0 ? hSum / hCount : minThick
      if (reverseStack) {
        // 反向堆叠：顶面固定在 zStart+maxHeightMm，底面随灰度变化（层序颠倒）
        mesh.vertices[bottomIndex(x, y)] = [worldX, worldY, zStart + maxHeightMm - avgH]
        mesh.vertices[topIndex(x, y)] = [worldX, worldY, zStart + maxHeightMm]
      } else {
        mesh.vertices[bottomIndex(x, y)] = [worldX, worldY, zStart]
        mesh.vertices[topIndex(x, y)] = [worldX, worldY, zStart + avgH]
      }
    }
  }
  // 三角形数组预估算：顶面(W*H*2) + 底面(W*H*2) + 四周侧面(H*2 + W*2 + 4) ≈ 4WH + 4(W+H)
  mesh.triangles = []

  const addTri = (a: number, b: number, c: number) => mesh.triangles.push([a, b, c])
  const addQuad = (a: number, b: number, c: number, d: number) => {
    addTri(a, b, c); addTri(a, c, d)
  }

  // 顶面（朝上，Z 增加方向）：绕 CCW（从上方看）(x,y) → (x+1,y) → (x+1,y+1) → (x,y+1)
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const a = topIndex(x, y)
      const b = topIndex(x + 1, y)
      const c = topIndex(x + 1, y + 1)
      const d = topIndex(x, y + 1)
      addQuad(a, b, c, d)
    }
  }
  // 底面（朝下）：需翻转顶点顺序以保持法线朝 -Z
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const a = bottomIndex(x, y)
      const b = bottomIndex(x + 1, y)
      const c = bottomIndex(x + 1, y + 1)
      const d = bottomIndex(x, y + 1)
      addQuad(a, d, c, b)
    }
  }

  // 左墙（x=0，法线朝 -X）：从前往后（y=0 到 y=H-1），顶面在外侧（-X方向）
  for (let y = 0; y < H; y += 1) {
    const bl = bottomIndex(0, y)        // (0, y) 底
    const tl = topIndex(0, y)           // (0, y) 顶
    const br = bottomIndex(0, y + 1)    // (0, y+1) 底
    const tr = topIndex(0, y + 1)       // (0, y+1) 顶
    addQuad(bl, tl, tr, br) // 朝 -X：bl → tl (沿+Y外侧向上) → tr → br
  }
  // 右墙（x=W，法线朝 +X）
  for (let y = 0; y < H; y += 1) {
    const bl = bottomIndex(W, y)
    const tl = topIndex(W, y)
    const br = bottomIndex(W, y + 1)
    const tr = topIndex(W, y + 1)
    addQuad(bl, br, tr, tl) // 朝 +X：bl → br → tr → tl
  }
  // 前墙（y=0，法线朝 -Y）：从左到右（x=0到W-1）。注意看法线朝外(-Y)的缠绕
  for (let x = 0; x < W; x += 1) {
    const bl = bottomIndex(x, 0)
    const br = bottomIndex(x + 1, 0)
    const tr = topIndex(x + 1, 0)
    const tl = topIndex(x, 0)
    addQuad(bl, br, tr, tl) // 朝 -Y：bl → br(+X) → tr(+Z) → tl
  }
  // 后墙（y=H，法线朝 +Y）
  for (let x = 0; x < W; x += 1) {
    const bl = bottomIndex(x, H)
    const br = bottomIndex(x + 1, H)
    const tr = topIndex(x + 1, H)
    const tl = topIndex(x, H)
    addQuad(bl, tl, tr, br)
  }

  return mesh
}

/**
 * 光映浮雕模式线稿处理。
 * - A 面始终提取黑色(0,0,0)线稿，走掐丝线稿处理管线。
 * - B 面模式：
 *   - 'lineart': 同图提取红色(255,0,0)线稿，B 面按线稿阴刻处理。
 *   - 'halftone': 透光浮雕，使用单独导入的 B 面图片，转为灰度高度图，按深浅打印厚度。
 * - 自动检测：当 bFaceMode==='lineart' 且图片不包含红色像素时，自动回退到 halftone 模式
 *   （此时若未导入 B 面图片，则 B 面为空）。
 * - DXF 导入时仅 A 面有效（无颜色信息）。
 * - baseplate 固定为矩形模板（参考 defaultLightReliefBaseplateSettings）。
 */
export async function processLightReliefArtwork({
  sourceImage,
  importedLineart,
  sourceImageB,
  lineartSettings,
  baseplateSettings,
  lightReliefSettings,
}: ProcessLightReliefArtworkInput): Promise<ProcessedArtwork> {
  // A 面固定提取黑色，强制不反相。
  const settingsForA: LineartSettings = { ...lineartSettings, targetColor: '#000000', invert: false }
  const sourceA = await resolveLineartSource(sourceImage, importedLineart, settingsForA)

  if (!sourceA || !sourceA.loops.length) {
    throw new Error('A 面没有可用的线稿轮廓，请尝试调整颜色容差。')
  }

  const aRaw = lineartSettings.mirror ? mirrorLoopsHorizontally(sourceA.loops) : sourceA.loops
  const aBounds = lineartSettings.mirror
    ? mirrorCanvasBoundsHorizontally(sourceA.loops, sourceA.canvasBounds)
    : sourceA.canvasBounds
  const layoutA = layoutLineLoops(aRaw, baseplateSettings, aBounds)

  const pixelsPerMm = choosePixelsPerMm(layoutA.boardWidthMm, layoutA.boardHeightMm, lineartSettings.detail)
  // 安全边距以 UI 设置的 marginMm 为准；outline 模板（没有 marginMm 概念）或缺失时回退 expandStrokeMm+1
  const paddingMm = baseplateSettings.template === 'outline'
    ? lineartSettings.expandStrokeMm + 1
    : Math.max(0, baseplateSettings.marginMm ?? lineartSettings.expandStrokeMm + 1)

  const finalLineLoopsA = finalizeLineLoops(
    layoutA.lineLoops,
    layoutA.boardWidthMm,
    layoutA.boardHeightMm,
    pixelsPerMm,
    paddingMm,
    lineartSettings.smoothing,
  )

  if (!finalLineLoopsA.length) {
    throw new Error('A 面线稿在当前参数下被清空了，请降低杂点清理或提高线宽。')
  }

  // 确定 B 面模式：auto 模式下检测红色像素；lineart 模式下也检测红色，无红色则回退 halftone。
  let effectiveBFaceMode: 'lineart' | 'halftone'
  if (lightReliefSettings.bFaceMode === 'halftone') {
    effectiveBFaceMode = 'halftone'
  } else if (lightReliefSettings.bFaceMode === 'lineart') {
    // 强制 lineart：不自动回退，即使无红色也按线稿处理（B 面可能为空）
    effectiveBFaceMode = 'lineart'
  } else {
    // auto：检测红色像素
    effectiveBFaceMode = 'lineart'
    if (sourceImage && !importedLineart) {
      const { hasRed } = await detectImageColors(sourceImage)
      if (!hasRed) {
        effectiveBFaceMode = 'halftone'
      }
    }
  }

  let finalLineLoopsB: VectorLoop[] = []
  let bFaceHeightMap: { width: number; height: number; data: Float32Array } | undefined

  if (effectiveBFaceMode === 'lineart') {
    // lineart 模式：从同图提取红色线稿。
    const settingsForB: LineartSettings = { ...lineartSettings, targetColor: '#ff0000', invert: false }
    const sourceB = sourceImage && !importedLineart
      ? await resolveLineartSource(sourceImage, null, settingsForB)
      : null
    const bRawRaw = sourceB?.loops.length ? sourceB.loops : []
    const bRaw = lineartSettings.mirror ? mirrorLoopsHorizontally(bRawRaw) : bRawRaw
    const bBounds = sourceB
      ? (lineartSettings.mirror
          ? mirrorCanvasBoundsHorizontally(sourceB.loops, sourceB.canvasBounds)
          : sourceB.canvasBounds)
      : sourceA.canvasBounds
    const layoutB = bRaw.length
      ? layoutLineLoops(bRaw, baseplateSettings, bBounds)
      : { boardWidthMm: layoutA.boardWidthMm, boardHeightMm: layoutA.boardHeightMm, lineLoops: [] as VectorLoop[] }
    finalLineLoopsB = layoutB.lineLoops.length
      ? finalizeLineLoops(
        layoutB.lineLoops,
        layoutB.boardWidthMm,
        layoutB.boardHeightMm,
        pixelsPerMm,
        paddingMm,
        lineartSettings.smoothing,
      )
      : []
  } else {
    // halftone 模式：从独立 B 面图片构建灰度高度图。
    if (sourceImageB) {
      const imageB = await loadHtmlImage(sourceImageB.dataUrl)
      const canvas = document.createElement('canvas')
      canvas.width = imageB.naturalWidth
      canvas.height = imageB.naturalHeight
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      if (ctx) {
        if (lineartSettings.mirror) {
          // 水平镜像：X 轴翻转后绘制
          ctx.save()
          ctx.translate(canvas.width, 0)
          ctx.scale(-1, 1)
          ctx.drawImage(imageB, 0, 0, canvas.width, canvas.height)
          ctx.restore()
        } else {
          ctx.drawImage(imageB, 0, 0, canvas.width, canvas.height)
        }
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const fullW = Math.max(1, Math.ceil(layoutA.boardWidthMm * pixelsPerMm))
        const fullH = Math.max(1, Math.ceil(layoutA.boardHeightMm * pixelsPerMm))
        // 图片居中（center）时 A 面以整个画板为边界（忽略安全边距），
        // B 面同样直接以整个画板为目标，保持 A/B 面对齐，不生成外围实心边环。
        const centerPlacement = baseplateSettings.imagePlacement === 'center'
        if (paddingMm <= 0 || centerPlacement) {
          // 安全边距=0（或图片居中）：内容直接铺满整个画板，不留外围空白
          bFaceHeightMap = buildHalftoneHeightMapFromImageData(
            imageData.data,
            canvas.width,
            canvas.height,
            fullW,
            fullH,
            lightReliefSettings.bFaceExposure,
            lightReliefSettings.bFaceInvert,
            baseplateSettings.imagePlacement,
          )
        } else {
          // 安全边距（paddingMm）对 A/B 面都生效：
          // 内容区域缩放到 (boardW - 2*padding) × (boardH - 2*padding) 并居中，
          // 外围 paddingMm 区域 height=1（最大厚度），halftone 壳体以满厚度耗材填充。
          const innerW = Math.max(1, layoutA.boardWidthMm - paddingMm * 2)
          const innerH = Math.max(1, layoutA.boardHeightMm - paddingMm * 2)
          const contentW = Math.max(1, Math.ceil(innerW * pixelsPerMm))
          const contentH = Math.max(1, Math.ceil(innerH * pixelsPerMm))
          const paddingPxX = Math.max(0, Math.floor((fullW - contentW) / 2))
          const paddingPxY = Math.max(0, Math.floor((fullH - contentH) / 2))
          // 先对"内容画布"构建灰度图（含缩放、居中），然后贴到完整画布的 padding 偏移处
          const innerHeightMap = buildHalftoneHeightMapFromImageData(
            imageData.data,
            canvas.width,
            canvas.height,
            contentW,
            contentH,
            lightReliefSettings.bFaceExposure,
            lightReliefSettings.bFaceInvert,
            baseplateSettings.imagePlacement,
          )
          // 外围 padding 区域填 1（=最大厚度=实心耗材），而非 0（=最薄≈空白）
          const outerData = new Float32Array(fullW * fullH).fill(1)
          for (let y = 0; y < contentH; y += 1) {
            const dstRow = (y + paddingPxY) * fullW + paddingPxX
            const srcRow = y * contentW
            for (let x = 0; x < contentW; x += 1) {
              outerData[dstRow + x] = innerHeightMap.data[srcRow + x]
            }
          }
          bFaceHeightMap = { width: fullW, height: fullH, data: outerData }
        }
      }
    }
  }

  // 光映浮雕画板固定为矩形模板，baseLoops 即矩形外框。
  const baseLoops = createTemplateBaseLoops(baseplateSettings)

  const previews = buildLightReliefPreviewAssets(
    finalLineLoopsA,
    finalLineLoopsB,
    bFaceHeightMap,
    effectiveBFaceMode,
    baseLoops,
    layoutA.boardWidthMm,
    layoutA.boardHeightMm,
    baseplateSettings,
  )

  return {
    sourceKind: sourceA.kind,
    sourceWidth: sourceA.width,
    sourceHeight: sourceA.height,
    lineLoops: finalLineLoopsA,
    lineLoopsB: finalLineLoopsB,
    bFaceHeightMap,
    effectiveBFaceMode,
    baseLoops,
    boardWidthMm: layoutA.boardWidthMm,
    boardHeightMm: layoutA.boardHeightMm,
    pixelsPerMm,
    previews,
    stats: {
      sourceKind: sourceA.kind,
      sourceWidth: sourceA.width,
      sourceHeight: sourceA.height,
      lineLoopCount: finalLineLoopsA.length,
      baseLoopCount: baseLoops.length,
      lineSegments: finalLineLoopsA.reduce((sum, loop) => sum + loop.points.length, 0),
      baseSegments: baseLoops.reduce((sum, loop) => sum + loop.points.length, 0),
      boardWidthMm: layoutA.boardWidthMm,
      boardHeightMm: layoutA.boardHeightMm,
    },
  }
}

// 光映浮雕预览中 B 面用蓝色辅助区分（A 面沿用 lineColor=黑）。
const LIGHT_RELIEF_FACE_B_PREVIEW_COLOR = '#0066cc'

/**
 * 将高度图渲染为 PNG dataUrl（halftone B 面预览用）。
 * 高度越高（越厚）颜色越深，便于在预览中看出深浅分布。
 */
function buildHalftonePreviewDataUrl(
  heightMap: { width: number; height: number; data: Float32Array } | undefined,
  boardWidthMm: number,
  boardHeightMm: number,
): string | null {
  if (!heightMap || !heightMap.data.length) return null
  const { width, height, data } = heightMap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imageData = ctx.createImageData(width, height)
  for (let i = 0; i < data.length; i += 1) {
    // 高度 1（最深/最厚）→ 黑，0（最浅/最薄）→ 白
    const v = Math.round((1 - data[i]) * 255)
    imageData.data[i * 4] = v
    imageData.data[i * 4 + 1] = v
    imageData.data[i * 4 + 2] = v
    imageData.data[i * 4 + 3] = 255
  }
  ctx.putImageData(imageData, 0, 0)
  // 缩放 SVG 容器，使预览尺寸与画板一致
  return canvas.toDataURL('image/png')
}

function buildLightReliefPreviewAssets(
  lineLoopsA: VectorLoop[],
  lineLoopsB: VectorLoop[],
  bFaceHeightMap: { width: number; height: number; data: Float32Array } | undefined,
  bFaceMode: 'lineart' | 'halftone',
  baseLoops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  settings: BaseplateSettings,
): PreviewAssets {
  const halftonePreviewUrl = bFaceMode === 'halftone'
    ? buildHalftonePreviewDataUrl(bFaceHeightMap, boardWidthMm, boardHeightMm)
    : null

  const baseLayers = [
    { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
    { id: 'lineart-a', fill: settings.lineColor, loops: lineLoopsA },
  ]
  const ghostLayers = [
    { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
    { id: 'lineart-a-ghost', fill: settings.lineColor, loops: lineLoopsA, opacity: 0.22 },
  ]

  if (bFaceMode === 'halftone' && halftonePreviewUrl) {
    // halftone 模式：B 面用灰度图叠加预览
    return {
      lineartDataUrl: halftonePreviewUrl,
      baseplateDataUrl: halftonePreviewUrl,
      compositeDataUrl: halftonePreviewUrl,
    }
  }

  // lineart 模式：B 面用蓝色线稿
  return {
    lineartDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'lineart-a', fill: settings.lineColor, loops: lineLoopsA },
      { id: 'lineart-b', fill: LIGHT_RELIEF_FACE_B_PREVIEW_COLOR, loops: lineLoopsB },
    ]),
    baseplateDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      ...ghostLayers,
      { id: 'lineart-b-ghost', fill: LIGHT_RELIEF_FACE_B_PREVIEW_COLOR, loops: lineLoopsB, opacity: 0.22 },
    ]),
    compositeDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      ...baseLayers,
      { id: 'lineart-b', fill: LIGHT_RELIEF_FACE_B_PREVIEW_COLOR, loops: lineLoopsB },
    ]),
  }
}

export function exportLineartSvg(filename: string, artwork: ProcessedArtwork, settings: BaseplateSettings) {
  downloadText(filename, buildLineartSvgDocument(artwork, settings), 'image/svg+xml;charset=utf-8')
}

export function exportLineartDxf(filename: string, artwork: ProcessedArtwork) {
  downloadText(filename, buildLoopDxf(artwork.lineLoops, 'LINEART'), 'application/dxf;charset=utf-8')
}

export async function export3mf(
  filename: string,
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
  sealSettings?: SealSettings | null,
) {
  const bytes = sealSettings
    ? await buildSeal3mfPackage(artwork, baseplateSettings, sealSettings, printBedSettings, threeMfProfile)
    : await build3mfPackage(artwork, baseplateSettings, extrudeSettings, printBedSettings, threeMfProfile)
  downloadBlob(filename, new Blob([bytes], { type: 'model/3mf' }))
}

export function buildLineartSvgDocument(artwork: ProcessedArtwork, settings: BaseplateSettings) {
  const basePaths = loopsToSvgPath(artwork.baseLoops)
  const linePaths = loopsToSvgPath(artwork.lineLoops)
  const strokePaths = artwork.strokeLoops ? loopsToSvgPath(artwork.strokeLoops) : ''

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.boardWidthMm}mm" height="${artwork.boardHeightMm}mm" viewBox="0 0 ${formatNumber(artwork.boardWidthMm)} ${formatNumber(artwork.boardHeightMm)}">`,
    '  <title>线稿底板图层</title>',
    '  <desc>包含底板与线稿两个图层的可编辑 SVG。</desc>',
    `  <g id="baseplate" fill="${settings.baseColor}">`,
    `    <path d="${basePaths}" />`,
    '  </g>',
    strokePaths ? `  <g id="stroke" fill="${settings.lineColor}">\n    <path d="${strokePaths}" />\n  </g>` : '',
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
  if (pairs.length > IMPORT_LIMITS.maxDxfPairs) {
    throw new Error('DXF contains too many entities.')
  }
  const loops: VectorLoop[] = []
  let vertexCount = 0

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
          vertexCount += 1
          if (vertexCount > IMPORT_LIMITS.maxDxfVertices) throw new Error('DXF contains too many vertices.')
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
          vertexCount += 1
          if (vertexCount > IMPORT_LIMITS.maxDxfVertices) throw new Error('DXF contains too many vertices.')
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

export async function build3mfPackage(
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
  onProgress?: (label: string) => void | Promise<void>,
  lineartSettings?: LineartSettings,
) {
  await onProgress?.('正在生成底板网格...')
  const flippedBaseLoops = flipLoopsForModelExport(artwork.baseLoops, artwork.boardHeightMm)
  const flippedLineLoops = flipLoopsForModelExport(artwork.lineLoops, artwork.boardHeightMm)
  const lineMeshPixelsPerMm = chooseSingleExportPixelsPerMm(artwork)
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
  await onProgress?.('正在生成线稿网格...')
  const lineMesh = translateMesh(
    extrudeMaskToMesh(
      flippedLineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      extrudeSettings.lineHeightMm,
      extrudeSettings.lineThicknessMm,
      extrudeSettings.minLineWidthMm,
      lineartSettings?.expandStrokeMm ?? 0,
      lineartSettings?.shrinkStrokeMm ?? 0,
    ),
    offsetX,
    offsetY,
  )
  await onProgress?.('正在生成 3MF XML...')
  const applicationName = threeMfProfile?.applicationName ?? 'BambuStudio-01.10.00.89'
  const modelXml = build3mfModelXml(baseMesh, lineMesh, baseplateSettings, applicationName)
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
  await onProgress?.('正在压缩 3MF 文件...')

  // 2026-08-28：把 2D 预览（composite：底板+线稿）作为 plate 缩略图嵌入 3MF。
  // 切片器在文件浏览器/加载界面会显示这张图，用户能直接看到眼睛等细节是否清晰，
  // 避免依赖切片器的 3D 预览（其会把网格孔洞渲染成底板灰色，看不到眼睛白）。
  const thumbnailPng = dataUrlToPngBytes(artwork.previews.compositeDataUrl)

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
    'Metadata/slice_info.config': strToU8(sliceInfoConfig),
    'Metadata/filament_sequence.json': strToU8(filamentSequence),
    ...(thumbnailPng ? { 'Metadata/plate_1.png': thumbnailPng } : {}),
  }, { level: 6 })
}

export async function buildSeal3mfPackage(
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  sealSettings: SealSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
  onProgress?: (label: string) => void | Promise<void>,
  extrudeSettings?: ExtrudeSettings,
  lineartSettings?: LineartSettings,
) {
  await onProgress?.('正在生成底板网格...')
  const minLineWidthMm = extrudeSettings?.minLineWidthMm ?? MIN_EXPORTABLE_LINE_WIDTH_MM
  const expandStrokeMm = lineartSettings?.expandStrokeMm ?? 0
  const shrinkStrokeMm = lineartSettings?.shrinkStrokeMm ?? 0
  const flippedBaseLoops = flipLoopsForModelExport(artwork.baseLoops, artwork.boardHeightMm)
  const flippedLineLoops = flipLoopsForModelExport(artwork.lineLoops, artwork.boardHeightMm)
  const lineMeshPixelsPerMm = chooseSingleExportPixelsPerMm(artwork)

  const singlePlacement = planPrintBedLayout([{
    id: 'single-artwork',
    label: '单文件导出',
    widthMm: artwork.boardWidthMm,
    heightMm: artwork.boardHeightMm,
  }], printBedSettings).placements[0]
  const offsetX = singlePlacement?.xMm ?? 0
  const offsetY = singlePlacement?.yMm ?? 0

  const sealHeightMm = sealSettings.sealHeightMm
  const engravingDiffMm = sealSettings.engravingHeightDiffMm
  const bodyHeightMm = Math.max(0, sealHeightMm - engravingDiffMm)
  const flippedStrokeLoops = artwork.strokeLoops?.length
    ? flipLoopsForModelExport(artwork.strokeLoops!, artwork.boardHeightMm)
    : null

  // Shared bottom layer: full baseplate extruded 0 -> bodyHeightMm
  const bodyMesh = translateMesh(
    extrudeLoopsToMesh(
      keepOuterLoops(flippedBaseLoops),
      0,
      bodyHeightMm,
    ),
    offsetX,
    offsetY,
  )

  const isIntaglio = sealSettings.carvingMode === 'intaglio'
  const meshes: Array<{ mesh: MeshData; objectId: number; name: string; pindex: number }> = [
    { mesh: bodyMesh, objectId: 2, name: '印章主体', pindex: 0 },
  ]

  if (isIntaglio) {
    // 阴刻顶层: 底板形状减去线稿和描边，在 bodyHeight -> sealHeight 之间
    const baseMask = rasterizeLoopsToMask(
      keepOuterLoops(flippedBaseLoops),
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      0,
    )
    const lineMask = rasterizeLoopsToMask(
      flippedLineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      0,
    )
    let topMask = subtractMask(baseMask.mask, lineMask.mask, baseMask.width, baseMask.height)

    if (flippedStrokeLoops?.length) {
      const strokeMask = rasterizeLoopsToMask(
        flippedStrokeLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        0,
      )
      topMask = subtractMask(topMask, strokeMask.mask, baseMask.width, baseMask.height)
    }

    const topLoops = traceMaskToLoops(topMask, baseMask.width, baseMask.height)
      .map((loop) => pixelsToMm(loop, lineMeshPixelsPerMm, 0))
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.01)

    if (topLoops.length) {
      const topMesh = translateMesh(
        extrudeMaskToMesh(
          topLoops,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          lineMeshPixelsPerMm,
          bodyHeightMm,
          engravingDiffMm,
          0,
        ),
        offsetX,
        offsetY,
      )
      meshes.push({ mesh: topMesh, objectId: 3, name: '印章顶面', pindex: 0 })
    }
  } else {
    // 阳刻顶层: 只有线稿和描边凸起，在 bodyHeight -> sealHeight 之间
    const raisedLineMesh = translateMesh(
      extrudeMaskToMesh(
        flippedLineLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        bodyHeightMm,
        engravingDiffMm,
        minLineWidthMm,
        expandStrokeMm,
        shrinkStrokeMm,
      ),
      offsetX,
      offsetY,
    )
    meshes.push({ mesh: raisedLineMesh, objectId: 3, name: '线稿', pindex: 0 })

    if (flippedStrokeLoops?.length) {
      const strokeMesh = translateMesh(
        extrudeMaskToMesh(
          flippedStrokeLoops,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          lineMeshPixelsPerMm,
          bodyHeightMm,
          engravingDiffMm,
          minLineWidthMm,
          expandStrokeMm,
          shrinkStrokeMm,
        ),
        offsetX,
        offsetY,
      )
      meshes.push({ mesh: strokeMesh, objectId: 5, name: '描边', pindex: 0 })
    }
  }

  await onProgress?.('正在生成 3MF XML...')
  const applicationName = threeMfProfile?.applicationName ?? 'BambuStudio-01.10.00.89'
  const modelXml = buildSeal3mfModelXml(meshes, 4, baseplateSettings, applicationName, sealSettings)

  const parts = meshes.map((m) => ({ id: m.objectId, name: m.name, extruder: 1 }))

  return buildSeal3mfZipPackage(
    modelXml,
    parts,
    4,
    baseplateSettings,
    printBedSettings,
    threeMfProfile,
    { compositeThumbnailPng: dataUrlToPngBytes(artwork.previews.compositeDataUrl) },
  )
}

/**
 * 光映浮雕 3MF 导出。
 *
 * Z 轴分层（以默认 totalHeight=1, faceAZ=0/faceAHeight=0.4, faceBZ=0.6/faceBHeight=0.2 为例）：
 *   - 背景下半 [0, faceBZMm]：耗材2（白），整块画板
 *   - B 面阴刻层 [faceBZMm, faceBZMm+faceBHeightMm]：耗材2（白），仅填充“画板 减去 B 面线稿”的区域（B 面线稿区域留空）
 *   - 背景顶部 [faceBZMm+faceBHeightMm, totalHeightMm]：耗材2（白），整块画板
 *   - A 面线稿 [faceAZMm, faceAZMm+faceAHeightMm]：耗材1（黑），A 面线稿区域
 *
 * 耗材槽位与掐丝模式相反：耗材1=线稿（黑），耗材2=背景（白）。
 *
 * 开启 bFaceReverseStack（浮雕暴露）时：
 *   - 背景下半 [0, faceBZMm] 始终保留（实心底座，贴热床，为浮雕提供基座避免悬空）
 *   - B 面浮雕保持正向朝向（底面固定在 faceBZMm、顶面随灰度变化），bumpy 顶面完全暴露
 *   - 背景顶部 [bFaceTopMm, totalHeightMm] 不再生成——让浮雕 bumpy 顶面直接暴露，提升透光率
 */
export async function buildLightRelief3mfPackage(
  artwork: ProcessedArtwork,
  baseplateSettings: BaseplateSettings,
  lightReliefSettings: LightReliefSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
  onProgress?: (label: string) => void | Promise<void>,
  extrudeSettings?: ExtrudeSettings,
  lineartSettings?: LineartSettings,
) {
  const flippedBaseLoops = flipLoopsForModelExport(artwork.baseLoops, artwork.boardHeightMm)
  const flippedLineLoopsA = flipLoopsForModelExport(artwork.lineLoops, artwork.boardHeightMm)
  const lineLoopsB = artwork.lineLoopsB?.length ? artwork.lineLoopsB : []
  const flippedLineLoopsB = lineLoopsB.length ? flipLoopsForModelExport(lineLoopsB, artwork.boardHeightMm) : []
  const minLineWidthMm = extrudeSettings?.minLineWidthMm ?? MIN_EXPORTABLE_LINE_WIDTH_MM
  const expandStrokeMm = lineartSettings?.expandStrokeMm ?? 0
  const shrinkStrokeMm = lineartSettings?.shrinkStrokeMm ?? 0
  const lineMeshPixelsPerMm = chooseSingleExportPixelsPerMm(artwork)

  const singlePlacement = planPrintBedLayout([{
    id: 'single-artwork',
    label: '单文件导出',
    widthMm: artwork.boardWidthMm,
    heightMm: artwork.boardHeightMm,
  }], printBedSettings).placements[0]
  const offsetX = singlePlacement?.xMm ?? 0
  const offsetY = singlePlacement?.yMm ?? 0

  const { totalHeightMm, faceAZMm, faceAHeightMm, faceBZMm, faceBHeightMm } = lightReliefSettings
  const bFaceTopMm = faceBZMm + faceBHeightMm
  // 浮雕暴露：浮雕保持正向朝向（bumpy 顶面朝上），底座始终保留；
  // 背景顶层（顶盖）省略——让浮雕 bumpy 顶面直接暴露，提升透光率。
  const reverseStack = lightReliefSettings.bFaceReverseStack ?? false
  const outerBaseLoops = keepOuterLoops(flippedBaseLoops)

  // 每个网格记录其耗材 pindex（0=耗材1黑/A面线稿，1=耗材2白/背景）。
  const meshes: Array<{ mesh: MeshData; objectId: number; name: string; pindex: number; extruder: number }> = []
  let nextObjectId = 2

  // 1. 背景下半 [0, faceBZMm]（耗材2）。实心底座，始终保留（为浮雕提供贴热床基座）。
  await onProgress?.('正在生成背景下层网格...')
  if (faceBZMm > 0) {
    const bgBottomMesh = translateMesh(
      extrudeLoopsToMesh(outerBaseLoops, 0, faceBZMm),
      offsetX,
      offsetY,
    )
    meshes.push({ mesh: bgBottomMesh, objectId: nextObjectId, name: '背景下层', pindex: 1, extruder: 2 })
    nextObjectId += 1
  }

  // 2. B 面层 [faceBZMm, faceBZMm+faceBHeightMm]（耗材2）
  if (faceBHeightMm > 0) {
    await onProgress?.('正在生成 B 面透光浮雕网格...')
    if (artwork.bFaceHeightMap) {
      // halftone 模式：按灰度高度图生成透光浮雕网格（耗材2），3MF 导出需 Y 翻转以与 flipLoopsForModelExport 对齐
      const reliefMesh = translateMesh(
        buildHalftoneReliefMesh(
          artwork.bFaceHeightMap,
          lineMeshPixelsPerMm,
          faceBZMm,
          faceBHeightMm,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          true, // flipY
          false, // 浮雕始终保持正向朝向（bumpy 顶面朝上），不翻转表面
        ),
        offsetX,
        offsetY,
      )
      if (reliefMesh.vertices.length) {
        meshes.push({ mesh: reliefMesh, objectId: nextObjectId, name: 'B面透光浮雕', pindex: 1, extruder: 2 })
        nextObjectId += 1
      }
    } else {
      // lineart 模式：画板减去 B 面线稿（B 面线稿区域留空）
      const baseMask = rasterizeLoopsToMask(
        outerBaseLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        0,
      )
      let topMask = baseMask.mask
      if (flippedLineLoopsB.length) {
        const lineMaskB = rasterizeLoopsToMask(
          flippedLineLoopsB,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          lineMeshPixelsPerMm,
          0,
        )
        topMask = subtractMask(baseMask.mask, lineMaskB.mask, baseMask.width, baseMask.height)
      }
      const topLoops = traceMaskToLoops(topMask, baseMask.width, baseMask.height)
        .map((loop) => pixelsToMm(loop, lineMeshPixelsPerMm, 0))
        .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.01)
      if (topLoops.length) {
        const bFaceMesh = translateMesh(
          extrudeMaskToMesh(
            topLoops,
            artwork.boardWidthMm,
            artwork.boardHeightMm,
            lineMeshPixelsPerMm,
            faceBZMm,
            faceBHeightMm,
            0,
          ),
          offsetX,
          offsetY,
        )
        meshes.push({ mesh: bFaceMesh, objectId: nextObjectId, name: 'B面阴刻层', pindex: 1, extruder: 2 })
        nextObjectId += 1
      }
    }
  }

  // 3. 背景顶部 [bFaceTopMm, totalHeightMm]（耗材2）。浮雕暴露模式时跳过——让浮雕 bumpy 顶面直接暴露。
  await onProgress?.('正在生成背景顶层网格...')
  const topHeightMm = totalHeightMm - bFaceTopMm
  if (topHeightMm > 0 && !reverseStack) {
    const bgTopMesh = translateMesh(
      extrudeLoopsToMesh(outerBaseLoops, bFaceTopMm, topHeightMm),
      offsetX,
      offsetY,
    )
    meshes.push({ mesh: bgTopMesh, objectId: nextObjectId, name: '背景顶层', pindex: 1, extruder: 2 })
    nextObjectId += 1
  }

  // 4. A 面线稿 [faceAZMm, faceAZMm+faceAHeightMm]（耗材1）
  await onProgress?.('正在生成 A 面线稿网格...')
  if (faceAHeightMm > 0 && flippedLineLoopsA.length) {
    const aFaceMesh = translateMesh(
      extrudeMaskToMesh(
        flippedLineLoopsA,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        faceAZMm,
        faceAHeightMm,
        minLineWidthMm,
        expandStrokeMm,
        shrinkStrokeMm,
      ),
      offsetX,
      offsetY,
    )
    meshes.push({ mesh: aFaceMesh, objectId: nextObjectId, name: 'A面线稿', pindex: 0, extruder: 1 })
    nextObjectId += 1
  }

  await onProgress?.('正在生成 3MF XML...')
  const compositeObjectId = nextObjectId
  const applicationName = threeMfProfile?.applicationName ?? 'BambuStudio-01.10.00.89'
  const modelXml = buildLightRelief3mfModelXml(meshes, compositeObjectId, baseplateSettings, applicationName)

  const parts = meshes.map((m) => ({ id: m.objectId, name: m.name, extruder: m.extruder }))
  await onProgress?.('正在压缩 3MF 文件...')
  return buildSeal3mfZipPackage(
    modelXml,
    parts,
    compositeObjectId,
    baseplateSettings,
    printBedSettings,
    threeMfProfile,
    {
      compositeName: '光映浮雕',
      filamentColorOrder: 'line-base',
      compositeThumbnailPng: dataUrlToPngBytes(artwork.previews.compositeDataUrl),
    },
  )
}

function buildLightRelief3mfModelXml(
  meshes: Array<{ mesh: MeshData; objectId: number; name: string; pindex: number }>,
  compositeObjectId: number,
  baseplateSettings: BaseplateSettings,
  applicationName: string,
) {
  // basematerials 顺序：耗材1=A面线稿（黑/lineColor），耗材2=背景（白/baseColor）。
  const lineColor = `${baseplateSettings.lineColor.toUpperCase()}FF`
  const baseColor = `${baseplateSettings.baseColor.toUpperCase()}FF`

  const objects: string[] = []
  const componentIds: number[] = []
  for (const entry of meshes) {
    objects.push(meshTo3mfObject(entry.mesh, entry.objectId, entry.name, entry.pindex))
    componentIds.push(entry.objectId)
  }
  objects.push(build3mfCompositeObject(compositeObjectId, '光映浮雕组合', componentIds))

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    `  <metadata name="Application">${applicationName}</metadata>`,
    '  <metadata name="Designer">线稿底板生成器</metadata>',
    '  <metadata name="Title">光映浮雕 3MF</metadata>',
    '  <resources>',
    '    <basematerials id="1">',
    `      <base name="耗材1-A面线稿" displaycolor="${lineColor}"/>`,
    `      <base name="耗材2-背景" displaycolor="${baseColor}"/>`,
    '    </basematerials>',
    ...objects,
    '  </resources>',
    '  <build>',
    `    <item objectid="${compositeObjectId}"/>`,
    '  </build>',
    '</model>',
  ].join('\n')
}

/**
 * 光映浮雕 3D 预览 glTF。与 buildLightRelief3mfPackage 共用同一套分层逻辑，
 * 仅以预览分辨率构建网格并用真实颜色渲染。
 */
export function buildLightReliefPreviewModelGltfBlob(
  artwork: PreviewModelArtworkInput,
  baseplateSettings: BaseplateSettings,
  lightReliefSettings: LightReliefSettings,
  extrudeSettings?: ExtrudeSettings,
  lineartSettings?: LineartSettings,
) {
  const lineMeshPixelsPerMm = choosePreviewModelPixelsPerMm(artwork)
  const { totalHeightMm, faceAZMm, faceAHeightMm, faceBZMm, faceBHeightMm } = lightReliefSettings
  const bFaceTopMm = faceBZMm + faceBHeightMm
  // 浮雕暴露：浮雕保持正向朝向（bumpy 顶面朝上），底座始终保留；
  // 背景顶层（顶盖）省略（与 3MF 导出保持一致）
  const reverseStack = lightReliefSettings.bFaceReverseStack ?? false
  const minLineWidthMm = extrudeSettings?.minLineWidthMm ?? MIN_EXPORTABLE_LINE_WIDTH_MM
  const expandStrokeMm = lineartSettings?.expandStrokeMm ?? 0
  const shrinkStrokeMm = lineartSettings?.shrinkStrokeMm ?? 0
  const outerBaseLoops = keepOuterLoops(artwork.baseLoops)
  const lineLoopsB = artwork.lineLoopsB?.length ? artwork.lineLoopsB : []

  const meshes: Array<{ mesh: MeshData; name: string; color: string }> = []

  if (faceBZMm > 0) {
    meshes.push({
      mesh: extrudeLoopsToMesh(outerBaseLoops, 0, faceBZMm),
      name: '背景下层',
      color: baseplateSettings.baseColor,
    })
  }

  if (faceBHeightMm > 0) {
    if (artwork.bFaceHeightMap) {
      // halftone 模式：透光浮雕网格（预览内部坐标系，不 flipY）
      meshes.push({
        mesh: buildHalftoneReliefMesh(
          artwork.bFaceHeightMap,
          lineMeshPixelsPerMm,
          faceBZMm,
          faceBHeightMm,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          false, // flipY
          false, // 浮雕始终保持正向朝向（bumpy 顶面朝上），不翻转表面
        ),
        name: 'B面透光浮雕',
        color: baseplateSettings.baseColor,
      })
    } else {
      // lineart 模式：画板减去 B 面线稿
      const baseMask = rasterizeLoopsToMask(
        outerBaseLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        0,
      )
      let topMask = baseMask.mask
      if (lineLoopsB.length) {
        const lineMaskB = rasterizeLoopsToMask(
          lineLoopsB,
          artwork.boardWidthMm,
          artwork.boardHeightMm,
          lineMeshPixelsPerMm,
          0,
        )
        topMask = subtractMask(baseMask.mask, lineMaskB.mask, baseMask.width, baseMask.height)
      }
      const topLoops = traceMaskToLoops(topMask, baseMask.width, baseMask.height)
        .map((loop) => pixelsToMm(loop, lineMeshPixelsPerMm, 0))
        .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.01)
      if (topLoops.length) {
        meshes.push({
          mesh: extrudeMaskToMesh(
            topLoops,
            artwork.boardWidthMm,
            artwork.boardHeightMm,
            lineMeshPixelsPerMm,
            faceBZMm,
            faceBHeightMm,
            0,
          ),
          name: 'B面阴刻层',
          color: baseplateSettings.baseColor,
        })
      }
    }
  }

  const topHeightMm = totalHeightMm - bFaceTopMm
  if (topHeightMm > 0 && !reverseStack) {
    meshes.push({
      mesh: extrudeLoopsToMesh(outerBaseLoops, bFaceTopMm, topHeightMm),
      name: '背景顶层',
      color: baseplateSettings.baseColor,
    })
  }

  if (faceAHeightMm > 0 && artwork.lineLoops.length) {
    meshes.push({
      mesh: extrudeMaskToMesh(
        artwork.lineLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        faceAZMm,
        faceAHeightMm,
        minLineWidthMm,
        expandStrokeMm,
        shrinkStrokeMm,
      ),
      name: 'A面线稿',
      color: baseplateSettings.lineColor,
    })
  }

  return buildGltfPreviewBlob(
    meshes,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
  )
}

function buildSeal3mfZipPackage(
  modelXml: string,
  parts: Array<{ id: number; name: string; extruder: number }>,
  compositeObjectId: number,
  baseplateSettings: BaseplateSettings,
  printBedSettings: PrintBedSettings,
  threeMfProfile?: ThreeMfTemplateProfile | null,
  options?: {
    compositeName?: string
    filamentColorOrder?: 'base-line' | 'line-base'
    compositeThumbnailPng?: Uint8Array | null
  },
) {
  const compositeName = options?.compositeName ?? (parts.length > 1 ? '阳刻印章' : '阴刻印章')
  const filamentColorOrder = options?.filamentColorOrder ?? 'base-line'
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
      id: compositeObjectId,
      name: compositeName,
      parts,
    },
  ], [{
    plateIndex: 0,
    objectIds: [compositeObjectId],
    identifyIds: [1],
  }])
  const projectSettings = buildThreeMfProjectSettingsConfig(threeMfProfile, baseplateSettings, printBedSettings, filamentColorOrder)
  const sliceInfoConfig = buildThreeMfSliceInfoConfig(threeMfProfile)
  const filamentSequence = buildThreeMfFilamentSequenceJson(threeMfProfile, 1)

  // 2026-08-28：把 2D 预览（composite：底板+线稿）作为 plate 缩略图嵌入 3MF。
  const thumbnailPng = options?.compositeThumbnailPng ?? null

  return zipSync({
    '[Content_Types].xml': strToU8(contentTypes),
    '_rels/.rels': strToU8(rootRels),
    '3D/3dmodel.model': strToU8(modelXml),
    'Metadata/model_settings.config': strToU8(modelSettings),
    'Metadata/project_settings.config': strToU8(projectSettings),
    'Metadata/slice_info.config': strToU8(sliceInfoConfig),
    'Metadata/filament_sequence.json': strToU8(filamentSequence),
    ...(thumbnailPng ? { 'Metadata/plate_1.png': thumbnailPng } : {}),
  }, { level: 6 })
}

function buildSeal3mfModelXml(
  meshes: Array<{ mesh: MeshData; objectId: number; name: string; pindex: number }>,
  compositeObjectId: number,
  baseplateSettings: BaseplateSettings,
  applicationName: string,
  sealSettings: SealSettings,
) {
  const baseColor = `${baseplateSettings.baseColor.toUpperCase()}FF`

  const objects: string[] = []
  const componentIds: number[] = []

  for (const entry of meshes) {
    objects.push(meshTo3mfObject(entry.mesh, entry.objectId, entry.name, entry.pindex))
    componentIds.push(entry.objectId)
  }

  objects.push(build3mfCompositeObject(compositeObjectId, sealSettings.carvingMode === 'intaglio' ? '阴刻印章' : '阳刻印章', componentIds))

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="zh-CN" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    `  <metadata name="Application">${applicationName}</metadata>`,
    '  <metadata name="Designer">线稿底板生成器</metadata>',
    `  <metadata name="Title">${escapeXmlAttribute(sealSettings.carvingMode === 'intaglio' ? '阴刻印章 3MF' : '阳刻印章 3MF')}</metadata>`,
    '  <resources>',
    '    <basematerials id="1">',
    `      <base name="印章耗材" displaycolor="${baseColor}"/>`,
    '    </basematerials>',
    ...objects,
    '  </resources>',
    '  <build>',
    `    <item objectid="${compositeObjectId}"/>`,
    '  </build>',
    '</model>',
  ].join('\n')
}

export function buildSealPreviewModelGltfBlob(
  artwork: PreviewModelArtworkInput & { strokeLoops?: VectorLoop[] },
  baseplateSettings: BaseplateSettings,
  sealSettings: SealSettings,
  extrudeSettings?: ExtrudeSettings,
  lineartSettings?: LineartSettings,
) {
  const lineMeshPixelsPerMm = choosePreviewModelPixelsPerMm(artwork)
  const sealHeightMm = sealSettings.sealHeightMm
  const engravingDiffMm = sealSettings.engravingHeightDiffMm
  const bodyHeightMm = Math.max(0, sealHeightMm - engravingDiffMm)
  const minLineWidthMm = extrudeSettings?.minLineWidthMm ?? MIN_EXPORTABLE_LINE_WIDTH_MM
  const expandStrokeMm = lineartSettings?.expandStrokeMm ?? 0
  const shrinkStrokeMm = lineartSettings?.shrinkStrokeMm ?? 0
  const baseColor = baseplateSettings.baseColor

  const meshes: Array<{ mesh: MeshData; name: string; color: string }> = []
  const strokeLoops = artwork.strokeLoops?.length ? artwork.strokeLoops : null

  // Shared bottom layer
  const bodyMesh = extrudeLoopsToMesh(
    keepOuterLoops(artwork.baseLoops),
    0,
    bodyHeightMm,
  )
  meshes.push({ mesh: bodyMesh, name: '印章主体', color: baseColor })

  if (sealSettings.carvingMode === 'relief') {
    // 阳刻顶层: 线稿凸起
    const lineMesh = extrudeMaskToMesh(
      artwork.lineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      bodyHeightMm,
      engravingDiffMm,
      minLineWidthMm,
      expandStrokeMm,
      shrinkStrokeMm,
    )
    meshes.push({ mesh: lineMesh, name: '线稿', color: baseColor })

    if (strokeLoops?.length) {
      const strokeMesh = extrudeMaskToMesh(
        strokeLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        bodyHeightMm,
        engravingDiffMm,
        minLineWidthMm,
        expandStrokeMm,
        shrinkStrokeMm,
      )
      meshes.push({ mesh: strokeMesh, name: '描边', color: baseColor })
    }
  } else {
    // 阴刻顶层: 底板形状减去线稿和描边
    const baseMask = rasterizeLoopsToMask(
      keepOuterLoops(artwork.baseLoops),
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      0,
    )
    const lineMask = rasterizeLoopsToMask(
      artwork.lineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      lineMeshPixelsPerMm,
      0,
    )
    let topMask = subtractMask(baseMask.mask, lineMask.mask, baseMask.width, baseMask.height)

    if (strokeLoops?.length) {
      const strokeMask = rasterizeLoopsToMask(
        strokeLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        0,
      )
      topMask = subtractMask(topMask, strokeMask.mask, baseMask.width, baseMask.height)
    }

    const topLoops = traceMaskToLoops(topMask, baseMask.width, baseMask.height)
      .map((loop) => pixelsToMm(loop, lineMeshPixelsPerMm, 0))
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.01)

    if (topLoops.length) {
      const topMesh = extrudeMaskToMesh(
        topLoops,
        artwork.boardWidthMm,
        artwork.boardHeightMm,
        lineMeshPixelsPerMm,
        bodyHeightMm,
        engravingDiffMm,
        0,
      )
      meshes.push({ mesh: topMesh, name: '印章顶面', color: baseColor })
    }
  }

  return buildGltfPreviewBlob(
    meshes,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
  )
}

export function buildPreviewModelGltfBlob(
  artwork: PreviewModelArtworkInput,
  baseplateSettings: BaseplateSettings,
  extrudeSettings: ExtrudeSettings,
  lineartSettings?: LineartSettings,
) {
  const lineMeshPixelsPerMm = choosePreviewModelPixelsPerMm(artwork)
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
    extrudeSettings.minLineWidthMm,
    lineartSettings?.expandStrokeMm ?? 0,
    lineartSettings?.shrinkStrokeMm ?? 0,
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
  // 与 3MF 导出分辨率保持一致：3D 预览网格按最终导出的像素密度光栅化，
  // 保证 3D 预览的线宽与 3MF 实际打印模型一致（所见即所得）。
  return chooseSingleExportPixelsPerMm(artwork)
}

export function chooseSingleExportPixelsPerMm(
  artwork: Pick<ProcessedArtwork, 'pixelsPerMm' | 'boardWidthMm' | 'boardHeightMm'>,
) {
  const sourcePixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 12), 10, 32)
  const longestSideMm = Math.max(artwork.boardWidthMm, artwork.boardHeightMm, 1)
  const areaMm = Math.max(artwork.boardWidthMm * artwork.boardHeightMm, 1)
  // 按像素逐格生成网格时，每个像素最多会产生 4 个三角面。限制栅格面积，
  // 防止稠密图案在序列化 3MF XML 时超过浏览器的字符串长度上限。
  // 2026-08-28：把上限从 960/420K 抬到 1280/720K，3MF 网格的像素密度从
  // 5.29 px/mm 提到 6.93 px/mm（在 150x100mm 板上）。3MF 文件体积约
  // +70%，但能给切片器留更多眼睛等细节像素，缓解 3MF 与 webapp 2D
  // 预览"切片器里看糊"的问题。
  const maxSingleDimensionPx = 1280
  const maxSingleAreaPx = 720_000
  const byDimension = maxSingleDimensionPx / longestSideMm
  const byArea = Math.sqrt(maxSingleAreaPx / areaMm)

  return Math.max(1, Math.min(sourcePixelsPerMm, byDimension, byArea))
}

export function chooseCombinedExportPixelsPerMm(
  artwork: ProcessedArtwork,
  itemCount: number,
  totalAreaMm: number,
) {
  const sourcePixelsPerMm = clamp(Math.max(artwork.pixelsPerMm, 12), 8, 24)
  const longestSideMm = Math.max(artwork.boardWidthMm, artwork.boardHeightMm, 1)
  const itemAreaMm = Math.max(artwork.boardWidthMm * artwork.boardHeightMm, 1)
  const safeAverageAreaMm = Math.max(totalAreaMm / Math.max(itemCount, 1), itemAreaMm, 1)
  const maxCombinedDimensionPx = itemCount >= 16 ? 640 : itemCount >= 8 ? 760 : 880
  const maxCombinedAreaPx = itemCount >= 16 ? 180_000 : itemCount >= 8 ? 240_000 : 320_000
  const byDimension = maxCombinedDimensionPx / longestSideMm
  const byArea = Math.sqrt(maxCombinedAreaPx / safeAverageAreaMm)

  return Math.max(1, Math.min(sourcePixelsPerMm, byDimension, byArea))
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
  lineartSettings?: LineartSettings,
) {
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
      extrudeSettings.minLineWidthMm,
      lineartSettings?.expandStrokeMm ?? 0,
      lineartSettings?.shrinkStrokeMm ?? 0,
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
  const modelSettings = buildBambuModelSettingsConfig(
    modelSettingsObjects,
    Array.from(plateAssignments.entries())
      .sort(([left], [right]) => left - right)
      .map(([plateIndex, assignment]) => ({ plateIndex, objectIds: assignment.objectIds, identifyIds: assignment.identifyIds })),
  )
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
  }, { level: 6 })
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

/** 线稿描边掩码参数：让预览位图与 3MF 导出走同一条掩码管线所需的设置。 */
export interface LineartStrokeMaskOptions {
  minLineWidthMm?: number
  expandStrokeMm?: number
  shrinkStrokeMm?: number
}

export function rebuildArtworkWithLineLoops(
  artwork: ProcessedArtwork,
  lineLoops: VectorLoop[],
  settings: BaseplateSettings,
  strokeOptions?: LineartStrokeMaskOptions,
) {
  const nextLineLoops = lineLoops.map((loop) => ({
    ...loop,
    points: sanitizeLoop(loop.points),
  })).filter((loop) => loop.points.length >= 3)

  // 与 processArtwork 对齐：用 3MF 导出同款"打印等效位图"作为预览，
  // 保证用户改完后在画布上看到的细节（眼睛瞳孔、高光）与实际切片一致。
  let printPreviewMask: PrintPreviewMask | null = null
  const minLineWidthMm = strokeOptions?.minLineWidthMm ?? 0
  if (minLineWidthMm > 0 && nextLineLoops.length) {
    printPreviewMask = shapeLoopsForPrintPreview(
      nextLineLoops,
      artwork.boardWidthMm,
      artwork.boardHeightMm,
      chooseSingleExportPixelsPerMm({
        pixelsPerMm: artwork.pixelsPerMm,
        boardWidthMm: artwork.boardWidthMm,
        boardHeightMm: artwork.boardHeightMm,
      }),
      minLineWidthMm,
      strokeOptions?.expandStrokeMm ?? 0,
      strokeOptions?.shrinkStrokeMm ?? 0,
    )
  }

  return {
    ...artwork,
    lineLoops: nextLineLoops,
    previews: buildPreviewAssets(
      printPreviewMask,
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

// 7-segment digit renderer for numbering mode.
// Segment layout:
//  aaa
// f   b
// f   b
//  ggg
// e   c
// e   c
//  ddd
const DIGIT_SEGMENTS: Record<string, number[]> = {
  '0': [0, 1, 2, 3, 4, 5],
  '1': [1, 2],
  '2': [0, 1, 3, 4, 6],
  '3': [0, 1, 2, 3, 6],
  '4': [1, 2, 5, 6],
  '5': [0, 2, 3, 5, 6],
  '6': [0, 2, 3, 4, 5, 6],
  '7': [0, 1, 2],
  '8': [0, 1, 2, 3, 4, 5, 6],
  '9': [0, 1, 2, 3, 5, 6],
}

function buildSegmentPolygon(
  segmentIndex: number,
  originX: number,
  originY: number,
  w: number,
  h: number,
  t: number,
): VectorLoop | null {
  const halfH = h * 0.5
  const halfT = t * 0.5
  const innerW = w - t
  let pts: VectorPoint[]

  switch (segmentIndex) {
    case 0: // a — top horizontal
      pts = [
        { x: t, y: 0 }, { x: innerW, y: 0 },
        { x: innerW, y: t }, { x: t, y: t },
      ]
      break
    case 1: // b — upper-right vertical
      pts = [
        { x: innerW, y: t }, { x: w, y: t },
        { x: w, y: halfH - halfT }, { x: innerW, y: halfH - halfT },
      ]
      break
    case 2: // c — lower-right vertical
      pts = [
        { x: innerW, y: halfH + halfT }, { x: w, y: halfH + halfT },
        { x: w, y: h - t }, { x: innerW, y: h - t },
      ]
      break
    case 3: // d — bottom horizontal
      pts = [
        { x: t, y: h - t }, { x: innerW, y: h - t },
        { x: innerW, y: h }, { x: t, y: h },
      ]
      break
    case 4: // e — lower-left vertical
      pts = [
        { x: 0, y: halfH + halfT }, { x: t, y: halfH + halfT },
        { x: t, y: h - t }, { x: 0, y: h - t },
      ]
      break
    case 5: // f — upper-left vertical
      pts = [
        { x: 0, y: t }, { x: t, y: t },
        { x: t, y: halfH - halfT }, { x: 0, y: halfH - halfT },
      ]
      break
    case 6: // g — middle horizontal
      pts = [
        { x: t, y: halfH - halfT }, { x: innerW, y: halfH - halfT },
        { x: innerW, y: halfH + halfT }, { x: t, y: halfH + halfT },
      ]
      break
    default:
      return null
  }

  return {
    closed: true,
    points: pts.map((p) => ({ x: p.x + originX, y: p.y + originY })),
  }
}

export function buildNumberLoops(
  number: number,
  boardWidthMm: number,
  boardHeightMm: number,
  settings: NumberingSettings,
): VectorLoop[] {
  const safeNumber = Math.max(0, Math.floor(number))
  const text = String(safeNumber)
  if (!text.length) return []

  const h = Math.max(2, settings.fontSizeMm)
  const w = h * 0.6
  const t = h * 0.16
  const gap = h * 0.2
  const totalWidth = text.length * w + (text.length - 1) * gap

  const margin = Math.max(0.5, settings.marginMm)

  let blockX: number
  switch (settings.horizontalAlign) {
    case 'left':
      blockX = margin
      break
    case 'center':
      blockX = (boardWidthMm - totalWidth) * 0.5
      break
    default:
      blockX = boardWidthMm - margin - totalWidth
      break
  }

  let blockY: number
  switch (settings.verticalAlign) {
    case 'top':
      blockY = margin
      break
    case 'center':
      blockY = (boardHeightMm - h) * 0.5
      break
    default:
      blockY = boardHeightMm - margin - h
      break
  }

  const loops: VectorLoop[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const segments = DIGIT_SEGMENTS[ch]
    if (!segments) continue
    const digitX = blockX + i * (w + gap)
    for (const seg of segments) {
      const loop = buildSegmentPolygon(seg, digitX, blockY, w, h, t)
      if (loop) loops.push(loop)
    }
  }

  return loops
}

export function applyNumberingToArtwork(
  artwork: ProcessedArtwork,
  settings: BaseplateSettings,
  numbering: NumberingSettings,
  number: number,
  strokeOptions?: LineartStrokeMaskOptions,
): ProcessedArtwork {
  if (!numbering.enabled) return artwork
  const numberLoops = buildNumberLoops(
    number,
    artwork.boardWidthMm,
    artwork.boardHeightMm,
    numbering,
  )
  if (!numberLoops.length) return artwork
  return rebuildArtworkWithLineLoops(
    artwork,
    [...artwork.lineLoops, ...numberLoops],
    settings,
    strokeOptions,
  )
}

export function applyLineartStrokeEdit(
  artwork: ProcessedArtwork,
  settings: BaseplateSettings,
  points: VectorPoint[],
  radiusMm: number,
  mode: 'brush' | 'eraser',
  strokeOptions?: LineartStrokeMaskOptions,
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

  return rebuildArtworkWithLineLoops(artwork, editedLoops, settings, strokeOptions)
}

export function layoutLineLoops(
  sourceLoops: VectorLoop[],
  settings: BaseplateSettings,
  srcBounds?: { width: number; height: number; minX: number; minY: number },
) {
  if (settings.template === 'outline') {
    const bounds = getLoopBounds(sourceLoops)
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

  const loopBounds = getLoopBounds(sourceLoops)
  // 如果提供了源画布尺寸（含空白边），按源画布尺寸作为"内容外接矩形"缩放+居中，
  // 保持源图的空白边比例（例如上方有 20% 空白，布局后仍保持 20%）。
  // 否则退回紧外接框（旧行为）。
  let contentBounds: { minX: number; minY: number; width: number; height: number }
  if (srcBounds && srcBounds.width > 0 && srcBounds.height > 0) {
    contentBounds = {
      minX: srcBounds.minX,
      minY: srcBounds.minY,
      width: srcBounds.width,
      height: srcBounds.height,
    }
  } else {
    contentBounds = loopBounds
  }

  const placement = settings.imagePlacement ?? 'fit'

  // 图片居中：保持原图比例，在不被裁剪、不超过画布（画板）的情况下最大化，居中显示。
  // 与"等比适应"的区别：忽略安全边距，直接以整个画板为边界。
  if (placement === 'center') {
    const centerScale = Math.min(
      boardWidthMm / Math.max(contentBounds.width, 0.001),
      boardHeightMm / Math.max(contentBounds.height, 0.001),
    )
    const centeredW = contentBounds.width * centerScale
    const centeredH = contentBounds.height * centerScale
    const offsetX = (boardWidthMm - centeredW) * 0.5 - contentBounds.minX * centerScale
    const offsetY = (boardHeightMm - centeredH) * 0.5 - contentBounds.minY * centerScale
    return {
      boardWidthMm,
      boardHeightMm,
      lineLoops: translateLoops(scaleLoops(sourceLoops, centerScale), offsetX, offsetY),
    }
  }

  // 图片缩放：非等比拉伸铺满安全边距内区域（比例可能变形）。
  if (placement === 'stretch') {
    const scaleX = safeWidth / Math.max(contentBounds.width, 0.001)
    const scaleY = safeHeight / Math.max(contentBounds.height, 0.001)
    const offsetX = (boardWidthMm - safeWidth) * 0.5 - contentBounds.minX * scaleX
    const offsetY = (boardHeightMm - safeHeight) * 0.5 - contentBounds.minY * scaleY
    const stretched = sourceLoops.map((loop) => ({
      ...loop,
      points: loop.points.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })),
    }))
    return {
      boardWidthMm,
      boardHeightMm,
      lineLoops: translateLoops(stretched, offsetX, offsetY),
    }
  }

  // 图片裁剪：从图片中间裁剪一块与安全区等比的最大区域，等比缩放铺满安全区（不变形）。
  if (placement === 'crop') {
    const targetAspect = safeWidth / Math.max(safeHeight, 0.001)
    let cropW = contentBounds.width
    let cropH = cropW / targetAspect
    if (cropH > contentBounds.height) {
      cropH = contentBounds.height
      cropW = cropH * targetAspect
    }
    cropW = Math.min(Math.max(cropW, 0.001), contentBounds.width)
    cropH = Math.min(Math.max(cropH, 0.001), contentBounds.height)
    const cropX = contentBounds.minX + (contentBounds.width - cropW) * 0.5
    const cropY = contentBounds.minY + (contentBounds.height - cropH) * 0.5
    const cropScale = safeWidth / cropW
    const offsetX = (boardWidthMm - safeWidth) * 0.5 - cropX * cropScale
    const offsetY = (boardHeightMm - safeHeight) * 0.5 - cropY * cropScale
    return {
      boardWidthMm,
      boardHeightMm,
      lineLoops: translateLoops(scaleLoops(sourceLoops, cropScale), offsetX, offsetY),
    }
  }

  const scale = Math.min(
    safeWidth / Math.max(contentBounds.width, 0.001),
    safeHeight / Math.max(contentBounds.height, 0.001),
  )

  const scaled = scaleLoops(sourceLoops, scale)
  const scaledContentW = contentBounds.width * scale
  const scaledContentH = contentBounds.height * scale
  const offsetX = (boardWidthMm - scaledContentW) * 0.5 - contentBounds.minX * scale
  const offsetY = (boardHeightMm - scaledContentH) * 0.5 - contentBounds.minY * scale
  const result = translateLoops(scaled, offsetX, offsetY)


  return {
    boardWidthMm,
    boardHeightMm,
    lineLoops: result,
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

/**
 * 以 loops 紧 bbox 中心为 X 轴镜像中心，对 canvasBounds 做同样映射，
 * 用于 mirrorLoopsHorizontally(source.loops) 后保持 srcBounds 与 loops 坐标一致。
 */
export function mirrorCanvasBoundsHorizontally(
  loops: VectorLoop[],
  canvasBounds: { minX: number; minY: number; width: number; height: number },
) {
  const bounds = getLoopBounds(loops) // 镜像前 loops（和 canvasBounds 匹配）的 bbox
  const centerX = bounds.minX + bounds.width * 0.5
  return {
    minY: canvasBounds.minY,
    height: canvasBounds.height,
    width: canvasBounds.width,
    minX: centerX * 2 - (canvasBounds.minX + canvasBounds.width),
  }
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
  let bridgedMask
  let slimmedEdges
  if (settings.protectFineDetail) {
    // 微细节保护：不做闭合/腐蚀等形态学操作，直接保留原始 mask。
    bridgedMask = targetMask.slice()
    slimmedEdges = bridgedMask
  } else {
    bridgedMask = getAdaptivePreservedMask(targetMask, width, height)
    slimmedEdges = getAdaptiveLineMask(bridgedMask, width, height)
  }
  // 等效 pixelsPerMm：内部画布最长边 → 最终 scale 到 DEFAULT_LINEART_MAX_MM(40mm)
  // 与 extrudeMaskToMesh 中的单位换算保持一致：半径 = mm * pixelsPerMm * 0.5
  const lineartPixelsPerMm = Math.max(width, height) / DEFAULT_LINEART_MAX_MM
  // 加粗描边：基于「原始线宽」叠加膨胀。
  // 基准 = bridgedMask（保留原图实际线粗的掩码，不做骨架细化），
  // expandStrokeMm=0 时直接输出基准 → 用户看到的就是原图粗细；
  // expandStrokeMm>0 时对 bridgedMask 做膨胀，再并入 slimmedEdges 保留细枝末节。
  const strokeRadius = Math.max(0, Math.round(settings.expandStrokeMm * lineartPixelsPerMm * 0.5))
  const widened = strokeRadius
    ? orMasks(dilateMask(bridgedMask, width, height, strokeRadius), slimmedEdges, width, height)
    : bridgedMask
  // 缩小描边（腐蚀）：按用户设定的完整半径腐蚀，不因为全局填充率回退。
  // 被整体吞掉或断裂的原始连通域由 rescueVanishedComponents 以原始像素救回，
  // 保证"拉满缩小描边也不出现线稿结构缺失"。最小线宽下限在 3D 导出阶段由
  // applyMinimumLineWidth 强制，此处 minLineWidthMm 视为 0（仅做不缺失救援）。
  const maxShrinkRadius = Math.max(0, Math.round(settings.shrinkStrokeMm * lineartPixelsPerMm * 0.5))
  let shrunk = widened
  const totalPx = Math.max(1, width * height)
  if (maxShrinkRadius > 0) {
    const eroded = erodeMask(widened, width, height, maxShrinkRadius)
    shrunk = rescueVanishedComponents(widened, eroded, width, height)
  }
  const fillRatio = getFilledPixelCount(shrunk) / totalPx
  const despeckleStrength = fillRatio < 0.12
    ? Math.round(settings.despeckle * 0.3)
    : fillRatio < 0.2
      ? Math.round(settings.despeckle * 0.55)
      : settings.despeckle
  let cleaned = despeckleStrength ? removeSmallComponents(shrunk, width, height, despeckleStrength) : shrunk
  // 最后兜底：如果 cleaned 已经完全空了但 widened 里还有东西，就回退到 widened（忽略本次 shrink）。
  if (getFilledPixelCount(cleaned) === 0 && getFilledPixelCount(widened) > 0) {
    cleaned = despeckleStrength ? removeSmallComponents(widened, width, height, despeckleStrength) : widened
  }

  // 基础平滑
  const baseSmoothingVal = settings.smoothing
  const rawLoops = traceMaskToLoops(cleaned, width, height)
    .filter((loop) => Math.abs(loopArea(loop.points)) >= 3)
  let loops = settings.bezierFitting
    ? smoothLoopsWithBezier(rawLoops, baseSmoothingVal, settings.bezierStrength)
    : smoothLoops(rawLoops, baseSmoothingVal)
  // 终极兜底：平滑后一个 loop 都没了，就用 widened 直接重新 trace，保证至少有线稿输出
  if (!loops.length) {
    const fallbackMask = widened
    const fallbackRawLoops = traceMaskToLoops(fallbackMask, width, height)
      .filter((loop) => Math.abs(loopArea(loop.points)) >= 3)
    loops = settings.bezierFitting
      ? smoothLoopsWithBezier(fallbackRawLoops, baseSmoothingVal, settings.bezierStrength)
      : smoothLoops(fallbackRawLoops, baseSmoothingVal)
  }
  const loopBounds = getLoopBounds(loops)
  const toMaxScale = DEFAULT_LINEART_MAX_MM / Math.max(loopBounds.width, loopBounds.height, 0.001)

  // 与 loops 同一套坐标变换（先 normalize（translate -minX, -minY），再 scale 到最长边 40mm），
  // 映射"完整源画布矩形（含空白边）"→ 供 layoutLineLoops 保持空白比例使用。
  // loops 是 traceMaskToLoops 在 width × height（processingScale 缩小后的画布）上追踪的，
  // 所以 canvas 的参考矩形就是 (0, 0, width, height)，与 loops 坐标完全对齐。
  const canvasRectNorm = {
    minX: 0 - loopBounds.minX,
    minY: 0 - loopBounds.minY,
    width,
    height,
  }
  const canvasBounds = {
    minX: canvasRectNorm.minX * toMaxScale,
    minY: canvasRectNorm.minY * toMaxScale,
    width: canvasRectNorm.width * toMaxScale,
    height: canvasRectNorm.height * toMaxScale,
  }

  const scaled = scaleLoopsToMaxDimension(normalizeLoops(loops), DEFAULT_LINEART_MAX_MM)

  return {
    kind: 'image' as const,
    width: sourceImage.width,
    height: sourceImage.height,
    loops: scaled,
    canvasBounds,
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

function subtractMask(baseMask: Uint8Array, cutMask: Uint8Array, width: number, height: number) {
  const output = new Uint8Array(baseMask.length)
  for (let i = 0; i < baseMask.length; i += 1) {
    output[i] = baseMask[i] && !cutMask[i] ? 1 : 0
  }
  void width
  void height
  return output
}

function buildSealStrokeLoops(
  baseLoops: VectorLoop[],
  strokeWidthMm: number,
  pixelsPerMm: number,
  paddingMm: number,
): VectorLoop[] {
  if (strokeWidthMm <= 0 || !baseLoops.length) return []

  const bounds = getLoopBounds(baseLoops)
  const width = Math.max(1, Math.ceil((bounds.width + paddingMm * 2) * pixelsPerMm))
  const height = Math.max(1, Math.ceil((bounds.height + paddingMm * 2) * pixelsPerMm))

  const baseMask = rasterizeLoopsToMask(baseLoops, bounds.width, bounds.height, pixelsPerMm, paddingMm)
  const eroded = erodeMask(baseMask.mask, baseMask.width, baseMask.height, Math.max(1, Math.round(strokeWidthMm * pixelsPerMm)))
  const strokeMask = subtractMask(baseMask.mask, eroded, baseMask.width, baseMask.height)

  const traced = traceMaskToLoops(strokeMask, baseMask.width, baseMask.height)
    .map((loop) => pixelsToMm(loop, pixelsPerMm, paddingMm))
    .filter((loop) => Math.abs(loopArea(loop.points)) >= 0.01)

  return smoothLoops(traced, 2)
}

function getSlimLineMask(mask: Uint8Array, width: number, height: number) {
  // Smart erosion that preserves fine lines (1-2px wide) while slimming thick structures.
  // A pixel is only eroded if it has ≥5 filled 8-neighbors — meaning it is interior
  // to a thick structure. Fine lines (1-2px) typically have only 2-4 filled neighbors
  // and survive this pass, avoiding the "erase all thin details" problem of 4-connectivity erosion.

  const eroded = mask.slice()
  const toRemove: number[] = []

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue

      let filledNeighbors = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            filledNeighbors += 1
          } else if (mask[ny * width + nx]) {
            filledNeighbors += 1
          }
        }
      }

      if (filledNeighbors >= 5) {
        toRemove.push(y * width + x)
      }
    }
  }

  if (!toRemove.length) return mask.slice()
  for (const idx of toRemove) {
    eroded[idx] = 0
  }
  return eroded
}

function getAdaptivePreservedMask(mask: Uint8Array, width: number, height: number) {
  const fillRatio = getFilledPixelCount(mask) / Math.max(1, width * height)

  if (fillRatio >= 0.18) {
    return mask.slice()
  }

  // Preserve fine lines before close operation:
  // The close (dilate→erode) can merge nearby parallel fine lines.
  // Extract fine structure (1-2px lines), apply close only to thicker areas,
  // then recombine to keep fine lines intact.
  const fineMask = extractFineStructures(mask, width, height)
  const thickMask = subtractMask(mask, fineMask, width, height)

  const closedThick = erodeMask(dilateMask(thickMask, width, height, 1), width, height, 1)
  const combined = orMasks(fineMask, closedThick, width, height)

  const retainedRatio = getFilledPixelCount(combined) / Math.max(1, getFilledPixelCount(mask))

  return retainedRatio >= 0.80 ? combined : mask.slice()
}

function getAdaptiveLineMask(mask: Uint8Array, width: number, height: number) {
  const fillRatio = getFilledPixelCount(mask) / Math.max(1, width * height)

  // Low coverage images are usually already line art; shrinking them drops major details.
  if (fillRatio < 0.15) {
    return mask.slice()
  }

  const slimmed = getSlimLineMask(mask, width, height)
  const retainedRatio = getFilledPixelCount(slimmed) / Math.max(1, getFilledPixelCount(mask))

  // With smart erosion that preserves fine lines, the retained ratio will be high.
  // Only fall back if the erosion was too aggressive (lost more than 40% of pixels).
  return retainedRatio >= 0.60 ? slimmed : mask.slice()
}

function extractFineStructures(mask: Uint8Array, width: number, height: number) {
  const fine = new Uint8Array(mask.length)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue

      let filled8 = 0
      let filled4 = 0
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) {
            filled8 += 1
            if (dx !== 0 && dy !== 0) filled4 += 1
          } else if (mask[ny * width + nx]) {
            filled8 += 1
            if (Math.abs(dx) + Math.abs(dy) === 1) filled4 += 1
          }
        }
      }

      // Fine structure: pixel has ≤3 filled 8-neighbors (1-2px wide lines)
      if (filled8 <= 3) {
        fine[y * width + x] = 1
      }
    }
  }

  return fine
}

function orMasks(a: Uint8Array, b: Uint8Array, width: number, height: number) {
  void width
  void height
  const output = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i += 1) {
    output[i] = a[i] || b[i] ? 1 : 0
  }
  return output
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
  if (smoothing <= 0) {
    return loops
      .map((loop) => ({
        ...loop,
        points: sanitizeLoop(loop.points),
      }))
      .filter((loop) => loop.points.length >= 3)
  }

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

/**
 * 带贝塞尔强度的平滑管线：
 * 在 smoothLoops 基础上，根据 bezierStrengthPercent（0-100）：
 * - 先执行基础平滑（smoothLoops）
 * - 对平滑后的轮廓，按强度线性增加一次「角点圆化 + 轻微简化」
 * 因为实际输出 SVG / 切片器使用的仍是闭合折线多边形，所以无法真正的 cubic bezier
 * 输出，而是用折线点密度模拟贝塞尔曲线平滑的观感。
 */
function smoothLoopsWithBezier(
  loops: VectorLoop[],
  smoothing: number,
  bezierStrengthPercent: number,
) {
  const baseSmoothed = smoothLoops(loops, smoothing)
  const strength = clamp(bezierStrengthPercent / 100, 0, 1)
  if (strength <= 0) return baseSmoothed

  // 贝塞尔强度控制：增加的额外平滑次数 + 额外简化容差
  const extraBlend = 0.1 + strength * 0.35
  const extraSimplifyTol = strength * 0.6
  const extraPruneTol = 0.1 + strength * 0.5

  return baseSmoothed
    .map((loop) => {
      const originalMetrics = measureLoopGeometry(loop.points)
      const shapeGuard = getLoopShapeGuard(originalMetrics)
      const isThinLineLoop = originalMetrics.minDimension <= 0.9 || originalMetrics.aspectRatio >= 5

      let points = loop.points
      // 再加一次强力环形平滑（模拟贝塞尔对硬拐角的软化）
      points = preserveLoopShape(
        points,
        smoothRing(points, extraBlend),
        originalMetrics,
        shapeGuard,
      )
      // 额外的折线简化（减少点数，效果更接近光滑曲线）
      if (extraSimplifyTol > 0) {
        points = preserveLoopShape(
          points,
          simplifyClosedLoop(points, isThinLineLoop ? extraSimplifyTol * 0.2 : extraSimplifyTol),
          originalMetrics,
          shapeGuard,
        )
      }
      // 额外的尖角修剪
      points = preserveLoopShape(
        points,
        pruneWrinkles(points, extraPruneTol),
        originalMetrics,
        shapeGuard,
      )
      points = sanitizeLoop(points)
      return { ...loop, points }
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

function buildLineMaskPngDataUrl(
  lineMask: PrintPreviewMask,
  lineColor: string,
): string | null {
  if (typeof document === 'undefined') {
    return null
  }
  const { mask, width, height } = lineMask
  if (width <= 0 || height <= 0 || mask.length < width * height) {
    return null
  }
  // 把 lineColor（任意 CSS 颜色字符串）解析成 RGBA，渲染到 canvas 上做带 alpha 的位图。
  // 这样 SVG 里以 <image href=...> 嵌入后，背景透明，可与底板颜色层叠加。
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const imageData = ctx.createImageData(width, height)
  const rgba = parseCssColor(lineColor)
  for (let i = 0; i < width * height; i += 1) {
    if (mask[i] === 1) {
      imageData.data[i * 4] = rgba.r
      imageData.data[i * 4 + 1] = rgba.g
      imageData.data[i * 4 + 2] = rgba.b
      imageData.data[i * 4 + 3] = 255
    } else {
      imageData.data[i * 4 + 3] = 0
    }
  }
  ctx.putImageData(imageData, 0, 0)
  return canvas.toDataURL('image/png')
}

/**
 * 把 data:image/png;base64,... 的 dataURL 解码成 PNG 字节，用于嵌入 3MF 缩略图。
 * Node 端（构建/测试）走 Buffer 路径，浏览器端走 atob/Uint8Array。
 */
function dataUrlToPngBytes(dataUrl: string | undefined | null): Uint8Array | null {
  if (!dataUrl || !dataUrl.startsWith('data:image/png;base64,')) return null
  const b64 = dataUrl.slice('data:image/png;base64,'.length)
  try {
    if (typeof Buffer !== 'undefined') {
      return new Uint8Array(Buffer.from(b64, 'base64'))
    }
    if (typeof atob === 'function') {
      const bin = atob(b64)
      const out = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
      return out
    }
  } catch {
    return null
  }
  return null
}

/**
 * 简单 CSS 颜色解析：支持 #rgb / #rrggbb / rgb()/rgba() / 颜色关键字（仅白/黑常用兜底）。
 * 仅用于把"线稿底色"贴到 canvas 上，不需要 hsl()/named colors 全集。
 */
function parseCssColor(input: string): { r: number; g: number; b: number; a: number } {
  const trimmed = input.trim()
  if (trimmed.startsWith('#')) {
    let hex = trimmed.slice(1)
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('')
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      return { r, g, b, a }
    }
  }
  const rgbMatch = trimmed.match(/^rgba?\s*\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([0-9.]+%?))?\s*\)$/i)
  if (rgbMatch) {
    return {
      r: clamp255(Number(rgbMatch[1])),
      g: clamp255(Number(rgbMatch[2])),
      b: clamp255(Number(rgbMatch[3])),
      a: rgbMatch[4] === undefined ? 1 : parseAlpha(rgbMatch[4]),
    }
  }
  // 兜底：默认黑色
  return { r: 0, g: 0, b: 0, a: 1 }
}

function clamp255(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(255, Math.round(n)))
}

function parseAlpha(raw: string): number {
  if (raw.endsWith('%')) return Math.max(0, Math.min(1, Number(raw.slice(0, -1)) / 100))
  return Math.max(0, Math.min(1, Number(raw)))
}

function buildPreviewAssets(
  lineMask: PrintPreviewMask | null,
  lineLoopsFallback: VectorLoop[],
  baseLoops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  settings: BaseplateSettings,
) {
  if (lineMask) {
    return {
      lineartDataUrl: buildPreviewSvgDataUrlWithMask(
        boardWidthMm,
        boardHeightMm,
        settings,
        lineMask,
        settings.lineColor,
      ),
      baseplateDataUrl: buildPreviewSvgDataUrlWithMask(
        boardWidthMm,
        boardHeightMm,
        settings,
        lineMask,
        settings.lineColor,
        { ghostOpacity: 0.22 },
      ),
      compositeDataUrl: buildPreviewSvgDataUrlWithMask(
        boardWidthMm,
        boardHeightMm,
        settings,
        lineMask,
        settings.lineColor,
        { showBaseplate: true, baseLoops },
      ),
    }
  }
  // 兜底：没有 mask（如编辑回调无 extrudeSettings 时）走旧矢量路径。
  return {
    lineartDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'lineart', fill: settings.lineColor, loops: lineLoopsFallback },
    ]),
    baseplateDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
      { id: 'lineart-ghost', fill: settings.lineColor, loops: lineLoopsFallback, opacity: 0.22 },
    ]),
    compositeDataUrl: buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [
      { id: 'baseplate', fill: settings.baseColor, loops: baseLoops },
      { id: 'lineart', fill: settings.lineColor, loops: lineLoopsFallback },
    ]),
  }
}

interface MaskSvgOptions {
  ghostOpacity?: number
  showBaseplate?: boolean
  baseLoops?: VectorLoop[]
}

function buildPreviewSvgDataUrlWithMask(
  boardWidthMm: number,
  boardHeightMm: number,
  settings: BaseplateSettings,
  lineMask: PrintPreviewMask,
  lineColor: string,
  options: MaskSvgOptions = {},
): string {
  const png = buildLineMaskPngDataUrl(lineMask, lineColor)
  if (!png) {
    return buildPreviewSvgDataUrl(boardWidthMm, boardHeightMm, [])
  }
  const { width: maskW, height: maskH, pixelsPerMm } = lineMask
  // SVG 画板尺寸用 mm，<image> 用 px（image 渲染单位由 SVG 自身决定），
  // 通过 width / height 属性以 mm 写出，使 1px PNG 像素 = 1/pixelsPerMm mm。
  // 即 mask 的横向宽度 = maskW / pixelsPerMm mm。
  const imgWidthMm = maskW / pixelsPerMm
  const imgHeightMm = maskH / pixelsPerMm
  const ghostOpacity = options.ghostOpacity
  const baseplateRect = `<rect id="baseplate" x="0" y="0" width="${formatNumber(boardWidthMm)}" height="${formatNumber(boardHeightMm)}" fill="${settings.baseColor}" />`
  const baseplatePath = options.baseLoops && options.baseLoops.length
    ? `<path id="baseplate-shape" d="${loopsToSvgPath(options.baseLoops)}" fill="${settings.baseColor}" />`
    : baseplateRect
  const lineImage = `<image id="lineart" href="${png}" x="0" y="0" width="${formatNumber(imgWidthMm)}mm" height="${formatNumber(imgHeightMm)}mm" preserveAspectRatio="none" />`
  const ghostImage = `<image id="lineart-ghost" href="${png}" x="0" y="0" width="${formatNumber(imgWidthMm)}mm" height="${formatNumber(imgHeightMm)}mm" preserveAspectRatio="none" opacity="${formatNumber(ghostOpacity ?? 0.22)}" />`

  let body = ''
  if (options.showBaseplate) {
    body += `  ${baseplatePath}\n`
    body += `  ${lineImage}\n`
  } else if (ghostOpacity !== undefined) {
    // baseplate 用浅色矩形 + 幽灵线条预览
    body += `  ${baseplateRect}\n`
    body += `  ${ghostImage}\n`
  } else {
    body += `  ${lineImage}\n`
  }

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${boardWidthMm}mm" height="${boardHeightMm}mm" viewBox="0 0 ${formatNumber(boardWidthMm)} ${formatNumber(boardHeightMm)}">`,
    body.trimEnd(),
    '</svg>',
  ].join('\n')
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`
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

/**
 * 线稿"打印等效"掩码统一管线：光栅化 →（可选）缩小描边腐蚀（含消失组件救援）→
 * （可选）加粗描边膨胀 → 最小线宽保底。
 *
 * 2026-08-28 抽取自 extrudeMaskToMesh：3MF 网格与 2D 预览位图（shapeLoopsForPrintPreview）
 * 必须走**完全相同**的掩码处理序列，否则当用户设置了加粗/缩小描边时，
 * 预览与 3MF 实际模型会出现肉眼可见的差异（此前预览漏掉了 expand/shrink 两个步骤，
 * 导致"缩小描边把 3MF 里的眼睛细节腐蚀没了，而预览却仍然清晰"——用户反馈与预览差得远）。
 *
 * 导出供测试直接验证管线行为（消失组件救援 / 最小线宽保底）。
 */
export function buildExportLineMask(
  loops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  pixelsPerMm: number,
  minimumLineWidthMm = 0,
  expandStrokeMm = 0,
  shrinkStrokeMm = 0,
): { mask: Uint8Array; width: number; height: number } {
  const raster = rasterizeLoopsToMask(loops, boardWidthMm, boardHeightMm, pixelsPerMm, 0)

  // 1. 缩小描边（腐蚀）——按用户设定的**完整** shrink 半径腐蚀，不再因全局填充率回退半径。
  //    设计意图（与 UI 文案一致）：缩小描边后若某线条宽度 < minimumLineWidthMm，则按
  //    minimumLineWidthMm 显示；绝不允许任何线稿结构（瞳孔、高光、细线、连续笔画）被
  //    腐蚀整体删除或掐断。
  //    做法：先以完整半径腐蚀，再做"消失/断裂组件救援"——凡是被整体吞掉、或在腐蚀中
  //    断裂成多段的原始连通域救回，最终由 applyMinimumLineWidth 把残留窄线保底到
  //    minimumLineWidthMm。这样即使拉满缩小描边，也只出现"缩小描边后的理想图像"，
  //    不会出现线稿缺失。
  let processedMask = raster.mask
  if (shrinkStrokeMm > 0) {
    const shrinkRadius = Math.max(0, Math.round(shrinkStrokeMm * pixelsPerMm * 0.5))
    if (shrinkRadius > 0) {
      const eroded = erodeMask(raster.mask, raster.width, raster.height, shrinkRadius)
      processedMask = rescueVanishedComponents(
        raster.mask,
        eroded,
        raster.width,
        raster.height,
      )
    }
  }

  // 2. 加粗描边（膨胀）
  if (expandStrokeMm > 0) {
    const expandRadius = Math.max(1, Math.round(expandStrokeMm * pixelsPerMm * 0.5))
    processedMask = dilateMask(processedMask, raster.width, raster.height, expandRadius)
  }

  // 3. 保证最小线宽——新版：基于 Chebyshev 距离变换做"选择性膨胀"，**已达标**的粗线
  //    (dist >= minRadius) 原样保留，**未达标**的细线才膨胀到 minimumLineWidthMm。
  //    旧版 `ceil((minWidth*pxPerMm - 1) * 0.5)` 是按"最坏 1px 输入"反推的全局膨胀，
  //    对所有线一律加粗 2px → 3px 输入变 5px (0.72mm)、5px 输入变 7px (1.01mm)。
  //    这正是用户反馈"预览 0.4mm / 切片要两条线 / 打印 > 1mm"的根因——粗线被无故加粗
  //    0.3-0.6mm，切片器要 2-3 道喷嘴才能覆盖，实测塑料宽度远超 mesh 宽度。
  const finalMask = applyMinimumLineWidth(
    processedMask,
    raster.width,
    raster.height,
    pixelsPerMm,
    minimumLineWidthMm,
  )
  return { mask: finalMask, width: raster.width, height: raster.height }
}

/**
 * 消失/断裂组件救援：腐蚀会把尺寸小于 2×腐蚀半径的连通域整个吞掉（瞳孔、高光、
 * 细小装饰线），也可能把一根连续笔画在细颈处掐断成多段——两者都是"线稿结构缺失"。
 *
 * 逐连通域判定每个原始组件在腐蚀结果里的命运：
 *   - 映射到恰好 1 个腐蚀子组件 → 存活且连续，直接保留腐蚀结果（即真正缩小后的形态）；
 *   - 映射到 0 个（整体消失）或 >1 个（被掐断）腐蚀子组件 → 需要救援。
 * 救援方式：把该原始组件的像素按 minimumLineWidthMm 宽度救回（minimumLineWidthMm=0
 * 时按原始像素救回），确保既不断裂也不消失；随后统一由 applyMinimumLineWidth 保底。
 *
 * 这样即使拉满缩小描边，也只出现"缩小描边后的理想图像"：
 *   宽度 > 最小线宽的线条正常缩小显示；宽度 < 最小线宽的按最小线宽显示，绝不缺失。
 */
function rescueVanishedComponents(
  originalMask: Uint8Array,
  erodedMask: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const originalLabels = labelSolidComponents(originalMask, width, height)
  const erodedLabels = labelSolidComponents(erodedMask, width, height)

  // 每个原始组件映射到哪些腐蚀后子组件（据此判断：消失 / 断裂 / 正常存活）
  const originalErodedSubs = new Map<number, Set<number>>()
  for (let index = 0; index < originalMask.length; index += 1) {
    const o = originalLabels[index]
    if (o === 0) continue
    const e = erodedLabels[index]
    let set = originalErodedSubs.get(o)
    if (!set) {
      set = new Set<number>()
      originalErodedSubs.set(o, set)
    }
    if (e !== 0) set.add(e)
  }

  // 需要救援的原始组件：腐蚀后完全消失（0 个子组件）或发生断裂（>1 个子组件）。
  const needRestore = new Set<number>()
  for (const [o, subs] of originalErodedSubs) {
    if (subs.size !== 1) needRestore.add(o)
  }

  const out = new Uint8Array(erodedMask)
  if (needRestore.size > 0) {
    for (let index = 0; index < originalMask.length; index += 1) {
      if (needRestore.has(originalLabels[index])) {
        out[index] = 1
      }
    }
  }

  // 只负责"救回消失/断裂的组件"，不做额外膨胀——最小线宽保底由调用方
  // （buildExportLineMask / 3D 预览路径）的 applyMinimumLineWidth 统一完成，
  // 避免双重保底把线条加粗过头。
  return out
}

/** 8 连通域标记，返回每个像素所属组件编号（0 = 背景），供消失组件救援使用。 */
function labelSolidComponents(mask: Uint8Array, width: number, height: number): Int32Array {
  const labels = new Int32Array(mask.length)
  let nextLabel = 0
  const stack: number[] = []

  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || labels[start] !== 0) continue
    nextLabel += 1
    labels[start] = nextLabel
    stack.length = 0
    stack.push(start)

    while (stack.length > 0) {
      const index = stack.pop() as number
      const x = index % width
      const y = (index - x) / width
      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const neighbor = ny * width + nx
          if (mask[neighbor] === 1 && labels[neighbor] === 0) {
            labels[neighbor] = nextLabel
            stack.push(neighbor)
          }
        }
      }
    }
  }
  return labels
}

function extrudeMaskToMesh(
  loops: VectorLoop[],
  boardWidthMm: number,
  boardHeightMm: number,
  pixelsPerMm: number,
  zStart: number,
  height: number,
  minimumLineWidthMm = 0,
  expandStrokeMm = 0,
  shrinkStrokeMm = 0,
): MeshData {
  const mesh: MeshData = {
    vertices: [],
    triangles: [],
  }

  if (height <= 0 || !loops.length) {
    return mesh
  }

  const raster = buildExportLineMask(
    loops,
    boardWidthMm,
    boardHeightMm,
    pixelsPerMm,
    minimumLineWidthMm,
    expandStrokeMm,
    shrinkStrokeMm,
  )
  const finalMask = raster.mask
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
    x >= 0 && y >= 0 && x < raster.width && y < raster.height ? finalMask[y * raster.width + x] === 1 : false
  )
  const z0 = zStart
  const z1 = zStart + height

  // 逐像素生成顶面和底面（与边墙的逐像素扫描对齐，确保水密）。
  // 不做矩形合并，因为合并后顶面/底面边界与逐像素边墙边界不匹配会产生开放边。
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (!isFilled(x, y)) {
        continue
      }
      const px0 = x * cellWidthMm
      const px1 = (x + 1) * cellWidthMm
      const py0 = y * cellWidthMm
      const py1 = (y + 1) * cellWidthMm
      // 顶面（朝 +Z）
      addQuad(
        [px0, py0, z1],
        [px1, py0, z1],
        [px1, py1, z1],
        [px0, py1, z1],
      )
      // 底面（朝 -Z，翻转缠绕方向）
      addQuad(
        [px0, py1, z0],
        [px1, py1, z0],
        [px1, py0, z0],
        [px0, py0, z0],
      )
    }
  }

  // 边墙逐像素生成（与顶面/底面的逐像素 quad 对齐，确保每条边被恰好 2 个三角形共享）
  // 上边墙（y 方向边界，当前像素填充且上方未填充）
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (isFilled(x, y) && !isFilled(x, y - 1)) {
        const px0 = x * cellWidthMm
        const px1 = (x + 1) * cellWidthMm
        const py0 = y * cellWidthMm
        addQuad([px0, py0, z0], [px1, py0, z0], [px1, py0, z1], [px0, py0, z1])
      }
    }
  }
  // 下边墙（当前像素填充且下方未填充）
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      if (isFilled(x, y) && !isFilled(x, y + 1)) {
        const px0 = x * cellWidthMm
        const px1 = (x + 1) * cellWidthMm
        const py1 = (y + 1) * cellWidthMm
        addQuad([px1, py1, z0], [px0, py1, z0], [px0, py1, z1], [px1, py1, z1])
      }
    }
  }
  // 左边墙（当前像素填充且左方未填充）
  for (let x = 0; x < raster.width; x += 1) {
    for (let y = 0; y < raster.height; y += 1) {
      if (isFilled(x, y) && !isFilled(x - 1, y)) {
        const px0 = x * cellWidthMm
        const py0 = y * cellWidthMm
        const py1 = (y + 1) * cellWidthMm
        addQuad([px0, py1, z0], [px0, py0, z0], [px0, py0, z1], [px0, py1, z1])
      }
    }
  }
  // 右边墙（当前像素填充且右方未填充）
  for (let x = 0; x < raster.width; x += 1) {
    for (let y = 0; y < raster.height; y += 1) {
      if (isFilled(x, y) && !isFilled(x + 1, y)) {
        const px1 = (x + 1) * cellWidthMm
        const py0 = y * cellWidthMm
        const py1 = (y + 1) * cellWidthMm
        addQuad([px1, py0, z0], [px1, py1, z0], [px1, py1, z1], [px1, py0, z1])
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

  // 目标最小线宽（像素）。一个前景像素 F 的"局部线宽" = 2*dist(F) - 1（Chebyshev），
  // 其中 dist(F) 是 F 到最近背景的 Chebyshev 步数。
  //   dist=1 的 1-px 细线 → 局部线宽 1px
  //   dist=2 的 3-px 区域 → 局部线宽 3px
  //   dist=3 的 5-px 区域 → 局部线宽 5px
  const minWidthPx = minimumLineWidthMm * pixelsPerMm

  // 关键：**仅在前景像素属于"细线连通域"时**才做膨胀。
  //
  // 旧版（`ceil((minWidth*pxPerMm - 1) * 0.5)` 全局膨胀 1px）的问题：
  //   任何线稿的边缘像素 dist=1（紧贴背景），全局膨胀一律把边缘往外推 1px。
  //   即使整条线已 5px 宽（dist=3），边缘仍被额外加粗 → 5px → 7px = 1.01mm。
  //   切片器为覆盖 1mm 网格线要 3 道喷嘴 = ~1.2mm 塑料 → 正是用户反馈
  //   "切片两条线、打印 > 1mm"的根因（粗线无故被加粗 0.3-0.6mm）。
  //
  // 修复：用 labelSolidComponents 找连通域；只要域内**任一像素**的
  // dist >= minDistThreshold = ceil((minWidthPx + 1) / 2)，整个域就视为粗线，
  // **完全跳过膨胀**——粗线一根都不动。
  // 只有"无达标中心"的细线域才被均匀膨胀到最小线宽：对整个域用同一个 dilateBy
  // = ceil((minWidthPx - domainThickness) / 2)，domainThickness = 2*maxDist - 1。
  // 这样细线（1-3 px）会被推到恰好过阈值的最近整数像素（不再连环 over-dilate），
  // 粗线（>= 阈值）原样保留。
  const minDistThreshold = Math.ceil((minWidthPx + 1) * 0.5)
  if (minDistThreshold <= 1) {
    return mask
  }

  const dist = chebyshevDistanceTransformBg(mask, width, height)
  const labels = labelSolidComponents(mask, width, height)

  // 每个连通域的最大 dist（域内"最粗"位置的线宽决定域是否达标）
  const domainInfo = new Map<number, { maxDist: number; dilateBy: number }>()
  for (let index = 0; index < mask.length; index += 1) {
    const label = labels[index]
    if (label === 0) continue
    const d = dist[index]
    const cur = domainInfo.get(label)
    if (!cur || d > cur.maxDist) {
      domainInfo.set(label, {
        maxDist: d,
        dilateBy: 0, // 稍后统一计算
      })
    }
  }

  // 计算每个细线域的统一膨胀半径
  for (const [label, info] of domainInfo) {
    if (info.maxDist >= minDistThreshold) {
      // 粗线域：不膨胀
      continue
    }
    const domainThickness = 2 * info.maxDist - 1  // 域的最粗位置的厚度
    const needed = minWidthPx - domainThickness
    info.dilateBy = Math.max(1, Math.ceil(needed * 0.5))  // 至少膨胀 1 以防 needed=0 边界
  }

  const out = new Uint8Array(mask)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (mask[index] === 0) continue
      const label = labels[index]
      const info = domainInfo.get(label)
      if (!info || info.dilateBy <= 0) continue
      // 细线域：对域内每个前景像素统一膨胀 dilateBy，使整条线变到 >= minWidthPx
      // 关键：同一个域用同一个 dilateBy，避免"边缘 dist=1 像素被推到 7px" 的连环膨胀
      const dilateBy = info.dilateBy
      for (let offsetY = -dilateBy; offsetY <= dilateBy; offsetY += 1) {
        const ny = y + offsetY
        if (ny < 0 || ny >= height) continue
        for (let offsetX = -dilateBy; offsetX <= dilateBy; offsetX += 1) {
          const nx = x + offsetX
          if (nx < 0 || nx >= width) continue
          out[ny * width + nx] = 1
        }
      }
    }
  }

  return out
}

/**
 * Chebyshev 距离变换（2-pass Chamfer）：对每个像素返回其到最近 0 像素的 Chebyshev
 * 距离。背景像素返回 0，前景像素返回 >= 1。
 *
 * 用于 `applyMinimumLineWidth` 识别"细"特征（dist 较小）和"粗"特征（dist 较大），
 * 配合"选择性膨胀"避免给已达标粗线加粗 0.3-0.6mm（用户反馈"预览 0.4mm / 切片
 * 两条线 / 打印 > 1mm" 的生成逻辑根因）。
 */
function chebyshevDistanceTransformBg(
  mask: Uint8Array,
  width: number,
  height: number,
): Int32Array {
  const size = mask.length
  const dist = new Int32Array(size)
  const INF = width + height  // 任何前景像素到边界的 Chebyshev 距离上界
  for (let i = 0; i < size; i += 1) {
    dist[i] = mask[i] === 0 ? 0 : INF
  }

  // 前向扫描：左上 → 右下
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x
      if (dist[index] === 0) continue
      let best = dist[index]
      if (x > 0) best = Math.min(best, dist[index - 1] + 1)
      if (y > 0) best = Math.min(best, dist[index - width] + 1)
      if (x > 0 && y > 0) best = Math.min(best, dist[index - width - 1] + 1)
      if (x < width - 1 && y > 0) best = Math.min(best, dist[index - width + 1] + 1)
      dist[index] = best
    }
  }

  // 反向扫描：右下 → 左上
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x
      if (dist[index] === 0) continue
      let best = dist[index]
      if (x < width - 1) best = Math.min(best, dist[index + 1] + 1)
      if (y < height - 1) best = Math.min(best, dist[index + width] + 1)
      if (x < width - 1 && y < height - 1) best = Math.min(best, dist[index + width + 1] + 1)
      if (x > 0 && y < height - 1) best = Math.min(best, dist[index + width - 1] + 1)
      dist[index] = best
    }
  }

  return dist
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
    `  <object id="${objectId}" name="${escapeXmlAttribute(name)}" p:UUID="${buildPseudoUuid(itemIndex + 1, 0, 0, 0, 0x61cb4c039d28)}" type="model">`,
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
  // Bambu Studio 多盘布局采用 2 列网格，坐标在所有盘之间共享：
  //   Plate 1 (0,0)    Plate 2 (+stepX, 0)
  //   Plate 3 (0,-stepY) Plate 4 (+stepX,-stepY)
  // X 向右递增；Y 向下递减（向下为负方向）。
  // 详见 Bambu Studio 3MF 文件格式研究：盘间偏移约为 bed 尺寸 + 间距。
  const spacing = Math.max(printBedSettings.spacingMm, 8)
  const stepX = printBedSettings.widthMm + spacing * 6
  const stepY = printBedSettings.depthMm + spacing * 6
  const column = plateIndex % 2
  const row = Math.floor(plateIndex / 2)

  return {
    xMm: column * stepX,
    yMm: -row * stepY,
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
  const chunkSize = 0x8000
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    chunks.push(String.fromCharCode(...chunk))
  }
  return btoa(chunks.join(''))
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
