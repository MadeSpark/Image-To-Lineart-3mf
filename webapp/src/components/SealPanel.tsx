import { Stamp } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CarvingMode, SealSettings } from '@/types/generator'
import { cn } from '@/lib/utils'

interface SealPanelProps {
  settings: SealSettings
  onUpdateSettings: (patch: Partial<SealSettings>) => void
}

const carvingOptions: Array<{ value: CarvingMode; label: string; desc: string }> = [
  {
    value: 'relief',
    label: '阳刻',
    desc: '线稿部分为凸起，印出来线稿是印泥颜色，背景为空白',
  },
  {
    value: 'intaglio',
    label: '阴刻',
    desc: '线稿部分为凹陷，印出来线稿是空白，背景为印泥颜色',
  },
]

export function SealPanel({ settings, onUpdateSettings }: SealPanelProps) {
  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-2">
        <Stamp className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">印章参数</h2>
      </div>

      <div className="space-y-4">
        <div>
          <label className="inline-flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
            <span>启用地板描边</span>
            <input
              type="checkbox"
              checked={settings.strokeEnabled}
              onChange={(event) => onUpdateSettings({ strokeEnabled: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff]"
            />
          </label>
          {settings.strokeEnabled && (
            <div className="mt-2">
              <SliderField
                label="描边宽度"
                min={0.5}
                max={5}
                step={0.5}
                value={settings.strokeWidthMm}
                onChange={(value) => onUpdateSettings({ strokeWidthMm: value })}
              />
            </div>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs text-slate-500">刻制方式</div>
          <div className="grid grid-cols-2 gap-2">
            {carvingOptions.map((option) => {
              const selected = option.value === settings.carvingMode
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onUpdateSettings({ carvingMode: option.value })}
                  className={cn(
                    'rounded-2xl border px-3 py-3 text-left transition',
                    selected
                      ? 'border-sky-300 bg-sky-50 text-sky-700 shadow-[0_6px_16px_rgba(0,136,255,0.12)]'
                      : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                  )}
                >
                  <div className="text-sm font-semibold">{option.label}</div>
                  <div className="mt-1 text-[11px] leading-4 text-slate-500">{option.desc}</div>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="grid gap-4 rounded-[20px] bg-slate-50 p-4">
        <SliderField
          label="印章高度"
          min={0.1}
          max={80}
          step={0.1}
          value={settings.sealHeightMm}
          onChange={(value) => onUpdateSettings({ sealHeightMm: value })}
        />
        <SliderField
          label="刻印高度差"
          min={0.1}
          max={5}
          step={0.1}
          value={settings.engravingHeightDiffMm}
          onChange={(value) => onUpdateSettings({ engravingHeightDiffMm: value })}
        />
      </div>

      <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4">
        <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
          <Stamp className="h-4 w-4" />
          印章打印说明
        </div>
        <p className="mt-2 text-xs leading-6 text-slate-500">
          印章高度为底板整体厚度；刻印高度差为阴阳面的高度差值。阳刻时线稿凸起，阴刻时线稿凹陷。
        </p>
      </div>
    </section>
  )
}

function SliderField({
  label,
  min,
  max,
  step,
  value,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
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
        <span className="rounded-full bg-white px-2 py-1 font-medium text-slate-800">{draftValue.toFixed(1)} mm</span>
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