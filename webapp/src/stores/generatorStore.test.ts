import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('useGeneratorStore persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.resetModules()
  })

  it('uses the updated default lineart settings', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(100)
    expect(useGeneratorStore.getState().lineartSettings.threshold).toBe(160)
    expect(useGeneratorStore.getState().lineartSettings.strokeWidth).toBe(0.4)
  })

  it('saves updated settings into localStorage', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    useGeneratorStore.getState().updateLineartSettings({
      detail: 88,
      threshold: 120,
      strokeWidth: 1.2,
    })

    const saved = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings') ?? '{}')

    expect(saved.lineartSettings.detail).toBe(88)
    expect(saved.lineartSettings.threshold).toBe(120)
    expect(saved.lineartSettings.strokeWidth).toBe(1.2)
  })

  it('loads saved settings on a fresh store import', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings', JSON.stringify({
      lineartSettings: {
        detail: 72,
        threshold: 90,
        strokeWidth: 2.4,
        targetColor: '#123456',
      },
      baseplateSettings: {
        template: 'rectangle',
        widthMm: 66,
      },
      extrudeSettings: {
        baseThicknessMm: 0.3,
      },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(72)
    expect(useGeneratorStore.getState().lineartSettings.threshold).toBe(90)
    expect(useGeneratorStore.getState().lineartSettings.strokeWidth).toBe(2.4)
    expect(useGeneratorStore.getState().lineartSettings.targetColor).toBe('#123456')
    expect(useGeneratorStore.getState().baseplateSettings.template).toBe('rectangle')
    expect(useGeneratorStore.getState().baseplateSettings.widthMm).toBe(66)
    expect(useGeneratorStore.getState().baseplateSettings.heightMm).toBe(50)
    expect(useGeneratorStore.getState().extrudeSettings.baseThicknessMm).toBe(0.3)
    expect(useGeneratorStore.getState().extrudeSettings.lineThicknessMm).toBe(0.2)
  })
})
