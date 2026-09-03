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
    expect(useGeneratorStore.getState().lineartSettings.smoothing).toBe(10)
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

    const saved = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings-filigree') ?? '{}')

    expect(saved.lineartSettings.detail).toBe(88)
    expect(saved.lineartSettings.threshold).toBe(120)
    expect(saved.lineartSettings.expandStrokeMm).toBe(1.2)
  })

  it('loads saved settings on a fresh store import', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings-filigree', JSON.stringify({
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
    }))
    localStorage.setItem('lineart-baseplate-generator-settings-shared', JSON.stringify({
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

  it('keeps print bed settings per work mode instead of sharing them', async () => {
    const { useGeneratorStore } = await import('@/stores/generatorStore')

    // 掐丝模式把打印盘改成 300x300，间距 12
    useGeneratorStore.getState().updatePrintBedSettings({
      widthMm: 300,
      depthMm: 300,
      spacingMm: 12,
    })
    // 切到印章模式：打印盘回到该模式自己的默认值，不被掐丝模式污染
    useGeneratorStore.getState().setWorkMode('seal')
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(256)
    expect(useGeneratorStore.getState().printBedSettings.spacingMm).toBe(8)

    // 印章模式改成小盘
    useGeneratorStore.getState().updatePrintBedSettings({ widthMm: 180, depthMm: 180 })
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(180)

    // 切到光映浮雕：同样是独立默认值
    useGeneratorStore.getState().setWorkMode('light-relief')
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(256)

    // 切回掐丝：拿到的是掐丝自己那一份 300x300/12
    useGeneratorStore.getState().setWorkMode('filigree')
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(300)
    expect(useGeneratorStore.getState().printBedSettings.depthMm).toBe(300)
    expect(useGeneratorStore.getState().printBedSettings.spacingMm).toBe(12)

    // 3MF 输出配置仍然跨模式共享
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
    useGeneratorStore.getState().setWorkMode('seal')
    expect(useGeneratorStore.getState().customThreeMfProfile?.sourceName).toBe('custom.3mf')
    // 共享配置里不再夹带打印盘参数
    const savedShared = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings-shared') ?? '{}')
    expect('printBedSettings' in savedShared).toBe(false)
  })

  it('migrates legacy shared print bed settings into every mode snapshot', async () => {
    // schema v6：打印盘参数从 shared 下沉到各模式。
    // 老快照里打印盘只在 shared 里有一份，迁移后三个模式都要拿到它，且 shared 里删掉。
    localStorage.setItem('lineart-baseplate-generator-settings-shared', JSON.stringify({
      printBedSettings: { widthMm: 220, depthMm: 220, spacingMm: 10 },
      customThreeMfProfile: null,
    }))
    localStorage.setItem('lineart-baseplate-generator-settings-seal', JSON.stringify({
      sealSettings: { carvingMode: 'relief' },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(220)

    useGeneratorStore.getState().setWorkMode('seal')
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(220)
    expect(useGeneratorStore.getState().printBedSettings.spacingMm).toBe(10)

    useGeneratorStore.getState().setWorkMode('light-relief')
    expect(useGeneratorStore.getState().printBedSettings.widthMm).toBe(220)

    const savedShared = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings-shared') ?? '{}')
    expect('printBedSettings' in savedShared).toBe(false)
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

    const saved = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings-filigree') ?? '{}')
    expect(saved.lineartSettings.detail).toBe(64)
    expect(saved.baseplateSettings.widthMm).toBe(250)
    // 打印盘已经属于模式快照，不再写进 shared
    expect(saved.printBedSettings.depthMm).toBe(180)
    const savedShared = JSON.parse(localStorage.getItem('lineart-baseplate-generator-settings-shared') ?? '{}')
    expect('printBedSettings' in savedShared).toBe(false)
  })

  it('migrates legacy smoothing default (36) to the new default on load', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings-filigree', JSON.stringify({
      lineartSettings: { smoothing: 36 },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().lineartSettings.smoothing).toBe(10)
  })

  it('preserves an explicitly modified smoothing value through migration', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings-filigree', JSON.stringify({
      lineartSettings: { smoothing: 20 },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    expect(useGeneratorStore.getState().lineartSettings.smoothing).toBe(20)
  })

  it('strips the removed bFaceReverseStack flag from legacy light-relief snapshots', async () => {
    // schema v4：B 面「反向堆叠」开关已删除（该形态不可打印）。
    // 老快照里残留的死键必须被清掉，避免继续参与字段合并。
    localStorage.setItem('lineart-baseplate-generator-settings-light-relief', JSON.stringify({
      lightReliefSettings: { bFaceReverseStack: true, faceBHeightMm: 1.4 },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')

    const settings = useGeneratorStore.getState().lightReliefSettings as unknown as Record<string, unknown>
    expect('bFaceReverseStack' in settings).toBe(false)
    // 其余自定义值保留
    expect(settings.faceBHeightMm).toBe(1.4)
    const saved = JSON.parse(
      localStorage.getItem('lineart-baseplate-generator-settings-light-relief') ?? '{}',
    )
    expect('bFaceReverseStack' in saved.lightReliefSettings).toBe(false)
  })

  it('migrates legacy light-relief mirror default (false) to the new mirrored default', async () => {
    // schema v5：光映浮雕线稿默认水平镜像改为开启。
    // 旧快照 mirror:false 是旧默认值，视作"用户未修改"，删除后回落到新默认 true；
    // 其余显式修改过的字段（detail:80）必须保留。
    localStorage.setItem('lineart-baseplate-generator-settings-light-relief', JSON.stringify({
      lineartSettings: { mirror: false, detail: 80 },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')
    useGeneratorStore.getState().setWorkMode('light-relief')

    expect(useGeneratorStore.getState().lineartSettings.mirror).toBe(true)
    expect(useGeneratorStore.getState().lineartSettings.detail).toBe(80)
  })

  it('keeps an explicitly enabled light-relief mirror through migration', async () => {
    localStorage.setItem('lineart-baseplate-generator-settings-light-relief', JSON.stringify({
      lineartSettings: { mirror: true },
    }))

    const { useGeneratorStore } = await import('@/stores/generatorStore')
    useGeneratorStore.getState().setWorkMode('light-relief')

    expect(useGeneratorStore.getState().lineartSettings.mirror).toBe(true)
  })
})
