import { describe, expect, it, vi } from 'vitest'
import type { BaseplateSettings, LightReliefSettings, LineartSettings, PrintBedSettings, ProcessedArtwork, VectorLoop } from '@/types/generator'
import { build3mfModelXml, build3mfPackage, buildCombined3mfPackage, buildExportLineMask, buildLoopDxf, buildLightReliefPreviewModelGltfBlob, buildPreviewModelGltfBlob, chooseCombinedExportPixelsPerMm, chooseSingleExportPixelsPerMm, layoutLineLoops, mirrorLoopsHorizontally, parseDxfText, planPrintBedLayout, processArtwork } from '@/utils/generator'
import { unzipSync, strFromU8 } from 'fflate'

const sourceLoops: VectorLoop[] = [
  {
    closed: true,
    points: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 0, y: 10 },
    ],
  },
]

const rectangleSettings: BaseplateSettings = {
  template: 'rectangle',
  expandMm: 2,
  widthMm: 50,
  heightMm: 50,
  rectangleSizeMode: 'manual',
  rectangleScalePercent: 100,
  diameterMm: 50,
  marginMm: 4,
  imagePlacement: 'fit',
  lineColor: '#111111',
  baseColor: '#f3f6fb',
}

const printBedSettings: PrintBedSettings = {
  widthMm: 256,
  depthMm: 256,
  spacingMm: 8,
}

const defaultLineartSettings: LineartSettings = {
  detail: 100,
  threshold: 160,
  thresholdAuto: true,
  targetColor: '#000000',
  despeckle: 24,
  expandStrokeMm: 0.4,
  shrinkStrokeMm: 0,
  smoothing: 10,
  invert: false,
  mirror: false,
  autoOptimize: true,
  protectFineDetail: true,
  uploadPreprocess: true,
  bezierFitting: true,
  bezierStrength: 45,
}

describe('generator exports', () => {
  it('lays out lineart at the center of a rectangle template', () => {
    const layout = layoutLineLoops(sourceLoops, rectangleSettings)
    const bounds = layout.lineLoops[0].points
    const xs = bounds.map((point) => point.x)
    const ys = bounds.map((point) => point.y)

    expect(layout.boardWidthMm).toBe(50)
    expect(layout.boardHeightMm).toBe(50)
    expect(Math.min(...xs)).toBeGreaterThan(3)
    expect(Math.max(...xs)).toBeLessThan(47)
    expect(Math.min(...ys)).toBeGreaterThan(13)
    expect(Math.max(...ys)).toBeLessThan(37)
  })

  it('center placement maximizes within the board without cropping', () => {
    const layout = layoutLineLoops(sourceLoops, {
      ...rectangleSettings,
      imagePlacement: 'center',
    })
    const pts = layout.lineLoops[0].points
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // 保持 2:1 比例，在 50×50 画板内最大化（忽略安全边距）：50 × 25，不被裁剪
    expect(maxX - minX).toBeCloseTo(50, 5)
    expect(maxY - minY).toBeCloseTo(25, 5)
    // 居中
    expect((minX + maxX) / 2).toBeCloseTo(25, 5)
    expect((minY + maxY) / 2).toBeCloseTo(25, 5)
  })

  it('stretch placement fills the safe area non-uniformly', () => {
    const layout = layoutLineLoops(sourceLoops, {
      ...rectangleSettings,
      imagePlacement: 'stretch',
    })
    const pts = layout.lineLoops[0].points
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // 安全区 = 50 - 2*(4+0.6) = 40.8，两个方向都铺满（20×10 被拉伸变形）
    expect(maxX - minX).toBeCloseTo(40.8, 5)
    expect(maxY - minY).toBeCloseTo(40.8, 5)
    expect(minX).toBeCloseTo(4.6, 5)
    expect(minY).toBeCloseTo(4.6, 5)
  })

  it('crop placement covers the safe area from the image middle', () => {
    const layout = layoutLineLoops(sourceLoops, {
      ...rectangleSettings,
      imagePlacement: 'crop',
    })
    const pts = layout.lineLoops[0].points
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const minX = Math.min(...xs)
    const maxX = Math.max(...xs)
    const minY = Math.min(...ys)
    const maxY = Math.max(...ys)

    // 源图 20×10，安全区为正方形（等比 1:1）：中间裁 10×10 → 等比放大 4.08 倍铺满
    // Y 方向铺满安全区
    expect(maxY - minY).toBeCloseTo(40.8, 5)
    expect(minY).toBeCloseTo(4.6, 5)
    // X 方向等比放大（20×4.08 = 81.6，超出画板，居中裁掉）
    expect(maxX - minX).toBeCloseTo(81.6, 5)
    expect((minX + maxX) / 2).toBeCloseTo(25, 5)
  })

  it('mirrors loops horizontally around their own bounds center', () => {
    const mirrored = mirrorLoopsHorizontally([
      {
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 6, y: 0 },
          { x: 4, y: 4 },
          { x: 1, y: 3 },
        ],
      },
    ])

    expect(mirrored[0].points).toEqual([
      { x: 6, y: 0 },
      { x: 0, y: 0 },
      { x: 2, y: 4 },
      { x: 5, y: 3 },
    ])
  })

  it('builds preview gltf blobs without DOM canvas support', async () => {
    vi.stubGlobal('document', undefined)

    try {
      const blob = buildPreviewModelGltfBlob(
        {
          baseLoops: sourceLoops,
          lineLoops: sourceLoops,
          boardWidthMm: 20,
          boardHeightMm: 10,
          pixelsPerMm: 10,
        },
        rectangleSettings,
        {
          baseThicknessMm: 0.2,
          lineThicknessMm: 0.2,
          lineHeightMm: 0.2,
          minLineWidthMm: 0.24,
        },
        {
          ...defaultLineartSettings,
          expandStrokeMm: 0,
          shrinkStrokeMm: 0,
        },
      )

      const gltfText = await readBlobText(blob as Blob)
      const gltf = JSON.parse(gltfText)
      expect(gltf.asset.version).toBe('2.0')
      expect(gltf.meshes).toHaveLength(2)
      expect(gltf.buffers[0].uri).toContain('data:application/octet-stream;base64,')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('exposes the B-face relief surface by skipping the top cover when reverse stack is enabled', async () => {
    const baseReliefSettings: LightReliefSettings = {
      totalHeightMm: 1,
      faceAZMm: 0,
      faceAHeightMm: 0.4,
      faceBZMm: 0.6,
      faceBHeightMm: 0.2,
      bFaceMode: 'auto',
      bFaceExposure: 100,
      bFaceInvert: false,
      bFaceReverseStack: false,
    }
    const artwork = {
      baseLoops: sourceLoops,
      lineLoops: sourceLoops,
      bFaceHeightMap: { width: 4, height: 2, data: new Float32Array(8).fill(0.5) },
      boardWidthMm: 20,
      boardHeightMm: 10,
      pixelsPerMm: 10,
    }

    const parseZRanges = async (reverseStack: boolean) => {
      const blob = buildLightReliefPreviewModelGltfBlob(
        artwork,
        rectangleSettings,
        { ...baseReliefSettings, bFaceReverseStack: reverseStack },
      )
      const gltf = JSON.parse(await readBlobText(blob as Blob))
      const ranges: Record<string, { minZ: number; maxZ: number }> = {}
      gltf.meshes.forEach((mesh: { name: string; primitives: Array<{ attributes: { POSITION: number } }> }, index: number) => {
        const accessor = gltf.accessors[mesh.primitives[0].attributes.POSITION]
        ranges[mesh.name] = { minZ: accessor.min[1], maxZ: accessor.max[1] }
      })
      return ranges
    }

    const normal = await parseZRanges(false)
    expect(normal['背景下层']).toEqual({ minZ: 0, maxZ: 0.6 })
    // 正常模式：底面固定在 faceBZMm=0.6，顶面随灰度变化（avgH = 0.05 + 0.5×0.15 = 0.125）
    expect(normal['B面透光浮雕'].minZ).toBeCloseTo(0.6, 5)
    expect(normal['B面透光浮雕'].maxZ).toBeCloseTo(0.725, 5)
    expect(normal['背景顶层']).toEqual({ minZ: 0.8, maxZ: 1 })

    const reversed = await parseZRanges(true)
    // 底座（背景下层）始终保留，为浮雕提供贴热床实心基座
    expect(reversed['背景下层']).toEqual({ minZ: 0, maxZ: 0.6 })
    // 反向堆叠：浮雕层序颠倒——原本的平面底（faceBZMm=0.6）翻到顶部 bFaceTopMm=0.8，
    // 起伏面转而朝向背景下层。均匀灰度下 avgH=0.125，故区间为 [0.8-0.125, 0.8] = [0.675, 0.8]
    expect(reversed['B面透光浮雕'].minZ).toBeCloseTo(0.675, 5)
    expect(reversed['B面透光浮雕'].maxZ).toBeCloseTo(0.8, 5)
    // 反向后浮雕顶面已占满 bFaceTopMm，背景顶层不再打印（避免叠成厚重挡光层）
    expect(reversed['背景顶层']).toBeUndefined()
    // 反向区间的厚度应与正向一致（只是位置挪到区间顶部），证明确实是"翻转"而非缩放
    const normalThickness = normal['B面透光浮雕'].maxZ - normal['B面透光浮雕'].minZ
    const reversedThickness = reversed['B面透光浮雕'].maxZ - reversed['B面透光浮雕'].minZ
    expect(reversedThickness).toBeCloseTo(normalThickness, 5)
  })

  it('reduces wrinkle points more aggressively as smoothing increases', async () => {
    const wrinkledLoop: VectorLoop = {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 2, y: 0.15 },
        { x: 4, y: -0.1 },
        { x: 6, y: 0.18 },
        { x: 8, y: -0.12 },
        { x: 10, y: 0 },
        { x: 10, y: 6 },
        { x: 8, y: 5.82 },
        { x: 6, y: 6.14 },
        { x: 4, y: 5.88 },
        { x: 2, y: 6.12 },
        { x: 0, y: 6 },
      ],
    }

    const lowSmoothArtwork = await processArtwork({
      sourceImage: null,
      importedLineart: {
        name: 'wrinkled.dxf',
        widthMm: 10,
        heightMm: 6,
        loops: [wrinkledLoop],
      },
      lineartSettings: {
        ...defaultLineartSettings,
        smoothing: 8,
      },
      baseplateSettings: rectangleSettings,
      extrudeSettings: {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
    })
    const highSmoothArtwork = await processArtwork({
      sourceImage: null,
      importedLineart: {
        name: 'wrinkled.dxf',
        widthMm: 10,
        heightMm: 6,
        loops: [wrinkledLoop],
      },
      lineartSettings: {
        ...defaultLineartSettings,
        smoothing: 88,
      },
      baseplateSettings: rectangleSettings,
      extrudeSettings: {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
    })

    expect(highSmoothArtwork.lineLoops[0].points.length).toBeLessThan(lowSmoothArtwork.lineLoops[0].points.length)
  })

  it('preserves thin line loops while removing wrinkles', async () => {
    const thinWrinkledLoop: VectorLoop = {
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 1.1, y: 0 },
        { x: 1.28, y: 1.6 },
        { x: 1.02, y: 3.2 },
        { x: 1.3, y: 4.8 },
        { x: 1.05, y: 6.4 },
        { x: 1.22, y: 8 },
        { x: 1.08, y: 9.6 },
        { x: 1.18, y: 11.2 },
        { x: 1.1, y: 12 },
        { x: 0, y: 12 },
        { x: -0.18, y: 10.4 },
        { x: 0.08, y: 8.8 },
        { x: -0.16, y: 7.2 },
        { x: 0.1, y: 5.6 },
        { x: -0.14, y: 4 },
        { x: 0.06, y: 2.2 },
        { x: -0.12, y: 0.8 },
      ],
    }

    const lowSmoothArtwork = await processArtwork({
      sourceImage: null,
      importedLineart: {
        name: 'thin-wrinkled.dxf',
        widthMm: 1.3,
        heightMm: 12,
        loops: [thinWrinkledLoop],
      },
      lineartSettings: {
        ...defaultLineartSettings,
        smoothing: 8,
      },
      baseplateSettings: rectangleSettings,
      extrudeSettings: {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
    })
    const highSmoothArtwork = await processArtwork({
      sourceImage: null,
      importedLineart: {
        name: 'thin-wrinkled.dxf',
        widthMm: 1.3,
        heightMm: 12,
        loops: [thinWrinkledLoop],
      },
      lineartSettings: {
        ...defaultLineartSettings,
        smoothing: 92,
      },
      baseplateSettings: rectangleSettings,
      extrudeSettings: {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
    })

    const lowBounds = getTestLoopBounds(lowSmoothArtwork.lineLoops[0])
    const highBounds = getTestLoopBounds(highSmoothArtwork.lineLoops[0])
    const lowArea = getTestLoopArea(lowSmoothArtwork.lineLoops[0])
    const highArea = getTestLoopArea(highSmoothArtwork.lineLoops[0])

    expect(highSmoothArtwork.lineLoops).toHaveLength(1)
    expect(highSmoothArtwork.lineLoops[0].points.length).toBeLessThan(lowSmoothArtwork.lineLoops[0].points.length)
    expect(highBounds.height).toBeGreaterThan(lowBounds.height * 0.9)
    expect(highBounds.width).toBeGreaterThan(lowBounds.width * 0.72)
    expect(highArea).toBeGreaterThan(lowArea * 0.78)
  })

  it('centers a single item on the configured print bed', () => {
    const layout = planPrintBedLayout([
      {
        id: 'a',
        label: '单图',
        widthMm: 50,
        heightMm: 30,
      },
    ], printBedSettings)

    expect(layout.overflowCount).toBe(0)
    expect(layout.placements[0].xMm).toBe(103)
    expect(layout.placements[0].yMm).toBe(113)
    expect(layout.placements[0].plateIndex).toBe(0)
  })

  it('creates a second print bed when the first one is full', () => {
    const layout = planPrintBedLayout([
      {
        id: 'a',
        label: 'A',
        widthMm: 90,
        heightMm: 90,
      },
      {
        id: 'b',
        label: 'B',
        widthMm: 90,
        heightMm: 90,
      },
      {
        id: 'c',
        label: 'C',
        widthMm: 90,
        heightMm: 90,
      },
    ], {
      widthMm: 200,
      depthMm: 120,
      spacingMm: 8,
    })

    expect(layout.overflowCount).toBe(0)
    expect(layout.plates).toHaveLength(2)
    expect(layout.placements[2].fits).toBe(true)
    expect(layout.placements[2].plateIndex).toBe(1)
  })

  it('marks items as overflow only when a single model is larger than the print bed', () => {
    const layout = planPrintBedLayout([
      {
        id: 'oversized',
        label: '超大件',
        widthMm: 220,
        heightMm: 140,
      },
    ], {
      widthMm: 200,
      depthMm: 120,
      spacingMm: 8,
    })

    expect(layout.overflowCount).toBe(1)
    expect(layout.placements[0].fits).toBe(false)
  })

  it('builds a closed polyline DXF', () => {
    const dxf = buildLoopDxf(sourceLoops)

    expect(dxf).toContain('LWPOLYLINE')
    expect(dxf).toContain('AC1009')
    expect(dxf).toContain('\n 70\n1')
    expect((dxf.match(/LWPOLYLINE/g) ?? []).length).toBe(1)
  })

  it('parses imported polyline dxf text', () => {
    const dxf = [
      '  0',
      'SECTION',
      '  2',
      'ENTITIES',
      '  0',
      'LWPOLYLINE',
      ' 70',
      '1',
      ' 90',
      '4',
      ' 10',
      '0',
      ' 20',
      '0',
      ' 10',
      '10',
      ' 20',
      '0',
      ' 10',
      '10',
      ' 20',
      '10',
      ' 10',
      '0',
      ' 20',
      '10',
      '  0',
      'ENDSEC',
      '  0',
      'EOF',
    ].join('\n')

    const parsed = parseDxfText(dxf, 'demo.dxf')
    expect(parsed.name).toBe('demo.dxf')
    expect(parsed.loops).toHaveLength(1)
    expect(parsed.widthMm).toBe(10)
    expect(parsed.heightMm).toBe(10)
  })

  it('builds 3mf model xml with separate baseplate and lineart objects', () => {
    const xml = build3mfModelXml(
      {
        vertices: [
          [0, 0, 0],
          [10, 0, 0],
          [10, 10, 0],
          [0, 10, 0],
        ],
        triangles: [
          [0, 1, 2],
          [0, 2, 3],
        ],
      },
      {
        vertices: [
          [2, 2, 0.2],
          [8, 2, 0.2],
          [8, 8, 0.2],
          [2, 8, 0.2],
        ],
        triangles: [
          [0, 1, 2],
          [0, 2, 3],
        ],
      },
      rectangleSettings,
    )

    expect(xml).toContain('displaycolor="#F3F6FBFF"')
    expect(xml).toContain('displaycolor="#111111FF"')
    expect(xml).toContain('object id="2"')
    expect(xml).toContain('object id="3"')
    expect(xml).toContain('object id="4"')
    expect(xml).toContain('<component objectid="2"/>')
    expect(xml).toContain('<component objectid="3"/>')
    expect(xml).toContain('<item objectid="4"/>')
  })

  it('uses line height as z start and line thickness as z span in 3mf export', async () => {
    const packageBytes = await build3mfPackage(
      {
        sourceKind: 'image',
        sourceWidth: 20,
        sourceHeight: 10,
        lineLoops: [
          {
            closed: true,
            points: [
              { x: 2, y: 2 },
              { x: 8, y: 2 },
              { x: 8, y: 8 },
              { x: 2, y: 8 },
            ],
          },
        ],
        baseLoops: sourceLoops,
        boardWidthMm: 20,
        boardHeightMm: 10,
        pixelsPerMm: 10,
        previews: {
          lineartDataUrl: '',
          baseplateDataUrl: '',
          compositeDataUrl: '',
        },
        stats: {
          sourceKind: 'image',
          sourceWidth: 20,
          sourceHeight: 10,
          lineLoopCount: 1,
          baseLoopCount: 1,
          lineSegments: 4,
          baseSegments: 4,
          boardWidthMm: 20,
          boardHeightMm: 10,
        },
      },
      rectangleSettings,
      {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
      printBedSettings,
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('z="0.2"')
    expect(modelXml).toContain('z="0.4"')
    expect(modelXml).toContain('x="118"')
    expect(modelXml).toContain('y="123"')
  })

  it('embeds composite preview as plate thumbnail when available', async () => {
    // 1x1 transparent PNG, base64
    const tinyPng =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
    const packageBytes = await build3mfPackage(
      {
        sourceKind: 'image',
        sourceWidth: 20,
        sourceHeight: 10,
        lineLoops: sourceLoops,
        baseLoops: sourceLoops,
        boardWidthMm: 20,
        boardHeightMm: 10,
        pixelsPerMm: 10,
        previews: {
          lineartDataUrl: '',
          baseplateDataUrl: '',
          compositeDataUrl: `data:image/png;base64,${tinyPng}`,
        },
        strokeLoops: [],
        stats: { lineLoopCount: 0, baseLoopCount: 0, lineSegments: 0, baseSegments: 0 },
      } as unknown as Parameters<typeof build3mfPackage>[0],
      {
        template: 'rectangle',
        expandMm: 2,
        widthMm: 50,
        heightMm: 50,
        rectangleSizeMode: 'manual',
        rectangleScalePercent: 100,
        diameterMm: 50,
        marginMm: 4,
        imagePlacement: 'fit',
        lineColor: '#000000',
        baseColor: '#ffffff',
      },
      {
        baseThicknessMm: 0.4,
        lineHeightMm: 0.4,
        lineThicknessMm: 0.4,
        minLineWidthMm: 0.4,
      },
      printBedSettings,
    )

    const files = unzipSync(packageBytes)
    const thumb = files['Metadata/plate_1.png']
    expect(thumb).toBeDefined()
    // PNG magic bytes: 89 50 4E 47 0D 0A 1A 0A
    expect(thumb[0]).toBe(0x89)
    expect(thumb[1]).toBe(0x50)
    expect(thumb[2]).toBe(0x4e)
    expect(thumb[3]).toBe(0x47)
  })

  it('writes default extruder assignments into bambu metadata for single exports', async () => {
    const packageBytes = await build3mfPackage(
      {
        sourceKind: 'image',
        sourceWidth: 20,
        sourceHeight: 10,
        lineLoops: sourceLoops,
        baseLoops: sourceLoops,
        boardWidthMm: 20,
        boardHeightMm: 10,
        pixelsPerMm: 10,
        previews: {
          lineartDataUrl: '',
          baseplateDataUrl: '',
          compositeDataUrl: '',
        },
        stats: {
          sourceKind: 'image',
          sourceWidth: 20,
          sourceHeight: 10,
          lineLoopCount: 1,
          baseLoopCount: 1,
          lineSegments: 4,
          baseSegments: 4,
          boardWidthMm: 20,
          boardHeightMm: 10,
        },
      },
      rectangleSettings,
      {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
      printBedSettings,
    )

    const files = unzipSync(packageBytes)
    const modelSettings = strFromU8(files['Metadata/model_settings.config'])
    const projectSettings = strFromU8(files['Metadata/project_settings.config'])
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelSettings).toContain('<object id="4">')
    expect(modelSettings).toContain('<part id="2" subtype="normal_part">')
    expect(modelSettings).toContain('<part id="3" subtype="normal_part">')
    expect(modelSettings).toContain('key="wall_filament" value="1"')
    expect(modelSettings).toContain('key="wall_filament" value="2"')
    expect(projectSettings).toContain('"filament_colour"')
    expect(projectSettings).toContain('"filament_ids"')
    expect(projectSettings).toContain(rectangleSettings.baseColor.toUpperCase())
    expect(projectSettings).toContain(rectangleSettings.lineColor.toUpperCase())
    expect(modelXml).toContain('<metadata name="Application">BambuStudio-01.10.00.89</metadata>')
  })

  it('flips y coordinates for 3mf export to match the preview orientation', async () => {
    const packageBytes = await build3mfPackage(
      {
        sourceKind: 'image',
        sourceWidth: 20,
        sourceHeight: 10,
        lineLoops: [
          {
            closed: true,
            points: [
              { x: 2, y: 1 },
              { x: 4, y: 1 },
              { x: 4, y: 2 },
              { x: 2, y: 2 },
            ],
          },
        ],
        baseLoops: sourceLoops,
        boardWidthMm: 20,
        boardHeightMm: 10,
        pixelsPerMm: 10,
        previews: {
          lineartDataUrl: '',
          baseplateDataUrl: '',
          compositeDataUrl: '',
        },
        stats: {
          sourceKind: 'image',
          sourceWidth: 20,
          sourceHeight: 10,
          lineLoopCount: 1,
          baseLoopCount: 1,
          lineSegments: 4,
          baseSegments: 4,
          boardWidthMm: 20,
          boardHeightMm: 10,
        },
      },
      rectangleSettings,
      {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
      printBedSettings,
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('y="131"')
    expect(modelXml).toContain('y="132"')
  })

  it('limits 3mf export raster density for large boards', () => {
    const largeArtwork = {
      boardWidthMm: 256,
      boardHeightMm: 256,
      pixelsPerMm: 16,
    } as ProcessedArtwork

    expect(chooseSingleExportPixelsPerMm(largeArtwork)).toBeCloseTo(Math.sqrt(720_000 / (256 * 256)), 6)
    expect(chooseCombinedExportPixelsPerMm(largeArtwork, 8, 256 * 256 * 8)).toBeCloseTo(Math.sqrt(240_000 / (256 * 256)), 6)
  })

  it('builds a combined 3mf package for multiple artworks', () => {
    const packageBytes = buildCombined3mfPackage(
      [
        {
          id: '1-a',
          name: '1-a',
          artwork: {
            sourceKind: 'image',
            sourceWidth: 20,
            sourceHeight: 10,
            lineLoops: sourceLoops,
            baseLoops: sourceLoops,
            boardWidthMm: 20,
            boardHeightMm: 10,
            pixelsPerMm: 10,
            previews: {
              lineartDataUrl: '',
              baseplateDataUrl: '',
              compositeDataUrl: '',
            },
            stats: {
              sourceKind: 'image',
              sourceWidth: 20,
              sourceHeight: 10,
              lineLoopCount: 1,
              baseLoopCount: 1,
              lineSegments: 4,
              baseSegments: 4,
              boardWidthMm: 20,
              boardHeightMm: 10,
            },
          },
        },
        {
          id: '2-b',
          name: '2-b',
          artwork: {
            sourceKind: 'image',
            sourceWidth: 20,
            sourceHeight: 10,
            lineLoops: sourceLoops,
            baseLoops: sourceLoops,
            boardWidthMm: 20,
            boardHeightMm: 10,
            pixelsPerMm: 10,
            previews: {
              lineartDataUrl: '',
              baseplateDataUrl: '',
              compositeDataUrl: '',
            },
            stats: {
              sourceKind: 'image',
              sourceWidth: 20,
              sourceHeight: 10,
              lineLoopCount: 1,
              baseLoopCount: 1,
              lineSegments: 4,
              baseSegments: 4,
              boardWidthMm: 20,
              boardHeightMm: 10,
            },
          },
        },
      ],
      rectangleSettings,
      {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
      {
        widthMm: 200,
        depthMm: 120,
        spacingMm: 8,
      },
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])
    const modelSettings = strFromU8(files['Metadata/model_settings.config'])

    expect(modelXml).toContain('name="1-a"')
    expect(modelXml).toContain('name="2-b"')
    expect((modelXml.match(/<item objectid=/g) ?? []).length).toBe(2)
    expect(modelSettings).toContain('<part id="1" subtype="normal_part">')
    expect(modelSettings).toContain('<part id="2" subtype="normal_part">')
    expect(modelSettings).toContain('<plate>')
    expect(modelSettings).toContain('value="打印板 1"')
  })

  it('keeps model instance identifiers unique across combined 3mf plates', () => {
    const largeArtwork = {
      sourceKind: 'image' as const,
      sourceWidth: 90,
      sourceHeight: 90,
      lineLoops: sourceLoops,
      baseLoops: sourceLoops,
      boardWidthMm: 90,
      boardHeightMm: 90,
      pixelsPerMm: 10,
      previews: {
        lineartDataUrl: '',
        baseplateDataUrl: '',
        compositeDataUrl: '',
      },
      stats: {
        sourceKind: 'image' as const,
        sourceWidth: 90,
        sourceHeight: 90,
        lineLoopCount: 1,
        baseLoopCount: 1,
        lineSegments: 4,
        baseSegments: 4,
        boardWidthMm: 90,
        boardHeightMm: 90,
      },
    }

    const packageBytes = buildCombined3mfPackage(
      [
        { id: '1-a', name: '1-a', artwork: largeArtwork },
        { id: '2-b', name: '2-b', artwork: largeArtwork },
      ],
      rectangleSettings,
      {
        baseThicknessMm: 0.2,
        lineThicknessMm: 0.2,
        lineHeightMm: 0.2,
        minLineWidthMm: 0.24,
      },
      {
        widthMm: 120,
        depthMm: 120,
        spacingMm: 8,
      },
    )

    const files = unzipSync(packageBytes)
    const modelSettings = strFromU8(files['Metadata/model_settings.config'])

    expect((modelSettings.match(/<plate>/g) ?? []).length).toBe(2)
    expect(modelSettings).toContain('<metadata key="identify_id" value="1"/>')
    expect(modelSettings).toContain('<metadata key="identify_id" value="2"/>')
  })
})

describe('buildExportLineMask 统一描边管线（预览与 3MF 共用）', () => {
  const pixelsPerMm = 10
  // 20 px/mm 接近真实使用 (6.93 px/mm) 的相对量级，用于"线宽不被 over-dilate"测试。
  const hiResPxPerMm = 20
  const boardWidthMm = 20
  const boardHeightMm = 10

  const barLoop: VectorLoop = {
    closed: true,
    points: [
      { x: 2, y: 2 },
      { x: 6, y: 2 },
      { x: 6, y: 8 },
      { x: 2, y: 8 },
    ],
  }

  // 小圆点：直径 0.6mm（6px），模拟眼睛瞳孔/高光这类小细节
  const dotLoop: VectorLoop = {
    closed: true,
    points: Array.from({ length: 16 }, (_, index) => {
      const angle = (index / 16) * Math.PI * 2
      return { x: 12 + Math.cos(angle) * 0.3, y: 5 + Math.sin(angle) * 0.3 }
    }),
  }

  const countFilled = (mask: Uint8Array) => {
    let filled = 0
    for (let index = 0; index < mask.length; index += 1) {
      if (mask[index] === 1) filled += 1
    }
    return filled
  }

  const isFilledAtMm = (mask: Uint8Array, xMm: number, yMm: number) => {
    const x = Math.round(xMm * pixelsPerMm)
    const y = Math.round(yMm * pixelsPerMm)
    return mask[y * (boardWidthMm * pixelsPerMm) + x] === 1
  }

  it('缩小描边时小细节（瞳孔/高光）被救回，不再被腐蚀整体删除', () => {
    // shrink 1mm → 腐蚀半径 5px；6px 直径的小点会被整体吞掉，
    // 救援逻辑应把它的原始像素并回，再由最小线宽保底。
    const result = buildExportLineMask(
      [barLoop, dotLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0.4,
      0,
      1,
    )
    expect(result.width).toBe(boardWidthMm * pixelsPerMm)
    expect(result.height).toBe(boardHeightMm * pixelsPerMm)
    // 小点中心必须保留实心像素
    expect(isFilledAtMm(result.mask, 12, 5)).toBe(true)
  })

  it('缩小描边仍然生效：大块区域被腐蚀变瘦', () => {
    const noStroke = buildExportLineMask(
      [barLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0,
      0,
      0,
    )
    const shrunk = buildExportLineMask(
      [barLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0,
      0,
      1,
    )
    expect(countFilled(shrunk.mask)).toBeLessThan(countFilled(noStroke.mask))
    // 腐蚀后仍保留主体
    expect(countFilled(shrunk.mask)).toBeGreaterThan(0)
  })

  it('最小线宽保底：缩小后线宽不低于 minLineWidthMm 对应的像素数', () => {
    // 4mm 宽条带 shrink 1mm（半径 5px @ 10 pxPerMm）→ 3mm = 30px，已远超下限；
    // 关键是小面积也至少有 minLineWidthMm（0.4mm = 4px）级别的宽度。
    // 旧版会再叠加 +4px 保底膨胀（变成 34px）——这是用户反馈"切片变两条线"的来源之一；
    // 新版只对**未达标**的细线做膨胀，3mm 粗线**不再**被无故加粗，应保留 30px。
    const shrunk = buildExportLineMask(
      [barLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0.4,
      0,
      1,
    )
    // y=5mm 行（条带中轴）上的连续实心像素宽度
    const row = 5 * pixelsPerMm
    let run = 0
    let best = 0
    for (let x = 0; x < shrunk.width; x += 1) {
      if (shrunk.mask[row * shrunk.width + x] === 1) {
        run += 1
        best = Math.max(best, run)
      } else {
        run = 0
      }
    }
    // 缩小后条带应为 30px 左右（±2px 圆整误差）；不该被无故加粗到 34px
    expect(best).toBeGreaterThanOrEqual(28)
    expect(best).toBeLessThanOrEqual(32)
  })

  it('加粗描边让掩码膨胀（预览与 3MF 同步加粗）', () => {
    const plain = buildExportLineMask(
      [dotLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0,
      0,
      0,
    )
    const expanded = buildExportLineMask(
      [dotLoop],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0,
      0.5,
      0,
    )
    expect(countFilled(expanded.mask)).toBeGreaterThan(countFilled(plain.mask))
  })

  it('拉满缩小描边：细线不消失，宽度被保底到最小线宽（而非被腐蚀删除）', () => {
    // 0.3mm 宽、8mm 长的细线；minLineWidthMm=0.4；shrink 拉到 3mm（远超线宽）。
    const thinLine: VectorLoop = {
      closed: true,
      points: [
        { x: 6, y: 4.85 },
        { x: 14, y: 4.85 },
        { x: 14, y: 5.15 },
        { x: 6, y: 5.15 },
      ],
    }
    const result = buildExportLineMask(
      [thinLine],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0.4,
      0,
      3,
    )
    // 细线必须仍在（未缺失）
    expect(countFilled(result.mask)).toBeGreaterThan(0)
    // 中轴行（y=5mm）上应当仍有连续实心像素
    expect(isFilledAtMm(result.mask, 10, 5)).toBe(true)
    // 宽度应被保底到约最小线宽（0.4mm ≈ 4px + 膨胀），而绝非归零
    let run = 0
    let best = 0
    const row = 5 * pixelsPerMm
    for (let x = 0; x < result.width; x += 1) {
      if (result.mask[row * result.width + x] === 1) {
        run += 1
        best = Math.max(best, run)
      } else {
        run = 0
      }
    }
    expect(best).toBeGreaterThanOrEqual(4)
  })

  it('拉满缩小描边：含细颈的连续笔画不会被掐断成多段', () => {
    // 哑铃形：左右两块 + 中间 0.3mm 细颈；shrink 拉满时细颈本会被腐蚀掐断。
    const left: VectorLoop = { closed: true, points: [{ x: 2, y: 3 }, { x: 5, y: 3 }, { x: 5, y: 7 }, { x: 2, y: 7 }] }
    const right: VectorLoop = { closed: true, points: [{ x: 15, y: 3 }, { x: 18, y: 3 }, { x: 18, y: 7 }, { x: 15, y: 7 }] }
    const neck: VectorLoop = { closed: true, points: [{ x: 5, y: 4.85 }, { x: 15, y: 4.85 }, { x: 15, y: 5.15 }, { x: 5, y: 5.15 }] }
    const result = buildExportLineMask(
      [left, right, neck],
      boardWidthMm,
      boardHeightMm,
      pixelsPerMm,
      0.4,
      0,
      3,
    )
    // 整体应仍是单个连通域（哑铃不断成两半）
    expect(countComponents(result.mask, result.width, result.height)).toBe(1)
  })

  it('最小线宽：1px 细线被保底到 >= minLineWidthMm（不再被 over-dilate 到 5px 厚）', () => {
    // 1-px 厚细线在 20 px/mm 高分辨率下：minDistThreshold=5，1-px 域 max dist=1 < 5 → 细线域
    // 像素按 needed = 8-1=7 → dilateBy=ceil(3.5)=4 → 1-px 细线变 9-px (0.45mm)。
    // 旧版全局膨胀 1px 把它变 3px 是因为旧公式按最坏 1px 算——但**所有**线都
    // 套用这套膨胀就导致 3-px 粗线被推到 5-px、5-px 推到 7-px 的连环 over-dilate。
    const thinLine: VectorLoop = {
      closed: true,
      points: [
        { x: 5, y: 4.96 },
        { x: 10, y: 4.96 },
        { x: 10, y: 5.04 },
        { x: 5, y: 5.04 },
      ],
    }
    const result = buildExportLineMask(
      [thinLine],
      boardWidthMm,
      boardHeightMm,
      hiResPxPerMm,
      0.4,
      0,
      0,
    )
    const thickness = measureLineThicknessAt(result.mask, result.width, result.height, 7 * hiResPxPerMm)
    // 1-px 输入 → 应>=8px(达到最小线宽 0.4mm @ 20px/mm)，<=10px(不被过度加粗)
    expect(thickness).toBeGreaterThanOrEqual(8)
    expect(thickness).toBeLessThanOrEqual(10)
  })

  it('最小线宽：8px（≈0.4mm）粗线原样保留，绝不膨胀成 14px（旧 over-dilate）', () => {
    // 0.4mm 宽、5mm 长的粗线（≈8px @ 20px/mm）→ 域 max dist=4，已达 minDistThreshold=5 的边界
    // → 视作粗线域 → **不再被连环 over-dilate**。
    // 旧版全局膨胀 1px 会把它变 10px (0.5mm)，叠加 shrink→expand 后变成 14px (0.7mm)，
    // 切片器要 2 条线 = 0.8mm 塑料，这正是用户反馈的"切片要打印两条线"的核心场景。
    // 整数像素物理极限：5-px 域 maxDist=3 (2*3-1=5px 厚) 与 8-px 目标差 3px，ceil(1.5)=2 → 膨胀到 9-px。
    // 7-px 域 maxDist=3，与 8 差 1px → 膨胀到 9-px。
    // 8-px 域 maxDist=4，与 8 差 0px → 不膨胀（或边缘 1px 膨胀）。总之绝不超过 10-px。
    const thickLine: VectorLoop = {
      closed: true,
      points: [
        { x: 5, y: 4.8 },
        { x: 10, y: 4.8 },
        { x: 10, y: 5.2 },
        { x: 5, y: 5.2 },
      ],
    }
    const result = buildExportLineMask(
      [thickLine],
      boardWidthMm,
      boardHeightMm,
      hiResPxPerMm,
      0.4,
      0,
      0,
    )
    const thickness = measureLineThicknessAt(result.mask, result.width, result.height, 7 * hiResPxPerMm)
    // 8px 输入 → 必须 <= 10px（绝不能像旧版那样被推到 14px）
    expect(thickness).toBeLessThanOrEqual(10)
    // 且 >= 8px（达到最小线宽下限）
    expect(thickness).toBeGreaterThanOrEqual(8)
  })

  it('最小线宽：3px（≈0.15mm）未达标的线被保底到 >= minLineWidthMm（同样不再 over-dilate）', () => {
    // 3-px 厚线：max dist=2 < minDistThreshold=5 → 细线域 → dilateBy=ceil((8-3)/2)=3 → 9-px
    const justThin: VectorLoop = {
      closed: true,
      points: [
        { x: 5, y: 4.925 },
        { x: 10, y: 4.925 },
        { x: 10, y: 5.075 },
        { x: 5, y: 5.075 },
      ],
    }
    const result = buildExportLineMask(
      [justThin],
      boardWidthMm,
      boardHeightMm,
      hiResPxPerMm,
      0.4,
      0,
      0,
    )
    const thickness = measureLineThicknessAt(result.mask, result.width, result.height, 7 * hiResPxPerMm)
    // 3-px 输入 → >= 8px(达到最小线宽)，<= 10px(不被过度加粗)
    expect(thickness).toBeGreaterThanOrEqual(8)
    expect(thickness).toBeLessThanOrEqual(10)
  })

  it('最小线宽：拉满缩小描边后细线宽度被保底到 minLineWidthMm，但**不**超过原值', () => {
    // 5px 粗线 + shrink 6mm + minLineWidthMm=0.4
    // 旧版：缩到 ~3px，再加 2px → 5px（与原值巧合相同）
    // 新版：缩到 ~3px（仍未达标 = 细线域）→ 膨胀到 ~9px
    const line: VectorLoop = {
      closed: true,
      points: [
        { x: 5, y: 4.5 },
        { x: 15, y: 4.5 },
        { x: 15, y: 5.5 },
        { x: 5, y: 5.5 },
      ],
    }
    const noShrink = buildExportLineMask(
      [line], boardWidthMm, boardHeightMm, hiResPxPerMm, 0.4, 0, 0,
    )
    const shrunk = buildExportLineMask(
      [line], boardWidthMm, boardHeightMm, hiResPxPerMm, 0.4, 0, 6,
    )
    const noShrinkT = measureLineThicknessAt(noShrink.mask, noShrink.width, noShrink.height, 7 * hiResPxPerMm)
    const shrunkT = measureLineThicknessAt(shrunk.mask, shrunk.width, shrunk.height, 7 * hiResPxPerMm)
    // 缩小后应**不比**未缩时更粗（甚至更细，但 >= minLineWidthMm）
    expect(shrunkT).toBeLessThanOrEqual(noShrinkT)
    expect(shrunkT).toBeGreaterThanOrEqual(8)  // 仍是可打印的最小线宽
  })
})

/**
 * 在指定 x 坐标处测量 mask 的"垂直厚度"——用于验证 applyMinimumLineWidth
 * 不会过度膨胀已达标的粗线。
 * 返回从该 x 位置起，连续前景像素的垂直段长度。
 */
function measureLineThicknessAt(mask: Uint8Array, width: number, height: number, x: number): number {
  if (x < 0 || x >= width) return 0
  let run = 0
  let best = 0
  for (let y = 0; y < height; y += 1) {
    if (mask[y * width + x] === 1) {
      run += 1
      if (run > best) best = run
    } else {
      run = 0
    }
  }
  return best
}

function readBlobText(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function getTestLoopBounds(loop: VectorLoop) {
  const xs = loop.points.map((point) => point.x)
  const ys = loop.points.map((point) => point.y)
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  }
}

function getTestLoopArea(loop: VectorLoop) {
  let area = 0
  for (let index = 0; index < loop.points.length; index += 1) {
    const current = loop.points[index]
    const next = loop.points[(index + 1) % loop.points.length]
    area += current.x * next.y - next.x * current.y
  }
  return Math.abs(area * 0.5)
}

function countComponents(mask: Uint8Array, width: number, height: number): number {
  const seen = new Uint8Array(mask.length)
  let count = 0
  for (let start = 0; start < mask.length; start += 1) {
    if (mask[start] !== 1 || seen[start] !== 0) continue
    count += 1
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const idx = stack.pop() as number
      const x = idx % width
      const y = (idx - x) / width
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
        const n = ny * width + nx
        if (mask[n] === 1 && seen[n] === 0) {
          seen[n] = 1
          stack.push(n)
        }
      }
    }
  }
  return count
}
