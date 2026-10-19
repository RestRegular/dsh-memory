/**
 * dsh-memory — 客户端半边(设置页「记忆」区块)。
 *
 * 合并后本 bundle 与 provider / 工具 / 注入同属一个 npm 包
 * `@restregular/dsh-memory`:一个包名、一条 Loader entry、两侧都在。
 * 拆成两个包时这里曾是 '@restregular/dsh-memory-panel'。
 *
 * 与 dsh-meme / dshmarket 客户端同款形态:
 *   - window.__ModuleLoader__.load({id, factory(require)}):**id 必须等于包名**
 *     (client-modules 按包名建图行;声明成别的名字会让宿主找不到该行、回退重拉
 *      同一个 bundle → 二次注册 → "duplicate factory registration" 启动失败);
 *     而且 client bundle 只为「有活 Loader entry 且该 entry 解析到包名」的包服务,
 *     所以这个 id 与 patch 里那一行的 name 必须同时是本包名。
 *   - exports.inject = ['slots'](dsh-client-ui-slots 在 desktop 宿主 asar 里存在);
 *   - ctx.get('slots') 判空防御,缺 slots 就静默退出,绝不让 client boot 失败;
 *   - 数据走 /memory/api HTTP(服务端半边注册的 prefix 路由);
 *   - 颜色全走宿主 --dsw-alias-* 主题 token,深浅色自适应,零硬编码色值。
 */
window.__ModuleLoader__.load({
  id: '@restregular/dsh-memory',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/memory/api'

    const CSS = [
      '.memp{display:flex;flex-direction:column;gap:14px;padding:2px 0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.memp .row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .toolbar input[type=text]{flex:1;min-width:170px;max-width:320px}',
      '.memp .linkbtn{background:none;border:none;padding:2px 4px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.memp .linkbtn:hover{color:var(--dsw-alias-brand-primary);border:none}',
      // 概览
      '.memp .stats{display:flex;gap:10px;flex-wrap:wrap}',
      '.memp .stat{min-width:104px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 14px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .stat b{display:block;font-size:17px;font-weight:600;line-height:1.35}',
      '.memp .stat span{font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.memp .muted{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .mono{font-family:var(--ds-font-family-code, ui-monospace, monospace);font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // 向量服务
      '.memp .server{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}',
      '.memp .server-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .server-spacer{flex:1}',
      '.memp .dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-border-l1)}',
      '.memp .dot.on{background:var(--dsw-alias-brand-primary)}',
      '.memp .dot.off{background:var(--dsw-alias-label-danger, #e05555)}',
      '.memp .pill{font-size:11px;line-height:1.7;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
      '.memp .hint code,.memp .mono code{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 4px}',
      // 控件
      '.memp input[type=text],.memp select,.memp input[type=number]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none}',
      '.memp input[type=text]:focus,.memp select:focus,.memp textarea:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.memp textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;resize:vertical;font-family:inherit}',
      '.memp button{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer;transition:border-color .12s ease,color .12s ease}',
      // hover 只改边框与文字颜色。**不要**再叠 box-shadow:那会在边框外多出一圈线
      // (看起来就是"双层边框"),鼠标移开时又容易被看成残留。
      '.memp button:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      // 点击后浏览器给的 focus 环同理:鼠标操作不留痕,键盘操作仍可见。
      '.memp button:focus{outline:none}',
      '.memp button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.memp button:disabled{opacity:.5;cursor:default;border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
      // 服务器开关(switch 造型)
      '.memp .toggle{display:inline-flex;align-items:center;gap:8px;padding:4px 12px 4px 5px}',
      '.memp .toggle-track{width:34px;height:18px;border-radius:999px;background:var(--dsw-alias-border-l1);position:relative;transition:background .15s ease;flex:none;display:inline-block}',
      '.memp .toggle.on .toggle-track{background:var(--dsw-alias-brand-primary)}',
      '.memp .toggle-knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .15s ease}',
      '.memp .toggle.on .toggle-knob{transform:translateX(16px)}',
      // 记忆列表:一条一行时信息密度优先
      '.memp .list{display:flex;flex-direction:column;gap:8px}',
      '.memp .rec{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1)}',
      '.memp .rec:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.memp .rec-head{display:flex;gap:7px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}',
      '.memp .rec-head:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;border-radius:6px}',
      '.memp .chev{font-size:9px;opacity:.6;width:9px;flex:none;transition:transform .12s ease}',
      '.memp .chev.open{transform:rotate(90deg)}',
      '.memp .badge{border:1px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 6px;line-height:1.7;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .badge.scope{color:var(--dsw-alias-brand-primary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .badge.corrected{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.memp .tags{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}',
      '.memp .tag{font-size:11px;line-height:1.7;padding:0 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}',
      '.memp .meta{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .meta-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;padding:1px 6px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:all}',
      '.memp .meta-id:hover{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.memp .meta-done{color:var(--dsw-alias-brand-primary);font-size:11.5px}',
      '.memp .footer{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px;margin-top:18px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);text-align:center}',
      '.memp .footer a{color:var(--dsw-alias-brand-primary);text-decoration:none}',
      '.memp .footer a:hover{text-decoration:underline}',
      '.memp .pending{flex:none}',
      '.memp .time{margin-left:auto;flex:none}',
      '.memp .preview{margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);line-height:1.5}',
      '.memp .content{margin-top:7px;white-space:pre-wrap;word-break:break-word;line-height:1.55}',
      '.memp .rec-body{margin-top:6px}',
      '.memp .acts{display:flex;gap:6px;margin-top:8px}',
      '.memp .acts button{padding:3px 10px;font-size:12px}',
      '.memp .editrow{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:6px}',
      '.memp .editrow input[type=text]{padding:4px 8px}',
      '.memp .editrow input[type=number]{width:64px;padding:4px 8px}',
      '.memp .err{color:var(--dsw-alias-label-danger, #e05555);font-size:12px}',
      '.memp .empty{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:16px 2px;text-align:center}',
      // 维护区（卸载向量服务 / 清空记忆数据）
      '.memp .maint{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}',
      '.memp .maint-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12.5px}',
      '.memp .maint-row .grow{flex:1;min-width:160px}',
      '.memp .path{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .danger{color:var(--dsw-alias-label-danger, #e05555);border-color:var(--dsw-alias-label-danger, #e05555)}',
      // 模型与硬件(折叠在向量服务卡片里:默认视图保持干净)
      '.memp .adv{border-top:1px solid var(--dsw-alias-border-l1);padding-top:8px}',
      // 原生三角标记藏掉:展开/收起由左边的 .advcaret 自己画
      '.memp .adv summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);outline:none;list-style:none}',
      '.memp .adv summary::-webkit-details-marker{display:none}',
      '.memp .adv summary:hover{color:var(--dsw-alias-brand-primary)}',
      '.memp .advsum{display:flex;gap:6px;align-items:center;flex-wrap:wrap}',
      '.memp .advcaret{font-size:9px;opacity:.7;flex:none}',
      '.memp .advsum .spacer{flex:1}',
      '.memp .spacer{flex:1}',
      '.memp .advbody{display:flex;flex-direction:column;gap:8px;padding-top:8px}',
      // 标签气泡(本机配置 / 当前模型 / 选项里的体积与推荐)
      // 两行都一样:一条线排开,超出就横向滚动(不换行、不挤压)
      // 但**不显示滚动条**(宽度太显眼):仍可用滚轮 / 触控板 / 拖拽滚动。
      '.memp .vec{display:flex;flex-direction:column;gap:8px}',
      '.memp .chipline{display:flex;gap:8px;align-items:center;min-width:0}',
      '.memp .chiptitle{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .chips{display:flex;gap:6px;align-items:center;flex:1;min-width:0;flex-wrap:nowrap;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;-ms-overflow-style:none}',
      '.memp .chips .chip{flex:none}',
      '.memp .chips::-webkit-scrollbar{display:none;width:0;height:0}',
      '.memp .chip{font-size:11px;line-height:1.75;padding:0 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);white-space:nowrap}',
      '.memp .chip.rec{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.memp .chip.on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      // 自定义下拉(原生 select 画不出气泡)
      '.memp .drop{position:relative;display:inline-flex;flex-direction:column;align-items:flex-start}',
      '.memp .dropbtn{display:inline-flex;align-items:center;gap:6px;max-width:100%}',
      '.memp .dropname{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 模型名可能很长:按钮与列表都给个上限,超出的省略
      '.memp .drop.modeldrop .dropbtn{max-width:360px}',
      '.memp .caret{margin-left:6px;opacity:.6;font-size:10px}',
      '.memp .droplist{position:absolute;z-index:10;top:100%;left:0;margin-top:4px;max-height:264px;overflow:auto;max-width:min(90vw,460px);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 8px 24px rgba(0,0,0,.20);padding:4px}',
      '.memp .dropitem{display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:6px;cursor:pointer;white-space:nowrap;border:1px solid transparent;transition:border-color .12s ease,color .12s ease,background .12s ease}',
      // hover 的边框只出现在指针下;移开即恢复透明边框,不留痕
      '.memp .dropitem:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}',
      // 当前项不用边框做标记(容易被看成残留),改用品牌色 + 加粗的名字
      '.memp .dropitem.on{background:var(--dsw-alias-bg-layer-2)}',
      '.memp .dropitem.on .dropname{font-weight:600;color:var(--dsw-alias-brand-primary)}',
      '.memp .warn{font-size:11.5px;color:var(--dsw-alias-label-secondary)}',
      // 面板内的标签栏:分段式按钮(参照宿主设置页的分段控件)
      '.memp .tabs{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);margin-bottom:14px}',
      '.memp .tab{background:none;border:0;border-radius:7px;padding:4px 14px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1.6;transition:background .12s ease,color .12s ease}',
      '.memp .tab:hover{color:var(--dsw-alias-label-primary)}',
      '.memp .tab.on{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-brand-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.10)}',
      // 记录视图:各区块之间留出呼吸感(之前全贴在一起)
      '.memp .memp-body > * + *{margin-top:14px}',
      '.memp .stats{margin-bottom:0}',
      '.memp .setrow{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:11px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.memp .setrow .set-title{min-width:112px;font-weight:600;font-size:13px}',
      '.memp .setrow .set-desc{flex:1 1 100%;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .setrow .set-field{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .setrow input[type=number]{width:78px}',
      // 开关:与向量服务的 toggle 同一套视觉(轨道 + 圆点)
      '.memp .switch{position:relative;width:34px;height:20px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;transition:background .12s ease}',
      '.memp .switch.on{background:var(--dsw-alias-brand-primary)}',
      '.memp .switch .knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .12s ease;box-shadow:0 1px 2px rgba(0,0,0,.25)}',
      '.memp .switch.on .knob{left:16px}',
      '.memp .setfoot{display:flex;align-items:center;gap:10px;padding-top:12px}',
      '.memp .create{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:8px 0;background:var(--dsw-alias-bg-layer-2)}',
      '.memp .create .row{display:flex;gap:8px;align-items:center;margin:6px 0;flex-wrap:wrap}',
      '.memp .create textarea{width:100%;min-height:64px}',
      '.memp .data{padding-top:4px}',
      '.memp .data .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:8px}',
      // 数据页:列表在独立滚动容器里,记忆多也不把面板撑长
      '.memp .scroll{max-height:min(52vh,460px);overflow-y:auto;overscroll-behavior:contain;padding:2px 8px 2px 2px;margin-right:-2px}',
      '.memp .scroll.is-empty{max-height:none;overflow:visible;padding-right:0}',
      // 自定义滚动条:细、圆头、透明轨道,hover 才加深;Firefox 用 scrollbar-width/color
      '.memp .scroll{scrollbar-width:thin;scrollbar-color:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent) transparent}',
      '.memp .scroll::-webkit-scrollbar{width:8px;height:8px}',
      '.memp .scroll::-webkit-scrollbar-track{background:transparent}',
      '.memp .scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 30%, transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5);background:color-mix(in srgb, var(--dsw-alias-label-secondary) 55%, transparent);border:2px solid transparent;background-clip:padding-box}',
      '.memp .scroll::-webkit-scrollbar-corner{background:transparent}',
      '.memp .list{display:flex;flex-direction:column;gap:8px;padding-bottom:4px}',
      // 侧栏入口打开的主界面页面:整块可滚动,内容用面板本体
      '.mem-page{height:100%;overflow:auto;padding:16px 20px 40px}',
      // 主界面里空间更大:列表容器跟着视口长高,别停在设置面板那档 62vh
      '.mem-page .memp .scroll{max-height:calc(100vh - 340px)}',
      '.mem-page-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
      '.mem-page-head h2{font-size:15px;font-weight:600;margin:0}',
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

    /**
     * scope 键 → 展示标签。优先用 /status 返回的 `label`(服务端能查会话标题、能解析
     * project 的 cwd);服务端没给(旧 provider / 还没加载到)时用本地回退。
     */
    function scopeLabel(scope, labels) {
      const mapped = labels && labels[scope]
      if (typeof mapped === 'string' && mapped.length > 0) return mapped
      if (scope === 'global') return '全局'
      if (scope.startsWith('project:')) return scope.slice(8)
      if (scope.startsWith('session:')) return `会话 ${scope.slice(8, 16)}`
      return scope
    }

    function RecordCard({ rec, vectorOn, labels, onSaved, onDeleted }) {
      // collapsed by default: the list stays scannable, full text on demand
      const [expanded, setExpanded] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [content, setContent] = React.useState(rec.content)
      const [kind, setKind] = React.useState(rec.kind)
      const [tags, setTags] = React.useState(rec.tags.join(', '))
      const [importance, setImportance] = React.useState(rec.importance)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [copied, setCopied] = React.useState(false)

      const copyId = () => {
        try {
          if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(rec.id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 剪贴板不可用时忽略 */ }
      }

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
          h('span', { className: 'badge scope', title: rec.scope }, scopeLabel(rec.scope, labels)),
          h('span', { className: 'badge' }, rec.kind),
          rec.supersedes
            ? h('span', {
                className: 'badge corrected',
                title: `修正版:它覆盖了旧记录 #${rec.supersedes}（旧记录仍可检索，只是排序降权）`,
              }, `修正自 ${rec.supersedes.slice(0, 8)}`)
            : null,
          rec.supersededBy
            ? h('span', {
                className: 'badge',
                title: `已被 #${rec.supersededBy} 修正（旧记录仍可检索，只是排序降权）`,
              }, '已被修正')
            : null,
          // 只在"待嵌入"时提示:已嵌入是常态,向量没启用时这条也没有行动价值。
          !rec.embedded && vectorOn ? h('span', { className: 'pending', title: '待嵌入:向量服务就绪后会自动补上' }, '待嵌入') : null,
          h('span', { className: 'time', title: `更新于 ${fmtTime(rec.updatedAt)}` }, fmtTime(rec.updatedAt)),
        ),
        !open ? h('div', { className: 'preview' }, rec.content) : null,
        open
          ? h('div', { className: 'rec-body' },
              editing
                ? h('div', null,
                    h('textarea', { rows: 4, value: content, onChange: (e) => setContent(e.target.value) }),
                    h('div', { className: 'editrow' },
                      // 类型也用同一个自绘下拉(全站不再有原生 select)
                      h(Dropdown, {
                        items: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule'].map((k) => ({ value: k, label: k })),
                        value: kind,
                        disabled: busy,
                        onChange: (next) => setKind(next),
                      }),
                      h('input', { type: 'text', style: { width: 170 }, value: tags, placeholder: '标签, 逗号分隔', onChange: (e) => setTags(e.target.value) }),
                      h('label', null, '重要度 ',
                        h('input', { type: 'number', min: 0, max: 1, step: 0.1, value: importance, onChange: (e) => setImportance(e.target.value) })),
                    ),
                    h('div', { className: 'acts' },
                      h('button', { disabled: busy, onClick: save }, busy ? '保存中…' : '保存'),
                      h('button', { disabled: busy, onClick: cancelEdit }, '取消'),
                    ),
                  )
                : h('div', null,
                    h('div', { className: 'content' }, rec.content),
                    h('div', { className: 'meta' },
                      h('span', { className: 'meta-label' }, 'id'),
                      h('code', { className: 'meta-id', title: '点击复制完整 id', onClick: copyId }, rec.id),
                      copied ? h('span', { className: 'meta-done' }, '已复制') : null,
                    ),
                    rec.tags && rec.tags.length > 0
                      ? h('div', { className: 'tags' }, rec.tags.map((tag) => h('span', { className: 'tag', key: tag }, tag)))
                      : null,
                  ),
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

    /** 磁盘文案:MB 就是 MB,不足 1GB 时别显示成 "0GB"(曾经多除了一次 1024)。 */
    function diskText(freeDiskMb) {
      return freeDiskMb >= 1024 ? `${(freeDiskMb / 1024).toFixed(0)}GB` : `${freeDiskMb.toFixed(0)}MB`
    }

    /** 体积文案:小于 1GB 用 MB,否则 GB。 */
    function sizeText(bytes) {
      const mb = bytes / 1048576
      return mb >= 1024 ? `${(mb / 1024).toFixed(1)}GB` : `${Math.round(mb)}MB`
    }

    /** 标签气泡。 */
    function Chip({ children, tone, title }) {
      return h('span', { className: `chip${tone ? ` ${tone}` : ''}`, ...(title ? { title } : {}) }, children)
    }

    /** 运行时风味的中文名。 */
    function flavorLabel(flavor) {
      if (flavor === 'cuda') return 'CUDA（显卡）'
      if (flavor === 'vulkan') return 'Vulkan（显卡）'
      if (flavor === 'metal') return 'Metal（显卡）'
      return 'CPU'
    }

    /**
     * 统一的**自绘下拉**:模型 / 运行时 / 作用域都用它。
     *
     * 为什么不用原生 `<select>`:它画不出气泡(体积、推荐标记),也没法在按钮里放多段内容。
     * 行为对齐原生:点按钮开合、点选项选中并关闭、点外面关、Esc 关。
     * `items`: [{ value, label, chips?, recommended? }]
     */
    function Dropdown({ items, value, disabled, title, onChange, className }) {
      const [open, setOpen] = React.useState(false)
      const current = items.find((item) => item.value === value) || items[0] || null

      // 点列表外面(或按 Esc)关掉 —— 原生 select 自带的行为,自绘的得自己补。
      // document 不可用(单元测试的脚手架)时安静跳过。
      React.useEffect(() => {
        if (!open) return undefined
        const doc = typeof document !== 'undefined' ? document : undefined
        if (doc === undefined || typeof doc.addEventListener !== 'function') return undefined
        const inside = (target) => Boolean(target && typeof target.closest === 'function' && target.closest('.drop'))
        const onDown = (event) => { if (!inside(event && event.target)) setOpen(false) }
        const onKey = (event) => { if (event && event.key === 'Escape') setOpen(false) }
        doc.addEventListener('click', onDown)
        doc.addEventListener('keydown', onKey)
        return () => {
          doc.removeEventListener('click', onDown)
          doc.removeEventListener('keydown', onKey)
        }
      }, [open])

      return h('div', { className: `drop${className ? ` ${className}` : ''}` },
        h('button', {
          className: 'dropbtn',
          disabled,
          ...(title ? { title } : {}),
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen(!open),
        },
          h('span', { className: 'dropname' }, current === null ? '—' : current.label),
          ...(current === null ? [] : (current.chips ?? []).map((text, i) => h(Chip, { key: `c${i}` }, text))),
          current !== null && current.recommended ? h(Chip, { tone: 'rec' }, '推荐') : null,
          h('span', { className: 'caret' }, '▾'),
        ),
        open
          ? h('div', { className: 'droplist', role: 'listbox' },
              items.map((item) => h('div', {
                key: item.value,
                role: 'option',
                'aria-selected': item.value === value,
                className: `dropitem${item.value === value ? ' on' : ''}`,
                onClick: () => { setOpen(false); onChange(item.value) },
              },
                h('span', { className: 'dropname' }, item.label),
                ...(item.chips ?? []).map((text, i) => h(Chip, { key: `c${i}` }, text)),
                item.recommended ? h(Chip, { tone: 'rec' }, '推荐') : null,
              )),
            )
          : null,
      )
    }

    /**
     * 向量服务这一整块:本机配置行 + 当前模型行 + 折叠的「模型与硬件」。
     *
     * 三行放在一起,是因为它们必须**始终可见**(不展开也要看到本机配置、当前模型和安装按钮),
     * 而展开体里只放"改选择"的东西。硬件探测在面板一出现时取一次(服务端有 10 分钟缓存),
     * 所以这两行不用等展开。下拉是自绘的 —— 原生 select 画不出气泡。
     */
    function ModelPicker({ busy, installing, installedBackend, current, onInstall }) {
      const [open, setOpen] = React.useState(false)
      const [report, setReport] = React.useState(null)
      const [err, setErr] = React.useState('')
      const [preset, setPreset] = React.useState('')
      const [variant, setVariant] = React.useState('')
      const [flavor, setFlavor] = React.useState('')
      const [customOpen, setCustomOpen] = React.useState(false)
      const [url, setUrl] = React.useState('')
      const [dims, setDims] = React.useState('')

      const load = async (force) => {
        setErr('')
        try {
          setReport(await api(force ? 'embed/model/refresh' : 'embed/model', force ? {} : undefined))
        } catch (e) {
          setErr(String(e.message || e))
        }
      }
      // 面板一出现就取一次(不等到展开):未配置时要在「向量服务」下面**直接**显示
      // 默认选中(推荐)的模型与配置,而不是点开「模型与硬件」才出现。
      // 服务端对硬件探测有 10 分钟缓存,所以这次请求通常只是一次读缓存。
      React.useEffect(() => { if (report === null && err === '') load(false) }, [])

      const catalog = (report && report.catalog) || []
      const rec = report && report.recommendation
      const hw = report && report.hardware
      const options = []
      for (const m of catalog) {
        for (const v of m.variants) {
          options.push({
            key: `${m.id}/${v.id}`,
            name: m.label,
            variantLabel: v.label,
            modelId: m.id,
            variantId: v.id,
            bytes: v.bytes,
            dims: m.dims,
            pooling: m.pooling,
            // 逐档的"装没装"(服务端按 exe + 该档模型文件是否存在判断)
            installed: Boolean(v.installed),
            recommended: Boolean(rec && rec.modelId === m.id && rec.variantId === v.id),
          })
        }
      }
      const configured = Boolean(current && current.presetId && current.presetId !== 'custom')
      const fallbackKey = configured
        ? `${current.presetId}/${current.variantId}`
        : (rec ? `${rec.modelId}/${rec.variantId}` : (options[0] ? options[0].key : ''))
      const selectedKey = preset !== '' && variant !== '' ? `${preset}/${variant}` : fallbackKey
      const selected = options.find((o) => o.key === selectedKey) || options[0] || null
      const flavors = (hw && hw.flavors) || ['cpu']
      const flavorValue = flavor !== '' ? flavor : (configured ? (current.flavor || 'cpu') : (rec ? rec.flavor : 'cpu'))

      // 本机配置的四个事实(气泡行)
      const machine = hw === null || hw === undefined
        ? []
        : [
            `${hw.cpuCount} 核`,
            `${Math.round(hw.totalRamMb / 1024)}GB 内存`,
            hw.gpu ? `显卡 ${hw.gpu.name}${hw.gpu.vramMb ? `(${Math.round(hw.gpu.vramMb / 1024)}GB)` : ''}` : '无独立显卡',
            hw.freeDiskMb !== null ? `磁盘剩余 ${diskText(hw.freeDiskMb)}` : '磁盘剩余未知',
          ]
      // 「当前模型」:已配置就显示实际配置,未配置就跟着上面的选择实时变
      const currentChips = []
      if (configured) {
        const [name, variantLabel] = String(current.modelLabel || current.model || '').split(' · ')
        currentChips.push(name, variantLabel, current.dims ? `${current.dims} 维` : null, current.pooling, current.flavor)
      } else if (selected !== null) {
        currentChips.push(selected.name, selected.variantLabel, `${selected.dims} 维`, selected.pooling, flavorValue)
      }
      const chipList = currentChips.filter(Boolean)

      // 选中的这一档装没装。两个来源:catalog 的逐档标记(准,但要等清单刷新),
      // 以及后端快照 install.installed(= exe + **当前配置那份**模型文件都在)。
      // 后者让"刚下完"的那一刻按钮就能立刻变「已安装」,不用等重新拉清单。
      const alreadyInstalled = selected !== null && (selected.installed
        || (Boolean(installedBackend) && configured && selectedKey === `${current.presetId}/${current.variantId}`))
      // 已经装过东西(运行时 + 某个模型)就不许再装第二个:要换模型,先去「维护」里卸载。
      // 允许并行安装会让 <root>/llamacpp 与 models 里堆着多份文件,而配置只能指向一份,
      // 之后"当前到底在跑哪个"就说不清了。
      const hasInstalled = Boolean(installedBackend) || options.some((o) => o.installed)
      const needUninstall = selected !== null && !alreadyInstalled && hasInstalled

      // 安装/卸载状态一变就重拉清单:否则清单里"装没装"的标记会一直是旧的,
      // 卸载完按钮还卡在「需先卸载」。
      const [seenState, setSeenState] = React.useState(null)
      React.useEffect(() => {
        const now = `${installing ? 'running' : 'idle'}:${installedBackend ? 'in' : 'out'}`
        if (seenState === null) { setSeenState(now); return }
        if (seenState === now) return
        setSeenState(now)
        load(false)
      }, [installing, installedBackend, seenState])

      const pickFlavor = (next) => setFlavor(next)
      const doInstall = () => {
        if (selected === null) return
        onInstall({ preset: selected.modelId, variant: selected.variantId, flavor: flavorValue })
      }
      const doCustom = () => {
        if (url.trim() === '' || !(Number(dims) > 0)) { setErr('自定义模型需要填 URL 与维度'); return }
        onInstall({ custom: { url: url.trim(), dims: Number(dims) } })
      }

      return h('div', { className: 'vec' },
        // 两行状态气泡都带标题、都横向滚动不换行;动作按钮各自挂在这一行的最右边。
        h('div', { className: 'chipline' },
          h('span', { className: 'chiptitle' }, '本机配置：'),
          h('div', { className: 'chips' },
            (machine.length > 0 ? machine : ['读取中…']).map((label, i) => h(Chip, { key: i }, label))),
          h('button', { disabled: busy, onClick: () => load(true) }, '重新检测硬件'),
        ),
        h('div', { className: 'chipline' },
          h('span', { className: 'chiptitle' }, '当前模型：'),
          h('div', { className: 'chips' }, chipList.map((label, i) => h(Chip, { key: i }, label))),
          h('button', {
            className: 'install',
            // 四态:请求中 / 下载中 / 已装好 / 已装过别的(要先卸载)。后三种都不可点。
            disabled: busy || installing || selected === null || alreadyInstalled || needUninstall,
            ...(installing ? { title: '正在下载,进度见上方向量服务那一行' }
              : alreadyInstalled ? { title: '这一档已经装好了' }
                : needUninstall ? { title: '已经装过一个模型了。要换模型,请先在下面的「维护」里卸载向量服务' } : {}),
            onClick: doInstall,
          }, busy ? '处理中…'
            : installing ? '下载中…'
              : alreadyInstalled ? '已安装'
                : needUninstall ? '需先卸载'
                  : '下载并安装'),
        ),
        h('details', { className: 'adv', onToggle: (e) => setOpen(Boolean(e.target.open)) },
          h('summary', { className: 'advsum' },
            h('span', { className: 'advcaret' }, open ? '▾' : '▸'),
            h('span', null, '模型与硬件'),
          ),
          h('div', { className: 'advbody' },
            report === null && err === '' ? h('div', { className: 'muted' }, '正在读取…') : null,
            err ? h('div', { className: 'err' }, err) : null,
            h('div', { className: 'row' },
              h('span', { className: 'hint' }, '向量检索为可选功能，可以自定义配置任意 OpenAI 兼容的服务'),
            ),
          selected !== null
            ? h('div', { className: 'row' },
                h(Dropdown, {
                  items: options.map((o) => ({
                    value: o.key,
                    label: o.name,
                    chips: [o.variantLabel, sizeText(o.bytes)],
                    recommended: o.recommended,
                  })),
                  value: selectedKey,
                  disabled: busy,
                  className: 'modeldrop',
                  onChange: (key) => {
                    const [pid, vid] = key.split('/')
                    setPreset(pid); setVariant(vid)
                  },
                }),
                h(Dropdown, {
                  items: flavors.map((f) => ({ value: f, label: flavorLabel(f) })),
                  value: flavorValue,
                  disabled: busy,
                  title: '运行时:CPU 最稳,GPU 更快',
                  onChange: (next) => pickFlavor(next),
                }),
              )
            : null,
          h('div', { className: 'row' },
            h('button', { onClick: () => setCustomOpen(!customOpen) }, customOpen ? '收起自定义模型' : '自定义 GGUF…'),
          ),
          customOpen
            ? h('div', { className: 'row' },
                h('input', { type: 'text', placeholder: 'https://…/model.gguf', value: url, onChange: (e) => setUrl(e.target.value) }),
                h('input', { type: 'number', placeholder: '维度', value: dims, style: { width: 80 }, onChange: (e) => setDims(e.target.value) }),
                h('button', { disabled: busy, onClick: doCustom }, '安装'),
              )
            : null,
          report && report.records > 0
            ? h('div', { className: 'muted' }, `换模型会让这 ${report.records} 条记忆重新嵌入;期间检索暂时用词法匹配。`)
            : null,
          ),
        ),
      )
    }

    /** 设置项开关:轨道 + 圆点,与向量服务的 toggle 同一套视觉。 */
    function Switch({ checked, disabled, onChange, title }) {
      return h('button', {
        type: 'button',
        className: 'switch' + (checked ? ' on' : ''),
        role: 'switch',
        'aria-checked': Boolean(checked),
        disabled: Boolean(disabled),
        ...(title ? { title } : {}),
        onClick: () => onChange(!checked),
      }, h('span', { className: 'knob' }))
    }

    /** 设置自动保存的合并定时器:连续调数值只发一次请求。 */
    let autoSaveTimer = null

    /**
     * 设置标签页:这些开关直接改注入行为,改完立即保存(没有"保存"按钮)。
     * 每轮召回 → 印象 → 会话摘要 → 系统提示(策略/规则) → 轮末提醒 → 界面。
     */
    const SETTINGS_GROUPS = [
      {
        key: 'recall', title: '每轮召回',
        desc: '按本轮问题检索记忆并插入上下文，内容没变不重复注入。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool' },
          { k: 'topK', label: '最多条数', type: 'num', min: 1, max: 20, step: 1 },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50 },
        ],
      },
      {
        key: 'impression', title: '印象形态',
        desc: '每条只给摘要，细节由模型用 memory_get 取。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool' },
          { k: 'chars', label: '每条字数', type: 'num', min: 40, max: 800, step: 20 },
        ],
      },
      {
        key: 'digest', title: '会话摘要',
        desc: '会话第一步给一次项目 / 全局的记忆概览。',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool' },
          { k: 'topK', label: '最多条数', type: 'num', min: 1, max: 30, step: 1 },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50 },
        ],
      },
      {
        key: 'policy', title: '记忆使用策略',
        desc: '系统提示常驻段：何时查、查到怎么用、查不到怎么办。',
        fields: [{ k: 'enabled', label: '启用', type: 'bool' }],
      },
      {
        key: 'rules', title: '硬性规则',
        desc: '把 kind=rule 的记忆放进系统提示常驻段。',
        hint: '关闭只影响系统提示常驻段，记忆本身仍可被检索',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool' },
          { k: 'maxItems', label: '最多条数', type: 'num', min: 1, max: 40, step: 1 },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50 },
        ],
      },
      {
        key: 'turnEnd', title: '轮末提醒',
        desc: '下一轮开头提醒把本轮结论落盘，默认关闭。',
        fields: [{ k: 'enabled', label: '启用', type: 'bool' }],
      },
      {
        key: 'sidebar', title: '侧栏入口',
        desc: '在左侧栏「插件」下方显示记忆入口，点击打开面板。',
        fields: [{ k: 'enabled', label: '启用', type: 'bool' }],
      },
    ]

    function SettingsTab() {
      const [settings, setSettings] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [rulesCount, setRulesCount] = React.useState(null)
      const [dataNotice, setDataNotice] = React.useState('')

      React.useEffect(() => {
        api('settings').then(setSettings).catch((e) => setError(String(e.message || e)))
        api('status')
          .then((status) => setRulesCount(status && status.rules ? status.rules : null))
          .catch(() => setRulesCount(null))
      }, [])

      /** 导出:纯文本 JSON,不含向量(导入时按当前模型重新嵌入)。 */
      const exportAll = async () => {
        setDataNotice('')
        try {
          const doc = await api('export')
          const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `dsh-memory-${new Date().toISOString().slice(0, 10)}.json`
          a.click()
          setTimeout(() => URL.revokeObjectURL(url), 2000)
          setDataNotice(`已导出 ${doc.records.length} 条（${doc.records.length > 0 ? '含作用域与类型' : '暂无记忆'}）`)
        } catch (e) {
          setDataNotice(`导出失败：${String(e.message || e)}`)
        }
      }

      /** 导入:接受导出的同一个文档(或记录数组),逐条走 save,自动重新嵌入。 */
      const importFile = async (event) => {
        const file = event && event.target && event.target.files && event.target.files[0]
        if (!file) return
        setDataNotice('')
        try {
          const text = await file.text()
          const doc = JSON.parse(text)
          const result = await api('import', doc)
          const firstError = result.errors && result.errors.length > 0 ? `；${result.errors[0]}` : ''
          setDataNotice(`导入完成：新增 ${result.imported}，跳过重复 ${result.skipped}，失败 ${result.rejected}${firstError}`)
          if (result.imported > 0 && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            try { window.dispatchEvent(new CustomEvent('dsh-memory:refresh')) } catch { /* 没有 CustomEvent 就靠下次打开面板刷新 */ }
          }
        } catch (e) {
          setDataNotice(`导入失败：${String(e.message || e)}`)
        }
        event.target.value = ''
      }

      // 改动即保存:开关/数值一变就提交(数值连续输入时合并成一次请求)，
      // 不再有"保存设置"按钮 —— 界面上也就不该再写"保存后生效"这类话。
      const patch = (group, key, value) => {
        if (!settings) return
        const next = { ...settings, [group]: { ...settings[group], [key]: value } }
        setSettings(next)
        autoSave(next)
      }

      const autoSave = (next) => {
        if (autoSaveTimer !== null) clearTimeout(autoSaveTimer)
        setError('')
        autoSaveTimer = setTimeout(async () => {
          autoSaveTimer = null
          try {
            await api('settings', next)
            setNotice('已保存')
            setTimeout(() => setNotice(''), 1500)
            if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
              try { window.dispatchEvent(new CustomEvent('dsh-memory:settings')) } catch { /* 没有 CustomEvent 就等下次启动 */ }
            }
          } catch (e) {
            setError(String(e.message || e))
          }
        }, 250)
      }

      if (!settings) return h('div', { className: 'empty' }, error || '加载设置…')

      return h('div', { className: 'setp' },
        h('div', { className: 'hint' }, '设置保存在记忆数据目录的 settings.json。'),
        SETTINGS_GROUPS.map((group) => {
          const value = settings[group.key] || {}
          return h('div', { className: 'setrow', key: group.key },
            h('span', { className: 'set-title' }, group.title),
            group.fields.map((field) => field.type === 'bool'
              ? h(Switch, {
                  key: field.k,
                  checked: Boolean(value[field.k]),
                  title: group.hint || field.label,
                  onChange: (next) => patch(group.key, field.k, next),
                })
              : h('label', { className: 'set-field', key: field.k }, field.label, ' ',
                  h('input', {
                    type: 'number', min: field.min, max: field.max, step: field.step, value: value[field.k],
                    onChange: (e) => patch(group.key, field.k, Number(e.target.value)),
                  }))),
            h('span', { className: 'set-desc' }, group.desc),
            group.key === 'rules' && rulesCount !== null
              ? h('span', { className: 'set-field' }, `${rulesCount.total} 条规则 / ${rulesCount.scopes} 个作用域（在「记录 → 新建」里选 kind=rule 添加）`)
              : null,
          )
        }),
        h('div', { className: 'setrow data' },
          h('span', { className: 'set-title' }, '数据'),
          h('span', { className: 'set-desc' }, '导出文本（不含向量），导入按当前模型重新嵌入并按内容去重。'),
          h('div', { className: 'row' },
            h('button', { onClick: exportAll }, '导出全部'),
            h('label', { className: 'set-field' }, '导入文件',
              h('input', { type: 'file', accept: '.json,application/json', onChange: importFile })),
            dataNotice ? h('span', { className: 'muted' }, dataNotice) : null,
          ),
        ),
        error ? h('div', { className: 'err' }, error) : null,
        notice ? h('div', { className: 'muted' }, notice) : null,
      )
    }

    /**
     * 新建记忆 / 规则。作用域必须是**明确的键**:面板拿不到会话上下文,所以
     * 'project' / 'session' 这种相对写法不提供,列出现有作用域 + global,再加
     * 一个自定义输入(project:<路径> / session:<id> / 自定义名)。
     */
    function CreateForm({ scopes, onCancel, onCreated }) {
      const [scope, setScope] = React.useState('global')
      const [customScope, setCustomScope] = React.useState('')
      const [kind, setKind] = React.useState('note')
      const [content, setContent] = React.useState('')
      const [tags, setTags] = React.useState('')
      const [importance, setImportance] = React.useState(0.6)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const scopeItems = [
        { value: 'global', label: '全局（global）' },
        ...scopes
          .filter((s) => s.scope !== 'global')
          .map((s) => ({ value: s.scope, label: s.label || scopeLabel(s.scope) })),
        { value: '__custom__', label: '自定义 / 指定作用域…' },
      ]
      const resolvedScope = scope === '__custom__' ? customScope.trim() : scope

      const submit = async () => {
        setBusy(true); setError('')
        try {
          await api('create', {
            scope: resolvedScope,
            kind,
            content,
            tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
            importance: Number(importance),
          })
          setBusy(false)
          onCreated()
        } catch (e) {
          setError(String(e.message || e))
          setBusy(false)
        }
      }

      return h('div', { className: 'create' },
        h('div', { className: 'row' },
          h(Dropdown, { items: scopeItems, value: scope, disabled: busy, onChange: setScope }),
          scope === '__custom__'
            ? h('input', {
                type: 'text', style: { width: 260 },
                placeholder: 'project:<路径> / session:<id> / 自定义名',
                value: customScope, onChange: (e) => setCustomScope(e.target.value),
              })
            : null,
          h(Dropdown, {
            items: ['fact', 'decision', 'preference', 'procedure', 'note', 'rule'].map((k) => ({ value: k, label: k })),
            value: kind, disabled: busy, onChange: setKind,
          }),
          kind === 'rule' ? h('span', { className: 'warn' }, '规则会进入系统提示常驻段') : null,
        ),
        h('div', { className: 'row' },
          h('textarea', {
            rows: 3,
            placeholder: '内容：一句自洽的话，脱离上下文也能读懂（写之前先搜一下有没有重复）',
            value: content, onChange: (e) => setContent(e.target.value),
          }),
        ),
        h('div', { className: 'row' },
          h('label', { className: 'set-field' }, '标签 ',
            h('input', {
              type: 'text', style: { width: 190 }, placeholder: '逗号分隔，例如 pnpm, 工具链',
              value: tags, onChange: (e) => setTags(e.target.value),
            })),
          h('label', null, '重要度 ',
            h('input', { type: 'number', min: 0, max: 1, step: 0.1, value: importance, onChange: (e) => setImportance(e.target.value) })),
          h('button', { onClick: submit, disabled: busy || content.trim() === '' || resolvedScope === '' }, busy ? '保存中…' : '保存'),
          h('button', { className: 'linkbtn', onClick: onCancel, disabled: busy }, '取消'),
        ),
        error ? h('div', { className: 'err' }, error) : null,
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
      const [tab, setTab] = React.useState('data')
      const [creating, setCreating] = React.useState(false)

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
      // 导入完成后从设置页切换回记录页时,列表要能看到新数据(事件由设置页发出)。
      React.useEffect(() => {
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onRefresh = () => { load('', '') }
        window.addEventListener('dsh-memory:refresh', onRefresh)
        return () => window.removeEventListener('dsh-memory:refresh', onRefresh)
      }, [])

      const embedAction = async (action, body = {}) => {
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = await api(`embed/${action}`, body)
          // 安装接口返回的是 { install, ...status }：先落状态，进度由轮询刷新
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (action === 'install') {
            // 不弹任何"下载开始"提示:进度本身就是反馈,装好会自动变成运行中。
            setInstallRequested(true)
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
      // 服务端 /status 给的 scope → label 映射(会话标题、project 的 cwd 只有服务端知道)
      const labels = {}
      for (const s of scopes) if (s && s.scope && typeof s.label === 'string') labels[s.scope] = s.label

      // 向量卡片的状态判定。provider 给的 mode 决定"该不该有启停开关"：
      //   off      没配置任何后端 → 不给开关,模型与安装入口都在「模型与硬件」里
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
      // 状态只说状态,归属由 pill 说 —— 之前两处各说一遍("运行中 · 由本应用管理" + "由本应用托管")。
      let stateText
      if (!embedServer) stateText = '不可用'
      else if (mode === 'off') stateText = installBusy ? '正在安装' : installed ? '检测到本地文件' : '未配置'
      else if (!vectorEnabled) stateText = '已在配置里关闭'
      else if (serverOn) stateText = '运行中'
      else stateText = managed ? '已停止' : '未连接'

      // 端点/pid/模型是排障信息,折成一行 mono;完整信息放 title,不占版面。
      const endpoint = embedServer ? String(embedServer.baseUrl || embedServer.endpoint || '') : ''
      const endpointLabel = (() => {
        if (!endpoint) return ''
        try { return new URL(endpoint).host } catch { return endpoint.replace(/^https?:\/\//, '').split('/')[0] }
      })()
      const endpointTitle = [endpoint, embedServer && embedServer.pid ? `pid ${embedServer.pid}` : '', embedServer && embedServer.model ? `模型 ${embedServer.model}` : ''].filter(Boolean).join(' · ')

      // 右侧动作区:安装进度 > 重试 > 启停开关。
      // 原则:只在"开关真能改变什么"时才渲染它——未配置、外部服务、配置里显式
      // 关闭,这三种情况给别的动作或干脆不给,避免一个永远灰着的开关。
      // 安装入口不放这里:模型在下面的「模型与硬件」里选,安装按钮跟着选择走。
      const actions = []
      if (installBusy) {
        actions.push(h('span', { className: 'muted', key: 'prog' },
          `${install.message || install.phase}${installPercent === null ? '' : ` ${installPercent}%`}`
          + (install.totalBytes ? `（${mb(install.receivedBytes)}/${mb(install.totalBytes)} MB）` : '')))
        actions.push(h('button', { key: 'cancel', disabled: embedBusy, onClick: () => embedAction('install/cancel') }, '取消'))
      } else if (install && install.phase === 'error') {
        actions.push(h('button', { key: 'retry', disabled: embedBusy, onClick: () => embedAction('install') }, '重试下载'))
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

      // 错误说明只在这里出现一次(重试按钮在右上方);配置里关掉了向量检索时解释一句。
      let notice = null
      if (mode !== 'off' && !vectorEnabled) {
        notice = h('div', { className: 'hint' }, '配置里关掉了向量检索（', h('code', null, 'retrieval.vector.enabled'), ' 改回 true 并重启即可）。')
      } else if (install && install.phase === 'error') {
        notice = h('div', { className: 'hint err' }, `安装失败：${install.error || install.message}`)
      }

      const filtering = q.trim() !== '' || scopeFilter !== ''

      // 三个标签的内容分开构建:记录(概览) / 数据(列表) / 设置。
      const statsCard = h('div', { className: 'stats' },
        h('div', { className: 'stat' }, h('b', null, String(total)), h('span', null, '条记忆')),
        h('div', { className: 'stat' }, h('b', null, String(scopes.length)), h('span', null, '个作用域')),
        configured && vectorEnabled
          ? h('div', { className: 'stat' }, h('b', null, String(pending)), h('span', null, '待嵌入向量'))
          : h('div', { className: 'stat' }, h('b', null, '—'), h('span', null, '向量未启用')),
      )
      const serverCard = h('div', { className: 'server' },
        h('div', { className: 'server-head' },
          h('span', { className: dotClass }),
          h('b', null, '向量服务'),
          h('span', { className: 'muted' }, stateText),
          // 地址紧跟在状态右边(排障要看的就是它),完整信息(pid/模型)进 title。
          endpointLabel ? h('span', { className: 'mono', title: endpointTitle }, endpointLabel) : null,
          configured && vectorEnabled ? h('span', { className: 'pill' }, managed ? '由本应用托管' : '外部服务') : null,
          h('span', { className: 'server-spacer' }),
          actions,
        ),
        notice,
        embedNotice ? h('div', { className: 'muted' }, embedNotice) : null,
        h(ModelPicker, {
          busy: embedBusy,
          // 下载是后台跑的,`busy`(一次请求)早就结束了;要单独把"正在下载"传给按钮,
          // 否则下载中还能反复点「下载并安装」。
          installing: installBusy || installRequested,
          installedBackend: installed,
          current: embedServer
            ? { presetId: embedServer.presetId, variantId: embedServer.variantId, model: embedServer.model, modelLabel: embedServer.modelLabel, dims: embedServer.dims, pooling: embedServer.pooling, flavor: embedServer.flavor }
            : null,
          onInstall: (override) => embedAction('install', override),
        }),
      )
      // 维护区：DSH 卸载插件时不会给插件任何提问机会（就是 pnpm remove + 去掉
      // bundles），所以"要不要留向量服务 / 要不要留记忆数据"只能在这里、卸载之前问。
      const maintenanceCard = maintenance
        ? h('div', { className: 'maint' },
          h('div', { className: 'maint-row' },
            h('b', null, '维护'),
            h('span', { className: 'muted' }, '卸载插件不会移除已配置的向量服务与记忆文件'),
          ),
          h('div', { className: 'maint-row' },
            h('span', { className: 'grow' }, `向量服务：${usageMb} MB`),
            maintenance.usageBytes > 0
              ? (dangerAsk === 'uninstall'
                ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, `确认卸载（释放 ${usageMb} MB）`),
                   h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('uninstall') }, '卸载向量服务'))
              : h('span', { className: 'muted' }, '未安装'),
          ),
          h('div', { className: 'maint-row' },
            h('span', { className: 'grow' }, `记忆数据：${maintenance.records} 条`),
            maintenance.storeDir ? h('span', { className: 'muted path', title: maintenance.storeDir }, maintenance.storeDir) : null,
            maintenance.records > 0
              ? (dangerAsk === 'wipe'
                ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, `确认清空 ${maintenance.records} 条（不可恢复）`),
                   h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('wipe') }, '清空记忆数据'))
              : h('span', { className: 'muted' }, '无'),
          ),
        )
        : null

      const toolbar = h('div', { className: 'row toolbar' },
        h('input', {
          type: 'text', placeholder: '搜索内容、类型或标签', value: q,
          onChange: (e) => setQ(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter') load(q, scopeFilter) },
        }),
        // 作用域也用同一个自绘下拉(与模型/运行时统一);标签优先用服务端给的 label
        h(Dropdown, {
          items: [
            { value: '', label: '全部作用域' },
            ...scopes.map((s) => ({ value: s.scope, label: s.label || scopeLabel(s.scope) })),
          ],
          value: scopeFilter,
          disabled: loading,
          onChange: (next) => { setScopeFilter(next); load(q, next) },
        }),
        h('button', { onClick: () => setCreating((v) => !v), disabled: loading }, creating ? '收起' : '新建'),
        h('button', { onClick: () => load(q, scopeFilter), disabled: loading }, loading ? '刷新中…' : '刷新'),
        filtering ? h('button', { className: 'linkbtn', onClick: () => { setQ(''); setScopeFilter(''); load('', '') } }, '清空筛选') : null,
      )
      const createForm = creating
        ? h(CreateForm, {
            scopes,
            onCancel: () => setCreating(false),
            onCreated: () => { setCreating(false); load('', '') },
          })
        : null
      const listBody = !loading && !error && records.length === 0
        ? h('div', { className: 'empty' }, filtering ? '没有匹配的记忆' : '还没有记忆')
        : h('div', { className: 'list' },
            records.map((rec) => h(RecordCard, { key: rec.id, rec, vectorOn: configured && vectorEnabled, labels: labels, onSaved: () => load(), onDeleted: () => load() })))

      // 服务页底部:一句号召 + 两个外链(Star / issue)。放在内容最后,不打扰上面的状态卡。
      const footer = h('div', { className: 'footer' },
        '觉得好用？',
        h('a', { href: 'https://github.com/RestRegular/dsh-memory', target: '_blank', rel: 'noreferrer' }, '⭐ 去 GitHub 点个 Star'),
        ' · ',
        h('a', { href: 'https://github.com/RestRegular/dsh-memory/issues/new', target: '_blank', rel: 'noreferrer' }, '💬 反馈建议 / 提 issue'),
      )
      const overviewBody = h('div', { className: 'memp-body' }, serverCard, maintenanceCard, footer)
      // 记录页:统计 + 工具栏 + 新建表单固定在上面,只有列表在滚动容器里 —— 记忆多了也不把面板撑长。
      const dataBody = h('div', { className: 'memp-body' },
        statsCard,
        toolbar,
        createForm,
        error ? h('div', { className: 'err' }, error) : null,
        h('div', { className: 'scroll' + (records.length > 0 || loading ? '' : ' is-empty') }, listBody),
      )

      return h('div', { className: 'memp' },
        h('div', { className: 'tabs' },
          h('button', { className: 'tab' + (tab === 'records' ? ' on' : ''), onClick: () => setTab('records') }, '服务'),
          h('button', { className: 'tab' + (tab === 'data' ? ' on' : ''), onClick: () => setTab('data') }, '记录'),
          h('button', { className: 'tab' + (tab === 'settings' ? ' on' : ''), onClick: () => setTab('settings') }, '设置'),
        ),
        tab === 'settings' ? h(SettingsTab, {}) : tab === 'data' ? dataBody : overviewBody,
      )
    }

    const inject = ['slots']

    /** 侧栏入口打开的主界面页面(整块可滚动,内容就是面板本体)。 */
    function MemoryPage() {
      return h('div', { className: 'mem-page' },
        h('div', { className: 'mem-page-head' }, h('h2', null, '记忆')),
        h(MemoryPanel, {}),
      )
    }

    /** 侧栏图标:16px 单色线稿芯片,与设置导航那一列同一规范。 */
    function NavChipIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 5, y: 5, width: 6, height: 6, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('rect', { x: 6.9, y: 6.9, width: 2.2, height: 2.2, rx: 0.6, stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: 'M8 5V3.2M8 11v1.8M5 8H3.2M11 8h1.8', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
      )
    }

    function apply(ctx) {
      try {
        const styleEl = document.createElement('style')
        styleEl.textContent = CSS
        document.head.appendChild(styleEl)
        // 侧栏那一行的图标:宿主写死了齿轮,我们只改它 SVG 的孩子(见 wrapSettingsNav)
        const stopNavWatch = wrapSettingsNav()
        ctx.effect(() => () => { styleEl.remove(); stopNavWatch() }, 'dsh-memory: styles + nav icon')

        const slots = ctx.get('slots')
        if (slots === undefined) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'memory', order: 24, label: NAV_LABEL },
          () => React.createElement(MemoryPanel),
        ))

        // 侧栏入口(可选):开启后在左侧栏「插件」下方多一个「记忆」,点击在主界面打开面板。
        // 注册契约见 dsh-client-ui-schedule:sidebar.panellist 给 id/label/icon,main 用同一个 key。
        let sidebarDisposers = null
        const syncSidebar = () => {
          api('settings').then((settings) => {
            const want = Boolean(settings && settings.sidebar && settings.sidebar.enabled)
            if (want === (sidebarDisposers !== null)) return
            if (!want) {
              for (const dispose of sidebarDisposers ?? []) {
                try { if (typeof dispose === 'function') dispose() } catch { /* 已卸载 */ }
              }
              sidebarDisposers = null
              return
            }
            try {
              sidebarDisposers = [
                slots.inject('main', () => slots.register({ name: 'main', key: 'memory' }, () => React.createElement(MemoryPage))),
                slots.inject('sidebar.panellist', () => slots.register(
                  { name: 'sidebar.panellist', id: 'memory', order: 20, label: () => NAV_LABEL },
                  () => React.createElement(NavChipIcon),
                )),
              ]
            } catch (error) {
              sidebarDisposers = null
              console.warn('[dsh-memory] 侧栏入口注册失败:', error?.message)
            }
          }).catch(() => { /* 读不到设置就维持现状 */ })
        }
        syncSidebar()
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('dsh-memory:settings', syncSidebar)
          ctx.effect(() => () => window.removeEventListener('dsh-memory:settings', syncSidebar), 'dsh-memory: sidebar entry')
        }
      } catch (error) {
        console.error('[dsh-memory] client apply 失败(已吞掉):', error?.message)
      }
    }

    /**
     * 侧栏这一行的显示名。导航图标覆盖靠"认出自己那一行"来定位,所以文案必须只有一处,
     * 注册与识别共用这个常量(改文案时不会漏改)。
     */
    const NAV_LABEL = '记忆'

    /**
     * 侧栏「记忆」那一行的图标。
     *
     * 宿主把导航图标写死在 `dsh-client-ui-settings-general` 的 `navIcon(id)` 里:只有
     * account / models / agent-presets / plugins / archived-sessions 五个 id 有专属图标
     * (`IconUserOutlineMedium` 等),其余(包括我们的 `memory`)一律回退成**齿轮**
     * `IconSettingsOutlineMedium`。`settings.section` 的注册契约是
     * `{ name, id, order, label, locale, inject }` —— **没有 icon 字段**,宿主也不读插件包
     * `package.json` 的 `icon`(那个只用于插件管理器的卡片/行),所以插件侧没有任何
     * "官方指定图标"的入口。
     *
     * 因此只有一条路:用宿主自己的类名做一次**定向覆盖** —— 把那颗齿轮**就地**换成我们的
     * 记号(内存芯片)。三条护栏让它不会把界面弄坏:
     *   1. 选择器只认 className 的**后缀**:宿主的类名是 CSS Modules 生成的
     *      `<hash>_navCell` / `<hash>_navIcon`(hash 随构建变),所以用
     *      `[class*="_navIcon"]` 匹配,hash 变了也照样命中;
     *   2. 只在**我们这一行**生效:wrapSettingsNav 给"文案等于 `NAV_LABEL`"的那个按钮加
     *      `dsh-memory-nav` 标记类,规则全部限定在它下面 —— 其它区块(账号/模型/插件市场)
     *      的图标一个都不碰。标记打在**按钮自己**身上而不是它所在的列表上:整列共用一个
     *      列表容器,标在容器上会波及所有区块。
     *   3. **不改布局、不插 DOM**:那颗 svg 还是宿主自己渲染的,我们只把它内部换成芯片,
     *      盒子尺寸/行高/对齐全由宿主保证。
     *
     * 风格必须跟着**侧栏这一列**走:这一列全是 16px 单色细线图标(宿主内置的
     * Icon*OutlineMedium:16 网格、fill:none、stroke:currentColor、strokeWidth 1.3),
     * 所以记号画成线稿芯片;**不是**插件管理器卡片/行那套"蓝色瓦片 + 白色记号"的插件美术
     * (那个尺寸是 36/30px,另一套 surface —— icon.svg 仍服务那边)。0.5.3/0.5.4 早期版本
     * 把蓝瓦片塞进这一列,结果就是一个实心蓝块混在细线图标里,格格不入。
     *
     * 实现:把宿主那颗 svg 的**子节点**换成芯片的线稿。三条被否掉的路,留给后来人:
     *   - `::before` 补一个(0.5.3):真机上盒子没成形 —— 齿轮没了、记号也没出现,空一格;
     *   - 给 svg 上背景图(0.5.4):能画出来,但只能画色块,画不出"1.3 描边的线稿",与这列不搭;
     *   - `content: url(...)` 替换 svg 内容:SVG 元素不支持 content 替换,实测无效。
     * 换子节点这条路的失败模式是良性的:svg 由宿主渲染,我们只动它的孩子,尺寸/对齐/行高
     * 一定由宿主保证;万一类名约定变了,选中不到就没有任何改动,图标保持原样。
     * React 若重渲染把图形覆盖回去,observer 会在下一轮按子节点重新补上。
     */
    const NAV_ICON_NS = 'http://www.w3.org/2000/svg'
    /** 芯片线稿:16 网格、1.3 描边、跟随 currentColor(与宿主内置图标同一规范)。 */
    const CHIP_SHAPES = [
      { tag: 'rect', attrs: { x: '5', y: '5', width: '6', height: '6', rx: '1.4', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' } },
      { tag: 'rect', attrs: { x: '6.9', y: '6.9', width: '2.2', height: '2.2', rx: '0.6', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' } },
      { tag: 'path', attrs: { d: 'M8 5V3.2M8 11v1.8M5 8H3.2M11 8h1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round' } },
    ]

    /** 把一颗 nav 图标的图形换成芯片;已经是芯片就跳过(observer 会反复调到这里)。 */
    function paintChip(svg) {
      const shapes = svg.querySelectorAll('rect,path,circle,line,polyline,polygon')
      const first = shapes[0]
      const isChip = shapes.length === CHIP_SHAPES.length
        && first?.tagName?.toLowerCase() === 'rect'
        && first.getAttribute('rx') === '1.4'
      if (isChip) return
      svg.replaceChildren(...CHIP_SHAPES.map(({ tag, attrs }) => {
        const node = document.createElementNS(NAV_ICON_NS, tag)
        for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v)
        return node
      }))
    }

    /**
     * 在"含「记忆」那一行"上做记号并换图。
     *
     * 关键:记号打在**按钮自己**身上,绝不打在父级 navList 上 —— 整列是同一个容器,
     * 打到父级等于给所有区块都加图标。面板随时可能卸载/重挂(它是 body 上的 portal),
     * 所以用 MutationObserver 跟着 DOM 走;识别依据是**这一行的文案**(trim 后比对),
     * 不依赖任何类名 —— 类名约定变了只是什么都不做,图标保持宿主原样。
     */
    function wrapSettingsNav() {
      const mark = () => {
        try {
          for (const cell of document.querySelectorAll('[class*="_navCell"]')) {
            const label = (cell.textContent ?? '').trim()
            if (label !== NAV_LABEL) continue
            cell.classList?.add('dsh-memory-nav')
            const icon = cell.querySelector('[class*="_navIcon"]')
            if (icon) paintChip(icon)
          }
        } catch { /* 换图失败:图标保持宿主原样 */ }
      }
      mark()
      const observer = new MutationObserver(mark)
      observer.observe(document.body, { childList: true, subtree: true })
      return () => observer.disconnect()
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
