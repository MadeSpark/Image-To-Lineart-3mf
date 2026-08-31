/* eslint-disable no-console */
// 透光浮雕几何 + 可打印性验证（自测脚本）。
//
// 【2026-08-30 第 12 轮定案：几何唯一解】
// 浮雕柱体**坐在 A 面底板上**：底面固定 zStart（整面齐平、与背景下层全接触、零空腔），
// 顶面 zStart + avgH 随灰度起伏，凹凸面在外侧朝上
//   → 横截面随 Z 单调收缩（SHRINKING）→ 0% 悬垂、免支撑、紧贴 A 面。
//
// 已废弃的形态：▼ 反向堆叠（柱体吊挂在平整顶棚下、尖端朝 A 面）。
//   该形态柱尖下方必有空腔（实测平均 0.848mm / 最大 1.35mm），而 A 面底板在柱尖另一侧，
//   形成「实心底板 + 空腔 + 实心浮雕」三明治：
//     正打 → 柱底悬空、GROWING，需支撑；
//     倒扣 180° → 底板变悬顶，实测第一层 87.5% 悬空。
//   两条路都打不了。
//   另外两条看似聪明的出路都是死路：
//     「把空腔填平」→ 各柱总厚度变常量 → 图像消失；
//     「让每根柱尖都贴住 A 面」→ 各柱等高 → 同样无图像。
//
// 【判据】可打印性 = 「每根柱体从第几层开始有材料」：
//   startLayer = floor((bottomZ − zMin) / layerH)，startLayer > 0 ⟹ 柱底悬空。
//   早年用过的「本层材料下方是否有材料」gap 判据会算出假绿（gap 恒为 0），千万别改回去。
//
// 【血泪教训：判据必须覆盖全部 mesh】
//   此前 reverseStack3mfExport.test.ts 只取 'B面透光浮雕' 单个网格做判据，
//   且构造数据时传 baseLoops: [] 让背景下层退化成 0 顶点的空网格，
//   而 expect(parsed['背景下层']).toBeTruthy() 对空数组 [] 也是真值 → 断言形同虚设。
//   于是「底板悬顶 87.5%」这个致命缺陷一路绿灯溜了过去。
//   本文件第 4 条（组合体逐层审计）专门补上这个盲区。
//
// 运行：npx vitest run src/utils/reliefSliceDiagnostic.test.ts

import { unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'

import {
  buildHalftoneReliefMesh,
  buildLightRelief3mfPackage,
  type HalftoneHeightMap,
} from './generator'
import {
  defaultBaseplateSettings,
  defaultPrintBedSettings,
} from '../stores/generatorStore'
import type {
  BaseplateSettings,
  LightReliefSettings,
  ProcessedArtwork,
} from '../types/generator'

type Col = { x: number; y: number; bottomZ: number; topZ: number; thickness: number }

function readCols(
  heightMap: HalftoneHeightMap,
  zStart: number,
  maxHeightMm: number,
  boardWidthMm: number,
  boardHeightMm: number,
): Col[] {
  const mesh = buildHalftoneReliefMesh(
    heightMap, zStart, maxHeightMm,
    boardWidthMm, boardHeightMm,
    false, // flipY=false：直接用 heightMap 直角坐标，便于对照 data
  )
  const W = heightMap.width
  const H = heightMap.height
  const numX = W + 1
  const numY = H + 1
  const cols: Col[] = []
  for (let y = 0; y < numY; y += 1) {
    for (let x = 0; x < numX; x += 1) {
      const b = mesh.vertices[(y * numX + x) * 2][2]
      const t = mesh.vertices[(y * numX + x) * 2 + 1][2]
      cols.push({ x, y, bottomZ: b, topZ: t, thickness: t - b })
    }
  }
  return cols
}

/** 模拟切片器：按 layerHeightMm 逐层上抬，统计每层「下方是空气」的悬垂耗材占比。 */
function quantifyOverhang(
  label: string,
  cols: Col[],
  zStart: number,
  layerHeightMm: number,
) {
  const topZ = Math.max(...cols.map((c) => c.topZ))
  const layerCount = Math.max(1, Math.ceil((topZ - zStart) / layerHeightMm))
  let worstRatio = 0
  let worstLayerZ = 0
  let maxGapBelow = 0
  console.log(`\n=== ${label} 悬垂量化 ===`)
  console.log(`zStart=${zStart} 最高=${topZ.toFixed(3)} 层高=${layerHeightMm} 层数=${layerCount}`)
  for (let l = 0; l < layerCount; l += 1) {
    const layerZ = zStart + l * layerHeightMm
    let solid = 0
    let hovering = 0
    for (const c of cols) {
      const inLayer = c.topZ > layerZ + 1e-9 && c.bottomZ < layerZ + layerHeightMm - 1e-9
      if (!inLayer) continue
      solid += 1
      if (c.bottomZ > layerZ + 1e-5) {
        hovering += 1
        maxGapBelow = Math.max(maxGapBelow, c.bottomZ - layerZ)
      }
    }
    if (solid === 0) continue
    const ratio = hovering / solid
    if (ratio > worstRatio) {
      worstRatio = ratio
      worstLayerZ = layerZ
    }
  }
  console.log(`最差层悬垂占比=${(worstRatio * 100).toFixed(1)}% (Z=${worstLayerZ.toFixed(3)})，最大架空高度=${maxGapBelow.toFixed(3)}mm`)
  return { worstRatio, worstLayerZ, maxGapBelow }
}

/**
 * 真正决定「能不能打」的判据：每根柱体从第几层开始有材料。
 * FDM 自下而上堆积，柱体若不是从第 1 层起，底部就没有承托 → 悬空炒面。
 */
function quantifyAnchoring(label: string, cols: Col[], layerHeightMm: number) {
  const zMin = Math.min(...cols.map((c) => c.bottomZ))
  let anchored = 0
  let floating = 0
  let maxGap = 0
  for (const c of cols) {
    if (c.thickness <= 1e-6) continue // 0 厚度，不打印
    const startLayer = Math.floor((c.bottomZ - zMin) / layerHeightMm + 1e-9)
    if (startLayer <= 0) {
      anchored += 1
    } else {
      floating += 1
      maxGap = Math.max(maxGap, c.bottomZ - zMin)
    }
  }
  const printed = anchored + floating
  console.log(`\n=== ${label} 柱体锚定 ===`)
  console.log(`有实体承托 ${anchored}/${printed}，凭空悬空 ${floating}/${printed}，最大架空 ${maxGap.toFixed(3)}mm`)
  return { anchored, floating, printed, maxGap }
}

/** 统计某个 Z 高度上有材料的列数（横截面实心面积代理）。 */
function countSolidAtZ(cols: Col[], z: number): number {
  return cols.filter((c) => c.bottomZ <= z + 1e-6 && c.topZ > z + 1e-9).length
}

const Z_START = 0.6
const MAX_H = 0.2
const BOARD = 50
const LAYER_H = 0.04

/** 5×5：外圈 = 安全边距外框（data=1），内容 3×3 按行渐变 0.3/0.6/0.9 */
function framedHeightMap(): HalftoneHeightMap {
  const W = 5
  const H = 5
  const data = new Float32Array(W * H)
  for (let i = 0; i < data.length; i += 1) data[i] = 1 // 外圈安全边距外框
  const contentData = [0.3, 0.6, 0.9]
  for (let cy = 0; cy < 3; cy += 1) {
    for (let cx = 0; cx < 3; cx += 1) data[(cy + 1) * W + (cx + 1)] = contentData[cy]
  }
  return { width: W, height: H, data }
}

function flatHeightMap(w: number, h: number, value = 0.5): HalftoneHeightMap {
  const data = new Float32Array(w * h)
  data.fill(value)
  return { width: w, height: h, data }
}

describe('透光浮雕几何与可打印性验证（柱体坐在 A 面上）', () => {
  it('几何：底面整面齐平贴死 A 面（零空腔），顶面随灰度起伏', () => {
    const heightMap = framedHeightMap()
    const cols = readCols(heightMap, Z_START, MAX_H, BOARD, BOARD)

    // 底面齐平 @zStart：每一列都实心贴背景下层，没有任何一列悬空
    expect(cols.every((c) => Math.abs(c.bottomZ - Z_START) < 1e-6)).toBe(true)
    // 顶面随灰度起伏（不是满铺平面）
    expect(new Set(cols.map((c) => c.topZ.toFixed(4))).size).toBeGreaterThan(1)
    // 外框（data=1）顶面 = zStart + MAX_H（满厚边墙，最高）
    const topMax = Math.max(...cols.map((c) => c.topZ))
    expect(topMax).toBeCloseTo(Z_START + MAX_H, 5)
    // 安全边距外框（角落顶点）是实心满厚边墙 [zStart, zStart+MAX_H]
    expect(cols[0].thickness).toBeCloseTo(MAX_H, 5)
    expect(cols[0].topZ).toBeCloseTo(Z_START + MAX_H, 5)

    console.log(`\n=== 柱体坐在 A 面上（外框 5x5，内容 3x3 渐变 0.3/0.6/0.9）===`)
    console.log(`底面齐平@${Z_START}（全接触、零空腔），顶面最高=${topMax.toFixed(4)}`)
  })

  it('可打印性：SHRINKING、0% 悬垂、0 根悬空柱，免支撑', () => {
    const heightMap = framedHeightMap()
    const cols = readCols(heightMap, Z_START, MAX_H, BOARD, BOARD)

    // 0% 悬垂、最大架空 0mm
    const slice = quantifyOverhang('flush-on-A-face (SHRINKING)', cols, Z_START, LAYER_H)
    expect(slice.worstRatio).toBeLessThan(0.02)
    expect(slice.maxGapBelow).toBeLessThan(1e-6)

    // 所有柱体从第 1 层起 → 全部有承托
    const anchor = quantifyAnchoring('flush-on-A-face (SHRINKING)', cols, LAYER_H)
    expect(anchor.floating).toBe(0)
    expect(anchor.anchored).toBe(anchor.printed)
    expect(anchor.maxGap).toBeLessThan(1e-6)

    // SHRINKING 不变量：横截面随 Z 单调非增（越往上越窄）。
    // 采样区间严格落在 (zStart, topMax) 内，避免最顶层整层归零造成假升。
    const topMax = Math.max(...cols.map((c) => c.topZ))
    const steps = 20
    let prevCount = Number.POSITIVE_INFINITY
    let shrinking = true
    for (let i = 0; i < steps; i += 1) {
      const z = Z_START + (topMax - Z_START) * ((i + 0.5) / steps)
      const count = countSolidAtZ(cols, z)
      if (count > prevCount) shrinking = false
      prevCount = count
    }
    console.log(`SHRINKING 不变量（截面随 Z 单调非增）= ${shrinking}`)
    expect(shrinking).toBe(true)
  })

  it('均匀灰度：等厚平板，直接贴床，无需支撑', () => {
    const W = 3
    const H = 3
    const data = new Float32Array(W * H)
    data.fill(0.5)
    const heightMap: HalftoneHeightMap = { width: W, height: H, data }

    // minThick = max(0.05, 0.2*0.02) = 0.05 → avgH = 0.05 + 0.5*(0.2 − 0.05) = 0.125
    const minThick = Math.max(0.05, MAX_H * 0.02)
    const expected = minThick + 0.5 * (MAX_H - minThick)

    const cols = readCols(heightMap, Z_START, MAX_H, BOARD, BOARD)
    for (const c of cols) {
      expect(c.bottomZ).toBeCloseTo(Z_START, 5)
      expect(c.thickness).toBeCloseTo(expected, 5)
    }
    // 等厚平板：顶/底面都没有起伏
    expect(new Set(cols.map((c) => c.topZ.toFixed(4))).size).toBe(1)
    expect(new Set(cols.map((c) => c.bottomZ.toFixed(4))).size).toBe(1)

    const slice = quantifyOverhang('uniform-gray', cols, Z_START, LAYER_H)
    expect(slice.worstRatio).toBeLessThan(0.02)
    const anchor = quantifyAnchoring('uniform-gray', cols, LAYER_H)
    expect(anchor.floating).toBe(0)
  })

  it('组合体逐层审计：背景下层 + 浮雕全程零悬空，且不再生成背景顶层', async () => {
    // 这条用例专门覆盖此前被漏掉的盲区：
    // 旧测试只统计浮雕网格、且用 baseLoops:[] 让背景下层退化成空网格，
    // 导致「底板悬顶 87.5%」一路绿灯。这里强制用真实底板轮廓并检查顶点数。
    const BOARD_MM = 40
    const LAYER_H_MM = 0.16
    const relief: LightReliefSettings = {
      totalHeightMm: 2.4,
      faceAZMm: 0,
      faceAHeightMm: 0.4,
      faceBZMm: 0.6,
      faceBHeightMm: 1.4,
      bFaceMode: 'halftone',
      bFaceExposure: 100,
      bFaceInvert: false,
    }
    const rectangleSettings: BaseplateSettings = {
      ...defaultBaseplateSettings,
      template: 'rectangle',
      rectangleSizeMode: 'manual',
      widthMm: BOARD_MM,
      heightMm: BOARD_MM,
    }

    const size = 64
    const data = new Float32Array(size * size)
    const c = (size - 1) / 2
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x - c, y - c) / c
        data[y * size + x] = Math.min(1, Math.max(0, Math.sin(d * Math.PI * 1.5) * 0.5 + 0.5))
      }
    }

    // 底板轮廓必须是真实矩形，否则背景下层会是 0 顶点的空网格（旧测试的坑）
    const baseLoops = [{
      closed: true,
      points: [
        { x: 0, y: 0 }, { x: BOARD_MM, y: 0 },
        { x: BOARD_MM, y: BOARD_MM }, { x: 0, y: BOARD_MM },
      ],
    }]
    const artwork = {
      baseLoops,
      lineLoops: [],
      bFaceHeightMap: { width: size, height: size, data },
      previews: { compositeDataUrl: '' },
      boardWidthMm: BOARD_MM,
      boardHeightMm: BOARD_MM,
      pixelsPerMm: 4,
    } as unknown as ProcessedArtwork

    const bytes = (await buildLightRelief3mfPackage(
      artwork,
      rectangleSettings,
      relief,
      defaultPrintBedSettings,
      null,
      undefined,
      undefined,
      undefined,
    )) as Uint8Array

    const files = unzipSync(bytes)
    const modelKey = Object.keys(files).find((k) => k.endsWith('.model'))
    expect(modelKey).toBeTruthy()
    const xml = new TextDecoder().decode(files[modelKey as string])

    const objects: Record<string, Array<{ x: number; y: number; z: number }>> = {}
    const objRe = /<object\b([^>]*)>([\s\S]*?)<\/object>/g
    let m: RegExpExecArray | null
    while ((m = objRe.exec(xml)) !== null) {
      const nameMatch = /name="([^"]*)"/.exec(m[1])
      const name = nameMatch ? nameMatch[1] : 'unknown'
      const verts: Array<{ x: number; y: number; z: number }> = []
      const vRe = /<vertex\s+x="([-\d.eE+]+)"\s+y="([-\d.eE+]+)"\s+z="([-\d.eE+]+)"\s*\/>/g
      let vm: RegExpExecArray | null
      while ((vm = vRe.exec(m[2])) !== null) {
        verts.push({ x: Number(vm[1]), y: Number(vm[2]), z: Number(vm[3]) })
      }
      objects[name] = verts
    }

    console.log('\nobjects:', Object.keys(objects).map((k) => `${k}(${objects[k].length}v)`).join(', '))

    // 背景下层必须存在【且非空】——旧测试 toBeTruthy() 对空数组也是真值，必须查顶点数
    expect(objects['背景下层']).toBeTruthy()
    expect(objects['背景下层'].length).toBeGreaterThan(0)

    // 背景顶层（顶盖）必须不存在：它是盖在凹凸面上的实心板，谷底上方全空腔 → 悬顶 + 挡光
    expect(objects['背景顶层']).toBeUndefined()

    // 逐层审计整个组合体
    const baseVerts = objects['背景下层']
    const baseLo = Math.min(...baseVerts.map((v) => v.z))
    const baseHi = Math.max(...baseVerts.map((v) => v.z))

    const byXy = new Map<string, { minZ: number; maxZ: number }>()
    for (const v of objects['B面透光浮雕']) {
      const key = `${v.x.toFixed(4)}|${v.y.toFixed(4)}`
      const cur = byXy.get(key)
      if (!cur) byXy.set(key, { minZ: v.z, maxZ: v.z })
      else {
        cur.minZ = Math.min(cur.minZ, v.z)
        cur.maxZ = Math.max(cur.maxZ, v.z)
      }
    }
    const reliefCols = Array.from(byXy.values())
    const nCols = reliefCols.length
    expect(nCols).toBeGreaterThan(100)

    // 浮雕底面必须齐平贴死底板顶面（零空腔）
    const reliefBottomMin = Math.min(...reliefCols.map((c) => c.minZ))
    const reliefBottomMax = Math.max(...reliefCols.map((c) => c.minZ))
    console.log(`底板 z∈[${baseLo.toFixed(3)}, ${baseHi.toFixed(3)}]，浮雕底面 min=${reliefBottomMin.toFixed(4)} max=${reliefBottomMax.toFixed(4)}`)
    expect(reliefBottomMin).toBeCloseTo(baseHi, 4)
    expect(reliefBottomMax).toBeCloseTo(baseHi, 4)

    // 逐层占用集合：浮雕按列，底板占满全部列
    const zMin = Math.min(baseLo, reliefBottomMin)
    const zMax = Math.max(baseHi, Math.max(...reliefCols.map((c) => c.maxZ)))
    const occ: Set<number>[] = []
    for (let z = zMin; z <= zMax + 1e-9; z += LAYER_H_MM) {
      const s = new Set<number>()
      reliefCols.forEach((col, i) => {
        if (col.minZ <= z + 1e-9 && col.maxZ >= z - 1e-9) s.add(i)
      })
      if (z >= baseLo - 1e-9 && z <= baseHi + 1e-9) {
        for (let i = 0; i < nCols; i += 1) s.add(i)
      }
      occ.push(s)
    }

    let worstPct = 0
    let worstZ = 0
    for (let l = 1; l < occ.length; l += 1) {
      let un = 0
      for (const i of occ[l]) if (!occ[l - 1].has(i)) un += 1
      const pct = occ[l].size ? un / occ[l].size : 0
      if (pct > worstPct) {
        worstPct = pct
        worstZ = zMin + l * LAYER_H_MM
      }
    }
    console.log(`组合体逐层审计：最坏层 z=${worstZ.toFixed(2)} 悬空率=${(worstPct * 100).toFixed(2)}%`)

    // 关键断言：整个组合体没有任何一层出现悬空（此前倒扣方案这里是 87.5%）
    expect(worstPct).toBeLessThan(0.02)
  }, 120000)

  it('高度图密度封顶到 0.2mm/格：150×100mm 板从 385 万面降到约 150 万面', () => {
    const BOARD_W = 150
    const BOARD_H = 100
    const srcW = Math.ceil(BOARD_W * 8) // 1200（choosePixelsPerMm 在 150mm 板上给 8px/mm）
    const srcH = Math.ceil(BOARD_H * 8) // 800
    const mesh = buildHalftoneReliefMesh(
      flatHeightMap(srcW, srcH), Z_START, 1.4, BOARD_W, BOARD_H, false,
    )
    // 封顶后应为 750×500（= 150×100mm × 5 格/mm），顶点 =(W+1)(H+1)×2
    expect(mesh.vertices.length).toBe((750 + 1) * (500 + 1) * 2)
    expect(mesh.triangles.length).toBeLessThan(1_600_000)
    console.log(
      `\n密度封顶：150x100mm 板 源 ${srcW}x${srcH} → 顶点 ${mesh.vertices.length.toLocaleString()}`
      + ` 三角面 ${mesh.triangles.length.toLocaleString()}（未封顶时 1,924,002 / 3,848,000）`,
    )
  }, 120000)

  it('超大画板由绝对格数上限兜底：500×500mm 不会超出可序列化规模', () => {
    // choosePixelsPerMm 下限 4px/mm → 500mm 板拿到 2000×2000 源格（0.25mm/格）。
    // 单格已比 0.2mm 目标粗 → 密度封顶不触发，必须靠 720K 绝对格数上限兜底。
    const BOARD = 500
    const srcW = Math.ceil(BOARD * 4) // 2000
    const mesh = buildHalftoneReliefMesh(
      flatHeightMap(srcW, srcW), Z_START, 1.4, BOARD, BOARD, false,
    )
    // 720K 上限等比收缩 2500×2500 → floor(2500*0.33941)=848
    expect(mesh.vertices.length).toBe((848 + 1) * (848 + 1) * 2)
    expect(mesh.vertices.length).toBeLessThan(1_500_000)
    console.log(
      `\n绝对格数封顶：500x500mm 板 源 ${srcW}x${srcW} → 顶点 ${mesh.vertices.length.toLocaleString()}`
      + ` 三角面 ${mesh.triangles.length.toLocaleString()}（未封顶时 8,008,002 / 16,000,000）`,
    )
  }, 120000)

  it('只降不升：比 0.2mm 更粗的高度图保持原分辨率', () => {
    // 40×40mm 板目标 200×200，源 64×64（0.625mm/格）更粗 → 不应被上采样
    const mesh = buildHalftoneReliefMesh(
      flatHeightMap(64, 64), Z_START, 1.4, 40, 40, false,
    )
    expect(mesh.vertices.length).toBe(65 * 65 * 2)
  })

  it('降采样用盒式平均而非抽样：细密棋盘收敛为均匀中间灰，不产生摩尔纹', () => {
    const BOARD = 40 // 目标 200×200
    const srcW = 400
    const srcH = 400 // 0.1mm/格 棋盘
    const data = new Float32Array(srcW * srcH)
    for (let y = 0; y < srcH; y += 1) {
      for (let x = 0; x < srcW; x += 1) data[y * srcW + x] = (x + y) % 2
    }
    const mesh = buildHalftoneReliefMesh(
      { width: srcW, height: srcH, data }, Z_START, 1.4, BOARD, BOARD, false,
    )
    // 降到 200×200，每格正好盒式平均 2×2 源格 → 全部 0.5 → 顶面完全平整。
    // 若实现退化成最近邻抽样，这里会留下 minThick~maxH（约 1.35mm）的锯齿。
    const tops: number[] = []
    for (let i = 1; i < mesh.vertices.length; i += 2) tops.push(mesh.vertices[i][2])
    const min = Math.min(...tops)
    const max = Math.max(...tops)
    console.log(`\n棋盘降采样后顶面 z∈[${min.toFixed(4)}, ${max.toFixed(4)}]，起伏=${(max - min).toFixed(6)}mm`)
    expect(max - min).toBeLessThan(1e-3)
  }, 120000)
})
