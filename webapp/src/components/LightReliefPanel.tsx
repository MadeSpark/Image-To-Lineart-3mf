import { ImageUp, Sun, Upload, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { LightReliefBFaceMode, LightReliefSettings, SourceImage } from '@/types/generator'

interface LightReliefPanelProps {
  settings: LightReliefSettings
  /** halftone 模式下 B 面独立图片源 */
  sourceImageB: SourceImage | null
  /** 当前实际生效的 B 面模式（auto 检测后）：lineart / halftone */
  effectiveBFaceMode?: 'lineart' | 'halftone'
  onUpdateSettings: (patch: Partial<LightReliefSettings>) => void
  onUploadImageB: (file: File) => void
  onClearSourceB: () => void
}

const B_FACE_MODE_OPTIONS: Array<{ value: LightReliefBFaceMode; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'lineart', label: '双色线稿' },
  { value: 'halftone', label: '透光浮雕' },
]

export function LightReliefPanel({
  settings,
  sourceImageB,
  effectiveBFaceMode,
  onUpdateSettings,
  onUploadImageB,
  onClearSourceB,
}: LightReliefPanelProps) {
  const bImageInputRef = useRef<HTMLInputElement | null>(null)
  const isHalftone = (effectiveBFaceMode ?? (settings.bFaceMode === 'halftone' ? 'halftone' : 'lineart')) === 'halftone'

  return (
    <section className="space-y-4 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_18px_60px_rgba(15,23,42,0.05)]">
      <div className="flex items-center gap-2">
        <Sun className="h-4 w-4 text-slate-500" />
        <h2 className="text-sm font-semibold text-slate-950">光映浮雕参数</h2>
      </div>

      {/* B 面模式选择 */}
      <div className="space-y-2">
        <div className="text-xs font-medium text-slate-500">B 面模式</div>
        <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-slate-100 p-1">
          {B_FACE_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => {
                const patch: Partial<LightReliefSettings> = { bFaceMode: opt.value }
                // 切换到透光浮雕时，B 面高度默认 1mm 并确保总高度足够
                if (opt.value === 'halftone') {
                  if (settings.faceBHeightMm < 1) {
                    patch.faceBHeightMm = 1
                  }
                  const minTotal = settings.faceBZMm + 1
                  if (settings.totalHeightMm < minTotal) {
                    patch.totalHeightMm = minTotal
                  }
                }
                onUpdateSettings(patch)
              }}
              className={`rounded-xl px-2.5 py-1.5 text-xs font-medium transition ${
                settings.bFaceMode === opt.value
                  ? 'bg-white text-slate-950 shadow-[0_4px_12px_rgba(15,23,42,0.08)]'
                  : 'text-slate-500 hover:bg-white/70 hover:text-slate-800'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] leading-5 text-slate-500">
          {settings.bFaceMode === 'auto' && (
            <>
              自动检测：图片同时含黑色(0,0,0)和红色(255,0,0)时走双色线稿；未检测到红色时自动切换为透光浮雕。
              {effectiveBFaceMode && (
                <div className="mt-1.5 font-medium text-sky-700">
                  当前生效：{effectiveBFaceMode === 'halftone' ? '透光浮雕（未识别到红色 B 面数据）' : '双色线稿'}
                </div>
              )}
            </>
          )}
          {settings.bFaceMode === 'lineart' && (
            <>双色线稿：从同一张图提取黑色为 A 面、红色为 B 面线稿，B 面按线稿阴刻处理。</>
          )}
          {settings.bFaceMode === 'halftone' && (
            <>透光浮雕：导入 B 面图片，转为灰度按深浅打印厚度，深色区域厚（透光呈黑线条），浅色区域薄。</>
          )}
        </div>
      </div>

      {/* B 面透光浮雕参数（仅 halftone 生效时显示） */}
      {isHalftone && (
        <div className="space-y-3 rounded-[20px] border border-sky-200 bg-sky-50/40 p-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-sky-700">
            <ImageUp className="h-4 w-4" />
            B 面（透光浮雕）
          </div>

          {/* B 面图片上传 */}
          <div className="space-y-2">
            <input
              ref={bImageInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) onUploadImageB(file)
                event.target.value = ''
              }}
            />
            {sourceImageB ? (
              <div className="flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-3 py-2">
                <ImageUp className="h-4 w-4 shrink-0 text-slate-400" />
                <span className="flex-1 truncate text-xs text-slate-700">{sourceImageB.name}</span>
                <button
                  type="button"
                  onClick={onClearSourceB}
                  className="rounded-lg p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  aria-label="清除 B 面图片"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => bImageInputRef.current?.click()}
                className="flex w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white px-4 py-3 text-xs font-medium text-slate-600 transition hover:border-sky-300 hover:text-slate-900"
              >
                <Upload className="h-4 w-4" />
                导入 B 面图片
              </button>
            )}
            {!sourceImageB && (
              <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
                未识别到 B 面数据（图片不含红色 255,0,0）。请导入一张图片作为 B 面，系统将转为黑白灰度并按深浅打印厚度。
              </div>
            )}
          </div>

          {/* 曝光滑块 */}
          <SliderField
            label="曝光"
            min={0}
            max={200}
            step={5}
            value={settings.bFaceExposure}
            suffix="%"
            hint="调整图片曝光率，图片过暗时拉高曝光可增厚深色区域"
            onChange={(value) => onUpdateSettings({ bFaceExposure: value })}
          />

          {/* 反相开关 */}
          <label className="inline-flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
            <span>反相灰度（深浅互换）</span>
            <input
              type="checkbox"
              checked={settings.bFaceInvert}
              onChange={(event) => onUpdateSettings({ bFaceInvert: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff]"
            />
          </label>

          {/* 浮雕暴露开关 */}
          <label className="inline-flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
            <span>B 面浮雕暴露（省略顶盖）</span>
            <input
              type="checkbox"
              checked={settings.bFaceReverseStack}
              onChange={(event) => onUpdateSettings({ bFaceReverseStack: event.target.checked })}
              className="h-4 w-4 accent-[#0088ff]"
            />
          </label>
          {settings.bFaceReverseStack && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
              已开启浮雕暴露：原 B 面顶盖层（背景顶层）不再打印，浮雕 bumpy 顶面直接暴露在模型最顶部，透光率更佳。底座（背景下层）保留为贴热床实心基座。模型总高度可能减少。
            </div>
          )}

          {/* B 面高度过低提示 */}
          {settings.faceBHeightMm < 1 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
              B 面高度过低（当前 {settings.faceBHeightMm.toFixed(1)}mm），会影响黑白层次效果，建议≥1mm。透光浮雕模式默认 B 面高度 1mm。
            </div>
          )}
        </div>
      )}

      {/* Z 轴参数滑块区域 */}
      <div className="grid gap-4 rounded-[20px] bg-slate-50 p-4">
        <div className="text-xs font-medium text-slate-500">Z 轴分层</div>
        <SliderField
          label="模型总高度"
          min={0.2}
          max={20}
          step={0.1}
          value={settings.totalHeightMm}
          onChange={(value) => onUpdateSettings({ totalHeightMm: value })}
        />
        <SliderField
          label="A 面 Z 轴位置"
          min={0}
          max={Math.max(0, settings.totalHeightMm - settings.faceAHeightMm)}
          step={0.1}
          value={settings.faceAZMm}
          onChange={(value) => {
            const patch: Partial<LightReliefSettings> = { faceAZMm: value }
            const newTotal = value + settings.faceAHeightMm
            if (newTotal > settings.totalHeightMm) {
              patch.totalHeightMm = newTotal
            }
            onUpdateSettings(patch)
          }}
        />
        <SliderField
          label="A 面高度"
          min={0.1}
          max={Math.max(0.1, settings.totalHeightMm - settings.faceAZMm)}
          step={0.1}
          value={settings.faceAHeightMm}
          onChange={(value) => {
            const patch: Partial<LightReliefSettings> = { faceAHeightMm: value }
            const newTotal = settings.faceAZMm + value
            if (newTotal > settings.totalHeightMm) {
              patch.totalHeightMm = newTotal
            }
            onUpdateSettings(patch)
          }}
        />
        <SliderField
          label="B 面 Z 轴位置"
          min={0}
          max={20}
          step={0.1}
          value={settings.faceBZMm}
          onChange={(value) => {
            const patch: Partial<LightReliefSettings> = { faceBZMm: value }
            const newTotal = value + settings.faceBHeightMm
            if (newTotal > settings.totalHeightMm) {
              patch.totalHeightMm = Math.min(20, newTotal)
            }
            onUpdateSettings(patch)
          }}
        />
        <SliderField
          label="B 面高度"
          min={0.1}
          max={10}
          step={0.1}
          value={settings.faceBHeightMm}
          onChange={(value) => {
            const patch: Partial<LightReliefSettings> = { faceBHeightMm: value }
            const newTotal = settings.faceBZMm + value
            if (newTotal > settings.totalHeightMm) {
              patch.totalHeightMm = Math.min(20, newTotal)
            }
            onUpdateSettings(patch)
          }}
        />
      </div>

      <div className="rounded-[18px] border border-slate-200 bg-slate-50 px-4 py-4">
        <div className="inline-flex items-center gap-2 text-xs font-medium text-slate-500">
          <Sun className="h-4 w-4" />
          光映浮雕打印说明
        </div>
        <p className="mt-2 text-xs leading-6 text-slate-500">
          模型按 Z 轴分四层：耗材1（黑）打印 A 面线稿，耗材2（白）打印背景与填充；B 面按所选模式处理（双色线稿阴刻或透光浮雕灰度厚度）。
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
  suffix = '',
  hint,
  onChange,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  suffix?: string
  hint?: string
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
          {draftValue.toFixed(1)}{suffix}
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
      {hint && (
        <div className="text-[11px] leading-5 text-slate-400">{hint}</div>
      )}
    </label>
  )
}
