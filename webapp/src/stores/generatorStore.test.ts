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
    expect(useGeneratorStore.getState().lineartSettings.expandStrokeMm).toBe(0)
    expect(useGeneratorStore.getState().baseplateSettings.rectangleSizeMode).toBe('ratio')
    expect(useGeneratorStore.getState().baseplateSettings.rectangleScalePercent).toBe(100)
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(256)
    expect(useGeneratorStore.getState().printBedSettings.depthMm).toBe(256)
    expect(useGeneratorStore.getState().customThreeMfProfile).toBeNull()
  })

  it('saves updated settings into localStorage', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    useGeneratorStore.getState().updateLineartSettings({
      detail: 88,
      threshold: 120,
      expandStrokeMm: 1.2,
    })

    const saved = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings') ?? '{}')

    expect(saved.lineartSettings.detail).toBe(88)
    expect(saved.lineartSettings.threshold).toBe(120)
    expect(saved.lineartSettings.expandStrokeMm).toBe(1.2)
  })

  it('loads saved settings on a fresh store import', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings', JSON.stringify({
      lineartSettings: {
        detail: 72,
        threshold: 90,
        expandStrokeMm: 2.4,
        targetColor: '#123456',
      },
      baseplateSettings: {
        template: 'rectangle',
        widthMm: 66,
      },
      extrudeSettings: {
        baseThicknessMm: 0.3,
      },
      printBedSettings: {
        widthMm: 300,
        spacingMm: 12,
      },
      customThreeMfProfile: {
        sourceName: 'custom.3mf',
        applicationName: 'BambuStudio-02.07.01.62',
        projectSettings: {
          printer_model: 'Bambu Lab A1',
          printable_area: ['0x0', '300x0', '300x256', '0x256'],
        },
        sliceInfoConfig: '<config />',
        filamentSequenceJson: '{"plate_1":{"sequence":[]}}',
        printBedWidthMm: 300,
        printBedDepthMm: 256,
        printerModel: 'Bambu Lab A1',
        printerVariant: '0.4',
        printerSettingsId: 'Bambu Lab A1 0.4 nozzle',
        printSettingsId: '0.20mm Standard @BBL A1',
        bedType: 'Textured PEI Plate',
        compatiblePrinters: ['Bambu Lab A1 0.4 nozzle'],
        filamentSlotCount: 2,
        layerHeightMm: null,
        lineWidthMm: null,
      },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(72)
    expect(useGeneratorStore.getState().lineartSettings.threshold).toBe(90)
    expect(useGeneratorStore.getState().lineartSettings.expandStrokeMm).toBe(2.4)
    expect(useGeneratorStore.getState().lineartSettings.targetColor).toBe('#123456')
    expect(useGeneratorStore.getState().baseplateSettings.template).toBe('rectangle')
    expect(useGeneratorStore.getState().baseplateSettings.widthMm).toBe(66)
    expect(useGeneratorStore.getState().baseplateSettings.heightMm).toBe(50)
    expect(useGeneratorStore.getState().baseplateSettings.rectangleSizeMode).toBe('ratio')
    expect(useGeneratorStore.getState().baseplateSettings.rectangleScalePercent).toBe(100)
    expect(useGeneratorStore.getState().extrudeSettings.baseThicknessMm).toBe(0.3)
    expect(useGeneratorStore.getState().extrudeSettings.lineThicknessMm).toBe(0.2)
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(300)
    expect(useGeneratorStore.getState().printBedSettings.depthMm).toBe(256)
    expect(useGeneratorStore.getState().printBedSettings.spacingMm).toBe(12)
    expect(useGeneratorStore.getState().customThreeMfProfile?.sourceName).toBe('custom.3mf')
  })

  it('resets settings back to defaults and clears custom 3mf profile', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    useGeneratorStore.getState().setCustomThreeMfProfile({
      sourceName: 'custom.3mf',
      applicationName: 'BambuStudio-02.07.01.62',
      projectSettings: {},
      sliceInfoConfig: '<config />',
      filamentSequenceJson: null,
      printBedWidthMm: 300,
      printBedDepthMm: 256,
      printerModel: 'Bambu Lab A1',
      printerVariant: '0.4',
      printerSettingsId: 'Bambu Lab A1 0.4 nozzle',
      printSettingsId: '0.20mm Standard @BBL A1',
      bedType: 'Textured PEI Plate',
      compatiblePrinters: ['Bambu Lab A1 0.4 nozzle'],
      filamentSlotCount: 2,
      layerHeightMm: null,
      lineWidthMm: null,
    })
    useGeneratorStore.getState().updatePrintBedSettings({
      widthMm: 300,
      depthMm: 280,
    })

    useGeneratorStore.getState().resetAllSettings({
      widthMm: 256,
      depthMm: 256,
    })

    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(100)
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(256)
    expect(useGeneratorStore.getState().printBedSettings.depthMm).toBe(256)
    expect(useGeneratorStore.getState().customThreeMfProfile).toBeNull()
  })

  it('applies imported settings and persists them', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    useGeneratorStore.getState().applyImportedSettings({
      previewMode: '线稿',
      lineartSettings: {
        detail: 64,
        targetColor: '#0f0f0f',
      },
      baseplateSettings: {
        template: 'rectangle',
        widthMm: 250,
        heightMm: 140,
        rectangleSizeMode: 'manual',
        rectangleScalePercent: 80,
        marginMm: 0,
      },
      printBedSettings: {
        widthMm: 180,
        depthMm: 180,
      },
    })

    expect(useGeneratorStore.getState().previewMode).toBe('线稿')
    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(64)
    expect(useGeneratorStore.getState().lineartSettings.targetColor).toBe('#0f0f0f')
    expect(useGeneratorStore.getState().baseplateSettings.template).toBe('rectangle')
    expect(useGeneratorStore.getState().baseplateSettings.widthMm).toBe(250)
    expect(useGeneratorStore.getState().baseplateSettings.heightMm).toBe(140)
    expect(useGeneratorStore.getState().baseplateSettings.rectangleSizeMode).toBe('manual')
    expect(useGeneratorStore.getState().baseplateSettings.rectangleScalePercent).toBe(80)
    expect(useGeneratorStore.getState().baseplateSettings.marginMm).toBe(0)
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(180)
    expect(useGeneratorStore.getState().printBedSettings.depthMm).toBe(180)

    const saved = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings') ?? '{}')
    expect(saved.lineartSettings.detail).toBe(64)
    expect(saved.baseplateSettings.widthMm).toBe(250)
    expect(saved.printBedSettings.depthMm).toBe(180)
  })
})
