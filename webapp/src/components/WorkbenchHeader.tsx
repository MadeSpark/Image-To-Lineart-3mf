import { Download, Eye, FileArchive, ImageUp, Layers3, RotateCcw, Shapes } from 'lucide-react'
import type { BaseTemplate, PreviewMode } from '@/types/generator'
import { cn } from '@/lib/utils'

const modes: PreviewMode[] = ['原图', '线稿', '底板预览', '分层预览']
const templates: Array<{ value: BaseTemplate; label: string }> = [
  { value: 'outline', label: '轮廓底板' },
  { value: 'rectangle', label: '矩形底板' },
  { value: 'circle', label: '圆形底板' },
]

interface WorkbenchHeaderProps {
  previewMode: PreviewMode
  template: BaseTemplate
  onPreviewModeChange: (mode: PreviewMode) => void
  onTemplateChange: (template: BaseTemplate) => void
  onExportJson: () => void
  onExportPreview: () => void
  onExport3mf: () => void
  onResetSettings: () => void
  canExport: boolean
}

export function WorkbenchHeader({
  previewMode,
  template,
  onPreviewModeChange,
  onTemplateChange,
  onExportJson,
  onExportPreview,
  onExport3mf,
  onResetSettings,
  canExport,
}: WorkbenchHeaderProps) {
  return (
    <header className="rounded-[28px] border border-slate-200 bg-white px-6 py-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-medium tracking-[0.24em] text-sky-700">
            <Layers3 className="h-3.5 w-3.5" />
            线稿底板工作台
          </div>
          <div>
            <h1 className="font-display text-[30px] leading-none text-slate-950">线稿底板生成器</h1>
            <p className="mt-2 max-w-2xl text-sm text-slate-500">
              导入图片或 DXF，生成可调线稿、自动底板和独立对象 3MF。目标是让底板与线稿能在切片软件里分别分配耗材。
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3 md:flex-row md:items-center">
          <div className="grid grid-cols-3 gap-2 rounded-2xl bg-slate-100 p-1">
            {templates.map((item) => (
              <button
                key={item.value}
                type="button"
                onClick={() => onTemplateChange(item.value)}
                className={cn(
                  'rounded-[14px] px-3 py-2 text-xs font-medium transition',
                  template === item.value
                    ? 'bg-white text-slate-950 shadow-[0_6px_16px_rgba(15,23,42,0.08)]'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                )}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-slate-100 p-1 md:grid-cols-4">
            {modes.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onPreviewModeChange(mode)}
                className={cn(
                  'rounded-[14px] px-3 py-2 text-xs font-medium transition',
                  previewMode === mode
                    ? 'bg-white text-slate-950 shadow-[0_6px_16px_rgba(15,23,42,0.08)]'
                    : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                )}
              >
                {mode}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onResetSettings}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              <RotateCcw className="h-4 w-4" />
              恢复默认配置
            </button>
            <button
              type="button"
              onClick={onExportPreview}
              disabled={!canExport}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            >
              <Eye className="h-4 w-4" />
              导出预览
            </button>
            <button
              type="button"
              onClick={onExportJson}
              disabled={!canExport}
              className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition enabled:hover:border-slate-300 enabled:hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              导出方案
            </button>
            <button
              type="button"
              onClick={onExport3mf}
              disabled={!canExport}
              className="inline-flex items-center gap-2 rounded-2xl bg-[#0088ff] px-4 py-2 text-sm font-medium text-white shadow-[0_14px_32px_rgba(0,136,255,0.28)] transition enabled:hover:bg-[#0077e0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileArchive className="h-4 w-4" />
              导出 3MF
            </button>
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5">
          <ImageUp className="h-3.5 w-3.5" />
          上传图片或导入 DXF 即可开始
        </div>
        <div className="rounded-full bg-slate-100 px-3 py-1.5">桌面优先工作台</div>
        <div className="rounded-full bg-slate-100 px-3 py-1.5">纯色扁平界面</div>
        <div className="inline-flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1.5">
          <Shapes className="h-3.5 w-3.5" />
          底板与线稿独立对象导出
        </div>
      </div>
    </header>
  )
}
