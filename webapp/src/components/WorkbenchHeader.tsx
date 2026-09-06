import { ChevronDown, Download, FileArchive, GitBranch, ImageUp, Layers3, RotateCcw, Shapes, Stamp, Sun, Upload, Settings2, MoreHorizontal, Eye } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { WorkMode } from '@/types/generator'
import { cn } from '@/lib/utils'

interface WorkbenchHeaderProps {
  appVersion: string
  workMode: WorkMode
  onWorkModeChange: (mode: WorkMode) => void
  onExportSettings: () => void
  onImportSettings: (file: File) => void
  onExportJson: () => void
  onExportPreview: () => void
  onExport3mf: () => void
  onResetSettings: () => void
  canExport: boolean
}

const workModes: Array<{ value: WorkMode; label: string; icon: typeof Layers3 }> = [
  { value: 'filigree', label: '掐丝', icon: Layers3 },
  { value: 'seal', label: '印章', icon: Stamp },
  { value: 'light-relief', label: '光映浮雕', icon: Sun },
  { value: 'string-art', label: '弦丝画(开发中)', icon: GitBranch },
]

export function WorkbenchHeader({
  appVersion,
  workMode,
  onWorkModeChange,
  onExportSettings,
  onImportSettings,
  onExportJson,
  onExportPreview,
  onExport3mf,
  onResetSettings,
  canExport,
}: WorkbenchHeaderProps) {
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const settingsMenuRef = useRef<HTMLDivElement | null>(null)
  const exportMenuRef = useRef<HTMLDivElement | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target as Node)) {
        setSettingsOpen(false)
      }
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setExportOpen(false)
      }
    }
    if (settingsOpen || exportOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
    return undefined
  }, [settingsOpen, exportOpen])

  return (
    <header className="rounded-[28px] border border-slate-200 bg-white px-6 py-4 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="inline-flex shrink-0 items-center gap-2 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-[11px] font-medium tracking-[0.2em] text-sky-700">
            <Layers3 className="h-3.5 w-3.5" />
            线稿底板工作台
          </div>
          <div className="hidden h-8 w-px bg-slate-200 sm:block" />
          <div className="min-w-0">
            <h1 className="font-display text-[22px] leading-none text-slate-950">线稿底板生成器</h1>
            <p className="mt-1 hidden truncate text-xs text-slate-500 md:block">
              导入图片或 DXF，生成可调线稿、自动底板和独立对象 3MF
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <SegmentedGroup>
            {workModes.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.value}
                  type="button"
                  onClick={() => onWorkModeChange(item.value)}
                  className={cn(
                    'inline-flex items-center justify-center gap-1 rounded-[12px] px-2.5 py-1.5 text-xs font-medium transition',
                    workMode === item.value
                      ? 'bg-white text-slate-950 shadow-[0_4px_12px_rgba(15,23,42,0.08)]'
                      : 'text-slate-500 hover:bg-white/70 hover:text-slate-800',
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              )
            })}
          </SegmentedGroup>

          <div className="mx-1 hidden h-6 w-px bg-slate-200 lg:block" />

          <div className="flex items-center gap-1.5">
            <input
              ref={importInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) {
                  onImportSettings(file)
                }
                event.currentTarget.value = ''
              }}
            />

            <div ref={settingsMenuRef} className="relative">
              <button
                type="button"
                onClick={() => { setSettingsOpen((v) => !v); setExportOpen(false) }}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-950"
              >
                <Settings2 className="h-3.5 w-3.5" />
                设置
                <ChevronDown className={cn('h-3 w-3 transition', settingsOpen && 'rotate-180')} />
              </button>
              {settingsOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.12)]">
                  <MenuItem icon={RotateCcw} label="恢复默认配置" onClick={() => { onResetSettings(); setSettingsOpen(false) }} />
                  <MenuItem icon={Upload} label="导入参数" onClick={() => { importInputRef.current?.click(); setSettingsOpen(false) }} />
                  <MenuItem icon={Download} label="导出参数" onClick={() => { onExportSettings(); setSettingsOpen(false) }} />
                </div>
              )}
            </div>

            <div ref={exportMenuRef} className="relative">
              <button
                type="button"
                onClick={() => { setExportOpen((v) => !v); setSettingsOpen(false) }}
                disabled={!canExport}
                className="inline-flex items-center gap-1 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
                更多
                <ChevronDown className={cn('h-3 w-3 transition', exportOpen && 'rotate-180')} />
              </button>
              {exportOpen && (
                <div className="absolute right-0 top-full z-50 mt-2 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-[0_16px_48px_rgba(15,23,42,0.12)]">
                  <MenuItem icon={Eye} label="导出预览 PNG" onClick={() => { onExportPreview(); setExportOpen(false) }} disabled={!canExport} />
                  <MenuItem icon={Download} label="导出工程 JSON" onClick={() => { onExportJson(); setExportOpen(false) }} disabled={!canExport} />
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={onExport3mf}
              disabled={!canExport}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0088ff] px-3 py-1.5 text-xs font-semibold text-white shadow-[0_8px_24px_rgba(0,136,255,0.28)] transition hover:bg-[#0077e0] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FileArchive className="h-3.5 w-3.5" />
              导出 3MF
            </button>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1">
          <ImageUp className="h-3 w-3" />
          上传图片或导入 DXF 即可开始
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-50 px-2 py-1">v{appVersion}</span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-50 px-2.5 py-1">
          <Shapes className="h-3 w-3" />
          底板与线稿独立对象导出
        </span>
      </div>
    </header>
  )
}

function SegmentedGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-0.5 rounded-xl bg-slate-100 p-0.5">
      {children}
    </div>
  )
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: typeof RotateCcw
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Icon className="h-3.5 w-3.5 text-slate-500" />
      {label}
    </button>
  )
}
