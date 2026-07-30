export interface RgbColor {
  r: number
  g: number
  b: number
}

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function hexToRgb(hex: string): RgbColor {
  const normalized = hex.replace('#', '')
  const safe = normalized.length === 3
    ? normalized.split('').map((part) => `${part}${part}`).join('')
    : normalized

  return {
    r: Number.parseInt(safe.slice(0, 2), 16),
    g: Number.parseInt(safe.slice(2, 4), 16),
    b: Number.parseInt(safe.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: RgbColor) {
  const toHex = (value: number) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

export function colorDistance(a: RgbColor, b: RgbColor) {
  const dr = a.r - b.r
  const dg = a.g - b.g
  const db = a.b - b.b
  return dr * dr + dg * dg + db * db
}

export function getBrightness(color: RgbColor) {
  return (0.299 * color.r + 0.587 * color.g + 0.114 * color.b) / 255
}

export function applyContrast(value: number, contrast: number) {
  return clamp((value - 0.5) * contrast + 0.5, 0, 1)
}

export function heatmapColor(value: number): RgbColor {
  const safe = clamp(value, 0, 1)
  const cool = hexToRgb('#7bb9e7')
  const mid = hexToRgb('#fff3ed')
  const hot = hexToRgb('#111111')

  if (safe < 0.5) {
    const t = safe / 0.5
    return {
      r: cool.r + (mid.r - cool.r) * t,
      g: cool.g + (mid.g - cool.g) * t,
      b: cool.b + (mid.b - cool.b) * t,
    }
  }

  const t = (safe - 0.5) / 0.5
  return {
    r: mid.r + (hot.r - mid.r) * t,
    g: mid.g + (hot.g - mid.g) * t,
    b: mid.b + (hot.b - mid.b) * t,
  }
}
