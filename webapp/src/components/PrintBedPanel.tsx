import { FileArchive, LayoutGrid, LoaderCircle, Maximize2, Ruler, ScanLine, Upload } from 'lucide-react'
import { useMemo, useRef } from 'react'
import type { PrintBedSettings, ProcessedArtwork } from '@/types/generator'
import { planPrintBedLayout } from '@/utils/generator'

interface PrintBedPreviewItem {
  id: string
  label: string
  artwork: ProcessedArtwork
  isActive: boolean
}

interface PrintBedPanelProps {
  settings: PrintBedSettings
  items: PrintBedPreviewItem[]
  batchCount: number
  processing: boolean
  error: string | null
  profileName: string
  printerModel: string
  printerSettingsId: string
  printSettingsId: string
  bedType: string
  profileLoading: boolean
  onUpdateSettings: (patch: Partial<PrintBedSettings>) => void
  onImport3mfProfile: (file: File) => void
  onFullPreview?: () => void
  fullPreviewProgress?: { current: number; total: number }
}

export function PrintBedPanel({
  settings,
  items,
  batchCount,
  processing,
  error,
  profileName,
  printerModel,
  printerSettingsId,
  printSettingsId,
  bedType,
  profileLoading,
  onUpdateSettings,
  onImport3mfProfile,
  onFullPreview,
  fullPreviewProgress,
}: PrintBedPanelProps) {
  const profileInputRef = useRef<HTMLInputElement | null>(null)
  const layout = useMemo(() => planPrintBedLayout(
    items.map((item) => ({
      id: item.id,
      label: item.label,
      widthMm: item.artwork.boardWidthMm,
      heightMm: item.artwork.boardHeightMm,
      previewDataUrl: item.artwork.previews.compositeDataUrl,
    })),
    settings,
  ), [items, settings])

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">打印盘与单 3MF 摆盘</h2>
          <p className="mt-1 text-xs text-slate-500">
            单 3MF 导出会基于当前 3MF 打印模板写入打印参数，并按这里的尺寸和间距自动拆分到多个打印板。
          </p>
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
          {layout.plates.length > 1 ? `${layout.plates.length} 个打印板` : batchCount > 1 ? `批量 ${batchCount} 项` : '单图居中'}
        </div>
      </div>

      <div className="grid gap-3 rounded-[20px] border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
              <FileArchive className="h-4 w-4" />
              3MF 打印模板
            </div>
            <div className="mt-2 text-sm font-semibold text-slate-900">
              {profileLoading ? '正在加载默认模板...' : profileName}
            </div>
            <div className="mt-1 text-xs text-slate-500">{printerModel}</div>
            {!!printerSettingsId && (
              <div className="mt-1 text-xs text-slate-500">打印机配置：{printerSettingsId}</div>
            )}
            {!!printSettingsId && (
              <div className="mt-1 text-xs text-slate-500">切片配置：{printSettingsId}</div>
            )}
            {!!bedType && (
              <div className="mt-1 text-xs text-slate-500">热床类型：{bedType}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => profileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:bg-white hover:text-slate-950"
          >
            <Upload className="h-4 w-4" />
            上传 3MF 打印参数
          </button>
        </div>
        <div className="text-xs leading-6 text-slate-500">
          可上传你自己的 `.3mf` 作为打印模板。程序会读取其中的打印参数、打印机信息和打印盘尺寸，并用于之后导出的所有 3MF。
        </div>
      </div>

      <input
        ref={profileInputRef}
        type="file"
        accept=".3mf,model/3mf,application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) {
            onImport3mfProfile(file)
          }
          event.target.value = ''
        }}
      />

      <div className="grid gap-3 rounded-[20px] bg-slate-50 p-4 md:grid-cols-3">
        <NumberField
          label="打印盘长度"
          value={settings.depthMm}
          min={80}
          max={500}
          step={1}
          onChange={(value) => onUpdateSettings({ depthMm: value })}
        />
        <NumberField
          label="打印盘宽度"
          value={settings.widthMm}
          min={80}
          max={500}
          step={1}
          onChange={(value) => onUpdateSettings({ widthMm: value })}
        />
        <NumberField
          label="模型间距"
          value={settings.spacingMm}
          min={0}
          max={40}
          step={1}
          onChange={(value) => onUpdateSettings({ spacingMm: value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <StatCard
          icon={Ruler}
          label="打印盘尺寸"
          value={`${layout.widthMm.toFixed(0)} × ${layout.depthMm.toFixed(0)} mm`}
        />
        <StatCard
          icon={ScanLine}
          label="边缘留白"
          value={`${layout.edgeMarginMm.toFixed(1)} mm`}
        />
        <StatCard
          icon={LayoutGrid}
          label="打印板数量"
          value={`${Math.max(layout.plates.length, items.length ? 1 : 0)}`}
        />
        <StatCard
          icon={Maximize2}
          label="当前状态"
          value={layout.overflowCount > 0 ? `超出 ${layout.overflowCount} 项` : `自动分配到 ${Math.max(layout.plates.length, 1)} 个打印板`}
          valueClassName={layout.overflowCount > 0 ? 'text-rose-600' : 'text-emerald-600'}
        />
      </div>

      <div className="overflow-hidden rounded-[20px] border border-slate-200 bg-slate-50">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <div className="text-xs font-medium text-slate-700">单 3MF 摆盘预览</div>
          <div className="flex items-center gap-2">
            {onFullPreview && (
              <button
                type="button"
                onClick={onFullPreview}
                className="inline-flex items-center gap-1.5 rounded-xl bg-[#0088ff] px-3 py-1.5 text-xs font-medium text-white transition hover:bg-[#0077e0]"
              >
                <LayoutGrid className="h-3.5 w-3.5" />
                完整预览
              </button>
            )}
            <div className="text-[11px] text-slate-500">
              {batchCount > 1 ? '预览模式仅处理当前图片' : '单图模式下会按打印盘中心摆放'}
            </div>
          </div>
        </div>

        <div className="relative bg-[#eef4fb] p-4">
          {processing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 backdrop-blur-sm">
              <div className="inline-flex items-center gap-2 rounded-full bg-slate-950 px-4 py-2 text-xs font-medium text-white">
                <LoaderCircle className="h-4 w-4 animate-spin" />
                正在生成摆盘预览
              </div>
            </div>
          )}

          {!items.length && !processing && (
            <div className="flex min-h-[220px] items-center justify-center rounded-[18px] border border-dashed border-slate-300 bg-white/80 text-sm text-slate-500">
              导入素材后，这里会显示单 3MF 的摆盘结果。
            </div>
          )}

          {!!items.length && (
            <div className="grid gap-4 md:grid-cols-2">
              {layout.plates.map((plate) => (
                <div key={plate.plateIndex} className="overflow-hidden rounded-[18px] border border-slate-300 bg-white shadow-inner">
                  <div className="border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs font-medium text-slate-600">
                    打印板 {plate.plateIndex + 1}
                  </div>
                  <div style={{ aspectRatio: `${layout.widthMm} / ${layout.depthMm}` }}>
                    <svg
                      viewBox={`0 0 ${layout.widthMm} ${layout.depthMm}`}
                      className="h-full w-full"
                      role="img"
                      aria-label={`打印板 ${plate.plateIndex + 1} 摆盘预览`}
                    >
                      <rect x="0" y="0" width={layout.widthMm} height={layout.depthMm} fill="#f8fbff" />
                      <rect
                        x={layout.edgeMarginMm}
                        y={layout.edgeMarginMm}
                        width={Math.max(0, layout.widthMm - layout.edgeMarginMm * 2)}
                        height={Math.max(0, layout.depthMm - layout.edgeMarginMm * 2)}
                        fill="none"
                        stroke="#cbd5e1"
                        strokeDasharray="3 3"
                      />

                      {plate.placements.map((placement) => {
                        const item = items.find((entry) => entry.id === placement.id)
                        const stroke = !placement.fits ? '#e11d48' : item?.isActive ? '#0088ff' : '#64748b'
                        const fill = !placement.fits ? '#ffe4e6' : '#ffffff'
                        const labelText = items.length > 1
                          ? String(items.findIndex((entry) => entry.id === placement.id) + 1)
                          : ''
                        // 翻转 Y 轴：3MF 坐标系 Y=0 在底部，SVG Y=0 在顶部，
                        // 需要翻转使预览与 3MF 输出一致（左下角起始）。
                        const flippedY = layout.depthMm - placement.yMm - placement.heightMm
                        // 编号字号自适应方格尺寸，取宽高较小者的 40%
                        const fontSize = Math.min(placement.widthMm, placement.heightMm) * 0.4

                        return (
                          <g key={`${plate.plateIndex}-${placement.id}`}>
                            <rect
                              x={placement.xMm}
                              y={flippedY}
                              width={placement.widthMm}
                              height={placement.heightMm}
                              rx="2"
                              ry="2"
                              fill={fill}
                              stroke={stroke}
                              strokeWidth={item?.isActive ? 2 : 1.2}
                            />
                            {labelText && (
                              <text
                                x={placement.xMm + placement.widthMm / 2}
                                y={flippedY + placement.heightMm / 2 + fontSize * 0.35}
                                fontSize={fontSize}
                                fill={stroke}
                                fontWeight="700"
                                textAnchor="middle"
                              >
                                {labelText}
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </svg>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {(error || layout.overflowCount > 0) && (
          <div className="border-t border-slate-200 bg-white px-4 py-3 text-xs">
            {error && <div className="text-rose-600">{error}</div>}
            {!error && layout.overflowCount > 0 && (
              <div className="text-rose-600">
                当前有 {layout.overflowCount} 项本身尺寸就超过打印盘范围。可以增大打印盘尺寸，或者减小底板尺寸。
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label className="space-y-1 text-[11px] text-slate-500">
      {label}
      <div className="relative">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 pr-10 text-sm font-medium text-slate-800 outline-none transition focus:border-sky-400"
        />
        <div className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11px] text-slate-400">
          mm
        </div>
      </div>
    </label>
  )
}

function StatCard({
  icon: Icon,
  label,
  value,
  valueClassName,
}: {
  icon: typeof Ruler
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="rounded-[18px] bg-slate-50 px-4 py-4">
      <div className="inline-flex items-center gap-2 text-[11px] font-medium text-slate-500">
        <Icon className="h-4 w-4" />
        {label}
      </div>
      <div className={`mt-2 text-sm font-semibold text-slate-950 ${valueClassName ?? ''}`}>{value}</div>
    </div>
  )
}
