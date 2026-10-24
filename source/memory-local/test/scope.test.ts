/**
 * scope 规范化 / 当前会话解析 / 文件名映射 的单元测试(0.5.0)。
 *
 * 这些规则是"写错就静默写到别处"的那类 bug 的护栏:旧实现把任何认不出的 scope
 * 静默回退成默认值,于是"记忆没存进去"永远不报错。现在非法一律 SCOPE_INVALID。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_SCOPE_NAME_CHARS,
  isCustomScope,
  normalizeScopeInput,
  resolveCurrentScopes,
  resolveScopeRef,
  scopeDisplayName,
  scopeKind,
  scopeTier,
  scopeTypePrefix,
  sessionShortId,
  writeScopeForDefault,
} from '../src/scope.ts'

function ok(raw: string | undefined) {
  const r = normalizeScopeInput(raw)
  assert.equal(r.ok, true, `expected ok for ${JSON.stringify(raw)}, got ${JSON.stringify(r)}`)
  return r as Extract<ReturnType<typeof normalizeScopeInput>, { ok: true }>
}

function bad(raw: string | undefined | null, hint?: RegExp) {
  const r = normalizeScopeInput(raw)
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(raw)}`)
  if (!r.ok) {
    assert.equal(r.code, 'SCOPE_INVALID')
    assert.ok(r.message.length > 0, 'message must be non-empty')
    if (hint) assert.match(r.message, hint)
  }
  return r
}

test('normalize: 保留名与默认值', () => {
  assert.equal(ok(undefined).kind, 'current-session', '未传 = 当前会话')
  assert.equal(ok('').kind, 'current-session', '空串视为未传')
  assert.equal(ok('   ').kind, 'current-session')
  assert.equal(ok('global').scope, 'global')
  assert.equal(ok('GLOBAL').scope, 'global', '保留名大小写不敏感')
  assert.equal(ok('project').kind, 'current-project')
  assert.equal(ok('session').kind, 'current-session')
  assert.equal(ok('all').kind, 'all')
  assert.equal(ok('*').kind, 'all')
})

test('normalize: 自定义名折叠空白 / 转小写 / 支持中文', () => {
  assert.equal(ok('  My   Notes ').scope, 'my notes')
  assert.equal(ok('项目\t笔记').scope, '项目 笔记', '制表符按空白折叠')
  assert.equal(ok('a-b_c.d').scope, 'a-b_c.d')
  assert.equal(ok('中文作用域').scope, '中文作用域')
  // NFC:'é' 的两种写法必须归一成同一个 scope,否则同一条记忆会分裂成两份
  assert.equal(ok('cafe\u0301').scope, ok('café').scope)
})

test('normalize: 保留前缀原样放行(旧数据与显式 pin 会话)', () => {
  assert.equal(ok('project:C:\\Users\\me\\repo').scope, 'project:C:\\Users\\me\\repo')
  assert.equal(ok('project:/a/b').kind, 'project')
  assert.equal(ok('session:abc-123').scope, 'session:abc-123')
  assert.equal(ok('Session:ABC').scope, 'session:ABC', '前缀大小写不敏感,值原样保留')
})

test('normalize: 非法名一律 SCOPE_INVALID(不再静默回退)', () => {
  bad('../etc/passwd')
  bad('a/b', /path separators/)
  bad('a\\b', /path separators/)
  bad('foo:bar', /':'/)
  bad('..')
  bad('...')
  bad('   .  ', /must not be/)
  bad('. .', /dots and spaces/)
  bad('a\u0000b', /control/)
  bad('a\u001fb', /control/)
  bad('x'.repeat(MAX_SCOPE_NAME_CHARS + 1), /exceeds/)
  bad('project:')
  bad('session:')
})

test('normalize: 自定义名里的保留字不是合法自定义名', () => {
  // 'global'/'project'/'session' 各自命中保留分支,而不是被当成自定义名
  assert.equal(ok('global').kind, 'global')
  assert.equal(ok('project').kind, 'current-project')
  assert.equal(ok('session').kind, 'current-session')
  // 'all' 是只读哨兵(合法),但它在写路径会被别人拒掉 —— 这里只确认它的 kind
  assert.equal(ok('all').kind, 'all')
})

test('scopeKind / isCustomScope / scopeTier', () => {
  assert.equal(scopeKind('global'), 'global')
  assert.equal(scopeKind('project:x'), 'project')
  assert.equal(scopeKind('session:x'), 'session')
  assert.equal(scopeKind('foo'), 'custom')
  assert.equal(isCustomScope('foo'), true)
  assert.equal(isCustomScope('session:x'), false)
  // 同分排序:session > project > 自定义 > global
  assert.ok(scopeTier('session:x') < scopeTier('project:x'))
  assert.ok(scopeTier('project:x') < scopeTier('foo'))
  assert.ok(scopeTier('foo') < scopeTier('global'))
})

test('resolveScopeRef: 写路径省略 scope 按 defaultScope 落点,拿不到会话回退 project', () => {
  const refs = { session: 'session:s1', project: 'project:/w' }
  const noSession = { project: 'project:/w' }
  assert.equal(resolveScopeRef(ok(undefined), refs, { mode: 'write' }).scope, 'session:s1')
  assert.equal(resolveScopeRef(ok(undefined), noSession, { mode: 'write' }).scope, 'project:/w', '无会话 → project,不抛错')
  assert.equal(resolveScopeRef(ok('project'), refs, { mode: 'write' }).scope, 'project:/w')
  assert.equal(resolveScopeRef(ok('global'), refs, { mode: 'write' }).scope, 'global')
  assert.equal(resolveScopeRef(ok('my notes'), refs, { mode: 'write' }).scope, 'my notes')
  // 显式 pin 某个会话
  assert.equal(resolveScopeRef(ok('session:other'), refs, { mode: 'write' }).scope, 'session:other')
})

test('resolveScopeRef: all 只读,写路径明确报错', () => {
  const refs = { session: 'session:s1', project: 'project:/w' }
  const write = resolveScopeRef(ok('all'), refs, { mode: 'write' })
  assert.equal(write.ok, false)
  if (!write.ok) assert.equal(write.code, 'SCOPE_NOT_WRITABLE')
  const read = resolveScopeRef(ok('all'), refs, { mode: 'read' })
  assert.deepEqual(read, { ok: true, all: true })
})

test('resolveScopeRef: 读路径省略 scope 交给调用方决定合并集合', () => {
  const refs = { session: 'session:s1', project: 'project:/w' }
  assert.deepEqual(resolveScopeRef(ok(undefined), refs, { mode: 'read' }), { ok: true })
  assert.equal(resolveScopeRef(ok('project'), refs, { mode: 'read' }).scope, 'project:/w')
  // 显式 'session' 与省略等价:交给调用方的合并集合
  assert.deepEqual(resolveScopeRef(ok('session'), refs, { mode: 'read' }), { ok: true })
  // 显式 pin 某个会话才是单 scope
  assert.equal(resolveScopeRef(ok('session:other'), refs, { mode: 'read' }).scope, 'session:other')
})

test('writeScopeForDefault: defaultScope 三种取值', () => {
  const refs = { session: 'session:s1', project: 'project:/w' }
  assert.equal(writeScopeForDefault('session', refs), 'session:s1')
  assert.equal(writeScopeForDefault('session', { project: 'project:/w' }), 'project:/w')
  assert.equal(writeScopeForDefault('project', refs), 'project:/w')
  assert.equal(writeScopeForDefault('global', refs), 'global')
  assert.equal(writeScopeForDefault(undefined, refs), 'session:s1', '缺省 = session')
})

test('resolveCurrentScopes: header.id / header.cwd / 子代理共享父会话', () => {
  const agent = { session: { header: { id: 'sess-1', cwd: '/work/repo' } } }
  assert.deepEqual(resolveCurrentScopes(agent), { session: 'session:sess-1', project: 'project:/work/repo' })
  // 只有 session.id(header 缺 id)时也能用
  assert.deepEqual(resolveCurrentScopes({ session: { id: 'sess-2' } }).session, 'session:sess-2')
  // **会话 cwd 优先于配置**:0.5.5 及以前是反的,后果是"当前项目"被钉成 process.cwd()
  // (= DSH 服务进程的 profile 目录),该 profile 下所有项目挤进同一个项目桶。
  assert.equal(
    resolveCurrentScopes(agent, { projectScope: 'project:fixed' }).project,
    'project:/work/repo',
    '有会话 cwd 时,项目键必须跟工作区走,不能被 projectScope 顶掉',
  )
  // 子代理 → 父会话 key
  const sub = { session: { header: { id: 'sub-1', cwd: '/w', origin: 'subagent', parentSession: 'parent-7' } } }
  assert.equal(resolveCurrentScopes(sub).session, 'session:parent-7')
  // fork(有 parentSession 但不是子代理)→ 仍用自己的会话 key
  const fork = { session: { header: { id: 'fork-1', parentSession: 'parent-7' } } }
  assert.equal(resolveCurrentScopes(fork).session, 'session:fork-1')
})

test('resolveCurrentScopes: 没有会话 cwd 时才用配置,再退回 process.cwd()', () => {
  // 显式配置(团队共享库那种用法)—— 拿不到会话 cwd 时必须生效
  assert.equal(
    resolveCurrentScopes({ session: { header: { id: 's' } } }, { projectScope: 'project:fixed' }).project,
    'project:fixed',
  )
  assert.equal(resolveCurrentScopes(undefined, { projectScope: 'project:fixed' }).project, 'project:fixed')
  // 配了但 cwd 也在 → cwd 赢(与上面同一条规则的另一面)
  assert.equal(
    resolveCurrentScopes({ session: { header: { id: 's', cwd: '/work/repo' } } }, { projectScope: 'project:fixed' }).project,
    'project:/work/repo',
  )
  // cwd 不是字符串(宿主形态意外)→ 当作没有 cwd,继续降级到配置
  assert.equal(
    resolveCurrentScopes({ session: { header: { id: 's', cwd: 42 } } }, { projectScope: 'project:fixed' }).project,
    'project:fixed',
  )
})

test('resolveCurrentScopes: 拿不到会话信息只降级,绝不抛错', () => {
  const cwd = process.cwd()
  assert.deepEqual(resolveCurrentScopes(undefined), { project: `project:${cwd}` })
  assert.deepEqual(resolveCurrentScopes(null), { project: `project:${cwd}` })
  assert.deepEqual(resolveCurrentScopes({}), { project: `project:${cwd}` })
  assert.deepEqual(resolveCurrentScopes({ session: {} }), { project: `project:${cwd}` })
  assert.deepEqual(resolveCurrentScopes({ session: { header: {} } }), { project: `project:${cwd}` })
  // header.id 不是字符串(宿主形态意外)→ 当成没有会话
  assert.equal(resolveCurrentScopes({ session: { header: { id: 42, cwd: '/w' } } }).session, undefined)
  // 宿主对象访问抛错(异常 getter)→ 不把错误带出去
  const hostile = { get session(): never { throw new Error('boom') } }
  assert.deepEqual(resolveCurrentScopes(hostile), { project: `project:${cwd}` })
})

test('会话作用域展示名:取会话 id 前 16 位(不是 8 位)', () => {
  // 真机 id 形如 `session-1a2b3c4d-…`:前 8 位恒为 `session-`,只取 8 位会让所有
  // 会话作用域都显示成同一个名字。
  const real = 'session-1a2b3c4d-0000-4000-8000-000000000001'
  assert.equal(sessionShortId(real), 'session-1a2b3c4d')
  assert.equal(scopeDisplayName(`session:${real}`), 'session:session-1a2b3c4d')
  // 短 id 原样返回,不补空格/不截断多字符
  assert.equal(sessionShortId('sess-abc12345'), 'sess-abc12345')
  assert.equal(scopeDisplayName('session:sess-abc12345'), 'session:sess-abc12345')
  // 两个会话必须显示成两个不同的名字(0.25.8 及以前的 bug:都是「会话 session-」)
  const other = 'session-99887766-0000-4000-8000-000000000002'
  assert.notEqual(scopeDisplayName(`session:${real}`), scopeDisplayName(`session:${other}`))
  // 异常输入不许抛错(展示层会把 undefined / 空 id 塞进来)
  assert.equal(sessionShortId(undefined as unknown as string), '')
  assert.doesNotThrow(() => scopeDisplayName('session:'))
})

test('作用域展示名带类型前缀(global / project / session / custom)', () => {
  // 四种类型的前缀必须由**类型**决定:global 与自定义的键本身不带前缀,靠这里补。
  assert.equal(scopeTypePrefix('global'), 'global:')
  assert.equal(scopeTypePrefix('project:/w'), 'project:')
  assert.equal(scopeTypePrefix('session:s1'), 'session:')
  assert.equal(scopeTypePrefix('handbook'), 'custom:')
  assert.equal(scopeTypePrefix('工作笔记'), 'custom:', '中文自定义作用域同样补 custom:')

  assert.equal(scopeDisplayName('global'), 'global:全局')
  assert.equal(scopeDisplayName('project:/w'), 'project:/w')
  assert.equal(scopeDisplayName('session:s1'), 'session:s1')
  assert.equal(scopeDisplayName('handbook'), 'custom:handbook')
  // 自定义作用域带名字(别名为空不算)时,前缀 + 名字
  assert.equal(scopeDisplayName('handbook', '工作笔记'), 'custom:工作笔记')
  assert.equal(scopeDisplayName('handbook', ''), 'custom:handbook')
  // 项目别名 / 会话标题走同一口径(前缀来自键,名字来自 humanName)
  assert.equal(scopeDisplayName('project:/w', '演示项目'), 'project:演示项目')
  assert.equal(scopeDisplayName('session:s1', '修层级(s1)'), 'session:修层级(s1)')
  // 没有 scope 键能落成「无前缀」的名字
  for (const scope of ['global', 'project:/w', 'session:s1', 'handbook']) {
    assert.match(scopeDisplayName(scope), /^(global|project|session|custom):/)
  }
})
