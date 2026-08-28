import { describe, expect, it } from 'vitest'
import type { BaseplateSettings, VectorLoop } from '@/types/generator'
import {
  layoutLineLoops,
  mirrorCanvasBoundsHorizontally,
  mirrorLoopsHorizontally,
} from '@/utils/generator'

/**
 * Using real values from the actual test image analysis:
 *   Source image 1685x934, processed to 1680x931.
 *   loopBounds approx (content bbox): minX=234 minY=44 w=1266 h=887
 *   toMaxScale = 40 / 1266 = 0.031595577
 * After normalizeLoops + scaleLoopsToMaxDimension(40):
 *   loops' bbox = (0,0) to (40, 28.09)
 * canvasBounds (same transformations applied to processing canvas rect 1680x931
 * with origin translation = -loopBounds.minX/Y):
 *   minX = (0-234) * 0.031596 = -7.3935
 *   minY = (0-44)  * 0.031596 = -1.3902
 *   w    = 1680 * 0.031596 = 53.081
 *   h    = 931  * 0.031596 = 29.416
 * This mirrors `buildImageLineart`'s computation.
 *
 * EXPECTED behavior with `srcBounds = canvasBounds` passed to layoutLineLoops:
 *   - The proportions of blank inside the SOURCE processing canvas should be
 *     preserved inside the safe area AFTER layout:
 *       left blank = 234/1680 = 13.93%
 *       right blank = (1680 - (234+1266)) / 1680 = 180/1680 = 10.71%
 *       top blank = 44/931 = 4.73%
 *       bot blank = (931 - (44+887)) / 931 = 0/931 = 0%
 *   - The CANVAS (content + preserved blank) is what's scaled to fit the safe
 *     rectangle (not the tight loop bbox).
 *   - Content is then placed proportionally inside CANVAS so these ratios hold
 *     relative to CANVAS edges (which are the safe-area edges after scaling).
 *
 * If srcBounds is NOT passed (old tight-bbox behavior), content would be
 * centered, wiping out the left-heavy blank (left and right inside-safe would
 * become roughly equal instead of 13.9%/10.7%).
 */

// Construct a synthetic normalized+scaled loop bbox rectangle matching the
// real-image analysis numbers, so we can test layoutLineLoops numerically.
const LOOP_W_MM = 1266 * (40 / 1266) // = 40
const LOOP_H_MM = 887 * (40 / 1266)  // = 28.088...
// After normalize: minX=0, minY=0
const contentLoop: VectorLoop = {
  closed: true,
  points: [
    { x: 0, y: 0 },
    { x: LOOP_W_MM, y: 0 },
    { x: LOOP_W_MM, y: LOOP_H_MM },
    { x: 0, y: LOOP_H_MM },
  ],
}
// normalize+scale already applied, equivalent to `scaled` returned by buildImageLineart
const sourceLoops: VectorLoop[] = [contentLoop]

const canvasBounds = {
  minX: (0 - 234) * (40 / 1266),
  minY: (0 - 44)  * (40 / 1266),
  width:  1680 * (40 / 1266),
  height: 931  * (40 / 1266),
}

const rectSettings: BaseplateSettings = {
  template: 'rectangle',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
  rectangleSizeMode: 'manual',
  rectangleScalePercent: 100,
  diameterMm: 50,
  marginMm: 4,
  imagePlacement: 'fit',
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

describe('canvasBounds (空白边保留) for real test image', () => {
  it('preserves asymmetrical source blank proportions inside safe area', () => {
    const layout = layoutLineLoops(sourceLoops, rectSettings, canvasBounds)
    const pts = layout.lineLoops[0].points
    const xs = pts.map(p => p.x)
    const ys = pts.map(p => p.y)
    const L = Math.min(...xs), R = Math.max(...xs)
    const T = Math.min(...ys), B = Math.max(...ys)

    const margin = rectSettings.marginMm! + 0.6 // code internal
    const safeL = margin, safeR = rectSettings.widthMm! - margin
    const safeT = margin, safeB = rectSettings.heightMm! - margin
    const safeW = safeR - safeL
    const safeH = safeB - safeT

    const insideL = L - safeL
    const insideR = safeR - R
    const insideT = T - safeT
    const insideB = safeB - B

    // Scaled canvas size (as placed inside safe area)
    // CANVAS aspect ~1680/931 ≈ 1.8045, safe is square (40.8x40.8) → horizontally constrained.
    // So canvas placed width = safeW. Then canvas is centered in the safe area, which
    // creates extra letterbox blank on top/bottom (or L/R if vertically constrained).
    // Inside-safe blank = letterbox margin + proportional inside-canvas blank.
    const canvasAspect = 1680 / 931
    const canvasPlacedW = safeW // horizontal constraint
    const canvasPlacedH = canvasPlacedW / canvasAspect
    const letterboxL = 0 // horizontally constrained → no L/R letterbox
    const letterboxR = 0
    const letterboxT = (safeH - canvasPlacedH) * 0.5 // safe 区垂直居中：上下各留一半
    const letterboxB = (safeH - canvasPlacedH) * 0.5

    const expectedInsideL = letterboxL + (234 / 1680) * canvasPlacedW
    const expectedInsideR = letterboxR + (180 / 1680) * canvasPlacedW
    const expectedInsideT = letterboxT + (44  / 931)  * canvasPlacedH
    const expectedInsideB = letterboxB + ( 0  / 931)  * canvasPlacedH

    // Tolerance: 1 decimal digit (~0.1mm), allows for float rounding in code
    expect(insideL).toBeCloseTo(expectedInsideL, 1)
    expect(insideR).toBeCloseTo(expectedInsideR, 1)
    expect(insideT).toBeCloseTo(expectedInsideT, 1)
    expect(insideB).toBeCloseTo(expectedInsideB, 1)

    // Print human readable diagnostics on failure (values are in assertion name above)
    console.log('[test] placed:', { L, R, T, B })
    console.log('[test] safe:', { safeL, safeR, safeT, safeB, safeW, safeH })
    console.log('[test] inside-safe blanks actual:', { insideL, insideR, insideT, insideB })
    console.log('[test] inside-safe expected:', { expectedInsideL, expectedInsideR, expectedInsideT, expectedInsideB, canvasPlacedW, canvasPlacedH })
  })

  it('mirrorCanvasBoundsHorizontally flips left/right blank proportions correctly', () => {
    // mirrorLoopsHorizontally around loops own center
    const mirrored = mirrorLoopsHorizontally(sourceLoops)
    const flippedBounds = mirrorCanvasBoundsHorizontally(sourceLoops, canvasBounds)

    // Run layout on mirrored loops + flipped srcBounds
    const layout = layoutLineLoops(mirrored, rectSettings, flippedBounds)
    const pts = layout.lineLoops[0].points
    const L = Math.min(...pts.map(p => p.x))
    const R = Math.max(...pts.map(p => p.x))
    const T = Math.min(...pts.map(p => p.y))
    const B = Math.max(...pts.map(p => p.y))

    const margin = rectSettings.marginMm! + 0.6
    const safeL = margin, safeR = rectSettings.widthMm! - margin
    const safeT = margin, safeB = rectSettings.heightMm! - margin
    const insideL = L - safeL
    const insideR = safeR - R
    const insideT = T - safeT
    const insideB = safeB - B

    // After mirror: inside-canvas left/right blank ratios SWAPPED. Top/bottom unchanged.
    // Canvas still horizontally constrained → letterbox only on T/B.
    const canvasAspect2 = 1680 / 931
    const canvasW2 = safeR - safeL   // same safeW, horizontal constraint
    const canvasH2 = canvasW2 / canvasAspect2
    const lbL2 = 0, lbR2 = 0
    const lbT2 = (safeB - safeT - canvasH2) * 0.5
    const lbB2 = (safeB - safeT - canvasH2) * 0.5

    const swappedInsideL = lbL2 + (180 / 1680) * canvasW2 // was right blank, now left (inside canvas)
    const swappedInsideR = lbR2 + (234 / 1680) * canvasW2 // was left blank, now right (inside canvas)
    const swappedInsideT = lbT2 + (44  / 931)  * canvasH2 // unchanged inside-canvas top + letterbox T
    const swappedInsideB = lbB2 + ( 0  / 931)  * canvasH2 // unchanged inside-canvas bottom + letterbox B

    expect(insideL).toBeCloseTo(swappedInsideL, 1)
    expect(insideR).toBeCloseTo(swappedInsideR, 1)
    expect(insideT).toBeCloseTo(swappedInsideT, 1)
    expect(insideB).toBeCloseTo(swappedInsideB, 1)

    console.log('[mirror test] inside-safe actual:', { insideL, insideR, insideT, insideB })
    console.log('[mirror test] inside-safe swapped expected:', { swappedInsideL, swappedInsideR, swappedInsideT, swappedInsideB })
  })
})
