/**
 * 模型清单的**完整性**测试。
 *
 * 清单是数据,错了不会有编译错误 —— 只会表现为"点了一键安装,报一句看不懂的失败",
 * 或者更糟:维度写错导致检索静默退化成词法。所以把不变量钉在这里。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_MODEL_ID, EMBEDDING_MODELS, defaultVariant, findModel, findVariant, variantOptions,
} from '../src/models.ts'

test('每个模型:唯一 id、正整数维度、至少一个档位', () => {
  const ids = new Set()
  for (const model of EMBEDDING_MODELS) {
    assert.ok(model.id.length > 0)
    assert.ok(!ids.has(model.id), `重复的模型 id: ${model.id}`)
    ids.add(model.id)
    assert.ok(Number.isInteger(model.dims) && model.dims > 0, `${model.id} 维度不合法`)
    assert.ok(model.variants.length > 0, `${model.id} 没有档位`)
    assert.ok(model.quality >= 1 && model.quality <= 7, `${model.id} quality 超出 1~7`)
    assert.ok(model.speed >= 1 && model.speed <= 5)
    assert.ok(model.contextTokens > 0)
  }
  assert.ok(ids.has(DEFAULT_MODEL_ID))
})

test('每个档位:文件名/体积/至少一个 http 源,且同一模型内文件名唯一', () => {
  for (const model of EMBEDDING_MODELS) {
    const files = new Set()
    for (const variant of model.variants) {
      assert.match(variant.file, /\.gguf$/, `${model.id}/${variant.id} 文件名不像 GGUF`)
      assert.ok(!files.has(variant.file), `${model.id} 里文件名重复: ${variant.file}`)
      files.add(variant.file)
      assert.ok(variant.bytes > 0)
      assert.ok(variant.sources.length >= 1, `${model.id}/${variant.id} 没有下载源`)
      for (const url of variant.sources) {
        assert.match(url, /^https:\/\//, `${model.id}/${variant.id} 的源不是 https: ${url}`)
        assert.ok(url.endsWith(variant.file), `源与文件名不匹配: ${url} vs ${variant.file}`)
      }
    }
    // 每个模型恰好一个默认档(否则 defaultVariant 的选择会随数组顺序漂移)
    assert.equal(model.variants.filter((v) => v.isDefault).length, 1, `${model.id} 的默认档不是恰好一个`)
  }
})

test('不配任何东西时的默认 = 老的 bge-m3 Q4_K_M(向后兼容的硬不变量)', () => {
  const model = findModel(DEFAULT_MODEL_ID)
  assert.ok(model)
  assert.equal(model.dims, 1024)
  assert.equal(model.pooling, 'cls')
  assert.equal(defaultVariant(model).file, 'bge-m3-Q4_K_M.gguf')
  assert.equal(defaultVariant(model).bytes, 437_778_496)
})

test('findVariant 认不出的档位退回默认档,而不是抛错', () => {
  const model = findModel('bge-m3')!
  assert.equal(findVariant(model, 'q8_0').id, 'q8_0')
  assert.equal(findVariant(model, 'nope').id, 'q4_k_m')
  assert.equal(findVariant(model, undefined).id, 'q4_k_m')
})

test('variantOptions 与清单一一对应(面板下拉用)', () => {
  const total = EMBEDDING_MODELS.reduce((n, m) => n + m.variants.length, 0)
  const options = variantOptions()
  assert.equal(options.length, total)
  for (const option of options) {
    const model = findModel(option.modelId)!
    assert.ok(model.variants.some((v) => v.id === option.variantId))
    assert.equal(option.dims, model.dims)
  }
})

test('带前缀的模型必须同时声明查询与文档前缀(只给一个等于没给)', () => {
  for (const model of EMBEDDING_MODELS) {
    const hasAny = model.queryPrefix !== undefined || model.documentPrefix !== undefined
    if (!hasAny) continue
    assert.ok(model.queryPrefix !== undefined && model.documentPrefix !== undefined, `${model.id} 只声明了一半前缀`)
    assert.notEqual(model.queryPrefix, model.documentPrefix, `${model.id} 的查询/文档前缀应当不同`)
  }
})
