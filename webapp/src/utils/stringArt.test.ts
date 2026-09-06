import { describe, expect, it } from 'vitest'
import { chooseStringArtChords, distributeNonCrossingChords, getStringArtAnchorPositions, getStringArtEndpointRadius } from '@/utils/stringArt'

describe('string art layer allocation', () => {
  it('buries strand end faces in the middle of the 2 mm frame', () => {
    const radius = 60
    const lineWidth = 0.42
    const wallThickness = 2
    const innerWallRadius = radius - wallThickness / 2
    const outerWallRadius = radius + wallThickness / 2
    const endpointRadius = getStringArtEndpointRadius(radius, lineWidth)

    expect(endpointRadius - innerWallRadius).toBeGreaterThan(wallThickness * 0.4)
    expect(outerWallRadius - endpointRadius).toBeGreaterThan(wallThickness * 0.4)
  })

  it('separates intersecting chords into different layers', () => {
    // 0-4 and 2-6 have interleaved endpoints, so they geometrically cross.
    const anchors = getStringArtAnchorPositions(8, 40, 40, 18)
    const result = distributeNonCrossingChords([[0, 4], [2, 6]], anchors, 2, 0.5)

    expect(result.layerChordCounts).toEqual([1, 1])
    expect(result.chords).toEqual([[0, 4], [2, 6]])
  })

  it('separates non-intersecting strands that are too close together', () => {
    const anchors = getStringArtAnchorPositions(64, 40, 40, 18)
    // Parallel diameter chords do not cross, but their centerlines are close.
    const result = distributeNonCrossingChords([[0, 32], [1, 31]], anchors, 2, 3)

    expect(result.layerChordCounts).toEqual([1, 1])
  })

  it('separates strands that share a wall endpoint', () => {
    const anchors = getStringArtAnchorPositions(8, 40, 40, 18)
    const result = distributeNonCrossingChords([[0, 3], [0, 5]], anchors, 2, 0.5)

    expect(result.layerChordCounts).toEqual([1, 1])
  })

  it('adds drawable detail when more layers are requested', () => {
    const anchors = getStringArtAnchorPositions(64, 40, 40, 18)
    const darkness = new Float32Array(64 * 64).fill(1)
    const oneLayer = chooseStringArtChords(darkness, 64, 64, anchors, 1, 1)
    const fourLayers = chooseStringArtChords(darkness, 64, 64, anchors, 4, 1)

    expect(oneLayer.layerChordCounts).toHaveLength(1)
    expect(fourLayers.layerChordCounts).toHaveLength(4)
    expect(fourLayers.chords.length).toBeGreaterThan(oneLayer.chords.length)
  })
})
