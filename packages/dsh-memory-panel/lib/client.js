/**
 * dsh-memory-panel — 客户端(设置页「记忆」区块)。
 *
 * 与 dsh-meme 客户端完全同款形态:
 *   - window.__ModuleLoader__.load({id, factory(require)}):**id 必须等于包名**
 *     (client-modules 按包名建图行;声明成别的名字会让宿主找不到该行、回退重拉
 *      同一个 bundle → 二次注册 → "duplicate factory registration" 启动失败);
 *   - exports.inject = ['slots'](dsh-client-ui-slots 在 desktop 宿主 asar 里存在);
 *   - ctx.get('slots') 判空防御,缺 slots 就静默退出,绝不让 client boot 失败;
 *   - 数据走 /memory/api HTTP(服务端半边注册的 prefix 路由);
 *   - 颜色全走宿主 --dsw-alias-* 主题 token,深浅色自适应,零硬编码色值。
 */
window.__ModuleLoader__.load({
  id: '@restregular/dsh-memory-panel',
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
      // 状态徽标（外部服务 / 由本应用托管）
      '.memp .pill{font-size:11px;line-height:1.6;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.memp .hint code{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 4px}',
      // 维护区（卸载向量服务 / 清空记忆数据）
      '.memp .maint{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.memp .maint-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}',
      '.memp .maint-row .grow{flex:1;min-width:200px}',
      '.memp .danger{color:var(--dsw-alias-label-danger, #e05555);border-color:var(--dsw-alias-label-danger, #e05555)}',
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

    function RecordCard({ rec, vectorOn, onSaved, onDeleted }) {
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
            : vectorOn === false
              ? h('span', { title: '未启用向量检索（仍可用词法匹配）' }, '◇')
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
      const [installRequested, setInstallRequested] = React.useState(false)
      const [dangerAsk, setDangerAsk] = React.useState('')
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
          // 安装接口返回的是 { install, ...status }：先落状态，进度由轮询刷新
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (action === 'install') {
            setInstallRequested(true)
            setEmbedNotice('开始下载运行时与模型（可以继续用记忆功能，不影响）')
          } else if (action === 'install/cancel') {
            setInstallRequested(false)
            setEmbedNotice('已请求取消下载')
          } else if (action === 'start') {
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

      /**
       * 维护动作：卸载向量服务 / 清空记忆数据。两者都不可撤销，所以都走两步确认
       * （dangerAsk 记住当前等确认的那一项，第二次点击才真的发请求）。
       */
      const maintenanceAction = async (which) => {
        if (dangerAsk !== which) { setDangerAsk(which); setEmbedNotice(''); return }
        setDangerAsk('')
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = which === 'uninstall'
            ? await api('embed/uninstall', {})
            // 服务端要求显式 confirm:"delete"，避免任何一次误触就清库
            : await api('data/wipe', { confirm: 'delete' })
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (which === 'uninstall') {
            setEmbedNotice(value.removed
              ? `已卸载向量服务，释放约 ${((value.freedBytes ?? 0) / 1048576).toFixed(1)} MB。向量检索已关闭，词法检索照常。`
              : value.reason === 'EXTERNAL_BACKEND'
                ? '当前后端不在本插件管理的目录里（是你自己装的），没有删除任何东西。'
                : '没有找到本插件安装的向量服务文件。')
          } else {
            setEmbedNotice(`已清空 ${value.removed ?? 0} 条记忆（${(value.scopes ?? []).length} 个作用域）。`)
          }
          await load('', '')
        } catch (e) {
          setEmbedNotice(`操作失败: ${String(e.message || e)}`)
        }
        setEmbedBusy(false)
      }

      // 安装状态要在 effect 之前算出来：依赖数组在渲染期取值，晚于它的 const 会踩 TDZ。
      const install = (embedServer && embedServer.install) || null
      const maintenance = (embedServer && embedServer.maintenance) || null
      const usageMb = maintenance ? (maintenance.usageBytes / 1048576).toFixed(1) : '0.0'
      const installPhase = install && install.phase ? install.phase : 'idle'
      const installRunning = installPhase !== 'idle' && installPhase !== 'done' && installPhase !== 'error'
      const installBusy = installRunning
      const installed = Boolean(install && install.installed)
      // 点了按钮就一定要轮询：provider 的 start() 是 fire-and-forget，紧接着返回的那次
      // 状态可能还停在 idle，只看 phase 会让进度永远不刷新。
      const shouldPoll = shouldPollInstall(installPhase, installRequested)
      React.useEffect(() => {
        if (!shouldPoll) return undefined
        const timer = setInterval(() => { load('', '') }, 1500)
        return () => clearInterval(timer)
      }, [shouldPoll])
      React.useEffect(() => {
        if (installRequested && (installPhase === 'done' || installPhase === 'error')) setInstallRequested(false)
      }, [installRequested, installPhase])

      const total = scopes.reduce((n, s) => n + s.records, 0)
      const pending = scopes.reduce((n, s) => n + s.pendingEmbeds, 0)

      // 向量卡片的状态判定。provider 给的 mode 决定"该不该有启停开关"：
      //   off      没配置任何后端 → 不给开关，给「下载并配置」按钮
      //   external 只知道 endpoint（云端/用户自建）→ 开关无意义，我们不该假装拥有它
      //   managed  配置了 spawn（或刚自动装好）→ 我们托管子进程，给开关
      // 另外 enabled=false（配置里显式关掉）时也不能给一个"开了也没用"的开关。
      const mode = embedServer && embedServer.mode
        ? embedServer.mode
        : (embedServer && embedServer.baseUrl ? 'managed' : 'off')
      const vectorEnabled = embedServer ? Boolean(embedServer.enabled) : false
      const configured = Boolean(embedServer && (embedServer.configured !== undefined
        ? embedServer.configured
        : mode !== 'off'))
      const serverOn = Boolean(embedServer && embedServer.reachable)
      const managed = mode === 'managed'
      const canToggle = Boolean(embedServer) && managed && vectorEnabled
      const toggleTitle = !embedServer
        ? '当前 provider 未提供向量服务管理'
        : mode === 'external' ? '这是外部服务（云端或你自己跑的），不由本应用启停'
          : !vectorEnabled ? '向量检索已在配置里关闭'
            : serverOn ? '点击关闭向量服务' : '点击启动向量服务'

      const mb = (n) => (n / 1048576).toFixed(1)
      const installPercent = install && install.totalBytes ? Math.min(100, Math.round((install.receivedBytes / install.totalBytes) * 100)) : null

      const dotClass = serverOn ? 'dot on' : 'dot off'
      let stateText
      if (!embedServer) stateText = '不可用（provider 未提供管理接口）'
      else if (mode === 'off') stateText = installBusy ? '未配置 · 正在安装' : installed ? '未配置 · 检测到本地文件' : '未配置（可选）'
      else if (!vectorEnabled) stateText = '已在配置里关闭'
      else if (serverOn) stateText = embedServer.owned ? '运行中 · 由本应用管理' : '运行中 · 外部服务'
      else stateText = managed ? '已停止' : '未连接'

      // 右侧动作区：安装进度 > 下载按钮 > 启停开关。
      // 原则：只在"开关真能改变什么"时才渲染它——未配置、外部服务、配置里显式
      // 关闭，这三种情况给别的动作或干脆不给，避免一个永远灰着的开关。
      const actions = []
      if (installBusy) {
        actions.push(h('span', { className: 'muted', key: 'prog' },
          `${install.message || install.phase}${installPercent === null ? '' : ` ${installPercent}%`}`
          + (install.totalBytes ? `（${mb(install.receivedBytes)}/${mb(install.totalBytes)} MB）` : '')))
        actions.push(h('button', { key: 'cancel', disabled: embedBusy, onClick: () => embedAction('install/cancel') }, '取消'))
      } else if (install && install.phase === 'error') {
        actions.push(h('button', { key: 'retry', disabled: embedBusy, onClick: () => embedAction('install') }, '重试下载'))
      } else if (mode === 'off' && !installed) {
        actions.push(h('button', {
          key: 'install',
          disabled: embedBusy,
          title: '下载 llama.cpp 运行时（CPU 版）与 bge-m3 量化模型到本地，并托管启动',
          onClick: () => embedAction('install'),
        }, embedBusy ? '处理中…' : '下载并配置'))
      } else if (canToggle) {
        actions.push(h('button', {
          key: 'toggle',
          className: serverOn ? 'toggle on' : 'toggle',
          role: 'switch',
          'aria-checked': serverOn,
          disabled: embedBusy,
          title: toggleTitle,
          onClick: () => embedAction(serverOn ? 'stop' : 'start'),
        },
          h('span', { className: 'toggle-track' }, h('span', { className: 'toggle-knob' })),
          h('span', null, embedBusy ? '处理中…' : serverOn ? '已开启' : '已关闭'),
        ))
      }
      actions.push(h('button', { key: 'refresh', disabled: embedBusy || loading, onClick: () => load(), title: '刷新状态' }, '↻'))

      let hint = null
      if (mode === 'off') {
        hint = install && install.phase === 'error'
          ? h('div', { className: 'hint err' }, `安装失败：${install.error || install.message}`)
          : installed
            ? h('div', { className: 'hint' }, '已检测到本地向量服务文件，正在启用…若长时间不变，点右上角 ↻ 刷新。')
            : h('div', { className: 'hint' },
              '向量检索是可选的：不配也能用（检索自动降级为词法匹配）。点「下载并配置」会拉取 llama.cpp CPU 版 + bge-m3 模型（约 440MB，装在 ',
              h('code', null, (install && install.root) || '插件数据目录'),
              '），装好即由本应用托管启动；也可以自己在配置里写 ',
              h('code', null, 'retrieval.vector.endpoint'),
              ' 指向任意 OpenAI 兼容的 embeddings 服务（云端或自建）。')
      } else if (!vectorEnabled) {
        hint = h('div', { className: 'hint' }, '配置里把向量检索关掉了（', h('code', null, 'retrieval.vector.enabled: false'), '）；改成 true 并重启应用即可启用。')
      } else if (mode === 'external') {
        hint = h('div', { className: 'hint' }, '外部服务：本应用只负责调用，不启动也不停止它。')
      } else if (managed) {
        hint = h('div', { className: 'hint' }, '应用启动时自动拉起、退出时自动关闭；开关可手动干预。')
      }

      return h('div', { className: 'memp' },
        h('div', { className: 'stats' },
          h('div', { className: 'stat' }, h('b', null, String(total)), h('span', null, '条记忆')),
          h('div', { className: 'stat' }, h('b', null, String(scopes.length)), h('span', null, '个作用域')),
          configured && vectorEnabled
            ? h('div', { className: 'stat' }, h('b', null, String(pending)), h('span', null, '待嵌入向量'))
            : h('div', { className: 'stat' }, h('b', null, '—'), h('span', null, '向量未启用')),
        ),
        h('div', { className: 'server' },
          h('div', { className: 'server-head' },
            h('span', { className: dotClass }),
            h('b', null, '向量服务'),
            h('span', { className: 'muted' }, stateText),
            embedServer && embedServer.pid ? h('span', { className: 'muted' }, `pid ${embedServer.pid}`) : null,
            embedServer && embedServer.baseUrl && mode !== 'off' ? h('span', { className: 'muted' }, embedServer.baseUrl) : null,
            configured && vectorEnabled ? h('span', { className: 'pill' }, managed ? '由本应用托管' : '外部服务') : null,
            h('span', { className: 'server-spacer' }),
            actions,
          ),
          hint,
          embedNotice ? h('div', { className: 'muted' }, embedNotice) : null,
        ),
        // 维护区：DSH 卸载插件时不会给插件任何提问机会（就是 pnpm remove + 去掉
        // bundles），所以"要不要留向量服务 / 要不要留记忆数据"只能在这里、卸载之前问。
        maintenance
          ? h('div', { className: 'maint' },
            h('div', { className: 'maint-row' },
              h('b', null, '维护'),
              h('span', { className: 'muted' }, '不可撤销，卸载插件前请先在这里处理'),
            ),
            h('div', { className: 'maint-row' },
              h('span', { className: 'grow' }, `向量服务文件占用 ${usageMb} MB`),
              maintenance.usageBytes > 0
                ? (dangerAsk === 'uninstall'
                  ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, `确认卸载（释放 ${usageMb} MB）`),
                     h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                  : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, '卸载向量服务'))
                : h('span', { className: 'muted' }, '没有本插件安装的向量服务文件'),
            ),
            h('div', { className: 'maint-row' },
              h('span', { className: 'grow' }, `记忆数据 ${maintenance.records} 条 · ${maintenance.storeDir}`),
              maintenance.records > 0
                ? (dangerAsk === 'wipe'
                  ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, `确认清空 ${maintenance.records} 条（不可恢复）`),
                     h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                  : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, '清空记忆数据'))
                : h('span', { className: 'muted' }, '没有记忆数据'),
            ),
            h('div', { className: 'hint' },
              '卸载插件本身：在「插件 / 插件市场」里移除 ',
              h('code', null, '@restregular/dsh-memory'),
              ' 与 ',
              h('code', null, '@restregular/dsh-memory-panel'),
              '。向量服务文件与记忆数据都不会被自动删除 —— 要清就在上面清。'),
          )
          : null,
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
          : records.map((rec) => h(RecordCard, { key: rec.id, rec, vectorOn: configured && vectorEnabled, onSaved: () => load(), onDeleted: () => load() })),
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
    /**
     * Should the panel keep polling the status endpoint?
     *
     * Two cases, and the second one is the reason this is a named function: the
     * provider's start() is fire-and-forget, so the status returned immediately
     * after POST /embed/install can still say 'idle'. Polling only while a phase
     * is in flight would then never show any progress at all.
     */
    function shouldPollInstall(phase, requested) {
      const running = phase !== 'idle' && phase !== 'done' && phase !== 'error'
      return running || (requested === true && phase === 'idle')
    }

    exports.__test = { RecordCard: RecordCard, MemoryPanel: MemoryPanel, CSS: CSS, shouldPollInstall: shouldPollInstall }
    return module.exports
  },
})
