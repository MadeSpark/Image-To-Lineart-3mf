import { strToU8, zipSync } from 'fflate'
import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, Sparkles } from 'lucide-react'
import { BatchExportDialog } from '@/components/BatchExportDialog'
import { ExportPanel } from '@/components/ExportPanel'
import { GifFramePicker } from '@/components/GifFramePicker'
import { PalettePanel } from '@/components/PalettePanel'
import { PreviewCanvas } from '@/components/PreviewCanvas'
import { PrintBedPanel } from '@/components/PrintBedPanel'
import { ThicknessPanel } from '@/components/ThicknessPanel'
import { UploadPanel } from '@/components/UploadPanel'
import { WorkbenchHeader } from '@/components/WorkbenchHeader'
import { useArtworkProcessor } from '@/hooks/useArtworkProcessor'
import { useGeneratorStore } from '@/stores/generatorStore'
import type { BatchSourceItem, GifFrameSource, PreviewMode, ProcessedArtwork } from '@/types/generator'
import {
  build3mfPackage,
  buildCombined3mfPackage,
  buildLineartSvgDocument,
  buildLoopDxf,
  decodeGifFrames,
  fileToImportedLineart,
  fileToSourceImage,
  getExportBaseName,
  processArtwork,
} from '@/utils/generator'
import {
  createFallbackThreeMfTemplateProfile,
  loadDefaultThreeMfTemplateProfile,
  parseThreeMfTemplateFile,
  summarizeThreeMfTemplateProfile,
} from '@/utils/threeMfProfile'

interface GifImportQueueItem {
  id: string
  fileName: string
  frames: GifFrameSource[]
}

interface ProcessedBatchItem {
  entry: BatchSourceItem
  artwork: ProcessedArtwork
}

export default function Home() {
  const {
    sourceImage,
    importedLineart,
    previewMode,
    lineartSettings,
    baseplateSettings,
    extrudeSettings,
    printBedSettings,
    customThreeMfProfile,
    setSourceImage,
    setImportedLineart,
    setPreviewMode,
    updateLineartSettings,
    updateBaseplateSettings,
    updateExtrudeSettings,
    updatePrintBedSettings,
    setCustomThreeMfProfile,
    resetAllSettings,
  } = useGeneratorStore()

  const [entries, setEntries] = useState<BatchSourceItem[]>([])
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
  const [gifQueue, setGifQueue] = useState<GifImportQueueItem[]>([])
  const [batch3mfDialogOpen, setBatch3mfDialogOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [placementPreviewItems, setPlacementPreviewItems] = useState<ProcessedBatchItem[]>([])
  const [placementPreviewProcessing, setPlacementPreviewProcessing] = useState(false)
  const [placementPreviewError, setPlacementPreviewError] = useState<string | null>(null)
  const [defaultThreeMfProfile, setDefaultThreeMfProfile] = useState(() => createFallbackThreeMfTemplateProfile())
  const [templateProfileLoading, setTemplateProfileLoading] = useState(true)

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === activeEntryId) ?? null,
    [activeEntryId, entries],
  )
  const effectiveThreeMfProfile = customThreeMfProfile ?? defaultThreeMfProfile

  useEffect(() => {
    let cancelled = false

    void loadDefaultThreeMfTemplateProfile()
      .then((profile) => {
        if (!cancelled) {
          setDefaultThreeMfProfile(profile)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDefaultThreeMfProfile(createFallbackThreeMfTemplateProfile())
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTemplateProfileLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!entries.length) {
      if (activeEntryId !== null) {
        setActiveEntryId(null)
      }
      return
    }

    if (!activeEntry || !entries.some((entry) => entry.id === activeEntry.id)) {
      setActiveEntryId(entries[0].id)
    }
  }, [activeEntry, activeEntryId, entries])

  useEffect(() => {
    if (!activeEntry) {
      setSourceImage(null)
      setImportedLineart(null)
      return
    }

    if (activeEntry.sourceKind === 'image') {
      setSourceImage(activeEntry.sourceImage)
      return
    }

    setImportedLineart(activeEntry.importedLineart)
  }, [activeEntry, setImportedLineart, setSourceImage])

  const { artwork, processing, error } = useArtworkProcessor(
    sourceImage,
    importedLineart,
    lineartSettings,
    baseplateSettings,
    extrudeSettings,
  )

  useEffect(() => {
    let cancelled = false

    if (!entries.length) {
      setPlacementPreviewItems([])
      setPlacementPreviewProcessing(false)
      setPlacementPreviewError(null)
      return () => {
        cancelled = true
      }
    }

    if (entries.length === 1 && activeEntry && artwork) {
      setPlacementPreviewItems([{ entry: activeEntry, artwork }])
      setPlacementPreviewProcessing(false)
      setPlacementPreviewError(null)
      return () => {
        cancelled = true
      }
    }

    setPlacementPreviewProcessing(true)
    setPlacementPreviewError(null)

    void buildProcessedItems(entries)
      .then((processedItems) => {
        if (cancelled) return
        setPlacementPreviewItems(processedItems)
      })
      .catch((caughtError) => {
        if (cancelled) return
        setPlacementPreviewItems([])
        setPlacementPreviewError(normalizeErrorMessage(caughtError, '摆盘预览生成失败'))
      })
      .finally(() => {
        if (!cancelled) {
          setPlacementPreviewProcessing(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeEntry, artwork, baseplateSettings, entries, extrudeSettings, lineartSettings])

  const currentPreviewUrl = useMemo(() => {
    if (!artwork || !activeEntry) return null
    return getPreviewUrlForMode(previewMode, artwork, activeEntry)
  }, [activeEntry, artwork, previewMode])

  const workflowItems = [
    '批量导入图片、GIF 帧或 DXF 线稿',
    '调节线稿细节、清理杂点与平滑',
    '选择底板模板并自动居中排版',
    '按单个或批量方式导出 3MF / DXF / SVG',
  ]

  const exportBaseName = getExportBaseName(activeEntry?.label, 'lineart-baseplate')
  const canExport = Boolean(artwork && activeEntry)
  const activeGifImport = gifQueue[0] ?? null

  const addEntries = (newEntries: BatchSourceItem[]) => {
    if (!newEntries.length) return
    setEntries((current) => [...current, ...newEntries])
    setActiveEntryId((current) => current ?? newEntries[0].id)
  }

  const handleUploadImages = async (files: File[]) => {
    try {
      const nextEntries: BatchSourceItem[] = []
      const pendingGifs: GifImportQueueItem[] = []

      for (const file of files) {
        if (isGifFile(file)) {
          const frames = await decodeGifFrames(file)
          pendingGifs.push({
            id: createId(),
            fileName: file.name,
            frames,
          })
          continue
        }

        const source = await fileToSourceImage(file)
        nextEntries.push(createImageEntry(source))
      }

      addEntries(nextEntries)
      if (pendingGifs.length) {
        setGifQueue((current) => [...current, ...pendingGifs])
      }
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, '图片导入失败'))
    }
  }

  const handleImportDxf = async (file: File) => {
    try {
      const imported = await fileToImportedLineart(file)
      addEntries([createDxfEntry(imported)])
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, 'DXF 导入失败'))
    }
  }

  const handleRemoveEntry = (entryId: string) => {
    setEntries((current) => current.filter((entry) => entry.id !== entryId))
    if (activeEntryId === entryId) {
      const currentIndex = entries.findIndex((entry) => entry.id === entryId)
      const nextEntry = entries[currentIndex + 1] ?? entries[currentIndex - 1] ?? null
      setActiveEntryId(nextEntry?.id ?? null)
    }
  }

  async function buildProcessedItems(targets: BatchSourceItem[]) {
    const results: ProcessedBatchItem[] = []

    for (const entry of targets) {
      const processedArtwork = entry.id === activeEntry?.id && artwork
        ? artwork
        : await processArtwork({
          sourceImage: entry.sourceImage,
          importedLineart: entry.importedLineart,
          lineartSettings,
          baseplateSettings,
          extrudeSettings,
        })

      results.push({
        entry,
        artwork: processedArtwork,
      })
    }

    return results
  }

  const exportBatch3mf = async (mode: 'single' | 'multiple') => {
    if (!entries.length) return
    setBatch3mfDialogOpen(false)
    setExporting(true)

    try {
      const processedItems = await buildProcessedItems(entries)

      if (mode === 'single') {
        const bytes = buildCombined3mfPackage(
          processedItems.map((item) => ({
            id: item.entry.id,
            name: buildNumberedBaseName(item.entry, entries.indexOf(item.entry)),
            artwork: item.artwork,
          })),
          baseplateSettings,
          extrudeSettings,
          printBedSettings,
          effectiveThreeMfProfile,
        )
        triggerBlobDownload('lineart-baseplate-batch.3mf', new Blob([bytes], { type: 'model/3mf' }))
        return
      }

      const archiveEntries: Record<string, Uint8Array> = {}
      processedItems.forEach((item, index) => {
        const filename = `${buildNumberedBaseName(item.entry, index)}.3mf`
        archiveEntries[filename] = build3mfPackage(
          item.artwork,
          baseplateSettings,
          extrudeSettings,
          printBedSettings,
          effectiveThreeMfProfile,
        )
      })
      triggerBlobDownload(
        'lineart-baseplate-3mf-batch.zip',
        new Blob([zipSync(archiveEntries, { level: 0 })], { type: 'application/zip' }),
      )
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, '批量导出 3MF 失败'))
    } finally {
      setExporting(false)
    }
  }

  const exportBatchFiles = async (format: 'dxf' | 'svg' | 'png' | 'json') => {
    if (!entries.length) return
    setExporting(true)

    try {
      if (entries.length === 1 && activeEntry && artwork) {
        const singleBaseName = getExportBaseName(activeEntry.label, 'lineart-baseplate')
        await exportSingleFile(format, singleBaseName, activeEntry, artwork)
        return
      }

      const processedItems = await buildProcessedItems(entries)
      const archiveEntries: Record<string, Uint8Array> = {}

      for (const [index, item] of processedItems.entries()) {
        const baseName = buildNumberedBaseName(item.entry, index)
        if (format === 'dxf') {
          archiveEntries[`${baseName}-lineart.dxf`] = strToU8(buildLoopDxf(item.artwork.lineLoops, 'LINEART'))
          continue
        }
        if (format === 'svg') {
          archiveEntries[`${baseName}.svg`] = strToU8(buildLineartSvgDocument(item.artwork, baseplateSettings))
          continue
        }
        if (format === 'json') {
          archiveEntries[`${baseName}-project.json`] = strToU8(JSON.stringify(buildProjectPayload(item.entry, item.artwork), null, 2))
          continue
        }

        const previewUrl = getPreviewUrlForMode(previewMode, item.artwork, item.entry)
        archiveEntries[`${baseName}-${getPreviewSuffix(previewMode)}.png`] = await dataUrlToU8(previewUrl)
      }

      triggerBlobDownload(
        `lineart-baseplate-${format}-batch.zip`,
        new Blob([zipSync(archiveEntries, { level: 0 })], { type: 'application/zip' }),
      )
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, '批量导出失败'))
    } finally {
      setExporting(false)
    }
  }

  const handleExport3mf = async () => {
    if (!activeEntry || !artwork) return
    if (entries.length > 1) {
      setBatch3mfDialogOpen(true)
      return
    }

    setExporting(true)
    try {
      triggerBlobDownload(
        `${exportBaseName}.3mf`,
        new Blob([build3mfPackage(
          artwork,
          baseplateSettings,
          extrudeSettings,
          printBedSettings,
          effectiveThreeMfProfile,
        )], { type: 'model/3mf' }),
      )
    } finally {
      setExporting(false)
    }
  }

  const handleImport3mfProfile = async (file: File) => {
    try {
      const profile = await parseThreeMfTemplateFile(file)
      setCustomThreeMfProfile(profile)
      updatePrintBedSettings({
        widthMm: profile.printBedWidthMm,
        depthMm: profile.printBedDepthMm,
      })
      window.alert([
        `已导入 3MF 打印配置：${profile.sourceName}`,
        '',
        ...summarizeThreeMfTemplateProfile(profile),
      ].join('\n'))
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, '3MF 打印参数导入失败'))
    }
  }

  const handleResetSettings = () => {
    resetAllSettings({
      widthMm: defaultThreeMfProfile.printBedWidthMm,
      depthMm: defaultThreeMfProfile.printBedDepthMm,
    })
  }

  const handleGifImportConfirm = (selectedFrames: GifFrameSource[]) => {
    if (!activeGifImport) return
    const baseName = getExportBaseName(activeGifImport.fileName, 'gif-frame')
    addEntries(selectedFrames.map((frame) => createImageEntry(frame, `${baseName}-frame-${String(frame.frameIndex + 1).padStart(3, '0')}`)))
    setGifQueue((current) => current.slice(1))
  }

  return (
    <main className="min-h-screen bg-app px-4 py-6 text-slate-900 lg:px-6 xl:px-8">
      <div className="mx-auto max-w-[1680px] space-y-6">
        <WorkbenchHeader
          appVersion={__APP_VERSION__}
          previewMode={previewMode}
          template={baseplateSettings.template}
          onPreviewModeChange={setPreviewMode}
          onTemplateChange={(template) => updateBaseplateSettings({ template })}
          onExportJson={() => void exportBatchFiles('json')}
          onExportPreview={() => void exportBatchFiles('png')}
          onExport3mf={() => void handleExport3mf()}
          onResetSettings={handleResetSettings}
          canExport={canExport && !exporting}
        />

        <section className="grid items-start gap-6 xl:grid-cols-[340px_minmax(0,1fr)_380px]">
          <div className="space-y-6">
            <UploadPanel
              entries={entries}
              activeEntryId={activeEntryId}
              sourceImage={sourceImage}
              importedLineart={importedLineart}
              sourceKind={activeEntry?.sourceKind ?? artwork?.sourceKind ?? null}
              settings={lineartSettings}
              processing={processing || exporting}
              onUpdateSettings={updateLineartSettings}
              onUploadImages={(files) => void handleUploadImages(files)}
              onImportDxf={(file) => void handleImportDxf(file)}
              onSelectEntry={setActiveEntryId}
              onRemoveEntry={handleRemoveEntry}
            />

            <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
              <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
                <Sparkles className="h-4 w-4" />
                当前工作流
              </div>
              <div className="mt-4 space-y-3">
                {workflowItems.map((item, index) => (
                  <div key={item} className="flex items-center gap-3 rounded-[18px] bg-slate-50 px-4 py-3">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white text-xs font-semibold text-slate-900">
                      {index + 1}
                    </div>
                    <div className="text-sm text-slate-600">{item}</div>
                    {index < workflowItems.length - 1 && <ArrowRight className="ml-auto h-4 w-4 text-slate-300" />}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="xl:sticky xl:top-6">
            <PreviewCanvas
              sourceImage={sourceImage}
              artwork={artwork}
              previewMode={previewMode}
              processing={processing || exporting}
              error={error}
              targetColor={lineartSettings.targetColor}
              onPickTargetColor={(color) => updateLineartSettings({ targetColor: color })}
            />
          </div>

          <div className="space-y-6">
            <PalettePanel
              settings={baseplateSettings}
              onUpdateSettings={updateBaseplateSettings}
            />
            <ThicknessPanel
              settings={extrudeSettings}
              onUpdateSettings={updateExtrudeSettings}
            />
            <PrintBedPanel
              settings={printBedSettings}
              items={placementPreviewItems.map((item) => ({
                id: item.entry.id,
                label: item.entry.label,
                artwork: item.artwork,
                isActive: item.entry.id === activeEntryId,
              }))}
              batchCount={entries.length}
              processing={placementPreviewProcessing}
              error={placementPreviewError}
              profileName={effectiveThreeMfProfile.sourceName}
              printerModel={effectiveThreeMfProfile.printerModel}
              printerSettingsId={effectiveThreeMfProfile.printerSettingsId}
              printSettingsId={effectiveThreeMfProfile.printSettingsId}
              bedType={effectiveThreeMfProfile.bedType}
              profileLoading={templateProfileLoading && !customThreeMfProfile}
              onUpdateSettings={updatePrintBedSettings}
              onImport3mfProfile={(file) => void handleImport3mfProfile(file)}
            />
            <ExportPanel
              stats={artwork?.stats ?? null}
              batchCount={entries.length}
              canExport={canExport && !exporting}
              onExportJson={() => void exportBatchFiles('json')}
              onExportPreview={() => void exportBatchFiles('png')}
              onExportSvg={() => void exportBatchFiles('svg')}
              onExportDxf={() => void exportBatchFiles('dxf')}
              onExport3mf={() => void handleExport3mf()}
            />
          </div>
        </section>
      </div>

      {activeGifImport && (
        <GifFramePicker
          fileName={activeGifImport.fileName}
          frames={activeGifImport.frames}
          onCancel={() => setGifQueue((current) => current.slice(1))}
          onConfirm={handleGifImportConfirm}
        />
      )}

      {batch3mfDialogOpen && (
        <BatchExportDialog
          count={entries.length}
          onCancel={() => setBatch3mfDialogOpen(false)}
          onChooseMode={(mode) => void exportBatch3mf(mode)}
        />
      )}
    </main>
  )
}

async function exportSingleFile(
  format: 'dxf' | 'svg' | 'png' | 'json',
  baseName: string,
  entry: BatchSourceItem,
  artwork: ProcessedArtwork,
) {
  if (format === 'dxf') {
    triggerBlobDownload(
      `${baseName}-lineart.dxf`,
      new Blob([buildLoopDxf(artwork.lineLoops, 'LINEART')], { type: 'application/dxf;charset=utf-8' }),
    )
    return
  }

  if (format === 'svg') {
    triggerBlobDownload(
      `${baseName}.svg`,
      new Blob([buildLineartSvgDocument(artwork, useGeneratorStore.getState().baseplateSettings)], { type: 'image/svg+xml;charset=utf-8' }),
    )
    return
  }

  if (format === 'json') {
    triggerBlobDownload(
      `${baseName}-project.json`,
      new Blob([JSON.stringify(buildProjectPayload(entry, artwork), null, 2)], { type: 'application/json' }),
    )
    return
  }

  const previewUrl = getPreviewUrlForMode(useGeneratorStore.getState().previewMode, artwork, entry)
  triggerBlobDownload(
    `${baseName}-${getPreviewSuffix(useGeneratorStore.getState().previewMode)}.png`,
    new Blob([await dataUrlToU8(previewUrl)], { type: 'image/png' }),
  )
}

function buildProjectPayload(entry: BatchSourceItem, artwork: ProcessedArtwork) {
  const state = useGeneratorStore.getState()

  return {
    sourceKind: artwork.sourceKind,
    sourceImage: entry.sourceImage,
    importedLineartName: entry.importedLineart?.name ?? null,
    previewMode: state.previewMode,
    lineartSettings: state.lineartSettings,
    baseplateSettings: state.baseplateSettings,
    extrudeSettings: state.extrudeSettings,
    printBedSettings: state.printBedSettings,
    board: {
      widthMm: artwork.boardWidthMm,
      heightMm: artwork.boardHeightMm,
    },
    stats: artwork.stats,
  }
}

function getPreviewUrlForMode(previewMode: PreviewMode, artwork: ProcessedArtwork, entry: BatchSourceItem) {
  if (previewMode === '原图') {
    return entry.sourceImage?.dataUrl ?? artwork.previews.lineartDataUrl
  }
  if (previewMode === '线稿') return artwork.previews.lineartDataUrl
  if (previewMode === '底板预览') return artwork.previews.baseplateDataUrl
  return artwork.previews.compositeDataUrl
}

function getPreviewSuffix(previewMode: PreviewMode) {
  if (previewMode === '原图') return 'source'
  if (previewMode === '线稿') return 'lineart'
  if (previewMode === '底板预览') return 'baseplate'
  return 'composite'
}

function createImageEntry(sourceImage: GifFrameSource | BatchSourceItem['sourceImage'], label?: string): BatchSourceItem {
  if (!sourceImage) {
    throw new Error('图片素材不能为空')
  }

  return {
    id: createId(),
    sourceKind: 'image',
    sourceImage,
    importedLineart: null,
    label: label ?? sourceImage.name,
    shortLabel: '图片',
  }
}

function createDxfEntry(importedLineart: NonNullable<BatchSourceItem['importedLineart']>): BatchSourceItem {
  return {
    id: createId(),
    sourceKind: 'dxf',
    sourceImage: null,
    importedLineart,
    label: importedLineart.name,
    shortLabel: 'DXF',
  }
}

function buildNumberedBaseName(entry: BatchSourceItem, index: number) {
  return `${index + 1}-${getExportBaseName(entry.label, 'lineart-baseplate')}`
}

function triggerBlobDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function dataUrlToU8(dataUrl: string) {
  const response = await fetch(dataUrl)
  return new Uint8Array(await response.arrayBuffer())
}

function normalizeErrorMessage(caughtError: unknown, fallback: string) {
  return caughtError instanceof Error ? caughtError.message : fallback
}

function isGifFile(file: File) {
  return file.type === 'image/gif' || /\.gif$/i.test(file.name)
}

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
