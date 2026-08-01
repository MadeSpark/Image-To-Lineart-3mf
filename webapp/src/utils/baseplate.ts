import type { PrintBedSettings } from '@/types/generator'

export interface RectangleRatioLayout {
  widthMm: number
  heightMm: number
  fitsPrintBed: boolean
  availableWidthMm: number
  availableHeightMm: number
  percent: number
}

function roundToTenth(value: number) {
  return Math.round(value * 10) / 10
}

export function calculateRectangleRatioLayout(
  aspectRatio: number,
  scalePercent: number,
  printBedSettings: PrintBedSettings,
  marginMm: number,
): RectangleRatioLayout {
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1
  const percent = Number.isFinite(scalePercent) ? scalePercent : 100
  const availableWidthMm = Math.max(10, printBedSettings.widthMm - marginMm * 2)
  const availableHeightMm = Math.max(10, printBedSettings.depthMm - marginMm * 2)
  const fitScale = Math.min(availableWidthMm / safeAspectRatio, availableHeightMm)
  const fitHeightMm = Math.max(1, fitScale)
  const fitWidthMm = Math.max(1, fitHeightMm * safeAspectRatio)
  const scale = Math.max(1, percent) / 100
  const widthMm = roundToTenth(fitWidthMm * scale)
  const heightMm = roundToTenth(fitHeightMm * scale)

  return {
    widthMm,
    heightMm,
    fitsPrintBed: widthMm <= availableWidthMm + 1e-6 && heightMm <= availableHeightMm + 1e-6,
    availableWidthMm,
    availableHeightMm,
    percent,
  }
}
