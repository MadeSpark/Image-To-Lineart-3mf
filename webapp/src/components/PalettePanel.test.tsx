import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PalettePanel } from '@/components/PalettePanel'
import { defaultBaseplateSettings } from '@/stores/generatorStore'
import type { BaseplatePreset, PrintBedSettings } from '@/types/generator'

const printBedSettings: PrintBedSettings = { widthMm: 256, depthMm: 256 }

// 与 Home.tsx 中 LIGHT_RELIEF_PRESETS 保持一致（3:2 预设）
const lightReliefPreset: BaseplatePreset = {
  name: '3:2',
  description: '底板 矩形模板 · 图片裁剪 · 150×100mm · 安全边距 2mm · 长宽模式 · 模型总高 2mm（A 面 0.2mm / B 面 1.7mm）',
  baseplate: {
    template: 'rectangle',
    imagePlacement: 'crop',
    widthMm: 150,
    heightMm: 100,
    marginMm: 2,
    rectangleSizeMode: 'manual',
  },
  lightRelief: {
    totalHeightMm: 2,
    faceAZMm: 0,
    faceAHeightMm: 0.2,
    faceBZMm: 0.3,
    faceBHeightMm: 1.7,
  },
}

function renderPanel(presets?: BaseplatePreset[], onApplyPreset?: (preset: BaseplatePreset) => void) {
  return render(
    <PalettePanel
      settings={{ ...defaultBaseplateSettings }}
      sourceAspectRatio={null}
      printBedSettings={printBedSettings}
      onUpdateSettings={vi.fn()}
      presets={presets}
      onApplyPreset={onApplyPreset}
    />,
  )
}

describe('PalettePanel 一键预设区块', () => {
  afterEach(cleanup)

  it('传入 presets 时在底板模板选择上方渲染预设卡片', () => {
    renderPanel([lightReliefPreset], vi.fn())

    expect(screen.getByText('预设配置')).toBeTruthy()
    const presetButton = screen.getByRole('button', { name: /3:2/ })
    // 预设区块必须排在底板模板（轮廓底板）按钮之前
    const allButtons = screen.getAllByRole('button')
    expect(allButtons.indexOf(presetButton)).toBeLessThan(allButtons.findIndex((b) => b.textContent?.includes('轮廓底板')))
  })

  it('点击预设卡片回调携带完整补丁数据', () => {
    const onApplyPreset = vi.fn()
    renderPanel([lightReliefPreset], onApplyPreset)

    fireEvent.click(screen.getByRole('button', { name: /3:2/ }))
    expect(onApplyPreset).toHaveBeenCalledTimes(1)
    expect(onApplyPreset).toHaveBeenCalledWith(lightReliefPreset)
    expect(onApplyPreset.mock.calls[0][0].baseplate).toMatchObject({
      template: 'rectangle',
      imagePlacement: 'crop',
      widthMm: 150,
      heightMm: 100,
      marginMm: 2,
      rectangleSizeMode: 'manual',
    })
    expect(onApplyPreset.mock.calls[0][0].lightRelief).toMatchObject({
      totalHeightMm: 2,
      faceAZMm: 0,
      faceAHeightMm: 0.2,
      faceBZMm: 0.3,
      faceBHeightMm: 1.7,
    })
  })

  it('未传 presets 时不渲染预设区块（filigree/seal 模式无变化）', () => {
    renderPanel()
    expect(screen.queryByText('预设配置')).toBeNull()
  })

  it('当前设置与预设一致时卡片高亮', () => {
    const applied: BaseplateSettings = {
      ...defaultBaseplateSettings,
      template: 'rectangle',
      imagePlacement: 'crop',
      widthMm: 150,
      heightMm: 100,
      marginMm: 2,
      rectangleSizeMode: 'manual',
    }
    render(
      <PalettePanel
        settings={applied}
        sourceAspectRatio={null}
        printBedSettings={printBedSettings}
        onUpdateSettings={vi.fn()}
        presets={[lightReliefPreset]}
        onApplyPreset={vi.fn()}
      />,
    )
    const presetButton = screen.getByRole('button', { name: /3:2/ }) as HTMLButtonElement
    expect(presetButton.className).toContain('border-emerald-300')
  })
})
