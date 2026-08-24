import { describe, expect, it } from 'vitest'
import { IMPORT_LIMITS, assertImageDimensions, assertThreeMfArchiveBudget } from '@/utils/importLimits'

describe('import limits', () => {
  it('rejects oversized image dimensions before canvas processing', () => {
    expect(() => assertImageDimensions(10_000, 10_000)).toThrow('resolution exceeds')
  })

  it('rejects archives with too many entries', () => {
    const files = Object.fromEntries(
      Array.from({ length: IMPORT_LIMITS.maxThreeMfEntries + 1 }, (_, index) => [`3D/${index}.model`, new Uint8Array(1)]),
    )
    expect(() => assertThreeMfArchiveBudget(files)).toThrow('too many files')
  })

  it('rejects unsafe archive paths', () => {
    expect(() => assertThreeMfArchiveBudget({ '../settings.json': new Uint8Array(1) })).toThrow('unsafe')
  })
})
