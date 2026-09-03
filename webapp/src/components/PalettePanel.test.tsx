import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PalettePanel } from '@/components/PalettePanel'
import { defaultBaseplateSettings } from '@/stores/generatorStore'
import type { BaseplatePreset, BaseplateSettings, PrintBedSettings } from '@/types/generator'

const printBedSettings: PrintBedSettings = { widthMm: 256, depthMm: 256, spacingMm: 0 }

// 与 Home.tsx 中 LIGHT_RELIEF_PRESETS 保持一致（3:2 预设）
const lightReliefPreset: BaseplatePreset = {
  name: '3:2',
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

// 与 Home.tsx 中 LIGHT_RELIEF_PRESETS 保持一致（2:3 预设，与 3:2 反向宽高比）
const lightReliefPreset23: BaseplatePreset = {
  name: '2:3',
  baseplate: {
    template: 'rectangle',
    imagePlacement: 'crop',
    widthMm: 100,
    heightMm: 150,
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

  it('传入 presets 时在底板模板选择上方渲染预设卡片，卡片文本只有预设名', () => {
    renderPanel([lightReliefPreset], vi.fn())

    expect(screen.getByText('预设配置')).toBeTruthy()
    const presetButton = screen.getByRole('button', { name: /3:2/ })
    // 卡片上除图标外只显示预设名本身，不带描述等附加文本
    expect(presetButton.textContent).toBe('3:2')
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

  it('2:3 预设与 3:2 同时渲染，且点击应用反向宽高比', () => {
    const onApplyPreset = vi.fn()
    renderPanel([lightReliefPreset, lightReliefPreset23], onApplyPreset)

    const preset23 = screen.getByRole('button', { name: /2:3/ })
    expect(preset23.textContent).toBe('2:3')
    expect(screen.getByRole('button', { name: /3:2/ })).toBeTruthy()

    fireEvent.click(preset23)
    expect(onApplyPreset).toHaveBeenCalledWith(lightReliefPreset23)
    expect(onApplyPreset.mock.calls[0][0].baseplate).toMatchObject({
      template: 'rectangle',
      imagePlacement: 'crop',
      widthMm: 100,
      heightMm: 150,
      marginMm: 2,
      rectangleSizeMode: 'manual',
    })
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
