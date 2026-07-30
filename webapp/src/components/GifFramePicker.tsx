import { CheckSquare, Film, Square } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { GifFrameSource } from '@/types/generator'

interface GifFramePickerProps {
  fileName: string
  frames: GifFrameSource[]
  onCancel: () => void
  onConfirm: (frames: GifFrameSource[]) => void
}

export function GifFramePicker({ fileName, frames, onCancel, onConfirm }: GifFramePickerProps) {
  const [selectedFrames, setSelectedFrames] = useState<number[]>(() => frames.map((frame) => frame.frameIndex))
  const selectedSet = useMemo(() => new Set(selectedFrames), [selectedFrames])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-4 py-8 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-slate-200 bg-white shadow-[0_32px_120px_rgba(15,23,42,0.28)]">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-[11px] font-medium text-slate-500">
              <Film className="h-3.5 w-3.5" />
              GIF 模式
            </div>
            <h2 className="mt-3 text-lg font-semibold text-slate-950">选择需要处理的帧</h2>
            <p className="mt-1 text-sm text-slate-500">{fileName} 已拆出 {frames.length} 帧，默认全部勾选。</p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSelectedFrames(frames.map((frame) => frame.frameIndex))}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            >
              <CheckSquare className="h-4 w-4" />
              全选
            </button>
            <button
              type="button"
              onClick={() => setSelectedFrames([])}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            >
              <Square className="h-4 w-4" />
              清空
            </button>
          </div>
        </div>

        <div className="grid max-h-[60vh] grid-cols-2 gap-4 overflow-y-auto p-6 sm:grid-cols-3 lg:grid-cols-4">
          {frames.map((frame) => {
            const selected = selectedSet.has(frame.frameIndex)

            return (
              <button
                key={frame.frameIndex}
                type="button"
                onClick={() => setSelectedFrames((current) => (
                  current.includes(frame.frameIndex)
                    ? current.filter((index) => index !== frame.frameIndex)
                    : [...current, frame.frameIndex].sort((a, b) => a - b)
                ))}
                className={`overflow-hidden rounded-[22px] border text-left transition ${
                  selected ? 'border-sky-300 bg-sky-50 shadow-[0_12px_32px_rgba(0,136,255,0.08)]' : 'border-slate-200 bg-white hover:border-slate-300'
                }`}
              >
                <div className="aspect-square bg-slate-100 p-3">
                  <img src={frame.dataUrl} alt={`GIF 第 ${frame.frameIndex + 1} 帧`} className="h-full w-full rounded-2xl object-contain" />
                </div>
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-slate-900">第 {frame.frameIndex + 1} 帧</div>
                    <div className="mt-1 text-[11px] text-slate-500">{frame.width} × {frame.height}px</div>
                  </div>
                  <div className={`rounded-full px-2 py-1 text-[11px] font-medium ${selected ? 'bg-[#0088ff] text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {selected ? '已选' : '未选'}
                  </div>
                </div>
              </button>
            )
          })}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 px-6 py-5">
          <div className="text-sm text-slate-500">将导入 {selectedFrames.length} 帧到素材列表，之后可逐帧预览并批量导出。</div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onCancel}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
            >
              跳过这个 GIF
            </button>
            <button
              type="button"
              onClick={() => onConfirm(frames.filter((frame) => selectedSet.has(frame.frameIndex)))}
              disabled={!selectedFrames.length}
              className="rounded-2xl bg-[#0088ff] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition enabled:hover:bg-[#0077e0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              导入选中帧
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
