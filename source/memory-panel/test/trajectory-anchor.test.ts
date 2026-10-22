/**
 * 审计 → 轨迹的锚点解析：Trajectory 深链只接受 callId，所以没有 operationId
 * 的审计事件必须能从同一会话的事件窗口里找到该 turn/step 的 tool/call。
 *
 * 这些用例只覆盖纯解析函数；HTTP 围栏由 host-guard 测试覆盖。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findTrajectoryAnchor, handleRequest } from '../lib/index.js'

const ROUTE = '/memory/api'
const LOOPBACK = { host: '127.0.0.1:19387' }

function fakeRes() {
  const out: { status: number | null; body: any } = { status: null, body: null }
  return {
    out,
    writeHead(status: number) { out.status = status },
    end(text: string) { try { out.body = JSON.parse(text) } catch { out.body = text } },
  }
}

function ctxWith(events: unknown[], sessionId = 's1') {
  const session = { ownEvents: () => events }
  return {
    get: (name: string) => name === 'sessions'
      ? { get: (id: string) => id === sessionId ? session : undefined }
      : undefined,
  }
}

const events = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-a', name: 'memory_search', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 1, step: 2, callId: 'call-b', name: 'bash', arguments: '{}' } },
  { type: 'tool/call', data: { turn: 2, step: 1, callId: 'call-c', name: 'write', arguments: '{}' } },
]

test('按 turn/step 找该步第一个工具调用', () => {
  assert.deepEqual(
    findTrajectoryAnchor(ctxWith(events), { sessionId: 's1', turn: 1, step: 2 }),
    { callId: 'call-b', tool: 'bash', turn: 1, step: 2, reason: 'step_tool' },
  )
  assert.equal(
    findTrajectoryAnchor(ctxWith(events), { sessionId: 's1', turn: 2 }).callId,
    'call-c',
  )
})

test('显式 callId 必须属于该会话', () => {
  assert.equal(
    findTrajectoryAnchor(ctxWith(events), { sessionId: 's1', callId: 'call-c' }).reason,
    'operation',
  )
  const missing = findTrajectoryAnchor(ctxWith(events), { sessionId: 's1', callId: 'call-x' })
  assert.equal(missing.callId, null)
  assert.equal(missing.reason, 'operation_not_found')
})

test('会话不可用或该步没有工具调用时不伪造锚点', () => {
  const noSession = findTrajectoryAnchor(ctxWith(events), { sessionId: 'other', turn: 1 })
  assert.equal(noSession.callId, null)
  assert.equal(noSession.reason, 'session_unavailable')
  const noTool = findTrajectoryAnchor(ctxWith(events), { sessionId: 's1', turn: 9, step: 9 })
  assert.equal(noTool.callId, null)
  assert.equal(noTool.reason, 'no_tool_in_step')
  const noId = findTrajectoryAnchor(ctxWith([]), { sessionId: '' })
  assert.equal(noId.reason, 'session_required')
})

test('/memory/api/anchor:返回 callId，参数错误返回 400', async () => {
  const ctx = ctxWith(events)
  const res = fakeRes()
  await handleRequest(ctx as never, ROUTE, {
    url: `${ROUTE}/anchor?session=s1&turn=1&step=2`,
    method: 'GET',
    headers: LOOPBACK,
  }, res as never)
  assert.equal(res.out.status, 200)
  assert.equal(res.out.body.ok, true)
  assert.equal(res.out.body.value.callId, 'call-b')

  const bad = fakeRes()
  await handleRequest(ctx as never, ROUTE, {
    url: `${ROUTE}/anchor?session=s1&turn=abc`,
    method: 'GET',
    headers: LOOPBACK,
  }, bad as never)
  assert.equal(bad.out.status, 400)
  assert.equal(bad.out.body.ok, false)
  assert.equal(bad.out.body.error.code, 'ANCHOR_QUERY_INVALID')
})
