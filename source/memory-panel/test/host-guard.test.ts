/**
 * 面板 HTTP 围栏测试(每个路由都先过 refuseRequest)。
 *
 * 为什么需要它:注册在裸 webServer 上的路由**不在**宿主的 /api 围栏与浏览器登录
 * 之后 —— 那是一个给别的路由主动调用的服务方法,不是自动套上的中间件。漏掉它,
 * 任何能访问该端口的东西都能读、改、删、清空全部记忆(以及拉起/卸载向量服务)。
 * 所以这里锁住四种结局:宿主放行、宿主拒绝(401/403)、宿主围栏抛错(失败关闭)、
 * 以及旧宿主没有该服务时的自建 loopback + 同源兜底。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { refuseRequest } from '../lib/index.js'

/** 只实现被测代码用到的 ctx.get。 */
function ctxWith(connection) {
  return { get: (name) => (name === 'connection' ? connection : undefined) }
}

const req = (headers) => ({ headers })
const LOOPBACK = req({ host: '127.0.0.1:19387' })

test('没有宿主围栏时:loopback + 同源放行', () => {
  assert.equal(refuseRequest(ctxWith(undefined), LOOPBACK), undefined)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: 'localhost:19387' })), undefined)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' })), undefined)
})

test('没有宿主围栏时:非 loopback 权威一律拒绝', () => {
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: 'evil.example.com' })), 403)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: '10.0.0.5:19387' })), 403)
})

test('没有宿主围栏时:缺失 Host 拒绝,跨站与 Origin 不符拒绝', () => {
  assert.equal(refuseRequest(ctxWith(undefined), req({})), 403)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' })), 403)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: '127.0.0.1:19387', origin: 'http://attacker.test' })), 403)
  assert.equal(refuseRequest(ctxWith(undefined), req({ host: '127.0.0.1:19387', origin: 'not a url' })), 403)
})

test('旧宿主只发布 trustedHosts 时:声明的权威放行', () => {
  const ctx = ctxWith({ trustedHosts: ['DSH.Example.org:8443'] })
  assert.equal(refuseRequest(ctx, req({ host: 'dsh.example.org:8443' })), undefined)
  assert.equal(refuseRequest(ctx, req({ host: 'dsh.example.org:9999' })), 403)
})

test('宿主围栏可用时以它为准:401 / 403 原样透传', () => {
  const login = ctxWith({ requestRejection: () => 401 })
  assert.equal(refuseRequest(login, LOOPBACK), 401)
  const fence = ctxWith({ requestRejection: () => 403 })
  // 即使 Host 看起来是本机,也以宿主判定为准(宿主还带着登录这一层)
  assert.equal(refuseRequest(fence, LOOPBACK), 403)
})

test('宿主围栏放行时不再叠加自己的判定', () => {
  const ctx = ctxWith({ requestRejection: () => undefined })
  assert.equal(refuseRequest(ctx, req({ host: 'dsh.example.org' })), undefined)
})

test('宿主围栏自己抛错 = 什么都没放行:失败关闭(403)', () => {
  const ctx = ctxWith({ requestRejection: () => { throw new Error('boom') } })
  assert.equal(refuseRequest(ctx, LOOPBACK), 403)
})

test('宿主围栏拿到的是真实 request,且 this 指向 connection 服务', () => {
  const connection = {
    seen: null,
    requestRejection(r) { this.seen = r; return undefined },
  }
  assert.equal(refuseRequest(ctxWith(connection), LOOPBACK), undefined)
  assert.equal(connection.seen, LOOPBACK)
})

test('ctx.get 本身抛错时也失败关闭', () => {
  const ctx = { get: () => { throw new Error('no loader') } }
  assert.equal(refuseRequest(ctx, req({ host: 'evil.example.com' })), 403)
})
