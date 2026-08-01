import { describe, expect, it } from 'vitest'
import { calculateRectangleRatioLayout } from '@/utils/baseplate'

describe('baseplate ratio sizing', () => {
  it('fits rectangle size to print bed while preserving aspect ratio', () => {
    const layout = calculateRectangleRatioLayout(140 / 250, 100, {
      widthMm: 256,
      depthMm: 256,
      spacingMm: 8,
    }, 4)

    expect(layout.widthMm).toBeCloseTo(138.9, 1)
    expect(layout.heightMm).toBeCloseTo(248, 1)
    expect(layout.fitsPrintBed).toBe(true)
  })

  it('marks oversized percentage as not fitting the print bed', () => {
    const layout = calculateRectangleRatioLayout(1, 140, {
      widthMm: 256,
      depthMm: 256,
      spacingMm: 8,
    }, 4)

    expect(layout.widthMm).toBeGreaterThan(layout.availableWidthMm)
    expect(layout.heightMm).toBeGreaterThan(layout.availableHeightMm)
    expect(layout.fitsPrintBed).toBe(false)
  })
})
