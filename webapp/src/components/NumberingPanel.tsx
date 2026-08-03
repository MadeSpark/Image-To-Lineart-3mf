import { Hash } from 'lucide-react'
import type { NumberingSettings } from '@/types/generator'
import { cn } from '@/lib/utils'

interface NumberingPanelProps {
  settings: NumberingSettings
  batchCount: number
  onUpdateSettings: (patch: Partial<NumberingSettings>) => void
}

const horizontalAligns: Array<{ value: NumberingSettings['horizontalAlign']; label: string }> = [
  { value: 'left', label: '左' },
  { value: 'center', label: '中' },
  { value: 'right', label: '右' },
]

const verticalAligns: Array<{ value: NumberingSettings['verticalAlign']; label: string }> = [
  { value: 'top', label: '上' },
  { value: 'center', label: '中' },
  { value: 'bottom', label: '下' },
]

export function NumberingPanel({ settings, batchCount, onUpdateSettings }: NumberingPanelProps) {
  const previewEndNumber = settings.startNumber + Math.max(0, batchCount - 1)

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">编号模式</h2>
          <p className="mt-1 text-xs text-slate-500">开启后按文件顺序在线稿上生成数字编号，方便批量识别。</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={settings.enabled}
          onClick={() => onUpdateSettings({ enabled: !settings.enabled })}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition',
            settings.enabled ? 'bg-[#0088ff]' : 'bg-slate-200',
          )}
        >
          <span
            className={cn(
              'inline-block h-4 w-4 transform rounded-full bg-white shadow transition',
              settings.enabled ? 'translate-x-6' : 'translate-x-1',
            )}
          />
        </button>
      </div>

      {settings.enabled && (
        <>
          <div className="grid gap-3 rounded-[20px] bg-slate-50 p-4">
            <NumberField
              label="起始编号"
              value={settings.startNumber}
              min={0}
              max={9999}
              step={1}
              onChange={(value) => onUpdateSettings({ startNumber: value })}
            />
            <NumberField
              label="字号高度"
              suffix="mm"
              value={settings.fontSizeMm}
              min={2}
              max={30}
              step={0.5}
              onChange={(value) => onUpdateSettings({ fontSizeMm: value })}
            />
            <NumberField
              label="边距"
              suffix="mm"
              value={settings.marginMm}
              min={0.5}
              max={20}
              step={0.5}
              onChange={(value) => onUpdateSettings({ marginMm: value })}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <AlignField
              label="水平位置"
              options={horizontalAligns}
              value={settings.horizontalAlign}
              onChange={(value) => onUpdateSettings({ horizontalAlign: value })}
            />
            <AlignField
              label="垂直位置"
              options={verticalAligns}
              value={settings.verticalAlign}
              onChange={(value) => onUpdateSettings({ verticalAlign: value })}
            />
          </div>

          <div className="rounded-[18px] bg-slate-50 px-4 py-3 text-xs text-slate-500">
            <div className="inline-flex items-center gap-2 font-medium text-slate-700">
              <Hash className="h-4 w-4" />
              编号预览
            </div>
            <p className="mt-2 leading-6">
              {batchCount > 0
                ? `当前 ${batchCount} 个素材，编号范围为 ${settings.startNumber} – ${previewEndNumber}。`
                : '导入素材后，编号会按文件顺序自动生成。'}
            </p>
          </div>
        </>
      )}
    </section>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix?: string
  onChange: (value: number) => void
}) {
  return (
    <label className="space-y-1 text-[11px] text-slate-500">
      {label}
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none transition focus:border-sky-400"
        />
        {suffix && <div className="min-w-8 text-right text-[11px] text-slate-400">{suffix}</div>}
      </div>
    </label>
  )
}

function AlignField<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ value: T; label: string }>
  value: T
  onChange: (value: T) => void
}) {
  return (
    <div className="space-y-2 text-[11px] text-slate-500">
      <div>{label}</div>
      <div className="grid grid-cols-3 gap-1.5">
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange(option.value)}
              className={cn(
                'rounded-xl border px-2 py-2 text-xs font-medium transition',
                selected
                  ? 'border-sky-300 bg-sky-50 text-sky-700'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
