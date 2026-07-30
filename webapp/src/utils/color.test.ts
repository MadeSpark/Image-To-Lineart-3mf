import { describe, expect, it } from 'vitest'
import { applyContrast, getBrightness, heatmapColor, hexToRgb, rgbToHex } from '@/utils/color'

describe('color utils', () => {
  it('supports hex and rgb round trip', () => {
    const rgb = hexToRgb('#7bb9e7')
    expect(rgb).toEqual({ r: 123, g: 185, b: 231 })
    expect(rgbToHex(rgb)).toBe('#7bb9e7')
  })

  it('keeps contrast output in safe range', () => {
    expect(applyContrast(0.2, 1.6)).toBeGreaterThanOrEqual(0)
    expect(applyContrast(0.8, 1.6)).toBeLessThanOrEqual(1)
  })

  it('returns brighter value for lighter colors', () => {
    expect(getBrightness(hexToRgb('#ffffff'))).toBeGreaterThan(getBrightness(hexToRgb('#000000')))
  })

  it('maps heat colors across the expected palette', () => {
    const cool = heatmapColor(0.05)
    const warm = heatmapColor(0.95)
    expect(cool.b).toBeGreaterThan(cool.r)
    expect(warm.r).toBeGreaterThanOrEqual(warm.g)
  })
})
