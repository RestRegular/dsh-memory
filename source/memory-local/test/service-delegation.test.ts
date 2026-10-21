/**
 * Cordis 服务包装层必须转发审计方法。
 *
 * 0.12.0/0.12.1 的 provider 实现加在 LocalMemoryService 上，但面板通过
 * ctx.get('memory') 拿到的是 CordisMemoryService 包装实例；包装层没转发时，
 * 面板就会显示“provider 未提供注入审计接口”。这里用最小 Service stub 检查
 * 包装层暴露的方法，防止再次“实现了但服务上看不到”。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const CORDIS_STUB = 'data:text/javascript,' + encodeURIComponent(`
export class Service {
  constructor(ctx, name) { this.ctx = ctx; this.name = name }
}
`)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/cordis') return { url: CORDIS_STUB, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { CordisMemoryService } = await import('../src/apply.ts')

test('CordisMemoryService 暴露面板所需的审计方法', () => {
  for (const name of ['attachInjectAudit', 'detachInjectAudit', 'injectAudit', 'injectAuditPage', 'injectAuditStats']) {
    assert.equal(
      typeof (CordisMemoryService.prototype as unknown as Record<string, unknown>)[name],
      'function',
      `ctx.get('memory').${name} 必须存在，否则面板审计不可用`,
    )
  }
})
