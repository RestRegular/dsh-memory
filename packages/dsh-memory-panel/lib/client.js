/**
 * dsh-memory-panel — 客户端(设置页「记忆」区块)。
 *
 * 与 dsh-meme 客户端完全同款形态:
 *   - window.__ModuleLoader__.load({id, factory(require)}),id 必须 = loader entry 名;
 *   - exports.inject = ['slots'](dsh-client-ui-slots 在 desktop 宿主 asar 里存在);
 *   - ctx.get('slots') 判空防御,缺 slots 就静默退出,绝不让 client boot 失败;
 *   - 数据走 /memory/api HTTP(服务端半边注册的 prefix 路由);
 *   - 颜色全走宿主 --dsw-alias-* 主题 token,深浅色自适应,零硬编码色值。
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/memory/api'

    const CSS = [
      '.memp{display:flex;flex-direction:column;gap:12px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.memp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .stats{display:flex;gap:10px;flex-wrap:wrap}',
      '.memp .stat{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 14px;background:var(--dsw-alias-bg-layer-1);min-width:110px}',
      '.memp .stat b{display:block;font-size:18px;font-weight:600}',
      '.memp .stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .muted{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .server{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}',
      '.memp .server-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-border-l1)}',
      '.memp .dot.on{background:#2ecc71}',
      '.memp .dot.off{background:#e05555}',
      '.memp input[type=text],.memp select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}',
      '.memp input[type=text]:focus,.memp select:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.memp textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit}',
      '.memp textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.memp button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
      '.memp button:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.memp button:disabled{opacity:.5;cursor:default}',
      '.memp .rec{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .rec-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.memp .rec-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.memp .chev{font-size:10px;opacity:.7;width:10px;flex:none;transition:transform .12s ease}',
      '.memp .chev.open{transform:rotate(90deg)}',
      '.memp .rec-body{margin-top:8px}',
      '.memp .badge{border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 6px;color:var(--dsw-alias-brand-primary)}',
      '.memp .preview{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.memp .content{white-space:pre-wrap;word-break:break-word;line-height:1.55}',
      '.memp .acts{display:flex;gap:6px;margin-top:8px}',
      '.memp .acts button{padding:3px 10px;font-size:12px}',
      '.memp .err{color:var(--dsw-alias-label-danger, #e05555);font-size:12px}',
      '.memp .empty{color:var(--dsw-alias-label-secondary);padding:20px;text-align:center}',
      '.memp .editrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}',
      '.memp .editrow input[type=text]{padding:4px 8px}',
      '.memp .editrow input[type=number]{width:64px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:4px 8px;font-size:13px;outline:none}',
      // 服务器开关(switch 造型)
      '.memp .toggle{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 5px}',
      '.memp .toggle-track{width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l1);position:relative;transition:background .15s ease;flex:none;display:inline-block}',
      '.memp .toggle.on .toggle-track{background:var(--dsw-alias-brand-primary)}',
      '.memp .toggle-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease}',
      '.memp .toggle.on .toggle-knob{transform:translateX(16px)}',
      '.memp .server-spacer{flex:1}',
    ].join('')

    async function api(method, body) {
      const res = await fetch(`${API}/${method}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      let wire
      try { wire = await res.json() } catch { throw new Error(`memory api: bad response (${res.status})`) }
      if (!wire || wire.ok !== true) throw new Error((wire && wire.error && wire.error.message) || `memory api: ${method} failed`)
      return wire.value
    }

    function fmtTime(ts) {
      if (!ts) return '—'
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    function scopeLabel(scope) {
      return scope === 'global' ? '全局' : scope.startsWith('project:') ? scope.slice(8) : scope
    }

    function RecordCard({ rec, onSaved, onDeleted }) {
      // collapsed by default: the list stays scannable, full text on demand
      const [expanded, setExpanded] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [content, setContent] = React.useState(rec.content)
      const [kind, setKind] = React.useState(rec.kind)
      const [tags, setTags] = React.useState(rec.tags.join(', '))
      const [importance, setImportance] = React.useState(rec.importance)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      // editing implies expanded: the editor replaces the body
      const open = expanded || editing
      const toggle = () => { if (!editing) setExpanded((v) => !v) }

      const save = async () => {
        setBusy(true); setError('')
        try {
          await api('update', {
            id: rec.id,
            content,
            kind,
            importance: Number(importance) || 0,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
          })
          setEditing(false)
          onSaved()
        } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const del = async () => {
        if (!window.confirm('删除这条记忆?')) return
        setBusy(true); setError('')
        try { await api('delete', { id: rec.id }); onDeleted() } catch (e) { setError(String(e.message || e)) } finally { setBusy(false) }
      }

      const cancelEdit = () => {
        setEditing(false)
        setContent(rec.content); setKind(rec.kind)
        setTags(rec.tags.join(', ')); setImportance(rec.importance)
      }

      return h('div', { className: 'rec' },
        h('div', {
          className: 'rec-head',
          role: 'button',
          tabIndex: 0,
          'aria-expanded': open,
          title: open ? '收起' : '展开查看完整内容',
          onClick: toggle,
          onKeyDown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle() }
          },
        },
          h('span', { className: open ? 'chev open' : 'chev' }, '▶'),
          h('span', { className: 'badge', title: rec.scope }, scopeLabel(rec.scope)),
          h('span', { className: 'badge' }, rec.kind),
          rec.embedded
            ? h('span', { title: '已生成向量' }, '◆')
            : h('span', { title: '待嵌入(向量服务未就绪或排队中)' }, '◇'),
          h('span', null, `更新 ${fmtTime(rec.updatedAt)}`),
          rec.supersedes ? h('span', null, `修正 #${String(rec.supersedes).slice(0, 6)}`) : null,
          h('span', { className: 'muted' }, `${rec.content.length} 字`),
        ),
        !open ? h('div', { className: 'preview', style: { marginTop: 6 } }, rec.content) : null,
        open
          ? h('div', { className: 'rec-body' },
              editing
                ? h('div', null,
                    h('textarea', { rows: 4, value: content, onChange: (e) => setContent(e.target.value) }),
                    h('div', { className: 'editrow' },
                      h('select', { value: kind, onChange: (e) => setKind(e.target.value) },
                        ['fact', 'decision', 'preference', 'procedure', 'note'].map((k) => h('option', { key: k, value: k }, k))),
                      h('input', { type: 'text', style: { width: 170 }, value: tags, placeholder: '标签, 逗号分隔', onChange: (e) => setTags(e.target.value) }),
                      h('label', null, '重要度 ',
                        h('input', { type: 'number', min: 0, max: 1, step: 0.1, value: importance, onChange: (e) => setImportance(e.target.value) })),
                    ),
                    h('div', { className: 'acts' },
                      h('button', { disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                      h('button', { disabled: busy, onClick: cancelEdit }, '取消'),
                    ),
                  )
                : h('div', { className: 'content' }, rec.content),
            )
          : null,
        error ? h('div', { className: 'err' }, error) : null,
        open && !editing
          ? h('div', { className: 'acts' },
              h('button', { onClick: () => setEditing(true) }, '编辑'),
              h('button', { disabled: busy, onClick: del }, busy ? '…' : '删除'),
            )
          : null,
      )
    }

    function MemoryPanel() {
      const [records, setRecords] = React.useState([])
      const [scopes, setScopes] = React.useState([])
      const [embedServer, setEmbedServer] = React.useState(null)
      const [embedBusy, setEmbedBusy] = React.useState(false)
      const [embedNotice, setEmbedNotice] = React.useState('')
      const [scopeFilter, setScopeFilter] = React.useState('')
      const [q, setQ] = React.useState('')
      const [loading, setLoading] = React.useState(true)
      const [error, setError] = React.useState('')

      const load = async (query, scopeF) => {
        setLoading(true); setError('')
        try {
          const params = new URLSearchParams()
          const qq = query !== undefined ? query : q
          const ss = scopeF !== undefined ? scopeF : scopeFilter
          if (ss) params.set('scope', ss)
          if (qq.trim()) params.set('q', qq.trim())
          const suffix = params.toString() ? `?${params}` : ''
          const [recVal, status] = await Promise.all([api(`records${suffix}`), api('status')])
          setRecords(recVal.records)
          setScopes(status.scopes)
          setEmbedServer(status.embedServer ?? null)
        } catch (e) {
          setError(String(e.message || e))
        }
        setLoading(false)
      }
      React.useEffect(() => { load('', '') }, [])

      const embedAction = async (action) => {
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = await api(`embed/${action}`, {})
          setEmbedServer(value)
          if (action === 'start') {
            setEmbedNotice(value.state === 'disabled'
              ? '未配置自启(spawn.enabled),无法启动'
              : value.reachable ? `已启动(pid ${value.pid ?? '?'})` : '已请求启动,但健康检查未通过,请看 llama-server.log')
          } else {
            setEmbedNotice(value.stopped
              ? '已停止'
              : value.reason === 'EXTERNAL_INSTANCE'
                ? '这是应用外部启动的实例,不受本应用管理,未关闭'
                : '当前没有由本应用管理的进程')
          }
        } catch (e) {
          setEmbedNotice(`操作失败: ${String(e.message || e)}`)
        }
        setEmbedBusy(false)
      }

      const total = scopes.reduce((n, s) => n + s.records, 0)
      const pending = scopes.reduce((n, s) => n + s.pendingEmbeds, 0)
      const serverOn = Boolean(embedServer && embedServer.reachable)
      const external = Boolean(embedServer && embedServer.reachable && !embedServer.owned)
      const toggleDisabled = embedBusy || !embedServer || external
      const toggleTitle = !embedServer
        ? '当前 provider 未提供向量服务管理'
        : external
          ? '这是应用外部启动的实例,不受本应用管理'
          : serverOn ? '点击关闭向量服务' : '点击启动向量服务'
      const embedState = !embedServer
        ? '不可用'
        : serverOn
          ? (embedServer.owned ? '运行中 · 由本应用管理' : '运行中 · 外部实例(不可停止)')
          : (embedServer.enabled ? '已停止' : '已停止 · 未启用自启')

      return h('div', { className: 'memp' },
        h('div', { className: 'stats' },
          h('div', { className: 'stat' }, h('b', null, String(total)), h('span', null, '条记忆')),
          h('div', { className: 'stat' }, h('b', null, String(scopes.length)), h('span', null, '个作用域')),
          h('div', { className: 'stat' }, h('b', null, String(pending)), h('span', null, '待嵌入向量')),
        ),
        h('div', { className: 'server' },
          h('div', { className: 'server-head' },
            h('span', { className: serverOn ? 'dot on' : 'dot off' }),
            h('b', null, '向量服务'),
            h('span', { className: 'muted' }, embedState),
            embedServer && embedServer.pid ? h('span', { className: 'muted' }, `pid ${embedServer.pid}`) : null,
            embedServer && embedServer.baseUrl ? h('span', { className: 'muted' }, embedServer.baseUrl) : null,
            h('span', { className: 'server-spacer' }),
            h('button', {
              className: serverOn ? 'toggle on' : 'toggle',
              role: 'switch',
              'aria-checked': serverOn,
              disabled: toggleDisabled,
              title: toggleTitle,
              onClick: () => embedAction(serverOn ? 'stop' : 'start'),
            },
              h('span', { className: 'toggle-track' }, h('span', { className: 'toggle-knob' })),
              h('span', null, embedBusy ? '处理中…' : serverOn ? '已开启' : '已关闭'),
            ),
            h('button', { disabled: embedBusy || loading, onClick: () => load(), title: '刷新状态' }, '↻'),
          ),
          h('div', { className: 'muted' }, '应用启动时自动拉起、退出时自动关闭;开关可手动干预'),
          embedNotice ? h('div', { className: 'muted' }, embedNotice) : null,
        ),
        h('div', { className: 'row' },
          h('input', {
            type: 'text', style: { width: 200 }, placeholder: '搜索内容/类型/标签…', value: q,
            onChange: (e) => setQ(e.target.value),
            onKeyDown: (e) => { if (e.key === 'Enter') load(q, scopeFilter) },
          }),
          h('select', { value: scopeFilter, onChange: (e) => { setScopeFilter(e.target.value); load(q, e.target.value) } },
            h('option', { value: '' }, '全部作用域'),
            scopes.map((s) => h('option', { key: s.scope, value: s.scope }, scopeLabel(s.scope)))),
          h('button', { onClick: () => load(q, scopeFilter), disabled: loading }, loading ? '刷新中…' : '刷新'),
          h('button', { onClick: () => { setQ(''); setScopeFilter(''); load('', '') } }, '重置'),
        ),
        error ? h('div', { className: 'err' }, error) : null,
        !loading && !error && records.length === 0
          ? h('div', { className: 'empty' }, '没有匹配的记忆。让模型用 memory_save 保存,或检查 provider 是否启用。')
          : records.map((rec) => h(RecordCard, { key: rec.id, rec, onSaved: () => load(), onDeleted: () => load() })),
      )
    }

    const inject = ['slots']

    function apply(ctx) {
      try {
        const styleEl = document.createElement('style')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        ctx.effect(() => () => { styleEl.remove() }, 'dsh-memory-panel: styles')

        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory', order: 24, label: '记忆' },
          () => React.createElement(MemoryPanel),
        ))
      } catch (error) {
        console.error('[dsh-memory-panel] client apply 失败(已吞掉):', error?.message)
      }
    }

    exports.apply = apply
    exports.inject = inject
    // exported for the render smoke test only (host/bundler never reads it),
    // same convention as the official dsh-meme client
    exports.__test = { RecordCard: RecordCard, MemoryPanel: MemoryPanel, CSS: CSS }
    return module.exports
  },
})
