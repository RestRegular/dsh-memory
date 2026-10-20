import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { memoryTools } from '../src/index.ts'

/**
 * 守卫:memoryTools 里声明了五个工具,apply.ts 必须逐个注册。
 *
 * 0.9.9 及以前 apply.ts 漏了 memory_get:实现和测试都在,但模型侧完全看不到
 * 这个工具。这里直接对源码做静态对账,防止再出现“实现了但没注册”。
 */
test('apply registers every memoryTools entry (including memory_get)', () => {
  const names = Object.keys(memoryTools({ getService: () => undefined }))
  assert.deepEqual(names.sort(), ['memory_forget', 'memory_get', 'memory_list', 'memory_save', 'memory_search'])
  const here = dirname(fileURLToPath(import.meta.url))
  const apply = readFileSync(join(here, '..', 'src', 'apply.ts'), 'utf8')
  for (const name of names) {
    assert.match(apply, new RegExp(`register\\(tools\\.${name}\\b`), `${name} 必须在 apply.ts 里注册`)
  }
})
