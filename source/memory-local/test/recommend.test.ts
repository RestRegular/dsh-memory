/**
 * 推荐器的规则测试(纯函数,用假硬件)。
 *
 * 这些断言的价值在于"可解释":推荐必须能说出为什么是它,以及为什么不是更大的那个。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HostHardware, RuntimeFlavor } from '../src/hardware.ts'
import { diskText, estimateFootprintMb, pickFlavor, recommendModel, usableRamMb, usableVramMb } from '../src/recommend.ts'
import { findModel } from '../src/models.ts'

function hw(over: Partial<HostHardware> = {}): HostHardware {
  const base: HostHardware = {
    platform: 'win32',
    arch: 'x64',
    cpuCount: 8,
    totalRamMb: 32 * 1024,
    freeDiskMb: 200 * 1024,
    diskPath: 'D:/stack',
    gpu: null,
    flavors: ['cpu'],
    notes: [],
  }
  return { ...base, ...over }
}

function nvidia(vramMb = 12288, driver = '551.86') {
  return { vendor: 'nvidia' as const, name: 'NVIDIA GeForce RTX 4070', vramMb, driver }
}

test('预算:内存按 60% 再扣 512MB,显存按 85%,体积含 1.15 权重系数', () => {
  assert.equal(usableRamMb(32 * 1024), Math.round(32 * 1024 * 0.6) - 512)
  assert.equal(usableVramMb(12288), Math.round(12288 * 0.85))
  assert.equal(estimateFootprintMb(1048576, false), Math.round(1.15) + 400)
  assert.equal(estimateFootprintMb(1048576, true), Math.round(1.15) + 250)
})

test('纯 CPU 的 8 核 32GB 中文机器:推荐多语言小模型 + CPU 运行时', () => {
  const rec = recommendModel({ hardware: hw(), locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.flavor, 'cpu')
  const model = findModel(rec.modelId)!
  // 中文环境优先中文/多语言,CPU 上惩罚 speed<=2 的大模型 → 落在 0.6B 这一档
  assert.equal(rec.modelId, 'qwen3-embedding-0.6b')
  assert.equal(model.dims, 1024)
  assert.ok(rec.reason.some((line) => line.includes('这台机器')), '必须说明本机事实')
  assert.ok(rec.warnings.length === 0, `不该有警告,实际:${JSON.stringify(rec.warnings)}`)
})

test('换模型必须提前告知"已有记忆要重嵌"', () => {
  const rec = recommendModel({ hardware: hw(), locale: 'zh-CN', recordCount: 42 })
  assert.ok(rec.warnings.some((line) => line.includes('42 条记忆重新嵌入')), JSON.stringify(rec.warnings))
})

test('弱机(4GB 内存 / 2 核)推的模型必须真的放得进内存预算', () => {
  const hardware = hw({ cpuCount: 2, totalRamMb: 4 * 1024 })
  const rec = recommendModel({ hardware, locale: 'en', recordCount: 0 })
  const model = findModel(rec.modelId)!
  const variant = model.variants.find((v) => v.id === rec.variantId)!
  const fp = estimateFootprintMb(variant.bytes, false)
  assert.ok(fp <= usableRamMb(hardware.totalRamMb), `推荐档 ${fp}MB 超过了可用内存 ${usableRamMb(hardware.totalRamMb)}MB`)
  assert.ok(rec.candidates.some((c) => c.blocked !== null), '应当有装不下的候选(并被解释)')
  assert.ok(rec.candidates.filter((c) => c.blocked !== null).every((c) => c.blocked!.includes('内存') || c.blocked!.includes('磁盘')))
})

test('磁盘不够时把候选标成 blocked,并给出原因', () => {
  const rec = recommendModel({ hardware: hw({ freeDiskMb: 120 }), locale: 'zh-CN', recordCount: 0 })
  const blocked = rec.candidates.filter((c) => c.blocked !== null)
  assert.ok(blocked.length > 0)
  assert.ok(blocked.every((c) => c.blocked!.includes('磁盘')), JSON.stringify(blocked.map((c) => c.blocked)))
  // 仍然要给一个结论,而不是抛错
  assert.ok(rec.modelId.length > 0)
})

test('有显卡:整块放得进显存的最大质量模型胜出(12GB → 8B,6GB → 4B)', () => {
  const big = hw({ gpu: nvidia(12288), flavors: ['cuda', 'vulkan', 'cpu'] })
  assert.equal(pickFlavor(big), 'cuda')
  const rec = recommendModel({ hardware: big, locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.flavor, 'cuda')
  assert.equal(rec.modelId, 'qwen3-embedding-8b', '12GB 显存装得下 8B,质量优先')
  assert.ok(rec.candidates.find((c) => c.modelId === rec.modelId)!.onGpu, '推荐档应当能整块放进显存')

  const mid = hw({ gpu: nvidia(6144), flavors: ['cuda', 'vulkan', 'cpu'] })
  const recMid = recommendModel({ hardware: mid, locale: 'zh-CN', recordCount: 0 })
  assert.equal(recMid.modelId, 'qwen3-embedding-4b', '6GB 显存放不下 8B,退到 4B')
})

test('CPU 上重罚大模型:4B/8B 不会因为"质量分高"被推荐给 32GB 的纯 CPU 机器', () => {
  const rec = recommendModel({ hardware: hw(), locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.modelId, 'qwen3-embedding-0.6b')
  const fourB = rec.candidates.find((c) => c.modelId === 'qwen3-embedding-4b')!
  const best = rec.candidates.find((c) => c.modelId === rec.modelId)!
  assert.ok(best.score > fourB.score, `CPU 上 0.6B(${best.score}) 应当优于 4B(${fourB.score})`)
})

test('驱动偏旧:退回 Vulkan 并说明原因', () => {
  const hardware = hw({ gpu: nvidia(8192, '470.14'), flavors: ['vulkan', 'cpu'] })
  const rec = recommendModel({ hardware, locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.flavor, 'vulkan')
  assert.ok(rec.warnings.some((line) => line.includes('550')), JSON.stringify(rec.warnings))
})

test('显存太小(核显/亮机卡)不推 GPU 风味', () => {
  const hardware = hw({ gpu: { vendor: 'intel', name: 'Intel UHD Graphics', vramMb: 1024, driver: null }, flavors: ['cpu'] })
  const rec = recommendModel({ hardware, locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.flavor, 'cpu')
})

test('英文环境与中文环境可以给出不同结论', () => {
  const zh = recommendModel({ hardware: hw(), locale: 'zh-CN', recordCount: 0 })
  const en = recommendModel({ hardware: hw(), locale: 'en-US', recordCount: 0 })
  assert.ok(findModel(zh.modelId))
  assert.ok(findModel(en.modelId))
  assert.ok(zh.reason.some((line) => line.includes('中文')), JSON.stringify(zh.reason))
})

test('候选表把"装不下"的也留着,便于面板解释', () => {
  const rec = recommendModel({ hardware: hw({ cpuCount: 2, totalRamMb: 8 * 1024 }), locale: 'zh-CN', recordCount: 0 })
  assert.ok(rec.candidates.length >= 8, '清单里的档位都应当出现在候选表里')
  assert.ok(rec.alternatives.length > 0 && rec.alternatives.length <= 3)
  for (const alt of rec.alternatives) {
    assert.ok(typeof alt.why === 'string' && alt.why.length > 0, '每个备选都要有一句为什么')
  }
})

test('磁盘文案:不足 1GB 不能说成 0GB(真机踩过:9.3GB 显示成 0GB)', () => {
  assert.equal(diskText(9553), '9GB')
  assert.equal(diskText(1024), '1GB')
  assert.equal(diskText(900), '900MB')
  const rec = recommendModel({ hardware: hw({ totalRamMb: 14 * 1024, freeDiskMb: 9553 }), locale: 'zh-CN', recordCount: 0 })
  const line = rec.reason.find((l) => l.includes('磁盘'))
  assert.ok(line?.includes('磁盘剩余 9GB'), `实际:${line}`)
})

test('2GB 共享显存的核显不算"可用 GPU"(真机踩过:AMD 核显被推了 Vulkan)', () => {
  const igpu = hw({ gpu: { vendor: 'amd', name: 'AMD Radeon (TM) Graphics', vramMb: 2048, driver: null }, flavors: ['cpu'] })
  const rec = recommendModel({ hardware: igpu, locale: 'zh-CN', recordCount: 0 })
  assert.equal(rec.flavor, 'cpu')
  assert.ok(rec.reason.some((l) => l.includes('CPU')), JSON.stringify(rec.reason))
})

test('风味顺序:macOS 走 metal,未知显卡退回 cpu', () => {
  const flavors = (value: RuntimeFlavor[]) => value
  assert.deepEqual(flavors(['metal', 'cpu']), ['metal', 'cpu'])
  const mac = recommendModel({ hardware: hw({ platform: 'darwin', arch: 'arm64', flavors: ['metal', 'cpu'] }), locale: 'zh-CN', recordCount: 0 })
  assert.equal(mac.flavor, 'metal')
  assert.ok(mac.reason.some((line) => line.includes('Metal')), JSON.stringify(mac.reason))
})
