import { describe, expect, it } from 'vitest'
import type { BaseplateSettings, VectorLoop } from '@/types/generator'
import { build3mfModelXml, build3mfPackage, buildCombined3mfPackage, buildLoopDxf, layoutLineLoops, mirrorLoopsHorizontally, parseDxfText } from '@/utils/generator'
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
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('z="0.2"')
    expect(modelXml).toContain('z="0.4"')
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
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('y="8"')
    expect(modelXml).toContain('y="9"')
  })

  it('builds a combined 3mf package for multiple artworks', () => {
    const packageBytes = buildCombined3mfPackage(
      [
        {
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
    )

    const files = unzipSync(packageBytes)
    const modelXml = strFromU8(files['3D/3dmodel.model'])

    expect(modelXml).toContain('name="1-a"')
    expect(modelXml).toContain('name="2-b"')
    expect((modelXml.match(/<item objectid=/g) ?? []).length).toBe(2)
    expect(strFromU8(files['Metadata/model_settings.config'])).toContain('<part id="3" subtype="normal_part">')
  })
})
