import { strFromU8, unzipSync } from 'fflate'
import type { BaseplateSettings, PrintBedSettings, ThreeMfTemplateProfile } from '@/types/generator'

const DEFAULT_TEMPLATE_URL = '/presets/default-print-profile.3mf'
const DEFAULT_TEMPLATE_NAME = '预设参数.3mf'
const FALLBACK_APPLICATION_NAME = 'BambuStudio-02.07.01.62'
const FALLBACK_SLICE_INFO = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<config>',
  '  <header>',
  '    <header_item key="X-BBL-Client-Type" value="slicer"/>',
  '    <header_item key="X-BBL-Client-Version" value="02.07.01.62"/>',
  '  </header>',
  '</config>',
].join('\n')

export async function loadDefaultThreeMfTemplateProfile() {
  const response = await fetch(DEFAULT_TEMPLATE_URL)
  if (!response.ok) {
    throw new Error('默认 3MF 打印模板加载失败')
  }

  return parseThreeMfTemplateArchive(new Uint8Array(await response.arrayBuffer()), DEFAULT_TEMPLATE_NAME)
}

export async function parseThreeMfTemplateFile(file: File) {
  return parseThreeMfTemplateArchive(new Uint8Array(await file.arrayBuffer()), file.name)
}

export function createFallbackThreeMfTemplateProfile(): ThreeMfTemplateProfile {
  return {
    sourceName: DEFAULT_TEMPLATE_NAME,
    applicationName: FALLBACK_APPLICATION_NAME,
    projectSettings: {
      printer_model: 'Bambu Lab A1',
      printer_variant: '0.4',
      printer_settings_id: 'Bambu Lab A1 0.4 nozzle',
      print_settings_id: '0.20mm Standard @BBL A1',
      print_compatible_printers: ['Bambu Lab A1 0.4 nozzle'],
      printable_area: ['0x0', '256x0', '256x256', '0x256'],
      printable_height: '256',
      curr_bed_type: 'Textured PEI Plate',
      filament_colour: ['#FFFFFF', '#161616'],
      filament_multi_colour: ['#FFFFFF', '#161616'],
      extruder_colour: ['#FFFFFF', '#161616'],
      filament_type: ['PLA', 'PLA'],
      filament_ids: ['LINEART_BASE_SLOT_1', 'LINEART_LINE_SLOT_2'],
      filament_settings_id: ['Generic PLA', 'Generic PLA'],
      filament_density: ['1.24', '1.24'],
      filament_diameter: ['1.75', '1.75'],
      flush_into_support: '1',
      print_sequence: 'by layer',
      support_filament: '0',
      support_interface_filament: '0',
      wall_filament: '0',
      sparse_infill_filament: '0',
      solid_infill_filament: '0',
    },
    sliceInfoConfig: FALLBACK_SLICE_INFO,
    filamentSequenceJson: JSON.stringify({
      plate_1: {
        nozzle_sequence: [],
        optimal_assignment: [],
        sequence: [],
      },
    }),
    printBedWidthMm: 256,
    printBedDepthMm: 256,
    printerModel: 'Bambu Lab A1',
    printerVariant: '0.4',
    printerSettingsId: 'Bambu Lab A1 0.4 nozzle',
    printSettingsId: '0.20mm Standard @BBL A1',
    bedType: 'Textured PEI Plate',
    compatiblePrinters: ['Bambu Lab A1 0.4 nozzle'],
    filamentSlotCount: 2,
  }
}

export function parseThreeMfTemplateArchive(bytes: Uint8Array, sourceName: string): ThreeMfTemplateProfile {
  const files = unzipSync(bytes)
  const projectSettings = parseProjectSettings(files['Metadata/project_settings.config'])
  const applicationName = extractApplicationName(files['3D/3dmodel.model'])
  const sliceInfoConfig = files['Metadata/slice_info.config']
    ? strFromU8(files['Metadata/slice_info.config'])
    : FALLBACK_SLICE_INFO
  const filamentSequenceJson = files['Metadata/filament_sequence.json']
    ? strFromU8(files['Metadata/filament_sequence.json'])
    : null
  const { widthMm, depthMm } = extractPrintableArea(projectSettings)

  return {
    sourceName,
    applicationName,
    projectSettings,
    sliceInfoConfig,
    filamentSequenceJson,
    printBedWidthMm: widthMm,
    printBedDepthMm: depthMm,
    printerModel: readString(projectSettings.printer_model, 'Bambu Lab A1'),
    printerVariant: readString(projectSettings.printer_variant, ''),
    printerSettingsId: readString(projectSettings.printer_settings_id, ''),
    printSettingsId: readString(projectSettings.print_settings_id, ''),
    bedType: readString(projectSettings.curr_bed_type, ''),
    compatiblePrinters: getStringArray(projectSettings.print_compatible_printers),
    filamentSlotCount: getMaxSlotCount(projectSettings),
  }
}

export function buildThreeMfProjectSettingsConfig(
  profile: ThreeMfTemplateProfile | null | undefined,
  baseplateSettings: BaseplateSettings,
  printBedSettings: PrintBedSettings,
) {
  const merged = JSON.parse(JSON.stringify(
    (profile ?? createFallbackThreeMfTemplateProfile()).projectSettings,
  )) as Record<string, unknown>
  const requiredSlots = Math.max(2, getMaxSlotCount(merged))
  const colorSlots = padStringArray(getStringArray(merged.filament_colour), requiredSlots, '#FFFFFF')
  colorSlots[0] = baseplateSettings.baseColor.toUpperCase()
  colorSlots[1] = baseplateSettings.lineColor.toUpperCase()
  merged.filament_colour = colorSlots
  merged.filament_multi_colour = [...colorSlots]
  merged.extruder_colour = [...colorSlots]
  merged.filament_type = padStringArray(getStringArray(merged.filament_type), requiredSlots, 'PLA')
  merged.filament_ids = padStringArray(getStringArray(merged.filament_ids), requiredSlots, 'LINEART_SLOT')
    .map((value, index) => value || `LINEART_SLOT_${index + 1}`)
  merged.filament_settings_id = padStringArray(getStringArray(merged.filament_settings_id), requiredSlots, 'Generic PLA')
  merged.filament_density = padStringArray(getStringArray(merged.filament_density), requiredSlots, '1.24')
  merged.filament_diameter = padStringArray(getStringArray(merged.filament_diameter), requiredSlots, '1.75')
  merged.printable_area = [
    '0x0',
    `${formatInteger(printBedSettings.widthMm)}x0`,
    `${formatInteger(printBedSettings.widthMm)}x${formatInteger(printBedSettings.depthMm)}`,
    `0x${formatInteger(printBedSettings.depthMm)}`,
  ]

  return JSON.stringify(merged, null, 2)
}

export function buildThreeMfSliceInfoConfig(profile: ThreeMfTemplateProfile | null | undefined) {
  return profile?.sliceInfoConfig || FALLBACK_SLICE_INFO
}

export function buildThreeMfFilamentSequenceJson(
  profile: ThreeMfTemplateProfile | null | undefined,
  plateCount: number,
) {
  const base = profile?.filamentSequenceJson
    ? safeParseJson(profile.filamentSequenceJson)
    : {}
  const output: Record<string, unknown> = {}

  for (let index = 1; index <= Math.max(1, plateCount); index += 1) {
    const key = `plate_${index}`
    output[key] = (typeof base[key] === 'object' && base[key] !== null)
      ? base[key]
      : {
        nozzle_sequence: [],
        optimal_assignment: [],
        sequence: [],
      }
  }

  return JSON.stringify(output)
}

export function summarizeThreeMfTemplateProfile(profile: ThreeMfTemplateProfile) {
  const summary: string[] = []

  summary.push(`打印机：${profile.printerModel}${profile.printerVariant ? ` (${profile.printerVariant} 喷嘴)` : ''}`)
  if (profile.printerSettingsId) {
    summary.push(`打印机配置：${profile.printerSettingsId}`)
  }
  if (profile.printSettingsId) {
    summary.push(`切片配置：${profile.printSettingsId}`)
  }
  summary.push(`打印盘尺寸：${formatInteger(profile.printBedWidthMm)} x ${formatInteger(profile.printBedDepthMm)} mm`)
  if (profile.bedType) {
    summary.push(`热床类型：${profile.bedType}`)
  }
  summary.push(`耗材槽位：${profile.filamentSlotCount}`)
  summary.push(`切片器：${profile.applicationName}`)
  if (profile.compatiblePrinters.length) {
    summary.push(`兼容打印机：${profile.compatiblePrinters.join(', ')}`)
  }

  return summary
}

function parseProjectSettings(file: Uint8Array | undefined) {
  if (!file) {
    return createFallbackThreeMfTemplateProfile().projectSettings
  }

  try {
    return JSON.parse(strFromU8(file)) as Record<string, unknown>
  } catch {
    return createFallbackThreeMfTemplateProfile().projectSettings
  }
}

function extractApplicationName(file: Uint8Array | undefined) {
  if (!file) return FALLBACK_APPLICATION_NAME
  const xml = strFromU8(file)
  const match = xml.match(/<metadata name="Application">([^<]+)<\/metadata>/)
  return match?.[1]?.trim() || FALLBACK_APPLICATION_NAME
}

function extractPrintableArea(projectSettings: Record<string, unknown>) {
  const printableArea = getStringArray(projectSettings.printable_area)
  if (printableArea.length >= 4) {
    const points = printableArea
      .map((point) => point.split('x').map((value) => Number(value)))
      .filter((point) => point.length === 2 && point.every((value) => Number.isFinite(value)))
    if (points.length) {
      const widthMm = Math.max(...points.map((point) => point[0]))
      const depthMm = Math.max(...points.map((point) => point[1]))
      if (widthMm > 0 && depthMm > 0) {
        return { widthMm, depthMm }
      }
    }
  }

  return { widthMm: 256, depthMm: 256 }
}

function getMaxSlotCount(projectSettings: Record<string, unknown>) {
  return Math.max(
    getStringArray(projectSettings.filament_colour).length,
    getStringArray(projectSettings.filament_type).length,
    getStringArray(projectSettings.filament_ids).length,
    2,
  )
}

function getStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? ''))
    : []
}

function padStringArray(values: string[], size: number, fallback: string) {
  return Array.from({ length: size }, (_, index) => values[index] || fallback)
}

function readString(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim()
    ? value
    : fallback
}

function safeParseJson(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

function formatInteger(value: number) {
  return String(Math.max(1, Math.round(value)))
}
