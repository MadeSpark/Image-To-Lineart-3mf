export const IMPORT_LIMITS = {
  maxImageFileBytes: 15 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxBatchFiles: 25,
  maxGifFrames: 120,
  maxDxfBytes: 8 * 1024 * 1024,
  maxDxfPairs: 300_000,
  maxDxfVertices: 150_000,
  maxSettingsBytes: 512 * 1024,
  maxThreeMfBytes: 30 * 1024 * 1024,
  maxThreeMfEntries: 200,
  maxThreeMfExpandedBytes: 80 * 1024 * 1024,
  maxThreeMfEntryBytes: 30 * 1024 * 1024,
  maxThreeMfMetadataBytes: 2 * 1024 * 1024,
} as const

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function assertImageFile(file: File) {
  if (!IMAGE_TYPES.has(file.type)) {
    throw new Error('Only PNG, JPEG, WebP, and GIF images are supported.')
  }
  assertFileSize(file, IMPORT_LIMITS.maxImageFileBytes, 'Image')
}

export function assertImageDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('The image dimensions are invalid.')
  }
  if (width * height > IMPORT_LIMITS.maxImagePixels) {
    throw new Error(`Image resolution exceeds the ${IMPORT_LIMITS.maxImagePixels.toLocaleString()} pixel limit.`)
  }
}

export function assertBatchSize(files: File[]) {
  if (!files.length) throw new Error('No files were selected.')
  if (files.length > IMPORT_LIMITS.maxBatchFiles) {
    throw new Error(`A maximum of ${IMPORT_LIMITS.maxBatchFiles} files can be imported at once.`)
  }
}

export function assertDxfFile(file: File) {
  assertFileSize(file, IMPORT_LIMITS.maxDxfBytes, 'DXF file')
}

export function assertSettingsFile(file: File) {
  assertFileSize(file, IMPORT_LIMITS.maxSettingsBytes, 'Settings file')
}

export function assertThreeMfFile(file: File) {
  assertFileSize(file, IMPORT_LIMITS.maxThreeMfBytes, '3MF template')
}

export function assertFileSize(file: File, maximum: number, label: string) {
  if (file.size < 1) throw new Error(`${label} is empty.`)
  if (file.size > maximum) {
    throw new Error(`${label} exceeds the ${(maximum / 1024 / 1024).toFixed(0)} MB limit.`)
  }
}

export function assertThreeMfArchiveBudget(files: Record<string, Uint8Array>) {
  const entries = Object.entries(files)
  if (entries.length > IMPORT_LIMITS.maxThreeMfEntries) {
    throw new Error('The 3MF archive contains too many files.')
  }

  let expandedBytes = 0
  for (const [name, file] of entries) {
    if (!isSafeThreeMfPath(name)) throw new Error('The 3MF archive contains an unsafe file path.')
    if (file.byteLength > IMPORT_LIMITS.maxThreeMfEntryBytes) {
      throw new Error('The 3MF archive contains an oversized file.')
    }
    expandedBytes += file.byteLength
    if (expandedBytes > IMPORT_LIMITS.maxThreeMfExpandedBytes) {
      throw new Error('The 3MF archive expands beyond the allowed size.')
    }
  }
}

export function assertThreeMfMetadataSize(file: Uint8Array | undefined, label: string) {
  if (file && file.byteLength > IMPORT_LIMITS.maxThreeMfMetadataBytes) {
    throw new Error(`${label} exceeds the 3MF metadata limit.`)
  }
}

export function assertSettingsPayload(value: unknown) {
  const seen = new Set<unknown>()
  let fields = 0

  const walk = (node: unknown, depth: number): void => {
    if (depth > 8) throw new Error('Settings file is nested too deeply.')
    if (node === null || typeof node === 'boolean') return
    if (typeof node === 'string') {
      if (node.length > 10_000) throw new Error('Settings file contains an oversized value.')
      return
    }
    if (typeof node === 'number') {
      if (!Number.isFinite(node) || Math.abs(node) > 1_000_000) throw new Error('Settings file contains an invalid number.')
      return
    }
    if (Array.isArray(node)) {
      if (node.length > 200) throw new Error('Settings file contains an oversized array.')
      node.forEach((entry) => walk(entry, depth + 1))
      return
    }
    if (!node || typeof node !== 'object') throw new Error('Settings file contains an unsupported value.')
    if (seen.has(node)) throw new Error('Settings file contains a circular value.')
    seen.add(node)
    const entries = Object.entries(node as Record<string, unknown>)
    fields += entries.length
    if (fields > 2_000) throw new Error('Settings file contains too many fields.')
    entries.forEach(([, entry]) => walk(entry, depth + 1))
  }

  walk(value, 0)
}

function isSafeThreeMfPath(path: string) {
  return !path.startsWith('/') && !path.includes('\\') && !path.split('/').includes('..')
}
