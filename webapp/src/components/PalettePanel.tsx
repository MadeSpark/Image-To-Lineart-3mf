import { Circle, RectangleHorizontal, ScanSearch, SwatchBook } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BaseplateSettings, BaseTemplate } from '@/types/generator'
import { cn } from '@/lib/utils'

const templates: Array<{
  value: BaseTemplate
  title: string
  desc: string
  icon: typeof ScanSearch
}> = [
  {
    value: 'outline',
    title: '轮廓底板',
    desc: '默认基于线稿轮廓生成，并支持外扩尺寸。',
    icon: ScanSearch,
  },
  {
    value: 'rectangle',
    title: '矩形模板',
    desc: '默认 50 × 50 mm，可继续调整长宽。',
    icon: RectangleHorizontal,
  },
  {
    value: 'circle',
    title: '圆形模板',
    desc: '默认直径 50 mm，适合挂件和徽章。',
    icon: Circle,
  },
]

interface PalettePanelProps {
  settings: BaseplateSettings
  onUpdateSettings: (patch: Partial<BaseplateSettings>) => void
}

export function PalettePanel({ settings, onUpdateSettings }: PalettePanelProps) {
  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-950">底板模板与颜色</h2>
          <p className="mt-1 text-xs text-slate-500">切换底板时会自动按比例缩放并居中线稿，保持版面关系稳定。</p>
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
          {settings.template === 'outline' ? '自动轮廓' : settings.template === 'rectangle' ? '矩形' : '圆形'}
        </div>
      </div>

      <div className="grid gap-3">
        {templates.map((template) => {
          const Icon = template.icon
          const selected = settings.template === template.value
          return (
            <button
              key={template.value}
              type="button"
              onClick={() => onUpdateSettings({ template: template.value })}
              className={cn(
                'rounded-[22px] border p-4 text-left transition',
                selected ? 'border-sky-300 bg-sky-50/60' : 'border-slate-200 bg-slate-50 hover:border-slate-300',
              )}
            >
              <div className="flex items-start gap-3">
                <div className={cn(
                  'rounded-2xl p-3 text-white shadow-[0_12px_26px_rgba(15,23,42,0.12)]',
                  selected ? 'bg-[#0088ff]' : 'bg-slate-900',
                )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-sm font-semibold text-slate-900">{template.title}</div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">{template.desc}</div>
                </div>
              </div>
            </button>
          )
        })}
      </div>

      <div className="grid gap-3 rounded-[20px] bg-slate-50 p-4">
        <NumberField
          label="轮廓外扩"
          suffix="mm"
          value={settings.expandMm}
          min={0}
          max={12}
          step={0.2}
          disabled={settings.template !== 'outline'}
          onChange={(value) => onUpdateSettings({ expandMm: value })}
        />
        <NumberField
          label="矩形长度"
          suffix="mm"
          value={settings.heightMm}
          min={20}
          max={200}
          step={1}
          disabled={settings.template !== 'rectangle'}
          onChange={(value) => onUpdateSettings({ heightMm: value })}
        />
        <NumberField
          label="矩形宽度"
          suffix="mm"
          value={settings.widthMm}
          min={20}
          max={200}
          step={1}
          disabled={settings.template !== 'rectangle'}
          onChange={(value) => onUpdateSettings({ widthMm: value })}
        />
        <NumberField
          label="圆形直径"
          suffix="mm"
          value={settings.diameterMm}
          min={20}
          max={200}
          step={1}
          disabled={settings.template !== 'circle'}
          onChange={(value) => onUpdateSettings({ diameterMm: value })}
        />
        <NumberField
          label="安全边距"
          suffix="mm"
          value={settings.marginMm}
          min={1}
          max={20}
          step={0.5}
          disabled={settings.template === 'outline'}
          onChange={(value) => onUpdateSettings({ marginMm: value })}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <ColorField
          label="线稿颜色"
          value={settings.lineColor}
          onChange={(value) => onUpdateSettings({ lineColor: value })}
        />
        <ColorField
          label="底板颜色"
          value={settings.baseColor}
          onChange={(value) => onUpdateSettings({ baseColor: value })}
        />
      </div>

      <div className="rounded-[18px] bg-slate-50 px-4 py-3 text-xs text-slate-500">
        <div className="inline-flex items-center gap-2 font-medium text-slate-700">
          <SwatchBook className="h-4 w-4" />
          使用建议
        </div>
        <p className="mt-2 leading-6">
          如果你要直接进拓竹等切片软件，建议把线稿和底板颜色先设置成最终打算分配的两种耗材颜色，这样 3MF 导入后更容易辨认对象。
        </p>
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
  suffix,
  disabled,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  disabled: boolean
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
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none transition focus:border-sky-400 disabled:cursor-not-allowed disabled:bg-slate-100"
        />
        <div className="min-w-12 text-right text-[11px] text-slate-400">{suffix}</div>
      </div>
    </label>
  )
}

function ColorField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
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
  const swatchValue = /^#(?:[0-9a-fA-F]{3}){1,2}$/.test(draftValue)
    ? draftValue
    : value

  return (
    <label className="rounded-[18px] border border-slate-200 bg-slate-50 p-4 text-[11px] text-slate-500">
      <div className="mb-3 font-medium text-slate-700">{label}</div>
      <div className="grid grid-cols-[auto_1fr] items-center gap-3">
        <div className="rounded-2xl border border-slate-200 bg-white p-2">
          <input
            type="color"
            value={swatchValue}
            onChange={(event) => setDraftValue(event.target.value)}
            onMouseUp={commitValue}
            onTouchEnd={commitValue}
            onKeyUp={commitValue}
            onBlur={commitValue}
            className="h-9 w-10 cursor-pointer rounded-xl border-0 bg-transparent p-0"
          />
        </div>
        <input
          value={draftValue}
          onChange={(event) => setDraftValue(event.target.value)}
          onBlur={commitValue}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitValue()
            }
          }}
          className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-800 outline-none transition focus:border-sky-400"
        />
      </div>
    </label>
  )
}
