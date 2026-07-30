import { Box, Ruler, Wand2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ExtrudeSettings } from '@/types/generator'

interface ThicknessPanelProps {
  settings: ExtrudeSettings
  onUpdateSettings: (patch: Partial<ExtrudeSettings>) => void
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
        <span className="rounded-full bg-white px-2 py-1 font-medium text-slate-800">{draftValue.toFixed(2)} mm</span>
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

export function ThicknessPanel({ settings, onUpdateSettings }: ThicknessPanelProps) {
  const totalModelHeight = settings.lineHeightMm + settings.lineThicknessMm

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div>
        <h2 className="text-sm font-semibold text-slate-950">打印参数</h2>
        <p className="mt-1 text-xs text-slate-500">这里的“厚度”和“高度”只管 3D 叠层，不再影响线条在平面里的宽窄。</p>
      </div>

      <div className="grid gap-4 rounded-[20px] bg-slate-50 p-4">
        <SliderField
          label="底板厚度"
          min={0}
          max={3}
          step={0.05}
          value={settings.baseThicknessMm}
          onChange={(value) => onUpdateSettings({ baseThicknessMm: value })}
        />
        <SliderField
          label="线稿厚度"
          min={0}
          max={2}
          step={0.05}
          value={settings.lineThicknessMm}
          onChange={(value) => onUpdateSettings({ lineThicknessMm: value })}
        />
        <SliderField
          label="线稿高度"
          min={0}
          max={3}
          step={0.05}
          value={settings.lineHeightMm}
          onChange={(value) => onUpdateSettings({ lineHeightMm: value })}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
            <Box className="h-4 w-4" />
            当前默认
          </div>
          <p className="mt-2 text-xs leading-6 text-slate-500">
            默认是底板 `0-0.2 mm`，线稿 `0.2-0.4 mm`。也就是底板厚度 0.2 mm、线稿高度 0.2 mm、线稿厚度 0.2 mm。
          </p>
        </div>
        <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
            <Ruler className="h-4 w-4" />
            尺寸逻辑
          </div>
          <p className="mt-2 text-xs leading-6 text-slate-500">
            线稿高度表示线稿层从模型底部开始的高度位置，线稿厚度表示这层本身再向上长多少。
          </p>
        </div>
        <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4">
          <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
            <Wand2 className="h-4 w-4" />
            实用建议
          </div>
          <p className="mt-2 text-xs leading-6 text-slate-500">
            当前模型最高点是 `线稿高度 + 线稿厚度 = {totalModelHeight.toFixed(2)} mm`。如果你想让线稿更粗，请改左侧“线条宽度”，不是这里的“线稿厚度”。
          </p>
        </div>
      </div>
    </section>
  )
}
