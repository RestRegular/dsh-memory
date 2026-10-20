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
      // ===== 记忆树 =====
      // 结构:统计 → 工具条/类型图例 → 画布(HTML 节点 + SVG 连线) → 右侧详情抽屉。
      // 节点用 HTML 而不是 SVG <text>:内容换行、省略号、悬停过渡都由浏览器排版,
      // SVG 只负责画连接线,缩放时整体 transform。
      '.memp .tree-tab{display:flex;flex-direction:column;gap:12px}',
      '.memp .tree-stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}',
      '.memp .tree-stats .stat{position:relative;overflow:hidden;padding:8px 12px 7px;border-radius:11px;background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 72%)}',
      '.memp .tree-stats .stat::after{content:"";position:absolute;right:-14px;top:-20px;width:56px;height:56px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);pointer-events:none}',
      '.memp .tree-stats .stat b{font-size:18px}',
      '.memp .tree-toolbar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.memp .tree-toolbar input[type=text]{flex:1 1 190px;min-width:150px;max-width:300px}',
      '.memp .tree-toolbar .spacer{flex:1}',
      '.memp .tree-toolbar button{padding:5px 10px;font-size:12px}',
      // 工具条里的类型胶囊沿用 kchip 的圆角与内边距,不被上面的通用 button 规则撑高。
      '.memp .tree-toolbar .kchip{padding:1px 9px 1px 7px;line-height:1.8;border-radius:999px;font-size:11.5px}',
      '.memp .tree-toolbar .linkbtn{padding:2px 4px;border:0;background:none}',
      '.memp .kindbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;min-width:0}',
      '.memp .kindbar-label{font-size:11.5px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .kchip{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 9px 1px 7px;font-size:11.5px;line-height:1.8;cursor:pointer;transition:opacity .12s ease,border-color .12s ease,color .12s ease,background .12s ease}',
      '.memp .kchip .tdot{width:7px;height:7px;border-radius:50%;background:var(--k);box-shadow:0 0 0 3px color-mix(in srgb,var(--k) 15%,transparent)}',
      '.memp .kchip b{font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.memp .kchip.off{opacity:.42;background:transparent}',
      '.memp .kchip.on{color:var(--dsw-alias-label-primary);border-color:color-mix(in srgb,#D9A441 45%,var(--dsw-alias-border-l1));background:color-mix(in srgb,#D9A441 8%,var(--dsw-alias-bg-layer-1))}',
      '.memp .kchip:hover{border-color:var(--k);color:var(--dsw-alias-label-primary)}',
      '.memp .kchip .corr-swatch{width:14px;border-top:1.5px dashed #D9A441}',
      '.memp .tree-matchinfo{font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}',
      '.memp .tree-wrap{position:relative;height:min(56vh,560px);min-height:320px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;overflow:hidden;background:radial-gradient(circle at 16% 8%,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent),transparent 44%),radial-gradient(circle at 1px 1px,color-mix(in srgb,var(--dsw-alias-label-secondary) 15%,transparent) 1px,transparent 0) 0 0/22px 22px,var(--dsw-alias-bg-layer-1)}',
      '.mem-page .memp .tree-wrap{height:calc(100vh - 360px);min-height:420px}',
      '.memp .tree-scroll{height:100%;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) transparent}',
      '.memp .tree-scroll::-webkit-scrollbar{width:9px;height:9px}',
      '.memp .tree-scroll::-webkit-scrollbar-track{background:transparent}',
      '.memp .tree-scroll::-webkit-scrollbar-thumb{background:rgba(127,127,127,.28);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .tree-scroll::-webkit-scrollbar-thumb:hover{background:rgba(127,127,127,.5);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 55%,transparent);border:2px solid transparent;background-clip:padding-box}',
      '.memp .tree-scroll::-webkit-scrollbar-corner{background:transparent}',
      '.memp .tree-zoomspace{position:relative;margin:0 auto}',
      '.memp .tree-canvas{position:relative;transform-origin:0 0;transition:transform .16s ease}',
      '.memp .tree-edges{position:absolute;inset:0;overflow:visible;pointer-events:none}',
      '.memp .edge{fill:none;stroke:color-mix(in srgb,var(--dsw-alias-label-secondary) 40%,transparent);stroke-width:1.2;transition:opacity .15s ease,stroke .15s ease,stroke-width .15s ease}',
      '.memp .edge.active{stroke:var(--dsw-alias-brand-primary);stroke-width:1.8;opacity:.95}',
      '.memp .tree-canvas.focused .edge:not(.active){opacity:.28}',
      '.memp .corr-edge{fill:none;stroke:#D9A441;stroke-width:1.25;stroke-dasharray:4 3;opacity:.5;transition:opacity .15s ease,stroke-width .15s ease}',
      '.memp .corr-edge.active{opacity:1;stroke-width:2;stroke-dasharray:none}',
      '.memp .tree-canvas.focused .corr-edge:not(.active){opacity:.14}',
      '.memp .corr-dot{fill:#D9A441;opacity:.6;transition:opacity .15s ease}',
      '.memp .corr-dot.active{opacity:1}',
      '.memp .tree-node{position:absolute;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer;user-select:none;transition:border-color .14s ease,box-shadow .14s ease,opacity .14s ease,background .14s ease;animation:memNodeIn .2s ease both}',
      '@keyframes memNodeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}',
      '.memp .tree-node.root{display:flex;align-items:center;gap:7px;padding:0 10px;border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 55%,var(--dsw-alias-border-l1));background:linear-gradient(145deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 72%);box-shadow:0 6px 18px color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);cursor:default}',
      '.memp .tree-node.root .root-icon{display:inline-flex;color:var(--dsw-alias-brand-primary);flex:none}',
      '.memp .tree-node.root b{display:block;font-size:13px;line-height:1.2}',
      '.memp .tree-node.root span{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.memp .tree-node.scope{display:flex;align-items:center;gap:7px;padding:0 10px;background:linear-gradient(120deg,var(--dsw-alias-bg-layer-1),color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-layer-1)))}',
      '.memp .tree-node.scope:hover,.memp .tree-node.kind:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 60%,var(--dsw-alias-border-l1))}',
      '.memp .tn-ico{flex:none;width:20px;height:20px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-brand-primary)}',
      '.memp .tn-scope{flex:1;min-width:0;font-size:12px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .tn-count{flex:none;font-size:10.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 6px;line-height:1.6;background:var(--dsw-alias-bg-layer-2)}',
      '.memp .tn-caret{flex:none;font-size:9px;color:var(--dsw-alias-label-secondary);opacity:.8}',
      '.memp .tree-node.collapsed{border-style:dashed}',
      '.memp .tree-node.kind{display:flex;align-items:center;gap:6px;padding:0 9px;border-radius:9px;border-left:3px solid var(--k)}',
      '.memp .tree-node.kind .tn-name{flex:1;min-width:0;font-size:11.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.memp .tree-node.kind .tdot{width:6px;height:6px;border-radius:50%;background:var(--k);flex:none}',
      '.memp .tree-node.record{padding:6px 9px 6px 12px;display:flex;flex-direction:column;gap:4px;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.memp .tree-node.record::before{content:"";position:absolute;left:0;top:8px;bottom:8px;width:3px;border-radius:999px;background:var(--k);opacity:.85}',
      '.memp .tree-node.record:hover{border-color:var(--k);box-shadow:0 6px 16px color-mix(in srgb,var(--k) 16%,transparent)}',
      '.memp .tree-node.record.selected{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,transparent),0 8px 20px rgba(0,0,0,.10)}',
      '.memp .tree-node.record.related{border-color:color-mix(in srgb,var(--k) 70%,var(--dsw-alias-border-l1))}',
      '.memp .tree-node.record.miss{opacity:.28}',
      '.memp .tree-node.record.match{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,transparent)}',
      '.memp .tree-canvas.focused .tree-node.record:not(.related){opacity:.55}',
      '.memp .tn-head{display:flex;align-items:center;gap:5px;min-width:0;font-size:10.5px;color:var(--dsw-alias-label-secondary)}',
      '.memp .tn-head .tdot{width:6px;height:6px;border-radius:50%;background:var(--k);flex:none}',
      '.memp .tn-kind{font-weight:600;color:var(--dsw-alias-label-primary);letter-spacing:.02em;flex:none}',
      '.memp .tn-badge{border-radius:999px;padding:0 5px;line-height:1.55;font-size:9.5px;border:1px solid transparent;flex:none}',
      '.memp .tn-badge.corr{color:color-mix(in srgb,#D9A441 62%,var(--dsw-alias-label-primary));background:color-mix(in srgb,#D9A441 14%,transparent);border-color:color-mix(in srgb,#D9A441 35%,transparent)}',
      '.memp .tn-badge.old{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}',
      '.memp .tn-time{margin-left:auto;flex:none;font-size:9.5px;opacity:.75}',
      '.memp .tn-content{font-size:11.5px;line-height:1.45;color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '.memp .tree-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.6;text-align:center;padding:24px;z-index:1}',
      '.memp .tree-empty .big{font-size:22px;opacity:.65}',
      '.memp .tree-empty button{padding:4px 12px;font-size:12px}',
      '.memp .tree-zoom{position:absolute;right:10px;bottom:10px;display:flex;align-items:center;gap:1px;padding:3px;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);backdrop-filter:blur(6px);box-shadow:0 4px 14px rgba(0,0,0,.12);z-index:3}',
      '.memp .tree-zoom button{background:none;border:0;padding:2px 8px;border-radius:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.memp .tree-zoom button:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary)}',
      '.memp .tree-zoom .zoomval{font-size:10.5px;min-width:38px;text-align:center;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.memp .tree-legend{position:absolute;left:10px;bottom:10px;display:flex;gap:10px;align-items:center;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding:3px 9px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 88%,transparent);border:1px solid var(--dsw-alias-border-l1);backdrop-filter:blur(6px);z-index:2;pointer-events:none}',
      '.memp .tree-legend .line{display:inline-block;width:18px;height:0;border-top:1.5px dashed #D9A441;margin-right:4px;vertical-align:middle}',
      '.memp .tree-detail{position:absolute;z-index:4;top:10px;left:10px;bottom:10px;width:min(322px,calc(100% - 20px));display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 96%,transparent);backdrop-filter:blur(10px);box-shadow:0 16px 42px rgba(0,0,0,.22);overflow:auto;font-size:11.5px;scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent) transparent}',
      '.memp .tree-detail::-webkit-scrollbar{width:8px}',
      '.memp .tree-detail::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 30%,transparent);border-radius:999px;border:2px solid transparent;background-clip:padding-box}',
      '.memp .td-head{display:flex;align-items:center;gap:6px}',
      '.memp .td-head .td-title{font-weight:600;font-size:12px}',
      '.memp .td-close{margin-left:auto;background:none;border:0;font-size:15px;line-height:1;padding:2px 4px;color:var(--dsw-alias-label-secondary)}',
      '.memp .td-close:hover{color:var(--dsw-alias-brand-primary)}',
      '.memp .td-scope{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0}',
      '.memp .td-scope .tn-scope{font-size:11px;font-weight:500}',
      '.memp .td-content{font-size:12.5px;line-height:1.62;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-primary)}',
      '.memp .td-tags{display:flex;flex-wrap:wrap;gap:4px}',
      '.memp .td-meta{display:flex;flex-direction:column;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary);padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.memp .td-meta .rowline{display:flex;align-items:center;gap:6px;min-width:0}',
      '.memp .td-meta .rowline b{font-weight:500;color:var(--dsw-alias-label-primary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .td-impbar{flex:1;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}',
      '.memp .td-impbar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent),var(--dsw-alias-brand-primary))}',
      '.memp .td-id{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:9.5px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);cursor:pointer;user-select:all;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.memp .td-rel{display:flex;flex-direction:column;gap:5px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.memp .td-rel-label{font-size:10px;color:var(--dsw-alias-label-secondary);letter-spacing:.04em}',
      '.memp .td-rel-btn{display:flex;align-items:flex-start;gap:6px;text-align:left;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);font-size:10.5px;line-height:1.45}',
      '.memp .td-rel-dir{flex:none;color:color-mix(in srgb,#D9A441 62%,var(--dsw-alias-label-primary));font-weight:600}',
      '.memp .td-rel-text{color:var(--dsw-alias-label-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}',
      '@media (max-width:620px){.memp .tree-stats{grid-template-columns:repeat(2,minmax(0,1fr))}.memp .tree-toolbar input[type=text]{max-width:none}}',
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

    /** 记忆类型 → 中文名 + 树里的强调色(与宿主主题无关的固定色相,底色用 color-mix 自适应)。 */
    const KIND_ORDER = ['fact', 'decision', 'preference', 'procedure', 'note', 'rule']
    const KIND_META = {
      fact: { label: '事实', color: '#5B8DEF' },
      decision: { label: '决策', color: '#D99A2B' },
      preference: { label: '偏好', color: '#D868A8' },
      procedure: { label: '流程', color: '#3FAE7A' },
      note: { label: '笔记', color: '#7C8AA0' },
      rule: { label: '规则', color: '#9B6BE0' },
    }

    function kindMeta(kind) {
      return KIND_META[kind] || { label: String(kind), color: '#8B93A7' }
    }

    function kindRank(kind) {
      const index = KIND_ORDER.indexOf(kind)
      return index < 0 ? KIND_ORDER.length : index
    }

    function scopeRank(scope) {
      if (scope === 'global') return 0
      if (scope.startsWith('project:')) return 1
      if (scope.startsWith('session:')) return 2
      return 3
    }

    /** 作用域类型的一字记号(全 / 项 / 会 / 自),比抽象图标更好认。 */
    function scopeGlyph(scope) {
      if (scope === 'global') return '全'
      if (scope.startsWith('project:')) return '项'
      if (scope.startsWith('session:')) return '会'
      return '自'
    }

    /** 紧凑时间:今天只给时分,其它日期给月/日。 */
    function shortTime(ts) {
      if (!ts) return ''
      const date = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      const now = new Date()
      if (date.toDateString() === now.toDateString()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`
      return `${date.getMonth() + 1}/${date.getDate()}`
    }

    function excerpt(text, limit = 64) {
      const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
      return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
    }

    /**
     * 记忆树的**纯布局**:输入记录,输出节点的绝对坐标、层级连线与修正连线。
     *
     * 层级固定为 root → scope → kind → record,列间平推、叶子纵向堆叠;父节点在自己
     * 子树的高度里居中。折叠一个 scope/kind 只是不展开它下面的节点,布局仍然成立。
     * 修正关系不改变层级(一条记录只会修正同一个作用域里的旧记录),所以单独作为
     * 曲线叠在右侧,避免把树本身拧成图。
     *
     * 这个函数不碰 DOM,测试可以直接断言节点与连线。
     */
    const TREE_METRICS = {
      rootW: 100, rootH: 48,
      scopeW: 202, scopeH: 42,
      kindW: 128, kindH: 30,
      recordW: 236, recordH: 56,
      padX: 26, padY: 24,
      colGap: 54, leafGap: 8, groupGap: 16,
      arcRoom: 104,
    }

    function buildMemoryTree(records, options = {}) {
      const M = TREE_METRICS
      const labels = options.labels || {}
      const collapsed = options.collapsed instanceof Set ? options.collapsed : new Set(options.collapsed || [])
      const activeKinds = options.activeKinds instanceof Set ? options.activeKinds : new Set(KIND_ORDER)
      const scopeFilter = typeof options.scopeFilter === 'string' ? options.scopeFilter : ''
      const query = String(options.query ?? '').trim().toLowerCase()

      const byScope = new Map()
      for (const rec of records) {
        if (!activeKinds.has(rec.kind)) continue
        if (scopeFilter !== '' && rec.scope !== scopeFilter) continue
        let kinds = byScope.get(rec.scope)
        if (kinds === undefined) { kinds = new Map(); byScope.set(rec.scope, kinds) }
        let list = kinds.get(rec.kind)
        if (list === undefined) { list = []; kinds.set(rec.kind, list) }
        list.push(rec)
      }

      const scopeGroups = []
      for (const [scope, kindMap] of byScope) {
        const kinds = []
        for (const [kind, list] of kindMap) {
          kinds.push({ kind, records: list.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)) })
        }
        kinds.sort((a, b) => kindRank(a.kind) - kindRank(b.kind) || String(a.kind).localeCompare(String(b.kind)))
        let count = 0
        for (const entry of kinds) count += entry.records.length
        scopeGroups.push({ scope, label: scopeLabel(scope, labels), kinds, count })
      }
      scopeGroups.sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.label.localeCompare(b.label, 'zh'))

      const scopeKey = (scope) => `scope:${scope}`
      const kindKey = (scope, kind) => `kind:${scope}|${kind}`
      const recordKey = (id) => `record:${id}`

      const scopeBlocks = scopeGroups.map((group) => {
        const collapsedScope = collapsed.has(scopeKey(group.scope))
        const kindBlocks = collapsedScope ? [] : group.kinds.map((entry) => {
          const collapsedKind = collapsed.has(kindKey(group.scope, entry.kind))
          const recordsHeight = entry.records.length * M.recordH
            + Math.max(0, entry.records.length - 1) * M.leafGap
          return {
            ...entry,
            collapsed: collapsedKind,
            height: collapsedKind ? M.kindH : Math.max(M.kindH, recordsHeight),
          }
        })
        let body = 0
        for (const entry of kindBlocks) body += entry.height
        const height = collapsedScope
          ? M.scopeH
          : Math.max(M.scopeH, body + Math.max(0, kindBlocks.length - 1) * M.groupGap)
        return { ...group, collapsed: collapsedScope, kindBlocks, height }
      })

      let scopesHeight = 0
      for (const block of scopeBlocks) scopesHeight += block.height
      if (scopeBlocks.length > 1) scopesHeight += (scopeBlocks.length - 1) * M.groupGap
      const contentHeight = Math.max(M.rootH, scopesHeight)

      const nodes = []
      const nodeByKey = new Map()
      const recordNode = new Map()
      const edges = []
      const corrections = []
      const addNode = (node) => { nodes.push(node); nodeByKey.set(node.key, node) }

      const rootX = M.padX
      const rootY = M.padY + (contentHeight - M.rootH) / 2
      const scopeX = rootX + M.rootW + M.colGap
      const kindX = scopeX + M.scopeW + M.colGap
      const recordX = kindX + M.kindW + M.colGap
      let visibleRecords = 0

      addNode({
        key: 'root', type: 'root',
        x: rootX, y: rootY, w: M.rootW, h: M.rootH,
        count: scopeGroups.reduce((sum, group) => sum + group.count, 0),
      })

      let top = M.padY
      for (const scope of scopeBlocks) {
        const sKey = scopeKey(scope.scope)
        addNode({
          key: sKey, type: 'scope',
          x: scopeX, y: top + (scope.height - M.scopeH) / 2, w: M.scopeW, h: M.scopeH,
          scope: scope.scope, label: scope.label, count: scope.count, collapsed: scope.collapsed,
        })
        edges.push({ key: `root>${sKey}`, type: 'tree', fromKey: 'root', toKey: sKey, toType: 'scope', toId: scope.scope })

        let kindTop = top
        for (const entry of scope.kindBlocks) {
          const kKey = kindKey(scope.scope, entry.kind)
          addNode({
            key: kKey, type: 'kind',
            x: kindX, y: kindTop + (entry.height - M.kindH) / 2, w: M.kindW, h: M.kindH,
            scope: scope.scope, kind: entry.kind, count: entry.records.length, collapsed: entry.collapsed,
          })
          edges.push({
            key: `${sKey}>${kKey}`, type: 'tree',
            fromKey: sKey, toKey: kKey, toType: 'kind', toId: `${scope.scope}|${entry.kind}`,
          })
          if (!entry.collapsed) {
            const recordsHeight = entry.records.length * M.recordH
              + Math.max(0, entry.records.length - 1) * M.leafGap
            const recordTop = kindTop + (entry.height - recordsHeight) / 2
            entry.records.forEach((rec, index) => {
              const rKey = recordKey(rec.id)
              const y = recordTop + index * (M.recordH + M.leafGap)
              addNode({
                key: rKey, type: 'record',
                x: recordX, y, w: M.recordW, h: M.recordH,
                scope: rec.scope, kind: rec.kind, rec,
              })
              recordNode.set(rec.id, rKey)
              edges.push({ key: `${kKey}>${rKey}`, type: 'tree', fromKey: kKey, toKey: rKey, toType: 'record', toId: rec.id })
              visibleRecords += 1
            })
          }
          kindTop += entry.height + M.groupGap
        }
        top += scope.height + M.groupGap
      }

      // 修正连线要等**所有**节点都落位后再算:新记录排在旧记录前面(按 updatedAt 倒序),
      // 单遍循环时还看不到被修正的旧记录。
      for (const node of nodes) {
        if (node.type !== 'record') continue
        const rec = node.rec
        const oldKey = rec.supersedes ? recordNode.get(rec.supersedes) : undefined
        if (oldKey === undefined) continue
        corrections.push({
          key: `corr:${rec.id}>${rec.supersedes}`,
          fromKey: node.key, toKey: oldKey, fromId: rec.id, toId: rec.supersedes,
        })
      }

      const matches = new Set()
      if (query !== '') {
        for (const node of nodes) {
          if (node.type !== 'record') continue
          const rec = node.rec
          const haystack = [
            rec.content, rec.kind, kindMeta(rec.kind).label,
            (rec.tags || []).join(' '), node.scope, scopeLabel(node.scope, labels),
          ].join(' ').toLowerCase()
          if (haystack.includes(query)) matches.add(rec.id)
        }
      }

      const visibleKinds = new Set()
      for (const group of scopeGroups) for (const entry of group.kinds) visibleKinds.add(entry.kind)
      const width = recordX + M.recordW + M.padX + M.arcRoom
      const height = M.padY * 2 + contentHeight

      return {
        nodes, edges, corrections, nodeByKey, recordNode, matches,
        width, height,
        counts: {
          records: visibleRecords,
          scopes: scopeGroups.length,
          kinds: visibleKinds.size,
          corrections: corrections.length,
        },
      }
    }

    /** 层级连线:从父节点右缘到子节点左缘,水平方向用三次贝塞尔。 */
    function treeEdgePath(from, to) {
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x
      const y2 = to.y + to.h / 2
      const bend = Math.max(18, Math.abs(x2 - x1) * 0.48)
      return `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
    }

    /** 修正连线:两端都从卡片右缘出,向右侧鼓出一条弧,不穿过叶子文本。 */
    function treeCorrectionPath(from, to) {
      const x1 = from.x + from.w
      const y1 = from.y + from.h / 2
      const x2 = to.x + to.w
      const y2 = to.y + to.h / 2
      const bend = 34 + Math.min(66, Math.abs(y2 - y1) * 0.09)
      return `M${x1},${y1} C${x1 + bend},${y1} ${x2 + bend},${y2} ${x2},${y2}`
    }

    function KindDot({ kind }) {
      return h('span', {
        className: 'tdot',
        style: { '--k': kindMeta(kind).color },
        'aria-hidden': 'true',
      })
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

    /** 树上的一条记忆:内容两行封顶,类型/修正/时间放在头行。 */
    function TreeRecordNode({ node, selected, related, miss, match, onSelect, onHover }) {
      const rec = node.rec
      const meta = kindMeta(rec.kind)
      const classes = ['tree-node', 'record']
      if (selected) classes.push('selected')
      if (related) classes.push('related')
      if (miss) classes.push('miss')
      if (match) classes.push('match')
      const pick = () => onSelect(rec.id)
      return h('div', {
        className: classes.join(' '),
        style: { left: node.x, top: node.y, width: node.w, height: node.h, '--k': meta.color },
        title: rec.content,
        role: 'button',
        tabIndex: 0,
        'aria-pressed': Boolean(selected),
        onClick: pick,
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); pick() }
        },
        onMouseEnter: () => onHover(rec.id),
        onMouseLeave: () => onHover(null),
        onFocus: () => onHover(rec.id),
        onBlur: () => onHover(null),
      },
        h('div', { className: 'tn-head' },
          h(KindDot, { kind: rec.kind }),
          h('span', { className: 'tn-kind' }, meta.label),
          rec.supersedes
            ? h('span', { className: 'tn-badge corr', title: `这条记录修正了旧记录 #${rec.supersedes}` }, '修正版')
            : null,
          rec.supersededBy
            ? h('span', { className: 'tn-badge old', title: `已被 #${rec.supersededBy} 修正` }, '已修正')
            : null,
          h('span', { className: 'tn-time' }, shortTime(rec.updatedAt)),
        ),
        h('div', { className: 'tn-content' }, rec.content),
      )
    }

    /** 树上的一个作用域:点击折叠/展开。 */
    function TreeScopeNode({ node, onToggle }) {
      return h('div', {
        className: 'tree-node scope' + (node.collapsed ? ' collapsed' : ''),
        style: { left: node.x, top: node.y, width: node.w, height: node.h },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !node.collapsed,
        title: `${node.scope} · 点击${node.collapsed ? '展开' : '折叠'}`,
        onClick: () => onToggle(node.scope),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(node.scope) }
        },
      },
        h('span', { className: 'tn-ico' }, scopeGlyph(node.scope)),
        h('span', { className: 'tn-scope' }, node.label),
        h('span', { className: 'tn-count' }, String(node.count)),
        h('span', { className: 'tn-caret' }, node.collapsed ? '▸' : '▾'),
      )
    }

    /** 树上的一个类型分组:点击折叠/展开。 */
    function TreeKindNode({ node, onToggle }) {
      const meta = kindMeta(node.kind)
      return h('div', {
        className: 'tree-node kind' + (node.collapsed ? ' collapsed' : ''),
        style: { left: node.x, top: node.y, width: node.w, height: node.h, '--k': meta.color },
        role: 'button',
        tabIndex: 0,
        'aria-expanded': !node.collapsed,
        title: `${node.kind} · ${meta.label} · 点击${node.collapsed ? '展开' : '折叠'}`,
        onClick: () => onToggle(node.scope, node.kind),
        onKeyDown: (event) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(node.scope, node.kind) }
        },
      },
        h('span', { className: 'tdot' }),
        h('span', { className: 'tn-name' }, meta.label),
        h('span', { className: 'tn-count' }, String(node.count)),
        h('span', { className: 'tn-caret' }, node.collapsed ? '▸' : '▾'),
      )
    }

    function TreeRootNode({ node }) {
      return h('div', {
        className: 'tree-node root',
        style: { left: node.x, top: node.y, width: node.w, height: node.h },
        title: '所有作用域的记忆',
      },
        h('span', { className: 'root-icon' }, h(NavLineIcon, { size: 19 })),
        h('span', null,
          h('b', null, '记忆'),
          h('span', null, `${node.count} 条`),
        ),
      )
    }

    /** 右侧详情抽屉:全文、标签、重要度、id,以及修正关系的双向入口。 */
    function TreeDetail({ rec, labels, byId, onClose, onJump }) {
      const [copied, setCopied] = React.useState(false)
      const meta = kindMeta(rec.kind)
      const older = rec.supersedes ? byId.get(rec.supersedes) : undefined
      const newer = rec.supersededBy ? byId.get(rec.supersededBy) : undefined
      const copyId = () => {
        try {
          if (navigator?.clipboard?.writeText) void navigator.clipboard.writeText(rec.id)
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        } catch { /* 剪贴板不可用时忽略 */ }
      }
      return h('aside', { className: 'tree-detail', 'aria-label': '记忆详情' },
        h('div', { className: 'td-head' },
          h(KindDot, { kind: rec.kind }),
          h('span', { className: 'td-title' }, meta.label),
          h('span', { className: 'tn-count' }, rec.kind),
          h('button', { className: 'td-close', title: '关闭详情', onClick: onClose }, '×'),
        ),
        h('div', { className: 'td-scope' },
          h('span', { className: 'tn-ico' }, scopeGlyph(rec.scope)),
          h('span', { className: 'tn-scope' }, scopeLabel(rec.scope, labels)),
        ),
        h('div', { className: 'td-content' }, rec.content),
        rec.tags && rec.tags.length > 0
          ? h('div', { className: 'td-tags' }, rec.tags.map((tag) => h('span', { className: 'tag', key: tag }, tag)))
          : null,
        h('div', { className: 'td-meta' },
          h('div', { className: 'rowline' },
            h('span', null, '重要度'),
            h('span', { className: 'td-impbar' }, h('i', { style: { width: `${Math.round((Number(rec.importance) || 0) * 100)}%` } })),
            h('span', null, `${Math.round((Number(rec.importance) || 0) * 100)}%`),
          ),
          h('div', { className: 'rowline' }, h('span', null, '创建'), h('b', null, fmtTime(rec.createdAt))),
          h('div', { className: 'rowline' }, h('span', null, '更新'), h('b', null, fmtTime(rec.updatedAt))),
          h('div', { className: 'rowline' },
            h('span', null, 'id'),
            h('code', { className: 'td-id', title: '点击复制完整 id', onClick: copyId }, rec.id),
            copied ? h('span', { className: 'meta-done' }, '已复制') : null,
          ),
        ),
        h('div', { className: 'td-rel' },
          h('span', { className: 'td-rel-label' }, '修正关系'),
          older
            ? h('button', { className: 'td-rel-btn', title: `跳转到被修正的旧记录 #${older.id}`, onClick: () => onJump(older.id) },
                h('span', { className: 'td-rel-dir' }, '修正自'),
                h('span', { className: 'td-rel-text' }, excerpt(older.content)),
              )
            : null,
          newer
            ? h('button', { className: 'td-rel-btn', title: `跳转到修正它的新记录 #${newer.id}`, onClick: () => onJump(newer.id) },
                h('span', { className: 'td-rel-dir' }, '已被修正为'),
                h('span', { className: 'td-rel-text' }, excerpt(newer.content)),
              )
            : null,
          !older && !newer ? h('span', { className: 'muted' }, '这条记忆没有修正关系。') : null,
          older && newer
            ? h('span', { className: 'muted' }, '这条记录处在一条修正链的中间。')
            : null,
        ),
      )
    }

    /**
     * 「记忆树」标签页。
     *
     * 层级:记忆 → 作用域 → 类型 → 记录。三个维度正好对应记忆的归属(scope)、
     * 语义(kind)与内容;修正关系是跨记录的点对点关系,用金色虚线单独画在树的右侧,
     * 悬停/选中任意一端时两端与整条链一起点亮。
     */
    function MemoryTreeTab({ records, scopes, loading, error, onRefresh }) {
      const [query, setQuery] = React.useState('')
      const [scopeFilter, setScopeFilter] = React.useState('')
      const [kindFilter, setKindFilter] = React.useState(null)
      const [collapsed, setCollapsed] = React.useState(new Set())
      const [selectedId, setSelectedId] = React.useState(null)
      const [hoverId, setHoverId] = React.useState(null)
      const [showCorrections, setShowCorrections] = React.useState(true)
      const [zoom, setZoom] = React.useState(1)
      const [autoFitDone, setAutoFitDone] = React.useState(false)
      const wrapRef = React.useRef(null)

      const labels = {}
      for (const entry of scopes) {
        if (entry && typeof entry.scope === 'string' && typeof entry.label === 'string') labels[entry.scope] = entry.label
      }
      const recordById = new Map()
      const kindCounts = new Map()
      const presentKinds = []
      const presentScopes = []
      for (const rec of records) {
        recordById.set(rec.id, rec)
        kindCounts.set(rec.kind, (kindCounts.get(rec.kind) || 0) + 1)
        if (!presentKinds.includes(rec.kind)) presentKinds.push(rec.kind)
        if (!presentScopes.includes(rec.scope)) presentScopes.push(rec.scope)
      }
      presentKinds.sort((a, b) => kindRank(a) - kindRank(b) || String(a).localeCompare(String(b)))
      presentScopes.sort((a, b) => scopeRank(a) - scopeRank(b) || scopeLabel(a, labels).localeCompare(scopeLabel(b, labels), 'zh'))

      const allKinds = new Set(presentKinds)
      const activeKinds = kindFilter === null
        ? allKinds
        : new Set(presentKinds.filter((kind) => kindFilter.has(kind)))

      const layout = buildMemoryTree(records, {
        labels, collapsed, activeKinds, scopeFilter, query,
      })

      // 第一次拿到记录时把宽度缩到画布内:右侧的记录列默认不该被横向截断。
      // 高度方向仍可滚动 —— 记忆很多时把整棵树压到一屏里会小到看不清。
      React.useEffect(() => {
        if (autoFitDone || layout.counts.records === 0) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        if (!scroll || scroll.clientWidth <= 0 || layout.width <= 0) return
        const widthFit = (scroll.clientWidth - 28) / layout.width
        if (widthFit < 0.99) setZoom(Math.max(0.62, Math.round(widthFit * 100) / 100))
        setAutoFitDone(true)
      }, [autoFitDone, layout.counts.records, layout.width])

      // 根节点在整棵树的高度里居中;树比视口高时,首屏应该正好看到它,
      // 而不是从最上面的作用域往下翻。
      React.useEffect(() => {
        if (!autoFitDone) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        const root = layout.nodeByKey.get('root')
        if (!scroll || !root) return
        const max = Math.max(0, scroll.scrollHeight - scroll.clientHeight)
        const target = (root.y + root.h / 2) * zoom - scroll.clientHeight / 2
        scroll.scrollTop = Math.max(0, Math.min(target, max))
      }, [autoFitDone, zoom])

      // 选中一条记忆时把它滚进视口:右侧详情是从「修正关系」里跳过来的,
      // 目标可能在当前滚动范围之外。
      React.useEffect(() => {
        if (selectedId === null) return
        const wrap = wrapRef.current
        const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
        const node = scroll ? scroll.querySelector('.tree-node.record.selected') : null
        if (!scroll || !node) return
        const top = node.offsetTop * zoom
        const bottom = top + node.offsetHeight * zoom
        const viewTop = scroll.scrollTop
        const viewBottom = viewTop + scroll.clientHeight
        if (top < viewTop + 12) scroll.scrollTop = Math.max(0, top - 12)
        else if (bottom > viewBottom - 12) scroll.scrollTop = bottom - scroll.clientHeight + 12
      }, [selectedId])

      const focusId = hoverId || selectedId
      const related = new Set()
      if (focusId) {
        related.add(focusId)
        for (const correction of layout.corrections) {
          if (correction.fromId === focusId) related.add(correction.toId)
          if (correction.toId === focusId) related.add(correction.fromId)
        }
      }
      const pathKeys = new Set()
      for (const id of related) {
        const rec = recordById.get(id)
        if (rec) {
          pathKeys.add(`scope:${rec.scope}`)
          pathKeys.add(`kind:${rec.scope}|${rec.kind}`)
        }
      }
      const edgeActive = (edge) => {
        if (focusId === null) return false
        if (edge.type === 'correction') return related.has(edge.fromId) || related.has(edge.toId)
        if (edge.toType === 'record') return related.has(edge.toId)
        if (edge.toType === 'kind' || edge.toType === 'scope') return pathKeys.has(edge.toKey)
        return false
      }

      const toggleScope = (scope) => {
        const key = `scope:${scope}`
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }
      const toggleKind = (scope, kind) => {
        const key = `kind:${scope}|${kind}`
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(key)) next.delete(key); else next.add(key)
          return next
        })
      }
      const toggleKindFilter = (kind) => {
        setKindFilter((previous) => {
          const next = previous === null ? new Set(presentKinds) : new Set(previous)
          if (next.has(kind)) next.delete(kind); else next.add(kind)
          return next
        })
      }
      const resetFilters = () => {
        setQuery('')
        setScopeFilter('')
        setKindFilter(null)
        setCollapsed(new Set())
      }
      const jumpTo = (id) => {
        // 从详情里跳修正链:清掉筛选并展开全部,否则目标可能正好被折叠/筛掉。
        setKindFilter(null)
        setScopeFilter('')
        setQuery('')
        setCollapsed(new Set())
        setSelectedId(id)
        setHoverId(null)
        setShowCorrections(true)
      }
      const stepZoom = (delta) => {
        setZoom((value) => Math.max(0.45, Math.min(1.6, Math.round((value + delta) * 100) / 100)))
      }
      const fitView = () => {
        try {
          const wrap = wrapRef.current
          const scroll = wrap && typeof wrap.querySelector === 'function' ? wrap.querySelector('.tree-scroll') : null
          if (!scroll || layout.width <= 0 || layout.height <= 0) { setZoom(1); return }
          const next = Math.min(
            (scroll.clientWidth - 28) / layout.width,
            Math.max((scroll.clientHeight - 28) / layout.height, 0.72),
            1.15,
          )
          setZoom(Math.max(0.5, Math.min(1.6, Math.round(next * 100) / 100)))
        } catch { setZoom(1) }
      }

      const selected = selectedId === null ? undefined : recordById.get(selectedId)
      const scopeItems = [{ value: '', label: '全部作用域' }]
      for (const scope of presentScopes) scopeItems.push({ value: scope, label: scopeLabel(scope, labels) })
      const correctionsTotal = records.reduce((sum, rec) => sum + (rec.supersedes ? 1 : 0), 0)
      const scopeTotal = new Set(records.map((rec) => rec.scope)).size
      const emptyText = records.length === 0
        ? (loading ? '正在加载记忆…' : '还没有记忆。去「记录」里新建一条，或让 Agent 用 memory_save 写一条。')
        : layout.counts.records === 0
          ? '当前筛选下没有记忆。'
          : ''
      const showEmpty = emptyText !== '' || (Boolean(error) && records.length === 0)

      const stats = h('div', { className: 'tree-stats' },
        h('div', { className: 'stat' }, h('b', null, String(records.length)), h('span', null, '条记忆')),
        h('div', { className: 'stat' }, h('b', null, String(scopeTotal)), h('span', null, '个作用域')),
        h('div', { className: 'stat' }, h('b', null, String(presentKinds.length)), h('span', null, '种类型')),
        h('div', { className: 'stat' }, h('b', null, String(correctionsTotal)), h('span', null, '处修正')),
      )

      const toolbar = h('div', { className: 'tree-toolbar' },
        h('input', {
          type: 'text',
          placeholder: '搜索内容、类型、标签或作用域',
          value: query,
          onChange: (event) => setQuery(event.target.value),
        }),
        h(Dropdown, {
          items: scopeItems,
          value: scopeFilter,
          disabled: loading,
          onChange: setScopeFilter,
        }),
        h('button', {
          className: 'kchip' + (showCorrections ? ' on' : ' off'),
          title: '显示 / 隐藏修正关系连线',
          onClick: () => setShowCorrections((value) => !value),
        }, h('span', { className: 'corr-swatch' }), '修正连线'),
        query.trim() !== ''
          ? h('span', { className: 'tree-matchinfo' }, `匹配 ${layout.matches.size} 条`)
          : null,
        h('span', { className: 'spacer' }),
        h('button', { onClick: () => setCollapsed(new Set()) }, '全部展开'),
        h('button', { onClick: () => setCollapsed(new Set(presentScopes.map((scope) => `scope:${scope}`))) }, '只看作用域'),
        h('button', { disabled: loading, onClick: onRefresh }, loading ? '刷新中…' : '刷新'),
      )

      const kindbar = h('div', { className: 'kindbar' },
        h('span', { className: 'kindbar-label' }, '类型'),
        presentKinds.map((kind) => h('button', {
          key: kind,
          className: 'kchip' + (activeKinds.has(kind) ? '' : ' off'),
          style: { '--k': kindMeta(kind).color },
          title: `${kind} · ${kindMeta(kind).label}`,
          onClick: () => toggleKindFilter(kind),
        },
          h('span', { className: 'tdot' }),
          kindMeta(kind).label,
          h('b', null, String(kindCounts.get(kind) || 0)),
        )),
        presentKinds.length > 0 && presentKinds.every((kind) => activeKinds.has(kind))
          ? null
          : h('button', { className: 'linkbtn', onClick: () => setKindFilter(null) }, '恢复全部类型'),
      )

      const nodes = []
      const add = (child) => { if (child !== null) nodes.push(child) }
      for (const node of layout.nodes) {
        if (node.type === 'root') {
          add(h(TreeRootNode, { key: node.key, node }))
        } else if (node.type === 'scope') {
          add(h(TreeScopeNode, { key: node.key, node, onToggle: toggleScope }))
        } else if (node.type === 'kind') {
          add(h(TreeKindNode, { key: node.key, node, onToggle: toggleKind }))
        } else {
          const rec = node.rec
          add(h(TreeRecordNode, {
            key: node.key,
            node,
            selected: rec.id === selectedId,
            related: related.has(rec.id),
            miss: query.trim() !== '' && !layout.matches.has(rec.id),
            match: query.trim() !== '' && layout.matches.has(rec.id),
            onSelect: (id) => setSelectedId((current) => current === id ? null : id),
            onHover: setHoverId,
          }))
        }
      }

      const edgePaths = []
      for (const edge of layout.edges) {
        const from = layout.nodeByKey.get(edge.fromKey)
        const to = layout.nodeByKey.get(edge.toKey)
        if (!from || !to) continue
        edgePaths.push(h('path', {
          key: edge.key,
          className: 'edge' + (edgeActive(edge) ? ' active' : ''),
          d: treeEdgePath(from, to),
        }))
      }
      if (showCorrections) {
        for (const edge of layout.corrections) {
          const from = layout.nodeByKey.get(edge.fromKey)
          const to = layout.nodeByKey.get(edge.toKey)
          if (!from || !to) continue
          const active = edgeActive(edge)
          edgePaths.push(h('path', {
            key: edge.key,
            className: 'corr-edge' + (active ? ' active' : ''),
            d: treeCorrectionPath(from, to),
          }))
          edgePaths.push(h('circle', {
            key: `${edge.key}:dot`,
            className: 'corr-dot' + (active ? ' active' : ''),
            cx: to.x + to.w,
            cy: to.y + to.h / 2,
            r: 2.6,
          }))
        }
      }

      const canvas = h('div', {
        className: 'tree-canvas' + (focusId !== null ? ' focused' : ''),
        style: { width: layout.width, height: layout.height, transform: `scale(${zoom})` },
      },
        h('svg', {
          className: 'tree-edges',
          width: layout.width,
          height: layout.height,
          viewBox: `0 0 ${layout.width} ${layout.height}`,
          'aria-hidden': 'true',
        }, edgePaths),
        nodes,
      )

      const treeWrap = h('div', { className: 'tree-wrap', ref: wrapRef },
        h('div', { className: 'tree-scroll' },
          h('div', {
            className: 'tree-zoomspace',
            style: { width: Math.ceil(layout.width * zoom), height: Math.ceil(layout.height * zoom) },
          }, canvas),
        ),
        showEmpty
          ? h('div', { className: 'tree-empty' },
              h('span', { className: 'big' }, '🌳'),
              h('span', null, emptyText || String(error)),
              emptyText === '当前筛选下没有记忆。'
                ? h('button', { onClick: resetFilters }, '清空筛选')
                : null,
            )
          : null,
        showEmpty ? null : h('div', { className: 'tree-zoom' },
          h('button', { title: '缩小', onClick: () => stepZoom(-0.1) }, '−'),
          h('span', { className: 'zoomval' }, `${Math.round(zoom * 100)}%`),
          h('button', { title: '放大', onClick: () => stepZoom(0.1) }, '+'),
          h('button', { title: '适应画布', onClick: fitView }, '适应'),
        ),
        showCorrections && layout.corrections.length > 0 && !showEmpty
          ? h('div', { className: 'tree-legend' }, h('span', null, h('i', { className: 'line' }), '修正关系'))
          : null,
        selected
          ? h(TreeDetail, {
              rec: selected,
              labels,
              byId: recordById,
              onClose: () => setSelectedId(null),
              onJump: jumpTo,
            })
          : null,
      )

      return h('div', { className: 'tree-tab' },
        stats,
        toolbar,
        kindbar,
        error && records.length > 0 ? h('div', { className: 'err' }, error) : null,
        treeWrap,
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
        desc: '把 kind=rule 的记忆放进系统提示常驻段；旧会话下一轮补一条新增/变更的规则。',
        hint: '关闭只影响系统提示常驻段，记忆本身仍可被检索',
        fields: [
          { k: 'enabled', label: '启用', type: 'bool' },
          { k: 'maxItems', label: '最多条数', type: 'num', min: 1, max: 40, step: 1 },
          { k: 'tokenBudget', label: 'token 预算', type: 'num', min: 50, max: 4000, step: 50 },
          { k: 'delta', label: '变更提醒', type: 'bool', hint: '旧会话在下一轮第一步补一条新增/编辑过的规则；没变化的不重复' },
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
                  title: field.hint || group.hint || field.label,
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

    /** 待嵌入自动刷新:最多 300 次 × 1.5s(后端挂着时不无限轮询)。 */
    const PENDING_POLL_LIMIT = 300

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
      const [pendingTick, setPendingTick] = React.useState(0)
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
       * 维护动作：卸载向量服务 / 清空记忆数据 / 重建全部向量。前两者不可撤销，重建代价高，
       * 都走两步确认（dangerAsk 记住当前等确认的那一项，第二次点击才真的发请求）。
       */
      const maintenanceAction = async (which) => {
        if (dangerAsk !== which) { setDangerAsk(which); setEmbedNotice(''); return }
        setDangerAsk('')
        setEmbedBusy(true); setEmbedNotice('')
        try {
          const value = which === 'uninstall'
            ? await api('embed/uninstall', {})
            : which === 'reindex'
              ? await api('embed/reindex', {})
              // 服务端要求显式 confirm:"delete"，避免任何一次误触就清库
              : await api('data/wipe', { confirm: 'delete' })
          setEmbedServer(value.embedServer ? { ...value.embedServer } : value)
          if (which === 'uninstall') {
            setEmbedNotice(value.removed
              ? `已卸载向量服务，释放约 ${((value.freedBytes ?? 0) / 1048576).toFixed(1)} MB。向量检索已关闭，词法检索照常。`
              : value.reason === 'EXTERNAL_BACKEND'
                ? '当前后端不在本插件管理的目录里（是你自己装的），没有删除任何东西。'
                : '没有找到本插件安装的向量服务文件。')
          } else if (which === 'reindex') {
            setPendingTick(0)
            setEmbedNotice(`已开始重建 ${value.records ?? 0} 条的向量；「待嵌入向量」会逐步下降，期间检索暂时只用词法。`)
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
      // 有"待嵌入"时自动刷新:编辑后向量重建需要一两秒,列表与统计不能一直停在旧状态,
      // 等用户切标签/重进面板才知道好了。(有上限,后端挂着时不会无限轮询。)
      React.useEffect(() => {
        if (pending === 0 || pendingTick >= PENDING_POLL_LIMIT) return undefined
        if (!configured || !vectorEnabled) return undefined
        const timer = setTimeout(() => {
          setPendingTick((n) => n + 1)
          load()
        }, 1500)
        return () => clearTimeout(timer)
      }, [pendingTick, pending])
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
      // 重建向量只在"配置了后端且启用"时有意义(maintenanceCard 在 configured 声明之前构建)。
      const canReindex = Boolean(embedServer && embedServer.enabled && (embedServer.configured === undefined ? Boolean(embedServer.baseUrl) : embedServer.configured))
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
            h('span', { className: 'grow' }, `向量索引：${maintenance.records} 条`),
            canReindex
              ? (maintenance.records > 0
                ? (dangerAsk === 'reindex'
                  ? [h('button', { key: 'ok', className: 'danger', disabled: embedBusy, onClick: () => maintenanceAction('reindex') }, `确认重建 ${maintenance.records} 条的向量`),
                     h('button', { key: 'no', disabled: embedBusy, onClick: () => setDangerAsk('') }, '取消')]
                  : h('button', { key: 'ask', disabled: embedBusy, onClick: () => maintenanceAction('reindex') }, '重建全部向量'))
                : h('span', { className: 'muted' }, '无'))
              : h('span', { className: 'muted' }, '向量未启用'),
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
            onCreated: () => { setCreating(false); setPendingTick(0); load('', '') },
          })
        : null
      const listBody = !loading && !error && records.length === 0
        ? h('div', { className: 'empty' }, filtering ? '没有匹配的记忆' : '还没有记忆')
        : h('div', { className: 'list' },
            records.map((rec) => h(RecordCard, { key: rec.id, rec, vectorOn: configured && vectorEnabled, labels: labels, onSaved: () => { setPendingTick(0); load() }, onDeleted: () => { setPendingTick(0); load() } })))

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
      // 记忆树是自己的过滤维度(客户端即时筛选),进来时先拉一份不带服务端筛选的全量记录,
      // 否则从「记录」页带着搜索词切过来会只剩一部分树。
      const treeBody = h(MemoryTreeTab, {
        records,
        scopes,
        loading,
        error,
        onRefresh: () => { setPendingTick(0); load('', '') },
      })

      return h('div', { className: 'memp' },
        h('div', { className: 'tabs' },
          h('button', { className: 'tab' + (tab === 'records' ? ' on' : ''), onClick: () => setTab('records') }, '服务'),
          h('button', { className: 'tab' + (tab === 'data' ? ' on' : ''), onClick: () => { if (tab !== 'data') load(); setTab('data') } }, '记录'),
          h('button', {
            className: 'tab' + (tab === 'tree' ? ' on' : ''),
            onClick: () => { if (tab !== 'tree') load('', ''); setTab('tree') },
          }, '记忆树'),
          h('button', { className: 'tab' + (tab === 'settings' ? ' on' : ''), onClick: () => setTab('settings') }, '设置'),
        ),
        tab === 'settings'
          ? h(SettingsTab, {})
          : tab === 'data'
            ? dataBody
            : tab === 'tree'
              ? treeBody
              : overviewBody,
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

    /**
     * 侧栏入口图标:年轮线稿(16 网格、1.3 描边、currentColor),按 size 缩放(默认 16)。
     *
     * 这里和插件列表的 **icon.svg** 是两个 surface,不能共用一套画法:
     *   - 插件管理器卡片/行:30/36px、深咖瓦片 + 香槟金年轮,是插件的品牌美术;
     *   - 左侧栏 / 设置侧栏:16px 单色线稿(宿主 Icon*OutlineMedium 同规范:
     *     16 网格、fill:none、stroke:currentColor、strokeWidth 1.3)。
     * 0.9.3 曾把彩色瓦片塞进侧栏,结果在那一列里是一块实心深色方块,和旁边的线稿
     * 图标格格不入;0.9.4 改回线稿,但记号仍是"年轮"(圆角瓦片轮廓 + 1.75 圈螺旋),
     * 不再是 0.9.1 以前的"内存芯片"。
     *
     * 螺旋用 7 段圆弧近似(不是几百个点的折线),16px 下是一条完整的线;颜色跟随
     * currentColor,深浅主题自动适配。
     */
    const NAV_ICON_NS = 'http://www.w3.org/2000/svg'
    const NAV_VIEW_BOX = '0 0 16 16'
    /** 年轮螺旋:16 网格、从中心 r1.3 长到 r4.4、1.75 圈。 */
    const NAV_RING = 'M7.35 6.87 A1.52 1.52 0 0 1 9.51 7.13 A1.96 1.96 0 0 1 9.09 9.89 A2.41 2.41 0 0 1 5.72 9.31 A2.85 2.85 0 0 1 6.46 5.34 A3.29 3.29 0 0 1 11.04 6.24 A3.74 3.74 0 0 1 9.98 11.43 A4.18 4.18 0 0 1 4.19 10.20'
    /** 圆角瓦片轮廓:与 icon.svg 的瓦片同形,只是描边而不是填色。 */
    const NAV_FRAME = { x: 1.65, y: 1.65, width: 12.7, height: 12.7, rx: 3.8 }

    function NavLineIcon({ size = 16 } = {}) {
      return h('svg', { width: size, height: size, viewBox: NAV_VIEW_BOX, fill: 'none', 'aria-hidden': 'true' },
        h('rect', { ...NAV_FRAME, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }),
        h('path', { d: NAV_RING, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' }),
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
                  () => React.createElement(NavLineIcon),
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
     * 设置侧栏「记忆」那一行的图标 —— 与侧栏入口、插件列表共用同一只年轮。
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
     * 记号。三条护栏让它不会把界面弄坏:
     *   1. 选择器只认 className 的**后缀**:宿主的类名是 CSS Modules 生成的
     *      `<hash>_navCell` / `<hash>_navIcon`(hash 随构建变),所以用
     *      `[class*="_navIcon"]` 匹配,hash 变了也照样命中;
     *   2. 只在**我们这一行**生效:wrapSettingsNav 给"文案等于 `NAV_LABEL`"的那个按钮加
     *      `dsh-memory-nav` 标记类,规则全部限定在它下面 —— 其它区块(账号/模型/插件市场)
     *      的图标一个都不碰。标记打在**按钮自己**身上而不是它所在的列表上:整列共用一个
     *      列表容器,标在容器上会波及所有区块。
     *   3. **不改布局、不插 DOM**:那颗 svg 还是宿主自己渲染的,我们只把它内部换成线稿,
     *      盒子尺寸/行高/对齐全由宿主保证。
     *
     * 记号必须和这一列**同一规范**:16 网格、`fill:none`、`stroke:currentColor`、1.3 描边。
     * 0.5.3/0.5.4 塞过蓝色瓦片,0.9.3 塞过深咖年轮瓦片 —— 在那个单色列里都是一块实心
     * 色块,和旁边的线稿不一致。0.9.4 起画成**年轮线稿**:圆角瓦片轮廓 + 1.75 圈螺旋,
     * 形状仍来自插件美术,但颜色只跟 currentColor,深浅主题自动适配。
     *
     * 实现:把宿主那颗 svg 的**子节点**换成线稿(viewBox 保持 16 网格)。三条被否掉的
     * 路,留给后来人:
     *   - `::before` 补一个(0.5.3):真机上盒子没成形 —— 齿轮没了、记号也没出现,空一格;
     *   - 给 svg 上背景图(0.5.4):能画出来,但只能画色块,画不出 1.3 描边的线稿;
     *   - `content: url(...)` 替换 svg 内容:SVG 元素不支持 content 替换,实测无效。
     * 换子节点这条路的失败模式是良性的:svg 由宿主渲染,我们只动它的孩子,尺寸/对齐/行高
     * 一定由宿主保证;万一类名约定变了,选中不到就没有任何改动,图标保持原样。
     * React 若重渲染把图形覆盖回去,observer 会在下一轮按子节点重新补上。
     */
    const NAV_DOM = [
      { tag: 'rect', attrs: { ...NAV_FRAME, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' } },
      { tag: 'path', attrs: { d: NAV_RING, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'data-dsh-memory-logo': '1' } },
    ]

    /** 递归建 SVG 节点(不用 innerHTML:避开宿主 CSP,也避免命名空间被字符串解析弄丢)。 */
    function svgNode({ tag, attrs, children }) {
      const node = document.createElementNS(NAV_ICON_NS, tag)
      for (const [name, value] of Object.entries(attrs ?? {})) node.setAttribute(name, String(value))
      for (const child of children ?? []) node.appendChild(svgNode(child))
      return node
    }

    /** 把一颗 nav 图标的图形换成年轮线稿;已经是线稿就跳过(observer 会反复调到这里)。 */
    function paintNavIcon(svg) {
      if (svg.querySelector('[data-dsh-memory-logo]') !== null) return
      svg.setAttribute('viewBox', NAV_VIEW_BOX)
      svg.replaceChildren(...NAV_DOM.map(svgNode))
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
            if (icon) paintNavIcon(icon)
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

    exports.__test = {
      RecordCard: RecordCard,
      MemoryPanel: MemoryPanel,
      MemoryTreeTab: MemoryTreeTab,
      buildMemoryTree: buildMemoryTree,
      KIND_META: KIND_META,
      CSS: CSS,
      shouldPollInstall: shouldPollInstall,
      // 图标一致性护栏:测试会核对两条渲染路径都是同一份 16px 单色线稿
      NavLineIcon: NavLineIcon,
      NAV_DOM: NAV_DOM,
      paintNavIcon: paintNavIcon,
    }
    return module.exports
  },
})
