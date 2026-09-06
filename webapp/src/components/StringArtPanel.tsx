import { CircleDotDashed, Layers3, Printer } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { StringArtSettings } from '@/types/generator'

interface StringArtPanelProps {
  settings: StringArtSettings
  layerHeightMm: number
  onUpdateSettings: (patch: Partial<StringArtSettings>) => void
}

function SliderField({ label, value, min, max, step, suffix, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  suffix: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draft !== value) onChange(draft)
  }

  return (
    <label className="block space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>{label}</span>
        <span className="rounded-full bg-white px-2 py-1 font-medium text-slate-800">{draft.toFixed(step < 1 ? 2 : 0)} {suffix}</span>
      </div>
      <input
        className="h-2 w-full accent-[#0088ff]"
        type="range"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(Number(event.target.value))}
        onMouseUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  )
}

export function StringArtPanel({ settings, layerHeightMm, onUpdateSettings }: StringArtPanelProps) {
  const modelHeightMm = settings.edgeHeightMm * 2 + settings.layerCount * layerHeightMm
  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div>
        <h2 className="text-sm font-semibold text-slate-950">分层弦丝画</h2>
        <p className="mt-1 text-xs text-slate-500">每层弦线彼此不相交；增加层数可承载更多直线弦段并提升图像细节。</p>
      </div>

      <div className="grid gap-4 rounded-[20px] bg-slate-50 p-4">
        <SliderField label="圆圈半径" value={settings.radiusMm} min={20} max={200} step={1} suffix="mm" onChange={(value) => onUpdateSettings({ radiusMm: value })} />
        <SliderField label="弦丝层数" value={settings.layerCount} min={1} max={50} step={1} suffix="层" onChange={(value) => onUpdateSettings({ layerCount: value })} />
        <SliderField label="底层/顶层增高" value={settings.edgeHeightMm} min={0.1} max={3} step={0.1} suffix="mm" onChange={(value) => onUpdateSettings({ edgeHeightMm: value })} />
      </div>

      <div className="flex items-center justify-between rounded-[18px] border border-sky-100 bg-sky-50 px-4 py-3 text-xs">
        <span className="text-slate-600">自动模型高度</span>
        <span className="font-semibold text-slate-950">{modelHeightMm.toFixed(2)} mm</span>
      </div>

      <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4 text-xs leading-6 text-slate-500">
        <div className="inline-flex items-center gap-2 font-medium text-slate-600"><CircleDotDashed className="h-4 w-4" />无底板、无锚钉</div>
        <p className="mt-2">圆周连接点只决定弦线端点，模型不会输出锚钉或填满圆内区域。每根弦会穿入圆墙外半部，与外框保留多条线宽的实体重叠，避免悬空终止。</p>
        <div className="mt-2 inline-flex items-center gap-2 font-medium text-slate-600"><Layers3 className="h-4 w-4" />层内不交叉</div>
        <p className="mt-1">算法会拒绝同层端点交错、共享端点或间距小于约 2.5 条线宽的弦段。弦段只能在不同高度相交，因此每一层都是可直接拉直的独立线集。</p>
        <div className="mt-2 inline-flex items-center gap-2 font-medium text-slate-600"><Printer className="h-4 w-4" />切片设置</div>
        <p className="mt-1">弦线宽度与层高直接读取当前导入的 3MF 打印配置。切片时建议启用 Arachne 墙生成器，并保持桥接/悬空线参数。</p>
      </div>
    </section>
  )
}
