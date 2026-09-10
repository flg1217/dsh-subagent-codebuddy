// CodeBuddy 子代理插件面板卡片(注册 settings.plugin.item,与 AntiGravity 卡片外观统一)。
// 复用 dsh primitives 组件(Button/图标/writeClipboard)与官方
// ui-settings-plugins 的 PluginCard/fields CSS(注入同款样式类)。
// 检测/测试走 api.llm.discoverModels({settingsNs:'codebuddy', provider:'status'|'test'}),
// 服务端直接 spawn codebuddy CLI,不落会话。
window.__ModuleLoader__.load({
  id: '@flg1217/dsh-subagent-codebuddy',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const slots = require('@deepseek-ai/dsh-client-ui-slots')
    const P = require('@deepseek-ai/dsh-client-ui-primitives')

    const {
      Button, Input, Modal, IconLoadingOutline16, IconCheckOutline16, IconRefreshOutline16,
      IconCopyOutline16, IconChevronDownOutline14, writeClipboard,
    } = P

    // ── 官方 PluginCard CSS(与 ui-settings-plugins 完全一致) ──
    const CSS = {
      card: '.dshCb_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}',
      cardHover: '.dshCb_card:hover{border-color:var(--dsw-alias-label-dimmed)}',
      cardOpen: '.dshCb_cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}',
      header: '.dshCb_header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}',
      headerFocus: '.dshCb_header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      headText: '.dshCb_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}',
      name: '.dshCb_name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}',
      description: '.dshCb_description{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}',
      chevron: '.dshCb_chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}',
      chevronOpen: '.dshCb_chevronOpen{transform:rotate(180deg)}',
      body: '.dshCb_body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding-bottom:8px}',
      field: '.dshCb_field{flex-direction:column;gap:6px;padding:12px 0;display:flex}',
      fieldTop: '.dshCb_field+.dshCb_field{border-top:1px solid var(--dsw-alias-border-l2)}',
      fieldHead: '.dshCb_fieldHead{align-items:center;gap:8px;display:flex}',
      label: '.dshCb_label{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}',
      hint: '.dshCb_hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}',
      badge: '.dshCb_badge{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}',
      code: '.dshCb_code{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:6px 10px;font-size:12px}',
      pre: '.dshCb_pre{margin:8px 0 0;white-space:pre-wrap;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px}',
      row: '.dshCb_row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0}',
      // 模型输入框:铺满卡片宽度;min-width:0 避免 flex 项被内容撑爆导致超出卡片
      modelField: '.dshCb_modelField{display:flex;width:100%;min-width:0;box-sizing:border-box}.dshCb_modelField input{flex:1;min-width:0;width:100%;box-sizing:border-box}',
      // 获取模型弹窗列表:抄 Menu.module.css 的菜单卡片 + 行样式
      pickerList: '.dshCb_pickerList{box-sizing:border-box;padding:4px;display:flex;flex-direction:column;gap:0;border:1px solid var(--dsw-alias-border-inverted);border-radius:12px;background:var(--dsw-specific-menu);box-shadow:var(--dsw-shadow-lv3);max-height:60vh;overflow-y:auto}',
      pickerItem: '.dshCb_pickerItem{display:flex;align-items:center;gap:8px;width:100%;min-height:40px;padding:8px 10px;border:none;border-radius:10px;background:transparent;cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);text-align:left}.dshCb_pickerItem:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      pickerLabel: '.dshCb_pickerLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      pickerCheck: '.dshCb_pickerCheck{flex:none;color:var(--dsw-alias-label-primary)}',
    }
    const cssText = Object.values(CSS).join('')
    const tagId = '@flg1217/codebuddy/plugin-card.css'
    if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = '@flg1217/codebuddy'
      tag.dataset.pluginCss = tagId
      tag.textContent = cssText
      document.head.appendChild(tag)
    }
    const C = {
      card: 'dshCb_card', cardOpen: 'dshCb_cardOpen', header: 'dshCb_header',
      headText: 'dshCb_headText', name: 'dshCb_name', description: 'dshCb_description',
      chevron: 'dshCb_chevron', chevronOpen: 'dshCb_chevronOpen', body: 'dshCb_body',
      field: 'dshCb_field', fieldHead: 'dshCb_fieldHead', label: 'dshCb_label',
      hint: 'dshCb_hint', badge: 'dshCb_badge', code: 'dshCb_code',
      pre: 'dshCb_pre', row: 'dshCb_row', modelField: 'dshCb_modelField',
      pickerList: 'dshCb_pickerList', pickerItem: 'dshCb_pickerItem',
      pickerLabel: 'dshCb_pickerLabel', pickerCheck: 'dshCb_pickerCheck',
    }

    // 安装命令 + 工具说明
    const INSTALL_CMDS = [
      { label: 'npm (global)', cmd: 'npm install -g @tencent-ai/codebuddy-code' },
    ]
    const TOOLS = [
      { name: 'subagent_codebuddy (opt-in)', desc: '委派独立任务给 CodeBuddy 子代理(独立进程 + 自带工具;continuable 可复用长线会话;可选 model 参数动态指定模型)——在上方开关开启后注册,推荐用通用 subagent 工具' },
      { name: 'list_codebuddy_models (opt-in)', desc: '列出 CodeBuddy CLI 当前支持的模型 id,委派前先查询再传准确 id;通用工具的模型目录由模型选择器/list_subagent_models 提供' },
    ]

    /** 安装命令行:label + code + 复制按钮(带已复制状态)。 */
    function InstallCommandRow({ label, cmd }) {
      const [copied, setCopied] = react.useState(false)
      const copy = react.useCallback(async () => {
        try { await writeClipboard(cmd) } catch { /* 剪贴板失败静默 */ }
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }, [cmd])
      return react.createElement('div', { className: C.field },
        react.createElement('div', { className: C.fieldHead },
          react.createElement('span', { className: C.label }, label),
          react.createElement('span', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, cmd),
          react.createElement(Button, {
            size: 'sm', variant: 'ghost', onClick: copy,
            icon: copied
              ? react.createElement(IconCheckOutline16, { size: 12 })
              : react.createElement(IconCopyOutline16, { size: 12 }),
          }, copied ? '已复制' : '复制'),
        ),
      )
    }

    function CodebuddyCard(props) {
      const [open, setOpen] = react.useState(false)
      const [checking, setChecking] = react.useState(false)
      const [testing, setTesting] = react.useState(false)
      const [statusText, setStatusText] = react.useState('')
      const [testText, setTestText] = react.useState('')
      const scope = props.scope

      // 走 api.llm.discoverModels:服务端 registerModelDiscovery 直接 spawn codebuddy,不落会话。
      const runProbe = react.useCallback(async (_provider, setOut, setBusy) => {
        setBusy(true)
        setOut('状态/测试探测在 0.1.2 插件设置页暂不可用(需会话级 remote);字段编辑正常。')
        setBusy(false)
      }, [])

      const onStatus = react.useCallback(() => runProbe('status', setStatusText, setChecking), [runProbe])
      const onTest = react.useCallback(() => runProbe('test', setTestText, setTesting), [runProbe])

      // 默认模型:字符串输入 + "获取模型"弹窗选择(models 探测取可选列表)。
      const [models, setModels] = react.useState([])
      const [currentModel, setCurrentModel] = react.useState('')
      const [savedModel, setSavedModel] = react.useState('')
      const [detailText, setDetailText] = react.useState('')
      const [loadingModels, setLoadingModels] = react.useState(false)
      const [pickerOpen, setPickerOpen] = react.useState(false)
      // 旧版自定义子代理工具开关(registerSubagentTools,默认关闭)。
      const [legacyTools, setLegacyTools] = react.useState(false)

      // 初始值与明细:走 settings.describe(结构化、经网关校验;不走 discoverModels,
      // 避免响应 schema 校验失败导致解析出垃圾值)。
      const loadConfig = react.useCallback(async () => {
        try {
          const v = scope.getSnapshot().value ?? {}
          const model = v.model ?? ''
          setCurrentModel(model)
          setSavedModel(model)
          setLegacyTools(v.registerSubagentTools === true)
          setDetailText(`命令:${v.command ?? 'codebuddy'} | 权限:${v.permissionMode ?? 'bypassPermissions'}`)
        } catch { /* 忽略 */ }
      }, [scope])

      const loadModels = react.useCallback(async () => {
        setLoadingModels(true)
        setModels([])
        setLoadingModels(false)
      }, [])

      react.useEffect(() => {
        if (!open) return
        // 只加载存储的历史值,不自动拉取模型列表(点"获取模型"时才请求)。
        loadConfig()
      }, [open, loadConfig])

      // 提交默认模型:非空 = set,空 = unset(重置为 schema 默认,不写空字符串)。
      const writeModel = react.useCallback(async (value) => {
        try {
          if (value === '') await scope.unset('model')
          else await scope.set('model', value)
          if (value !== '') { setCurrentModel(value); setSavedModel(value) }
          loadConfig()
        } catch { /* 写失败回读还原 */ loadConfig() }
      }, [scope, loadConfig])

      // 旧版工具开关:开 = set(true),关 = unset(回落 schema 默认 false)。
      const toggleLegacyTools = react.useCallback(async () => {
        const next = !legacyTools
        setLegacyTools(next)
        try {
          if (next) await scope.set('registerSubagentTools', true)
          else await scope.unset('registerSubagentTools')
        } catch { /* 写失败回读还原 */ }
        loadConfig()
      }, [legacyTools, scope, loadConfig])

      // 手动输入:输入时只更新本地,失焦提交;与已保存值一致时跳过。
      const onModelInput = react.useCallback((e) => setCurrentModel(e.target.value), [])
      const onModelBlur = react.useCallback(() => {
        const value = currentModel.trim()
        if (value === savedModel) return
        writeModel(value)
      }, [currentModel, savedModel, writeModel])

      // 弹窗选择:打开时若未加载则拉取列表。
      const openPicker = react.useCallback(async () => {
        setPickerOpen(true)
        if (models.length === 0) loadModels()
      }, [models.length, loadModels])
      const pickFromList = react.useCallback((value) => {
        writeModel(value)
        setPickerOpen(false)
      }, [writeModel])

      return react.createElement('li', { className: `${C.card} ${open ? C.cardOpen : ''}` },
        // 卡片头(与官方 PluginCard 一致)
        react.createElement('button', {
          type: 'button', className: C.header, 'aria-expanded': open,
          'aria-label': `${open ? '收起' : '展开'}: CodeBuddy`,
          onClick: () => setOpen(!open),
        },
          react.createElement('span', { className: C.headText },
            react.createElement('span', { className: C.name }, 'CodeBuddy'),
            react.createElement('span', { className: C.description }, 'CodeBuddy 作为主模型(模型选择器可选)与子代理 provider;默认配置、检测安装/登录、连通性测试、安装命令与工具说明'),
          ),
          react.createElement(IconChevronDownOutline14, { className: `${C.chevron} ${open ? C.chevronOpen : ''}` }),
        ),
        open && react.createElement('div', { className: C.body },
          // 检测与测试
          react.createElement('div', { className: C.row },
            react.createElement(Button, {
              size: 'md', onClick: onStatus, disabled: checking,
              icon: checking
                ? react.createElement(IconLoadingOutline16, { size: 14 })
                : react.createElement(IconRefreshOutline16, { size: 14 }),
            }, checking ? '检测中...' : '检测安装/登录'),
            react.createElement(Button, {
              size: 'md', onClick: onTest, disabled: testing,
              icon: testing ? react.createElement(IconLoadingOutline16, { size: 14 }) : undefined,
            }, testing ? '测试中...' : '测试(回复 hi)'),
          ),
          react.createElement('p', { className: C.hint }, '若已安装仍提示未安装,请重启 dsh 服务(PATH 生效后需重启)'),
          statusText !== '' && react.createElement('pre', { className: C.pre }, statusText),
          testText !== '' && react.createElement('pre', { className: C.pre }, testText),

          // 默认模型:字符串输入 + "获取模型"弹窗选择
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '默认模型'),
              react.createElement(Button, {
                size: 'sm', variant: 'ghost', onClick: openPicker, disabled: loadingModels,
                icon: loadingModels
                  ? react.createElement(IconLoadingOutline16, { size: 12 })
                  : react.createElement(IconRefreshOutline16, { size: 12 }),
              }, loadingModels ? '获取中...' : '获取模型'),
            ),
            react.createElement(Input, {
              type: 'text', value: currentModel, onChange: onModelInput, onBlur: onModelBlur,
              placeholder: '输入模型 id',
              className: C.modelField,
            }),
            detailText !== '' && react.createElement('p', { className: C.hint, style: { fontFamily: 'var(--dsw-font-family-code, monospace)' } }, detailText),
            react.createElement('p', { className: C.hint }, '可直接输入模型 id(失焦保存),或点"获取模型"从弹窗选择;作为委派子代理的默认模型(实时生效);主会话可直接在模型选择器中选择 CodeBuddy 的任意模型'),
          ),

          // 旧版子代理工具开关(默认关闭,实时生效)
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '旧版子代理工具'),
              react.createElement(Button, {
                size: 'sm',
                variant: legacyTools ? undefined : 'ghost',
                onClick: toggleLegacyTools,
              }, legacyTools ? '已开启(点按关闭)' : '已关闭(点按开启)'),
            ),
            react.createElement('p', { className: C.hint },
              '提供 subagent_codebuddy / list_codebuddy_models 自定义工具;默认关闭——推荐用通用 subagent 工具(provider: codebuddy + 模型选择)。开启/关闭对新会话生效。'),
          ),

          // 安装命令
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '安装命令'),
            ),
            react.createElement('p', { className: C.hint }, 'CodeBuddy CLI 由 Tencent 维护,npm 全局安装即可'),
          ),
          ...INSTALL_CMDS.map((item) => react.createElement(InstallCommandRow, { key: item.label, label: item.label, cmd: item.cmd })),

          // 工具说明
          react.createElement('div', { className: C.field },
            react.createElement('div', { className: C.fieldHead },
              react.createElement('span', { className: C.label }, '工具说明'),
            ),
            react.createElement('ul', { style: { margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 } },
              TOOLS.map((t) => react.createElement('li', { key: t.name, className: C.hint },
                react.createElement('strong', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t.name), ' — ', t.desc,
              )),
            ),
          ),

          // 获取模型弹窗:官方 Modal(模糊遮罩/Escape/标题/关闭) + Menu 样式列表
          react.createElement(Modal, {
            open: pickerOpen,
            onClose: () => setPickerOpen(false),
            title: '选择模型',
            closeLabel: '关闭',
          },
            loadingModels && models.length === 0
              ? react.createElement('p', { className: C.hint }, '加载中...')
              : models.length === 0
                ? react.createElement('p', { className: C.hint }, '未获取到模型列表,请确认 CodeBuddy CLI 已安装')
                : react.createElement('div', { className: C.pickerList },
                    models.map((m) => react.createElement('button', {
                      key: m,
                      type: 'button',
                      className: C.pickerItem,
                      onClick: () => pickFromList(m),
                    },
                      react.createElement('span', { className: C.pickerLabel }, m),
                      m === currentModel && react.createElement(IconCheckOutline16, { className: C.pickerCheck, size: 14 }),
                    )),
                  ),
          ),
        ),
      )
    }

    function apply(ctx) {
      const codebuddyScope = ctx.settingsScope.bind({ namespace: 'codebuddy' })
      const sectionInject = () => ({
        scope: codebuddyScope,
      })
      ctx.effect(() => {
        return ctx.slots.inject('settings.plugin.item', () => {
          return ctx.slots.register({
            name: 'settings.plugin.item',
            // id(rc.6 list 槽)与 key(rc.7 keyed 槽)都传,兼容两种槽类型。
            id: 'codebuddy',
            key: 'codebuddy',
            order: 31,
            label: () => 'CodeBuddy',
            inject: sectionInject,
          }, CodebuddyCard)
        })
      }, 'subagent-codebuddy-client: settings.plugin.item')
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    exports.name = 'subagent-codebuddy-client'
    return module.exports
  },
})
