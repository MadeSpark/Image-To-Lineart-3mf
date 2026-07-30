import { FileCode2, ImagePlus, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { BatchSourceItem, ImportedLineart, LineartSettings, SourceImage, SourceKind } from '@/types/generator'

interface UploadPanelProps {
  entries: BatchSourceItem[]
  activeEntryId: string | null
  sourceImage: SourceImage | null
  importedLineart: ImportedLineart | null
  sourceKind: SourceKind | null
  settings: LineartSettings
  processing: boolean
  onUploadImages: (files: File[]) => void
  onImportDxf: (file: File) => void
  onUpdateSettings: (patch: Partial<LineartSettings>) => void
  onSelectEntry: (entryId: string) => void
  onRemoveEntry: (entryId: string) => void
}

export function UploadPanel({
  entries,
  activeEntryId,
  sourceImage,
  importedLineart,
  sourceKind,
  settings,
  processing,
  onUploadImages,
  onImportDxf,
  onUpdateSettings,
  onSelectEntry,
  onRemoveEntry,
}: UploadPanelProps) {
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const dxfInputRef = useRef<HTMLInputElement | null>(null)

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
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length) {
            onUploadImages(files)
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

      <div className="rounded-[20px] bg-slate-50 p-4">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
          <SlidersHorizontal className="h-4 w-4" />
          线稿处理参数
        </div>
        <div className="mt-4 grid gap-4">
          <SliderRow
            label="采样细节"
            min={20}
            max={100}
            step={1}
            value={settings.detail}
            suffix=""
            onChange={(value) => onUpdateSettings({ detail: value })}
          />
          <SliderRow
            label="颜色容差"
            min={0}
            max={160}
            step={1}
            value={settings.threshold}
            suffix=""
            onChange={(value) => onUpdateSettings({ threshold: value })}
          />
          <label className="space-y-1 text-[11px] text-slate-500">
            目标颜色
            <div className="grid grid-cols-[auto_1fr] items-center gap-3 rounded-2xl border border-slate-200 bg-white px-3 py-3">
              <input
                type="color"
                value={settings.targetColor}
                onChange={(event) => onUpdateSettings({ targetColor: event.target.value })}
                className="h-9 w-10 cursor-pointer rounded-xl border-0 bg-transparent p-0"
              />
              <input
                value={settings.targetColor}
                onChange={(event) => onUpdateSettings({ targetColor: event.target.value })}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none transition focus:border-sky-400"
              />
            </div>
          </label>
          <SliderRow
            label="杂点清理"
            min={0}
            max={120}
            step={2}
            value={settings.despeckle}
            suffix=""
            onChange={(value) => onUpdateSettings({ despeckle: value })}
          />
          <SliderRow
            label="线条宽度"
            min={0}
            max={4}
            step={0.2}
            value={settings.strokeWidth}
            suffix=""
            onChange={(value) => onUpdateSettings({ strokeWidth: value })}
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
            <span>水平镜像</span>
            <input
              type="checkbox"
              checked={settings.mirror}
              onChange={(event) => onUpdateSettings({ mirror: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff]"
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
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  suffix: string
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
        <span className="rounded-full bg-white px-2 py-1 font-medium text-slate-800">
          {draftValue}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={draftValue}
        onChange={(event) => setDraftValue(Number(event.target.value))}
        onMouseUp={commitValue}
        onTouchEnd={commitValue}
        onKeyUp={commitValue}
        onBlur={commitValue}
        className="h-2 w-full accent-[#0088ff]"
      />
    </label>
  )
}
