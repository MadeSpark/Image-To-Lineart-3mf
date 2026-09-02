import { Circle, Frame, RectangleHorizontal, ScanSearch, Scaling, Scissors, Sparkles, SwatchBook } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BaseplatePreset, BaseplateSettings, BaseTemplate, ImagePlacement, PrintBedSettings, RectangleSizeMode } from '@/types/generator'
import { cn } from '@/lib/utils'
import { calculateRectangleRatioLayout } from '@/utils/baseplate'

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
  sourceAspectRatio: number | null
  printBedSettings: PrintBedSettings
  onUpdateSettings: (patch: Partial<BaseplateSettings>) => void
  /** 一键预设（仅光映浮雕模式传入），渲染在底板模板选择上方 */
  presets?: BaseplatePreset[]
  onApplyPreset?: (preset: BaseplatePreset) => void
}

const rectangleSizeModes: Array<{ value: RectangleSizeMode; label: string }> = [
  { value: 'ratio', label: '比例模式' },
  { value: 'manual', label: '长宽模式' },
]

const imagePlacements: Array<{
  value: ImagePlacement
  label: string
  desc: string
  icon: typeof Frame
}> = [
  {
    value: 'fit',
    label: '等比适应',
    desc: '等比缩放完整显示在安全边距内',
    icon: Frame,
  },
  {
    value: 'center',
    label: '图片居中',
    desc: '保持原比例，在画布内最大化居中，不裁剪',
    icon: ScanSearch,
  },
  {
    value: 'stretch',
    label: '图片缩放',
    desc: '拉伸铺满安全边距内区域，比例可能变形',
    icon: Scaling,
  },
  {
    value: 'crop',
    label: '图片裁剪',
    desc: '从图片中间裁剪铺满安全边距内区域，保持比例',
    icon: Scissors,
  },
]

export function PalettePanel({ settings, sourceAspectRatio, printBedSettings, onUpdateSettings, presets, onApplyPreset }: PalettePanelProps) {
  const rectangleRatioLayout = sourceAspectRatio
    ? calculateRectangleRatioLayout(
      sourceAspectRatio,
      settings.rectangleScalePercent,
      printBedSettings,
      settings.marginMm,
    )
    : null
  const lowScaleWarning = settings.rectangleScalePercent < 35

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

      {presets && presets.length > 0 && onApplyPreset && (
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">
            <Sparkles className="h-3.5 w-3.5" />
            预设配置
            <span className="font-normal text-slate-400">（点击一键应用整组参数）</span>
          </div>
          <div className="grid gap-2">
            {presets.map((preset) => {
              const active =
                settings.template === preset.baseplate.template &&
                settings.imagePlacement === preset.baseplate.imagePlacement &&
                settings.widthMm === preset.baseplate.widthMm &&
                settings.heightMm === preset.baseplate.heightMm &&
                settings.marginMm === preset.baseplate.marginMm &&
                settings.rectangleSizeMode === preset.baseplate.rectangleSizeMode
              return (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => onApplyPreset(preset)}
                  className={cn(
                    'rounded-[22px] border p-4 text-left transition',
                    active
                      ? 'border-emerald-300 bg-emerald-50/60'
                      : 'border-amber-200 bg-amber-50/50 hover:border-amber-300 hover:bg-amber-50',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Sparkles className={cn('h-4 w-4 shrink-0', active ? 'text-emerald-600' : 'text-amber-500')} />
                    <div className="text-sm font-semibold text-slate-900">{preset.name}</div>
                  </div>
                  <div className="mt-1 text-xs leading-5 text-slate-500">{preset.description}</div>
                </button>
              )
            })}
          </div>
        </div>
      )}

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
        {settings.template !== 'outline' && (
          <div className="space-y-2 text-[11px] text-slate-500">
            <div>底板规则</div>
            <div className="grid grid-cols-2 gap-2">
              {imagePlacements.map((placement) => {
                const Icon = placement.icon
                const selected = settings.imagePlacement === placement.value
                return (
                  <button
                    key={placement.value}
                    type="button"
                    onClick={() => onUpdateSettings({ imagePlacement: placement.value })}
                    className={cn(
                      'rounded-xl border px-3 py-2 text-left transition',
                      selected
                        ? 'border-sky-300 bg-sky-50 text-sky-700'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                    )}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <Icon className="h-3.5 w-3.5" />
                      {placement.label}
                    </div>
                    <div className="mt-1 text-[10px] leading-4 text-slate-400">{placement.desc}</div>
                  </button>
                )
              })}
            </div>
          </div>
        )}
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
          value={settings.widthMm}
          min={20}
          max={500}
          step={1}
          disabled={settings.template !== 'rectangle' || settings.rectangleSizeMode === 'ratio'}
          onChange={(value) => onUpdateSettings({ widthMm: value })}
        />
        <NumberField
          label="矩形宽度"
          suffix="mm"
          value={settings.heightMm}
          min={20}
          max={500}
          step={1}
          disabled={settings.template !== 'rectangle' || settings.rectangleSizeMode === 'ratio'}
          onChange={(value) => onUpdateSettings({ heightMm: value })}
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
          min={0}
          max={20}
          step={0.5}
          disabled={settings.template === 'outline'}
          onChange={(value) => onUpdateSettings({ marginMm: value })}
        />
        {settings.template === 'rectangle' && (
          <>
            <div className="space-y-2 text-[11px] text-slate-500">
              <div>矩形计算方式</div>
              <div className="grid grid-cols-2 gap-2">
                {rectangleSizeModes.map((mode) => {
                  const selected = settings.rectangleSizeMode === mode.value
                  return (
                    <button
                      key={mode.value}
                      type="button"
                      onClick={() => onUpdateSettings({ rectangleSizeMode: mode.value })}
                      className={cn(
                        'rounded-xl border px-3 py-2 text-xs font-medium transition',
                        selected
                          ? 'border-sky-300 bg-sky-50 text-sky-700'
                          : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
                      )}
                    >
                      {mode.label}
                    </button>
                  )
                })}
              </div>
            </div>
            <NumberField
              label="比例百分比"
              suffix="%"
              value={settings.rectangleScalePercent}
              min={10}
              max={200}
              step={1}
              disabled={settings.rectangleSizeMode !== 'ratio'}
              onChange={(value) => onUpdateSettings({ rectangleScalePercent: value })}
            />
            {settings.rectangleSizeMode === 'ratio' && (
              <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs leading-6 text-slate-500">
                {sourceAspectRatio && rectangleRatioLayout ? (
                  <>
                    <div className="font-medium text-slate-700">
                      当前将按原图比例自动计算为 {rectangleRatioLayout.widthMm.toFixed(1)} × {rectangleRatioLayout.heightMm.toFixed(1)} mm
                    </div>
                    <div>基准可用范围：{rectangleRatioLayout.availableWidthMm.toFixed(1)} × {rectangleRatioLayout.availableHeightMm.toFixed(1)} mm</div>
                    {!rectangleRatioLayout.fitsPrintBed && (
                      <div className="text-rose-600">当前比例过大，已经超出打印板可用范围，请调低比例百分比或减小安全边距。</div>
                    )}
                    {lowScaleWarning && (
                      <div className="text-amber-700">当前比例偏小，虽然能生成，但会明显影响输出质量和细节保留。</div>
                    )}
                  </>
                ) : (
                  <div className="text-amber-700">比例模式需要先导入图片或 DXF，才能按原始长宽比自动计算矩形尺寸。</div>
                )}
              </div>
            )}
          </>
        )}
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
