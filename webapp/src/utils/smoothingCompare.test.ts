import { describe, expect, it, beforeAll, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { JSDOM } from 'jsdom'

// 大图管线单次跑 30~60s；本对比测试跑 6 次，总耗时 2~3 分钟。
vi.setConfig({ testTimeout: 600_000, hookTimeout: 120_000 })

/**
 * 线稿平滑优化对比测试（2026-09-01）。
 *
 * 用用户提供的双角色图（黑色描边动漫线稿，已存 webapp/test-assets/testimg.png）验证：
 * 1. Chaikin 细分 + 子像素校正是否消除了像素台阶锯齿
 * 2. 不同 smoothing 值下的点数/平滑度变化趋势
 * 3. bezier 密度注入模式的效果
 *
 * ⚠️ **默认跳过**（2026-09-01）：这是调优期的比对手册，不是回归测试。
 * - 单次运行 6~7 分钟（大图完整管线 ×6），会把日常 `npm test` 从 30s 拖到 7min+
 * - 需要重新对比时：把 `it.skip` 改回 `it`，再执行
 *   `npx vitest run src/utils/smoothingCompare.test.ts`
 * 输出 SVG 到 .debug/smoothing-compare-output/ 供肉眼对比。
 */

// ---- 类型：全部直接从 generator 导入真实定义 ----
// ⚠️ 2026-09-01 修正：此前此处手抄了一份类型定义，BaseplateSettings 新增
// rectangleSizeMode / rectangleScalePercent 后手抄版本过时，导致 `npm run build`
// 的 tsc -b 报 TS2322 中断构建（vitest 用 esbuild 不做类型检查所以测试仍绿）。
// 手抄类型是"必然漂移"的反模式——改为 import type，类型随定义自动同步。
import type {
  VectorLoop,
  LineartSettings,
  BaseplateSettings,
  ExtrudeSettings,
  SourceImage,
} from '../types/generator'

// 2026-09-01：测试图已挪到 webapp/test-assets/（根目录去重后仅存一份，与 _testimg.png 同源）
const TEST_IMAGE_PATH = path.resolve(__dirname, '../../test-assets/testimg.png')
// 调试产物输出到 gitignore 的 .debug/ 目录，不再污染 src/
const OUTPUT_DIR = path.resolve(__dirname, '../../.debug/smoothing-compare-output')

let processArtwork: typeof import('../utils/generator').processArtwork

// node-canvas 提供真正的 Image 解码（jsdom 默认 Canvas 不解码 raster）
let canvasPkg: typeof import('canvas') | null = null

const defaultLineartSettings: LineartSettings = {
  detail: 50,
  threshold: 30,
  thresholdAuto: false,
  targetColor: '#000000',
  despeckle: 4,
  expandStrokeMm: 0,
  shrinkStrokeMm: 0,
  smoothing: 10,
  invert: false,
  mirror: false,
  autoOptimize: false,
  protectFineDetail: false,
  uploadPreprocess: false,
  bezierFitting: false,
  bezierStrength: 50,
}

const rectangleSettings: BaseplateSettings = {
  template: 'rectangle',
  widthMm: 150,
  heightMm: 100,
  rectangleSizeMode: 'manual',
  rectangleScalePercent: 100,
  diameterMm: 80,
  marginMm: 2,
  baseColor: '#ffffff',
  lineColor: '#000000',
  expandMm: 0,
  imagePlacement: 'fit',
}

const extrudeSettings: ExtrudeSettings = {
  baseThicknessMm: 1.0,
  lineHeightMm: 0.4,
  lineThicknessMm: 0.8,
  minLineWidthMm: 0.24,
}

function loopStats(loops: VectorLoop[]): {
  totalPoints: number
  totalLoops: number
  avgPointsPerLoop: number
  avgSegmentLength: number
  maxSegmentLength: number
  minSegmentLength: number
  directionChanges: number // 方向突变次数（近似锯齿指标）
} {
  let totalPoints = 0
  let totalSegments = 0
  let sumSegLen = 0
  let maxSeg = 0
  let minSeg = Infinity
  let dirChanges = 0

  for (const loop of loops) {
    const pts = loop.points
    totalPoints += pts.length
    for (let i = 0; i < pts.length; i += 1) {
      const a = pts[i]
      const b = pts[(i + 1) % pts.length]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const len = Math.sqrt(dx * dx + dy * dy)
      if (len > 0) {
        totalSegments += 1
        sumSegLen += len
        maxSeg = Math.max(maxSeg, len)
        minSeg = Math.min(minSeg, len)
      }
      // 检测方向突变：当前段与前一段的夹角 > 45°
      if (i > 0) {
        const prev = pts[i - 1]
        const pdx = a.x - prev.x
        const pdy = a.y - prev.y
        const prevLen = Math.sqrt(pdx * pdx + pdy * pdy)
        if (prevLen > 0 && len > 0) {
          const dot = (pdx * dx + pdy * dy) / (prevLen * len)
          if (dot < 0.707) dirChanges += 1 // cos(45°) ≈ 0.707
        }
      }
    }
  }

  return {
    totalPoints,
    totalLoops: loops.length,
    avgPointsPerLoop: totalPoints / Math.max(loops.length, 1),
    avgSegmentLength: sumSegLen / Math.max(totalSegments, 1),
    maxSegmentLength: maxSeg,
    minSegmentLength: minSeg === Infinity ? 0 : minSeg,
    directionChanges: dirChanges,
  }
}

beforeAll(async () => {
  // 用 node-canvas 提供真正的 Image/Canvas（jsdom 默认不解码 raster 图像）
  canvasPkg = await import('canvas')
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    pretendToBeVisual: true,
    Canvas: canvasPkg.createCanvas,
    Image: canvasPkg.Image,
  })
  ;(globalThis as unknown as Record<string, unknown>).window = dom.window
  ;(globalThis as unknown as Record<string, unknown>).document = dom.window.document
  ;(globalThis as unknown as Record<string, unknown>).Image = canvasPkg.Image
  ;(globalThis as unknown as Record<string, unknown>).navigator = dom.window.navigator
  ;(globalThis as unknown as Record<string, unknown>).HTMLElement = dom.window.HTMLElement
  ;(globalThis as unknown as Record<string, unknown>).HTMLCanvasElement = dom.window.HTMLCanvasElement
  ;(globalThis as unknown as Record<string, unknown>).CanvasRenderingContext2D = canvasPkg.CanvasRenderingContext2D

  // 动态导入（vitest ESM 模式下需要）
  const mod = await import('../utils/generator')
  processArtwork = mod.processArtwork

  await fs.mkdir(OUTPUT_DIR, { recursive: true })
})

async function loadImageAsSource(imagePath: string): Promise<SourceImage> {
  const buf = await fs.readFile(imagePath)
  const b64 = buf.toString('base64')
  const ext = imagePath.toLowerCase().endsWith('.png') ? 'png' : 'jpeg'
  const dataUrl = `data:image/${ext};base64,${b64}`

  // 用 node-canvas 的 Image 加载获取真实尺寸
  if (!canvasPkg) throw new Error('canvas not initialized')
  return new Promise<SourceImage>((resolve, reject) => {
    const img = new canvasPkg.Image()
    img.onload = () => {
      resolve({
        name: path.basename(imagePath),
        width: img.naturalWidth || img.width,
        height: img.naturalHeight || img.height,
        dataUrl,
      })
    }
    img.onerror = (err) => reject(err)
    img.src = dataUrl
  })
}

describe('smoothing optimization comparison', () => {
  let sourceImage: SourceImage

  beforeAll(async () => {
    // 测试图缺失时优雅跳过（克隆仓库 / 精简测试资产后仍可跑其余测试）
    const exists = await fs.access(TEST_IMAGE_PATH).then(() => true).catch(() => false)
    if (!exists) {
      console.warn(`[skip] 测试图不存在：${TEST_IMAGE_PATH}`)
      sourceImage = { name: 'missing.png', width: 1, height: 1, dataUrl: '' }
      return
    }
    sourceImage = await loadImageAsSource(TEST_IMAGE_PATH)
  }, 60000)

  async function runAndDump(
    label: string,
    settings: Partial<LineartSettings>,
  ): Promise<{ artwork: Awaited<ReturnType<typeof processArtwork>>; stats: ReturnType<typeof loopStats> }> {
    const merged: LineartSettings = { ...defaultLineartSettings, ...settings }
    const artwork = await processArtwork({
      sourceImage,
      importedLineart: null,
      lineartSettings: merged,
      baseplateSettings: rectangleSettings,
      extrudeSettings,
    })

    const stats = loopStats(artwork.lineLoops)

    // 导出 SVG 供肉眼对比
    const svgPath = path.join(OUTPUT_DIR, `${label.replace(/\s+/g, '-')}.svg`)
    const svgContent = buildCompareSvg(artwork, label, stats)
    await fs.writeFile(svgPath, svgContent)

    // 也导出 composite preview PNG
    if (artwork.previews.compositeDataUrl) {
      const b64 = artwork.previews.compositeDataUrl.split(',')[1]
      if (b64) {
        await fs.writeFile(
          path.join(OUTPUT_DIR, `${label.replace(/\s+/g, '-')}-preview.png`),
          Buffer.from(b64, 'base64'),
        )
      }
    }

    return { artwork, stats }
  }

  it.skip('compares smoothing=10 vs 50 vs 100 (no bezier)', async () => {
    console.log('\n=== Smoothing Comparison (No Bezier) ===\n')

    const s10 = await runAndDump('smooth-10', { smoothing: 10 })
    const s50 = await runAndDump('smooth-50', { smoothing: 50 })
    const s100 = await runAndDump('smooth-100', { smoothing: 100 })

    console.log(`smoothing=10:  ${s10.stats.totalLoops} loops, ${s10.stats.totalPoints} pts, avgSeg=${s10.stats.avgSegmentLength.toFixed(3)}mm, dirChanges=${s10.stats.directionChanges}`)
    console.log(`smoothing=50:  ${s50.stats.totalLoops} loops, ${s50.stats.totalPoints} pts, avgSeg=${s50.stats.avgSegmentLength.toFixed(3)}mm, dirChanges=${s50.stats.directionChanges}`)
    console.log(`smoothing=100: ${s100.stats.totalLoops} loops, ${s100.stats.totalPoints} pts, avgSeg=${s100.stats.avgSegmentLength.toFixed(3)}mm, dirChanges=${s100.stats.directionChanges}`)

    // 验证基本不变量
    expect(s10.artwork.lineLoops.length).toBeGreaterThan(0)
    expect(s50.artwork.lineLoops.length).toBeGreaterThan(0)
    expect(s100.artwork.lineLoops.length).toBeGreaterThan(0)

    // 更高 smoothing 应该有更少的方向突变（更平滑）
    expect(s100.stats.directionChanges).toBeLessThanOrEqual(s10.stats.directionChanges * 1.5)

    console.log(`\nSVG outputs written to: ${OUTPUT_DIR}`)
  })

  it.skip('compares bezier off vs bezier on (strength=70)', async () => {
    console.log('\n=== Bezier Mode Comparison (smoothing=50) ===\n')

    const noBezier = await runAndDump('bezier-off-smooth50', {
      smoothing: 50,
      bezierFitting: false,
    })
    const withBezier = await runAndDump('bezier-on-70-smooth50', {
      smoothing: 50,
      bezierFitting: true,
      bezierStrength: 70,
    })

    console.log(`bezier=off:   ${noBezier.stats.totalPoints} pts, avgSeg=${noBezier.stats.avgSegmentLength.toFixed(3)}mm`)
    console.log(`bezier=70:    ${withBezier.stats.totalPoints} pts, avgSeg=${withBezier.stats.avgSegmentLength.toFixed(3)}mm`)

    // bezier 模式应该产生更多点（密度注入）但不应丢失太多 loops（±1 容差）
    expect(Math.abs(withBezier.artwork.lineLoops.length - noBezier.artwork.lineLoops.length)).toBeLessThanOrEqual(1)
    // 点数应明显增加（曲线段被细分采样）
    expect(withBezier.stats.totalPoints).toBeGreaterThan(noBezier.stats.totalPoints)
  })
})

function buildCompareSvg(
  artwork: Awaited<ReturnType<typeof processArtwork>>,
  title: string,
  stats: ReturnType<typeof loopStats>,
): string {
  const { lineLoops, boardWidthMm, boardHeightMm } = artwork

  const paths = lineLoops.map((loop) => {
    const d = loop.points
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(4)} ${p.y.toFixed(4)}`)
      .join(' ')
    return loop.closed ? `${d} Z` : d
  }).join(' ')

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg"`,
    ` width="${boardWidthMm}mm" height="${boardHeightMm}mm"`,
    ` viewBox="0 0 ${boardWidthMm} ${boardHeightMm}">`,
    `<title>${title}</title>`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<g fill="none" stroke="#000" stroke-width="0.3" stroke-linejoin="round">`,
    `  <path d="${paths}" />`,
    `</g>`,
    `<text x="2" y="6" font-size="3" font-family="monospace" fill="#666">${title}</text>`,
    `<text x="2" y="10" font-size="2.5" font-family="monospace" fill="#999">`,
    `loops=${stats.totalLoops} pts=${stats.totalPoints} avgSeg=${stats.avgSegmentLength.toFixed(2)}mm dirChg=${stats.directionChanges}`,
    `</text>`,
    '</svg>',
  ].join('\n')
}
