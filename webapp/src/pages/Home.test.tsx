import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import Home from '@/pages/Home'
import { useGeneratorStore } from '@/stores/generatorStore'

describe('Home', () => {
  beforeEach(() => {
    useGeneratorStore.setState({
      sourceImage: null,
      importedLineart: null,
      previewMode: '分层预览',
      lineartSettings: {
        detail: 100,
        threshold: 160,
        targetColor: '#000000',
        despeckle: 24,
        strokeWidth: 0.4,
        smoothing: 36,
        invert: false,
        mirror: false,
      },
      baseplateSettings: {
        template: 'outline',
        expandMm: 2,
        widthMm: 50,
        heightMm: 50,
        rectangleSizeMode: 'ratio',
        rectangleScalePercent: 100,
        diameterMm: 50,
        marginMm: 4,
        lineColor: '#111111',
        baseColor: '#f3f6fb',
      },
      extrudeSettings: {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
      },
      printBedSettings: {
        widthMm: 256,
        depthMm: 256,
        spacingMm: 8,
      },
    })
  })

  it('renders the lineart workbench title and upload actions', () => {
    render(<Home />)
    expect(screen.getAllByText('欢迎使用喵').length).toBeGreaterThan(0)
    expect(screen.getByText('这就去助力')).toBeTruthy()
    expect(screen.getByText('助力过了喵')).toBeTruthy()
    expect(screen.getByText('残忍拒绝')).toBeTruthy()
    expect(screen.getByText('线稿底板生成器')).toBeTruthy()
    expect(screen.getByText('批量导入 PNG / JPG / GIF')).toBeTruthy()
    expect(screen.getByText('导入线稿 DXF')).toBeTruthy()
    expect(screen.getByText('目标颜色')).toBeTruthy()
    expect(screen.getByText('水平镜像')).toBeTruthy()
    expect(screen.getByText('底板模板与颜色')).toBeTruthy()
    expect(screen.getByText('打印盘与单 3MF 摆盘')).toBeTruthy()
    expect(screen.getByText('3D预览')).toBeTruthy()
    expect(screen.getByText('恢复默认配置')).toBeTruthy()
    expect(screen.getByText('上传 3MF 打印参数')).toBeTruthy()
    expect(screen.getByText(/当前版本 v/)).toBeTruthy()
  })
})
