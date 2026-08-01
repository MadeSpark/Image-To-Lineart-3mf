import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import {
  buildThreeMfFilamentSequenceJson,
  buildThreeMfProjectSettingsConfig,
  createFallbackThreeMfTemplateProfile,
  parseThreeMfTemplateArchive,
  summarizeThreeMfTemplateProfile,
} from '@/utils/threeMfProfile'

describe('threeMfProfile utilities', () => {
  it('parses printable area and slicer metadata from a 3mf template', () => {
    const bytes = zipSync({
      'Metadata/project_settings.config': strToU8(JSON.stringify({
        printer_model: 'Bambu Lab A1',
        printer_variant: '0.4',
        printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
        print_settings_id: '0.20mm Standard @BBL A1',
        curr_bed_type: 'Textured PEI Plate',
        print_compatible_printers: ['Bambu Lab A1 0.4 nozzle'],
        filament_colour: ['#FFFFFF', '#000000', '#FF0000'],
        printable_area: ['0x0', '300x0', '300x180', '0x180'],
      })),
      'Metadata/slice_info.config': strToU8('<config><header /></config>'),
      'Metadata/filament_sequence.json': strToU8('{"plate_1":{"sequence":[]}}'),
      '3D/3dmodel.model': strToU8('<model><metadata name="Application">BambuStudio-02.07.01.62</metadata></model>'),
    }, { level: 0 })

    const profile = parseThreeMfTemplateArchive(bytes, 'custom.3mf')

    expect(profile.sourceName).toBe('custom.3mf')
    expect(profile.applicationName).toBe('BambuStudio-02.07.01.62')
    expect(profile.printBedWidthMm).toBe(300)
    expect(profile.printBedDepthMm).toBe(180)
    expect(profile.printerModel).toBe('Bambu Lab A1')
    expect(profile.printerSettingsId).toBe('Bambu Lab A1 0.4 nozzle')
    expect(profile.printSettingsId).toBe('0.20mm Standard @BBL A1')
    expect(profile.bedType).toBe('Textured PEI Plate')
    expect(profile.compatiblePrinters).toEqual(['Bambu Lab A1 0.4 nozzle'])
    expect(profile.filamentSlotCount).toBe(3)
  })

  it('writes colors and printable area back into project settings', () => {
    const profile = createFallbackThreeMfTemplateProfile()
    const projectSettings = JSON.parse(buildThreeMfProjectSettingsConfig(profile, {
      template: 'outline',
      expandMm: 2,
      widthMm: 50,
      heightMm: 50,
      rectangleSizeMode: 'ratio',
      rectangleScalePercent: 100,
      diameterMm: 50,
      marginMm: 4,
      lineColor: '#111111',
      baseColor: '#f3f6fb',
    }, {
      widthMm: 300,
      depthMm: 200,
      spacingMm: 8,
    }))

    expect(projectSettings.filament_colour[0]).toBe('#F3F6FB')
    expect(projectSettings.filament_colour[1]).toBe('#111111')
    expect(projectSettings.printable_area).toEqual(['0x0', '300x0', '300x200', '0x200'])
  })

  it('creates one empty filament sequence entry per plate', () => {
    const filamentSequence = JSON.parse(buildThreeMfFilamentSequenceJson(null, 3))

    expect(Object.keys(filamentSequence)).toEqual(['plate_1', 'plate_2', 'plate_3'])
  })

  it('summarizes imported 3mf settings for the user', () => {
    const summary = summarizeThreeMfTemplateProfile(createFallbackThreeMfTemplateProfile())

    expect(summary.some((line) => line.includes('打印机：Bambu Lab A1'))).toBe(true)
    expect(summary.some((line) => line.includes('打印盘尺寸：256 x 256 mm'))).toBe(true)
    expect(summary.some((line) => line.includes('耗材槽位：2'))).toBe(true)
  })
})
