import { describe, expect, it, vi } from 'vitest'
import type { BaseplateSettings, LineartSettings, PrintBedSettings, VectorLoop } from '@/types/generator'
import { build3mfModelXml, build3mfPackage, buildCombined3mfPackage, buildLoopDxf, buildPreviewModelGltfBlob, layoutLineLoops, mirrorLoopsHorizontally, parseDxfText, planPrintBedLayout, processArtwork } from '@/utils/generator'
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
  diameterMm: 50,
  marginMm: 4,
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
  targetColor: '#000000',
  despeckle: 24,
  strokeWidth: 0.4,
  smoothing: 36,
  invert: false,
  mirror: false,
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

  it('uses line height as z start and line thickness as z span in 3mf export', () => {
    const packageBytes = build3mfPackage(
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

  it('writes default extruder assignments into bambu metadata for single exports', () => {
    const packageBytes = build3mfPackage(
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

  it('flips y coordinates for 3mf export to match the preview orientation', () => {
    const packageBytes = build3mfPackage(
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
      },
      printBedSettings,
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('y="131"')
    expect(modelXml).toContain('y="132"')
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
    expect(strFromU8(files['Metadata/model_settings.config'])).toContain('<part id="3" subtype="normal_part">')
    expect(modelSettings).toContain('<plate>')
    expect(modelSettings).toContain('value="打印板 1"')
  })
})

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
