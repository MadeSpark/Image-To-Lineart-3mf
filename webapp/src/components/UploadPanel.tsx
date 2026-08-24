import { ChevronDown, ChevronRight, Copy, FileCode2, ImagePlus, LayoutGrid, LoaderCircle, SlidersHorizontal, Sparkles, Trash2, Upload, CheckCircle2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BatchSourceItem, ImportedLineart, LineartSettings, SourceImage, SourceKind, WorkMode } from '@/types/generator'
import { AI_PROMPT_TEXT, autoCropFilmstrip, copyTextToClipboard, dataUrlToFile, downloadDataUrl, mergeImagesToFilmstrip } from '@/utils/filmstrip'
import { assertImageFile } from '@/utils/importLimits'

interface UploadPanelProps {
  entries: BatchSourceItem[]
  activeEntryId: string | null
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  sourceKind: SourceKind | null
  settings: LineartSettings
  despeckleLocked?: boolean
  processing: boolean
  workMode: WorkMode
  onUploadImages: (files: File[]) => void
  onImportDxf: (file: File) => void
  onUpdateSettings: (patch: Partial<LineartSettings>) => void
  onSelectEntry: (entryId: string) => void
  onRemoveEntry: (entryId: string) => void
  onClearEntries: () => void
}

export function UploadPanel({
  entries,
  activeEntryId,
  sourceImage,
  importedLineart,
  sourceKind,
  settings,
  despeckleLocked = false,
  processing,
  workMode,
  onUploadImages,
  onImportDxf,
  onUpdateSettings,
  onSelectEntry,
  onRemoveEntry,
  onClearEntries,
}: UploadPanelProps) {
  const isSealMode = workMode === 'seal'
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const dxfInputRef = useRef<HTMLInputElement | null>(null)
  const [draftTargetColor, setDraftTargetColor] = useState(settings.targetColor)

  useEffect(() => {
    setDraftTargetColor(settings.targetColor)
  }, [settings.targetColor])

  useEffect(() => {
    if (isSealMode && !settings.mirror) {
      onUpdateSettings({ mirror: true })
    }
  }, [isSealMode, settings.mirror, onUpdateSettings])

  const commitTargetColor = () => {
    if (draftTargetColor !== settings.targetColor) {
      onUpdateSettings({ targetColor: draftTargetColor })
    }
  }
  const targetSwatchValue = /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(draftTargetColor)
    ? draftTargetColor
    : settings.targetColor

  const filmstripInputRef = useRef<HTMLInputElement | null>(null)
  const [aiAssistOpen, setAiAssistOpen] = useState(false)
  const [aiAction, setAiAction] = useState<'idle' | 'merging' | 'importing'>('idle')
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied'>('idle')
  const [pendingCroppedUrls, setPendingCroppedUrls] = useState<string[]>([])
  const [selectedCroppedIndex, setSelectedCroppedIndex] = useState<number>(0)

  const imageEntries = entries.filter((entry) => entry.sourceKind === 'image' && entry.sourceImage)

  const readFileAsDataUrl = (file: File): Promise<string> => new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })

  const handleMergeOutput = async () => {
    if (!imageEntries.length || aiAction !== 'idle') return
    setAiAction('merging')
    try {
      const dataUrls = imageEntries.map((entry) => entry.sourceImage!.dataUrl)
      const sheets = await mergeImagesToFilmstrip(dataUrls)
      sheets.forEach((dataUrl, index) => {
        const name = sheets.length > 1 ? `filmstrip-${index + 1}.png` : 'filmstrip.png'
        downloadDataUrl(dataUrl, name)
      })
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '合并输出失败')
    } finally {
      setAiAction('idle')
    }
  }

  const handleImportFilmstrip = async (file: File) => {
    setAiAction('importing')
    try {
      assertImageFile(file)
      const dataUrl = await readFileAsDataUrl(file)
      const cropped = await autoCropFilmstrip(dataUrl)
      if (!cropped.length) {
        window.alert('未在图片中检测到内容，请确认是否为胶卷图')
        return
      }
      if (isSealMode && cropped.length > 1) {
        setPendingCroppedUrls(cropped)
        setSelectedCroppedIndex(0)
        return
      }
      const files = cropped.map((url, index) => dataUrlToFile(url, `filmstrip-cell-${String(index + 1).padStart(2, '0')}.png`))
      onClearEntries()
      onUploadImages(isSealMode ? files.slice(0, 1) : files)
    } catch (error) {
      window.alert(error instanceof Error ? error.message : '导入胶卷图失败')
    } finally {
      setAiAction('idle')
    }
  }

  const handleConfirmCroppedSelection = () => {
    const url = pendingCroppedUrls[selectedCroppedIndex]
    if (!url) return
    const file = dataUrlToFile(url, 'filmstrip-cell-selected.png')
    onClearEntries()
    onUploadImages([file])
    setPendingCroppedUrls([])
  }

  const handleCancelCroppedSelection = () => {
    setPendingCroppedUrls([])
  }

  const handleCopyPrompt = async () => {
    try {
      await copyTextToClipboard(AI_PROMPT_TEXT)
      setCopyStatus('copied')
      setTimeout(() => setCopyStatus('idle'), 2000)
    } catch {
      window.alert('复制失败，请手动复制')
    }
  }

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">素材与线稿</h2>
          <p className="mt-1 text-xs text-slate-500">支持批量导入图片，GIF 会先拆帧再挑选需要处理的帧。</p>
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
          {processing ? '处理中' : `${entries.length} 项`}
        </div>
      </div>

      <div className="grid gap-3">
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          className="group block w-full rounded-[22px] border border-dashed border-sky-300 bg-[linear-gradient(180deg,rgba(243,246,251,0.8),rgba(255,255,255,1))] p-5 text-left transition hover:border-sky-400 hover:shadow-[0_18px_40px_rgba(123,185,231,0.18)]"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-[#0088ff] p-3 text-white shadow-[0_12px_26px_rgba(0,136,255,0.28)]">
              <ImagePlus className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-950">批量导入 PNG / JPG / GIF</div>
              <div className="mt-1 text-xs text-slate-500">可一次选多张图片，GIF 会自动拆出所有帧供你勾选后导入。</div>
            </div>
          </div>
        </button>

        <button
          type="button"
          onClick={() => dxfInputRef.current?.click()}
          className="group block w-full rounded-[22px] border border-dashed border-slate-300 bg-white p-5 text-left transition hover:border-slate-400 hover:shadow-[0_18px_40px_rgba(148,163,184,0.18)]"
        >
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-slate-950 p-3 text-white shadow-[0_12px_26px_rgba(15,23,42,0.22)]">
              <FileCode2 className="h-5 w-5" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-950">导入线稿 DXF</div>
              <div className="mt-1 text-xs text-slate-500">支持闭合 polyline 轮廓，可与批量图片一起放进素材列表中逐张处理。</div>
            </div>
          </div>
        </button>
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple={!isSealMode}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) {
            if (isSealMode) {
              onClearEntries()
            }
            onUploadImages(isSealMode ? files.slice(0, 1) : files)
          }
          event.target.value = ''
        }}
      />
      <input
        ref={dxfInputRef}
        type="file"
        accept=".dxf,application/dxf"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            onImportDxf(file)
          }
          event.target.value = ''
        }}
      />

      <div className="rounded-[20px] border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between">
          <div className="text-xs font-medium text-slate-500">素材列表</div>
          <div className="text-[11px] text-slate-400">点击切换当前预览</div>
        </div>

        <div className="mt-3 max-h-56 space-y-2 overflow-y-auto pr-1">
          {!entries.length && (
            <div className="rounded-2xl border border-dashed border-slate-200 bg-white px-4 py-5 text-center text-xs text-slate-400">
              还没有导入素材。支持一次选多张图片，或者先导入 GIF 再勾选需要的帧。
            </div>
          )}

          {entries.map((entry, index) => {
            const isActive = entry.id === activeEntryId
            const dimensions = entry.sourceKind === 'image'
              ? `${entry.sourceImage?.width ?? 0} × ${entry.sourceImage?.height ?? 0}px`
              : entry.importedLineart
                ? `${entry.importedLineart.widthMm.toFixed(1)} × ${entry.importedLineart.heightMm.toFixed(1)}mm`
                : '--'

            return (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSelectEntry(entry.id)}
                className={`flex w-full items-start gap-3 rounded-2xl border px-3 py-3 text-left transition ${
                  isActive
                    ? 'border-sky-300 bg-sky-50 shadow-[0_10px_30px_rgba(0,136,255,0.08)]'
                    : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                  isActive ? 'bg-[#0088ff] text-white' : 'bg-slate-100 text-slate-600'
                }`}>
                  {index + 1}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-slate-900">{entry.label}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-slate-500">
                    <span>{entry.sourceKind === 'image' ? '图片' : 'DXF'}</span>
                    <span>{dimensions}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {entry.shortLabel && (
                    <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-medium text-slate-500">
                      {entry.shortLabel}
                    </span>
                  )}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRemoveEntry(entry.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        event.stopPropagation()
                        onRemoveEntry(entry.id)
                      }
                    }}
                    className="rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                  >
                    <Trash2 className="h-4 w-4" />
                  </span>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      <div className="rounded-[20px] border border-slate-200 bg-slate-50 p-4">
        <button
          type="button"
          onClick={() => setAiAssistOpen((current) => !current)}
          className="flex w-full items-center justify-between text-left"
        >
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <Sparkles className="h-4 w-4" />
            AI 辅助识别
          </div>
          {aiAssistOpen
            ? <ChevronDown className="h-4 w-4 text-slate-400" />
            : <ChevronRight className="h-4 w-4 text-slate-400" />}
        </button>

        {aiAssistOpen && (
          <div className="mt-3 grid gap-2">
            {workMode !== 'light-relief' && (
              <>
                <button
                  type="button"
                  onClick={() => void handleMergeOutput()}
                  disabled={!imageEntries.length || aiAction !== 'idle'}
                  className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {aiAction === 'merging'
                    ? <LoaderCircle className="h-4 w-4 animate-spin" />
                    : <LayoutGrid className="h-4 w-4" />}
                  合并输出胶卷图
                </button>
                <button
                  type="button"
                  onClick={() => filmstripInputRef.current?.click()}
                  disabled={aiAction !== 'idle'}
                  className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {aiAction === 'importing'
                    ? <LoaderCircle className="h-4 w-4 animate-spin" />
                    : <Upload className="h-4 w-4" />}
                  导入胶卷图（自动裁剪）
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void handleCopyPrompt()}
              className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-medium text-slate-700 transition hover:border-sky-300 hover:text-slate-950"
            >
              <Copy className="h-4 w-4" />
              {copyStatus === 'copied' ? '已复制 AI 提示词' : '复制 AI 提示词'}
            </button>
            {workMode !== 'light-relief' && (
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-[11px] leading-5 text-slate-500">
                合并输出：将素材列表中的图片按每行 5 张拼成胶卷图（最多 5×5），超出另存一张。把胶卷图交给 AI 处理后，用“导入胶卷图”自动裁剪回单张并导入。
              </div>
            )}
          </div>
        )}
      </div>

      <input
        ref={filmstripInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            void handleImportFilmstrip(file)
          }
          event.target.value = ''
        }}
      />

      <div className="rounded-[20px] bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          <SlidersHorizontal className="h-4 w-4" />
          {workMode === 'light-relief' ? 'A 面（图像识别）' : '图像识别'}
        </div>
        <div className="mt-4 grid gap-4">
          <SliderRow
            label="识别灵敏度"
            min={0}
            max={160}
            step={1}
            value={settings.threshold}
            suffix=""
            autoLabel={settings.thresholdAuto ? '自动' : undefined}
            onToggleAuto={() => onUpdateSettings({ thresholdAuto: !settings.thresholdAuto })}
            onChange={(value) => onUpdateSettings({ threshold: value, thresholdAuto: false })}
          />
          <SliderRow
            label="线条平滑"
            min={0}
            max={72}
            step={2}
            value={settings.smoothing}
            suffix=""
            onChange={(value) => onUpdateSettings({ smoothing: value })}
          />
          <SliderRow
            label="去除杂点"
            min={0}
            max={120}
            step={2}
            value={settings.despeckle}
            suffix=""
            disabled={despeckleLocked}
            onChange={(value) => onUpdateSettings({ despeckle: value })}
          />
          {despeckleLocked && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-700">
              当前素材已使用画笔或橡皮擦修线，已自动关闭并锁定“去除杂点”，避免把手工修改冲掉。
            </div>
          )}
          <SliderRow
            label="模型分辨率（细节）"
            min={0}
            max={200}
            step={1}
            value={settings.detail}
            suffix=" · 标准"
            onChange={(value) => onUpdateSettings({ detail: value })}
          />

          {/* 开关行 */}
          <SettingSwitch
            label="自动识别优化"
            description="导入图片时根据分辨率自动调参"
            checked={settings.autoOptimize}
            onChange={(value) => onUpdateSettings({ autoOptimize: value })}
          />
          <SettingSwitch
            label="微细节保护"
            description="保留 1-2px 细线，避免腐蚀消除"
            checked={settings.protectFineDetail}
            onChange={(value) => onUpdateSettings({ protectFineDetail: value })}
          />
          <SettingSwitch
            label="上传图片预处理"
            description="上传后自动根据分辨率应用默认参数"
            checked={settings.uploadPreprocess}
            onChange={(value) => onUpdateSettings({ uploadPreprocess: value })}
          />
          <SettingSwitch
            label="贝塞尔曲线拟合"
            description="用平滑曲线替换折线，输出结构更干净"
            checked={settings.bezierFitting}
            onChange={(value) => onUpdateSettings({ bezierFitting: value })}
          />
          {settings.bezierFitting && (
            <SliderRow
              label="曲线拟合强度"
              min={0}
              max={100}
              step={5}
              value={settings.bezierStrength}
              suffix="%"
              onChange={(value) => onUpdateSettings({ bezierStrength: value })}
            />
          )}

          <SliderRow
            label="加粗描边"
            min={0}
            max={2}
            step={0.05}
            value={settings.expandStrokeMm}
            suffix="mm"
            disabled={settings.shrinkStrokeMm > 0}
            onChange={(value) => onUpdateSettings(value > 0 ? { expandStrokeMm: value, shrinkStrokeMm: 0 } : { expandStrokeMm: value })}
          />
          <SliderRow
            label="缩小描边"
            min={0}
            max={2}
            step={0.05}
            value={settings.shrinkStrokeMm}
            suffix="mm"
            disabled={settings.expandStrokeMm > 0}
            onChange={(value) => onUpdateSettings(value > 0 ? { shrinkStrokeMm: value, expandStrokeMm: 0 } : { shrinkStrokeMm: value })}
          />
          <p className="text-[11px] leading-relaxed text-slate-400">
            缩小描边受「最小线宽」限制，过度缩小不会低于打印线宽下限；二者互斥，调整其中一项会自动将另一项归零。
          </p>
          <label className="space-y-1 text-[11px] text-slate-500">
            目标颜色
            <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
              <input
                type="color"
                value={targetSwatchValue}
                onChange={(event) => setDraftTargetColor(event.target.value)}
                onMouseUp={commitTargetColor}
                onTouchEnd={commitTargetColor}
                onKeyUp={commitTargetColor}
                onBlur={commitTargetColor}
                className="h-9 w-10 cursor-pointer rounded-xl border-0 bg-transparent p-0"
              />
              <input
                value={draftTargetColor}
                onChange={(event) => setDraftTargetColor(event.target.value)}
                onBlur={commitTargetColor}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    commitTargetColor()
                  }
                }}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none transition focus:border-sky-400"
              />
            </div>
          </label>
          <label className="inline-flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            <span>反相线稿</span>
            <input
              type="checkbox"
              checked={settings.invert}
              onChange={(event) => onUpdateSettings({ invert: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff]"
            />
          </label>
          <label className="inline-flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            <span>水平镜像{isSealMode && <span className="ml-1 text-[11px] text-slate-400">（印章模式自动开启）</span>}</span>
            <input
              type="checkbox"
              checked={settings.mirror}
              disabled={isSealMode}
              onChange={(event) => onUpdateSettings({ mirror: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff] disabled:cursor-not-allowed"
            />
          </label>
        </div>
      </div>

      <div className="grid gap-3 text-xs text-slate-500">
        <div className="rounded-[18px] border border-slate-200 bg-white px-4 py-3">
          <div className="font-medium text-slate-700">当前素材</div>
          <div className="mt-2 break-all text-slate-500">
            {sourceImage?.name ?? importedLineart?.name ?? '尚未导入图片或 DXF'}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[18px] border border-slate-200 bg-white px-4 py-3">
            <div className="font-medium text-slate-700">原始尺寸</div>
            <div className="mt-2 text-slate-500">
              {sourceImage
                ? `${sourceImage.width} × ${sourceImage.height}px`
                : importedLineart
                  ? `${importedLineart.widthMm.toFixed(1)} × ${importedLineart.heightMm.toFixed(1)}mm`
                  : '--'}
            </div>
          </div>
          <div className="rounded-[18px] border border-slate-200 bg-white px-4 py-3">
            <div className="font-medium text-slate-700">取线方式</div>
            <div className="mt-2 text-slate-500">
              {sourceKind === 'image' ? '按颜色值取线稿' : sourceKind === 'dxf' ? 'DXF 线稿' : '未开始'}
            </div>
          </div>
        </div>
      </div>

      {pendingCroppedUrls.length > 0 && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-sm">
          <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_120px_rgba(15,23,42,0.28)]">
            <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
              <div>
                <div className="inline-flex items-center gap-2 rounded-full bg-sky-50 px-3 py-1 text-[11px] font-medium text-sky-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  印章模式
                </div>
                <h2 className="mt-3 text-lg font-semibold text-slate-950">选择要使用的印章图案</h2>
                <p className="mt-1 text-sm text-slate-500">已自动裁剪出 {pendingCroppedUrls.length} 张图片，印章模式仅允许导入一张，请选择其中一张。</p>
              </div>
            </div>

            <div className="grid max-h-[60vh] grid-cols-2 gap-4 overflow-y-auto p-6 sm:grid-cols-3 lg:grid-cols-4">
              {pendingCroppedUrls.map((url, index) => {
                const selected = selectedCroppedIndex === index
                return (
                  <button
                    key={index}
                    type="button"
                    onClick={() => setSelectedCroppedIndex(index)}
                    className={`relative overflow-hidden rounded-[22px] border text-left transition ${
                      selected ? 'border-sky-300 bg-sky-50 shadow-[0_12px_32px_rgba(0,136,255,0.08)]' : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <div className="aspect-square bg-slate-100 p-3">
                      <img src={url} alt={`裁剪图 ${index + 1}`} className="h-full w-full rounded-2xl object-contain" />
                    </div>
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="text-sm font-medium text-slate-900">第 {index + 1} 张</div>
                      {selected
                        ? <CheckCircle2 className="h-5 w-5 text-[#0088ff]" />
                        : <div className="h-5 w-5 rounded-full border-2 border-slate-200" />}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-5">
              <div className="text-sm text-slate-500">将导入选中的 1 张图片到素材列表。</div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleCancelCroppedSelection}
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleConfirmCroppedSelection}
                  className="rounded-2xl bg-[#0088ff] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition hover:bg-[#0077e0]"
                >
                  导入选中图片
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function SliderRow({
  label,
  min,
  max,
  step,
  value,
  suffix,
  disabled,
  autoLabel,
  onToggleAuto,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  suffix: string
  disabled?: boolean
  autoLabel?: string
  onToggleAuto?: () => void
  onChange: (value: number) => void
}) {
  const [draftValue, setDraftValue] = useState(value)

  useEffect(() => {
    setDraftValue(value)
  }, [value])

  const commitValue = () => {
    if (draftValue !== value) {
      onChange(draftValue)
    }
  }

  return (
    <label className="block space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <div className="flex items-center gap-2">
          {autoLabel && onToggleAuto && (
            <button
              type="button"
              onClick={onToggleAuto}
              className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 transition hover:bg-sky-100"
            >
              {autoLabel}
            </button>
          )}
          <span className="rounded-full bg-white px-2 py-1 font-medium text-slate-800">
            {draftValue}
            {suffix}
          </span>
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draftValue}
        disabled={disabled}
        onChange={(event) => setDraftValue(Number(event.target.value))}
        onMouseUp={commitValue}
        onTouchEnd={commitValue}
        onKeyUp={commitValue}
        onBlur={commitValue}
        className="h-2 w-full accent-[#0088ff] disabled:cursor-not-allowed disabled:opacity-45"
      />
    </label>
  )
}

function SettingSwitch({
  label,
  description,
  checked,
  onChange,
}: {
  label: string
  description?: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-slate-700">{label}</div>
        {description && (
          <div className="mt-1 text-[11px] leading-5 text-slate-500">{description}</div>
        )}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        aria-pressed={checked}
        className={`relative mt-0.5 inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full border transition ${
          checked
            ? 'border-[#0088ff] bg-[#0088ff]'
            : 'border-slate-300 bg-slate-200'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow-sm transition ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  )
}
