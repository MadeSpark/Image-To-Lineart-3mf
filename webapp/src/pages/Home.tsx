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
import {
  buildPersistedSettingsSnapshot,
  useGeneratorStore,
} from '@/stores/generatorStore'
import type { GeneratorSettingsPatch, GeneratorSettingsPayload } from '@/stores/generatorStore'
import type { BatchSourceItem, GifFrameSource, PreviewMode, ProcessedArtwork, VectorLoop, VectorPoint } from '@/types/generator'
import {
  applyLineartStrokeEdit,
  build3mfPackage,
  buildCombined3mfPackage,
  buildLineartSvgDocument,
  rebuildArtworkWithLineLoops,
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
import { calculateRectangleRatioLayout } from '@/utils/baseplate'

interface GifImportQueueItem {
  id: string
  fileName: string
  frames: GifFrameSource[]
}

interface ProcessedBatchItem {
  entry: BatchSourceItem
  artwork: ProcessedArtwork
}

const MAKERWORLD_SUPPORT_URL = 'https://makerworld.com.cn/zh/models/2796222-kai-yuan-xian-gao-sheng-cheng-qi-fan-ye-dong-hua-s#profileId-3257232'

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
    applyImportedSettings,
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
  const [welcomeDialogOpen, setWelcomeDialogOpen] = useState(true)
  const [thanksDialogOpen, setThanksDialogOpen] = useState(false)
  const [qaqModeEnabled, setQaqModeEnabled] = useState(false)
  const [lineartOverrides, setLineartOverrides] = useState<Record<string, VectorLoop[]>>({})

  const activeEntry = useMemo(
    () => entries.find((entry) => entry.id === activeEntryId) ?? null,
    [activeEntryId, entries],
  )
  const effectiveThreeMfProfile = customThreeMfProfile ?? defaultThreeMfProfile
  const activeSourceAspectRatio = useMemo(() => {
    if (sourceImage && sourceImage.width > 0 && sourceImage.height > 0) {
      return sourceImage.width / sourceImage.height
    }

    if (importedLineart && importedLineart.widthMm > 0 && importedLineart.heightMm > 0) {
      return importedLineart.widthMm / importedLineart.heightMm
    }

    return null
  }, [importedLineart, sourceImage])

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

  useEffect(() => {
    if (baseplateSettings.template !== 'rectangle' || baseplateSettings.rectangleSizeMode !== 'ratio' || !activeSourceAspectRatio) {
      return
    }

    const nextLayout = calculateRectangleRatioLayout(
      activeSourceAspectRatio,
      baseplateSettings.rectangleScalePercent,
      printBedSettings,
      baseplateSettings.marginMm,
    )

    if (
      Math.abs(nextLayout.widthMm - baseplateSettings.widthMm) < 0.05
      && Math.abs(nextLayout.heightMm - baseplateSettings.heightMm) < 0.05
    ) {
      return
    }

    updateBaseplateSettings({
      widthMm: nextLayout.widthMm,
      heightMm: nextLayout.heightMm,
    })
  }, [
    activeSourceAspectRatio,
    baseplateSettings.heightMm,
    baseplateSettings.marginMm,
    baseplateSettings.rectangleScalePercent,
    baseplateSettings.rectangleSizeMode,
    baseplateSettings.template,
    baseplateSettings.widthMm,
    printBedSettings,
    updateBaseplateSettings,
  ])

  const { artwork, processing, error } = useArtworkProcessor(
    sourceImage,
    importedLineart,
    lineartSettings,
    baseplateSettings,
    extrudeSettings,
  )
  const activeLineartOverride = activeEntryId ? lineartOverrides[activeEntryId] : undefined
  const effectiveArtwork = useMemo(
    () => (artwork && activeLineartOverride
      ? rebuildArtworkWithLineLoops(artwork, activeLineartOverride, baseplateSettings)
      : artwork),
    [activeLineartOverride, artwork, baseplateSettings],
  )

  useEffect(() => {
    setLineartOverrides((current) => {
      const activeIds = new Set(entries.map((entry) => entry.id))
      const nextEntries = Object.entries(current).filter(([entryId]) => activeIds.has(entryId))
      if (nextEntries.length === Object.keys(current).length) {
        return current
      }
      return Object.fromEntries(nextEntries)
    })
  }, [entries])

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

    if (entries.length === 1 && activeEntry && effectiveArtwork) {
      setPlacementPreviewItems([{ entry: activeEntry, artwork: effectiveArtwork }])
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
  }, [activeEntry, artwork, baseplateSettings, effectiveArtwork, entries, extrudeSettings, lineartOverrides, lineartSettings])

  useEffect(() => {
    if (!qaqModeEnabled) return

    const root = document.getElementById('root')
    if (!root) return

    const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT'])

    const prefixTextNodes = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        const textNode = node as Text
        const content = textNode.textContent ?? ''
        if (!content.trim()) return
        if (content.trimStart().startsWith('QAQ')) return
        textNode.textContent = content.replace(/^(\s*)/, '$1QAQ ')
        return
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return

      const element = node as HTMLElement
      if (ignoredTags.has(element.tagName)) return
      if (element.dataset.qaqIgnore === 'true') return

      element.childNodes.forEach(prefixTextNodes)
    }

    prefixTextNodes(root)

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'characterData') {
          prefixTextNodes(mutation.target)
          return
        }

        mutation.addedNodes.forEach(prefixTextNodes)
      })
    })

    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
    })

    return () => {
      observer.disconnect()
    }
  }, [qaqModeEnabled])

  const currentPreviewUrl = useMemo(() => {
    if (!effectiveArtwork || !activeEntry) return null
    return getPreviewUrlForMode(previewMode, effectiveArtwork, activeEntry)
  }, [activeEntry, effectiveArtwork, previewMode])

  const workflowItems = [
    '批量导入图片、GIF 帧或 DXF 线稿',
    '调节线稿细节、清理杂点与平滑',
    '选择底板模板并自动居中排版',
    '按单个或批量方式导出 3MF / DXF / SVG',
  ]

  const exportBaseName = getExportBaseName(activeEntry?.label, 'lineart-baseplate')
  const canExport = Boolean(effectiveArtwork && activeEntry)
  const activeGifImport = gifQueue[0] ?? null
  const despeckleLocked = Boolean(activeEntryId && activeLineartOverride)

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
    setLineartOverrides((current) => {
      if (!(entryId in current)) return current
      const next = { ...current }
      delete next[entryId]
      return next
    })
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

      const lineartOverride = lineartOverrides[entry.id]
      results.push({
        entry,
        artwork: lineartOverride
          ? rebuildArtworkWithLineLoops(processedArtwork, lineartOverride, baseplateSettings)
          : processedArtwork,
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
      if (entries.length === 1 && activeEntry && effectiveArtwork) {
        const singleBaseName = getExportBaseName(activeEntry.label, 'lineart-baseplate')
        await exportSingleFile(format, singleBaseName, activeEntry, effectiveArtwork)
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

        const previewAsset = getPreviewAssetForMode(previewMode, item.artwork, item.entry)
        archiveEntries[`${baseName}-${getPreviewSuffix(previewMode)}.${previewAsset.extension}`] = await dataUrlToU8(previewAsset.url)
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
    if (!activeEntry || !effectiveArtwork) return
    if (entries.length > 1) {
      setBatch3mfDialogOpen(true)
      return
    }

    setExporting(true)
    try {
      triggerBlobDownload(
        `${exportBaseName}.3mf`,
        new Blob([build3mfPackage(
          effectiveArtwork,
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
    setLineartOverrides({})
    resetAllSettings({
      widthMm: defaultThreeMfProfile.printBedWidthMm,
      depthMm: defaultThreeMfProfile.printBedDepthMm,
    })
  }

  const handleExportSettings = () => {
    const settingsPayload: GeneratorSettingsExportFile = {
      kind: 'lineart-baseplate-settings',
      version: __APP_VERSION__,
      exportedAt: new Date().toISOString(),
      settings: {
        previewMode,
        ...buildPersistedSettingsSnapshot({
          lineartSettings,
          baseplateSettings,
          extrudeSettings,
          printBedSettings,
          customThreeMfProfile,
        }),
      },
    }

    triggerBlobDownload(
      `lineart-settings-v${__APP_VERSION__}.json`,
      new Blob([JSON.stringify(settingsPayload, null, 2)], { type: 'application/json' }),
    )
  }

  const handleImportSettings = async (file: File) => {
    try {
      const payload = extractImportedSettingsPayload(JSON.parse(await file.text()))
      setLineartOverrides({})
      applyImportedSettings(payload)
      window.alert([
        `已导入参数：${file.name}`,
        `预览模式：${payload.previewMode ?? previewMode}`,
        `目标颜色：${payload.lineartSettings?.targetColor ?? lineartSettings.targetColor}`,
        `底板模板：${payload.baseplateSettings?.template ?? baseplateSettings.template}`,
        `打印盘：${payload.printBedSettings?.widthMm ?? printBedSettings.widthMm} x ${payload.printBedSettings?.depthMm ?? printBedSettings.depthMm} mm`,
      ].join('\n'))
    } catch (caughtError) {
      window.alert(normalizeErrorMessage(caughtError, '参数导入失败'))
    }
  }

  const handleApplyLineartStroke = (points: VectorPoint[], mode: 'brush' | 'eraser', radiusMm: number) => {
    if (!activeEntry || !effectiveArtwork || previewMode !== '线稿' || !points.length) {
      return
    }

    const editedArtwork = applyLineartStrokeEdit(
      effectiveArtwork,
      baseplateSettings,
      points,
      radiusMm,
      mode,
    )
    setLineartOverrides((current) => ({
      ...current,
      [activeEntry.id]: editedArtwork.lineLoops,
    }))
    if (lineartSettings.despeckle !== 0) {
      updateLineartSettings({ despeckle: 0 })
    }
  }

  const handleResetLineartEdits = () => {
    if (!activeEntry) return
    setLineartOverrides((current) => {
      if (!(activeEntry.id in current)) return current
      const next = { ...current }
      delete next[activeEntry.id]
      return next
    })
  }

  const handleSupportNow = () => {
    window.open(MAKERWORLD_SUPPORT_URL, '_blank', 'noopener,noreferrer')
    setWelcomeDialogOpen(false)
  }

  const handleAlreadySupported = () => {
    setWelcomeDialogOpen(false)
    setThanksDialogOpen(true)
  }

  const handleCruelReject = () => {
    setWelcomeDialogOpen(false)
    setQaqModeEnabled(true)
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
          onExportSettings={handleExportSettings}
          onImportSettings={(file) => void handleImportSettings(file)}
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
              sourceKind={activeEntry?.sourceKind ?? effectiveArtwork?.sourceKind ?? artwork?.sourceKind ?? null}
              settings={lineartSettings}
              despeckleLocked={despeckleLocked}
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
              artwork={effectiveArtwork}
              previewMode={previewMode}
              processing={processing || exporting}
              error={error}
              targetColor={lineartSettings.targetColor}
              baseplateSettings={baseplateSettings}
              extrudeSettings={extrudeSettings}
              hasLineartEdits={despeckleLocked}
              viewResetKey={activeEntry?.id ?? 'empty'}
              onApplyLineartStroke={handleApplyLineartStroke}
              onResetLineartEdits={handleResetLineartEdits}
              onPickTargetColor={(color) => updateLineartSettings({ targetColor: color })}
            />
          </div>

          <div className="space-y-6">
            <PalettePanel
              settings={baseplateSettings}
              sourceAspectRatio={activeSourceAspectRatio}
              printBedSettings={printBedSettings}
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
              stats={effectiveArtwork?.stats ?? null}
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

      {welcomeDialogOpen && (
        <WelcomeDialog
          onSupportNow={handleSupportNow}
          onAlreadySupported={handleAlreadySupported}
          onCruelReject={handleCruelReject}
        />
      )}

      {thanksDialogOpen && (
        <MessageDialog
          title="谢谢喵"
          message="感谢你的支持喵，祝你打印顺利、出图顺利喵~"
          confirmText="知道了喵"
          onConfirm={() => setThanksDialogOpen(false)}
        />
      )}
    </main>
  )
}

function WelcomeDialog({
  onSupportNow,
  onAlreadySupported,
  onCruelReject,
}: {
  onSupportNow: () => void
  onAlreadySupported: () => void
  onCruelReject: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.2)]">
        <div className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-medium tracking-[0.24em] text-sky-700">
          欢迎使用喵
        </div>
        <h2 className="mt-4 text-2xl font-semibold text-slate-950">欢迎使用喵</h2>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          此为开源项目，如果喜欢的话还请前往拓竹社区给作者助力喵~
        </p>

        <div className="mt-6 flex flex-col gap-3">
          <button
            type="button"
            onClick={onSupportNow}
            className="inline-flex items-center justify-center rounded-2xl bg-[#0088ff] px-4 py-3 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition hover:bg-[#0077e0]"
          >
            这就去助力
          </button>
          <button
            type="button"
            onClick={onAlreadySupported}
            className="inline-flex items-center justify-center rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
          >
            助力过了喵
          </button>
          <button
            type="button"
            onClick={onCruelReject}
            className="inline-flex items-center justify-center rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-600 transition hover:border-rose-300 hover:bg-rose-100"
          >
            残忍拒绝
          </button>
        </div>
      </div>
    </div>
  )
}

function MessageDialog({
  title,
  message,
  confirmText,
  onConfirm,
}: {
  title: string
  message: string
  confirmText: string
  onConfirm: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-[28px] border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.2)]">
        <div className="rounded-full bg-sky-50 px-3 py-1 text-[11px] font-medium tracking-[0.24em] text-sky-700">
          {title}
        </div>
        <h2 className="mt-4 text-2xl font-semibold text-slate-950">{title}</h2>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          {message}
        </p>

        <div className="mt-6">
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex w-full items-center justify-center rounded-2xl bg-[#0088ff] px-4 py-3 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition hover:bg-[#0077e0]"
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
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

  const previewAsset = getPreviewAssetForMode(useGeneratorStore.getState().previewMode, artwork, entry)
  triggerBlobDownload(
    `${baseName}-${getPreviewSuffix(useGeneratorStore.getState().previewMode)}.${previewAsset.extension}`,
    new Blob([await dataUrlToU8(previewAsset.url)], { type: previewAsset.mimeType }),
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

interface GeneratorSettingsExportFile {
  kind: 'lineart-baseplate-settings'
  version: string
  exportedAt: string
  settings: GeneratorSettingsPayload
}

function extractImportedSettingsPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('参数文件格式无效')
  }

  const candidate = payload as Record<string, unknown>
  const settings = 'settings' in candidate && candidate.settings && typeof candidate.settings === 'object'
    ? candidate.settings as Record<string, unknown>
    : candidate

  if (
    !('lineartSettings' in settings)
    && !('baseplateSettings' in settings)
    && !('extrudeSettings' in settings)
    && !('printBedSettings' in settings)
  ) {
    throw new Error('未找到可导入的参数配置')
  }

  return settings as GeneratorSettingsPatch
}

function getPreviewUrlForMode(previewMode: PreviewMode, artwork: ProcessedArtwork, entry: BatchSourceItem) {
  return getPreviewAssetForMode(previewMode, artwork, entry).url
}

function getPreviewAssetForMode(previewMode: PreviewMode, artwork: ProcessedArtwork, entry: BatchSourceItem) {
  if (previewMode === '原图') {
    return {
      url: entry.sourceImage?.dataUrl ?? artwork.previews.lineartDataUrl,
      extension: 'png',
      mimeType: 'image/png',
    }
  }
  if (previewMode === '线稿') {
    return {
      url: artwork.previews.lineartDataUrl,
      extension: 'svg',
      mimeType: 'image/svg+xml;charset=utf-8',
    }
  }
  if (previewMode === '底板预览') {
    return {
      url: artwork.previews.baseplateDataUrl,
      extension: 'svg',
      mimeType: 'image/svg+xml;charset=utf-8',
    }
  }
  if (previewMode === '3D预览') {
    return {
      url: artwork.previews.compositeDataUrl,
      extension: 'svg',
      mimeType: 'image/svg+xml;charset=utf-8',
    }
  }
  return {
    url: artwork.previews.compositeDataUrl,
    extension: 'svg',
    mimeType: 'image/svg+xml;charset=utf-8',
  }
}

function getPreviewSuffix(previewMode: PreviewMode) {
  if (previewMode === '原图') return 'source'
  if (previewMode === '线稿') return 'lineart'
  if (previewMode === '底板预览') return 'baseplate'
  if (previewMode === '3D预览') return '3d-preview'
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
