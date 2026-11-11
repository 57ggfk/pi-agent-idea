# 018 composer 行内引用 chip + 图片缩略图卡 + 粘贴识别收紧 + 消息表格弱边框 + 模型组折叠 + 扩展包全部升级 + fork 标题后缀

> 来源:用户 2026-11-10 六件事——①编辑框富文本化(mention 式):文件/目录引用 chip 内联进编辑区文本流(像 Cursor/Slack 的 @-mention),不再放输入框上方独立行;图片升级为缩略图卡并可点击预览;②缺陷:粘贴 markdown 格式文本会被误识别成多个引用 chip;③消息区 Markdown 表格无边框(浏览器默认渲染),加弱颜色边框;④模型选择器支持按供应商折叠分组;⑤扩展包管理支持全部升级(单个删除/升级 001 已交付,本条只补缺口);⑥fork 出的会话标题结尾追加 "(fork)"。
> 版本归属:0.5.7。关联:spec 015(引用 chip 首版/拖拽三路)、016(IDE 侧 takeDrop)、010(FR-009 IME、autosize)、012 US7(ImagePreview 模态)。

## 调研结论(决定方案的关键事实)

1. **架构决策(用户已定,B 方案)**:编辑面保留 textarea,`@path` 文本 token 是唯一事实源;新增镜像覆盖层(mirror overlay)把文本里的 token 渲染成不透明 chip 盖住原文。contenteditable 真富文本因 CJK IME 风险 + composer e2e 全量重写被否;仅样式升级因不满足「编辑区域内显示」被否。
2. **误识别根因**:`Composer.tsx` `collectDroppedRefs` 的 text/plain 兜底逐行取首个空白分隔 token,`looksLikePath` 命中 `/`、`./`、`~/`、`../`、`C:\` 开头即成 chip;`onPaste` 走同一路径,粘贴含此类行的 markdown(`/usr/bin/env node`、`./gradlew build`)即误生成多个引用。
3. **发送链路自然简化**:消息 = textarea 原文(token 内联在用户所放位置,pi 自行展开 `@`),现有 `refs` 状态数组、`mergeRefs` 去重、首行 `@p1 @p2` 拼装全部删除;发送可用条件回归「文本非空或图片非空」。
4. 图片预览模态 `ImagePreview`(012 US7)已存在,由 transcript items 驱动;composer 需给它加「外部图片列表」入口。
5. 现有管线全部保留:autosize 与高度 cap(010)、IME composition(010 FR-009)、@/slash 补全菜单与键盘、拖拽三路(015/016,含 `files.takeDrop` 主通道)、`files.relpath`、pendingPrompt(ide 事件)。
6. 覆盖层技术要点:mirror 与 textarea 同字体/同内边距/同宽度/`white-space:pre-wrap`,高度跟随 autosize 结果,`textarea.scrollTop/Left` 同步;overlay `pointer-events:none`,仅 chip 上的删除按钮 `auto`;选中高亮被不透明 chip 遮住属可接受瑕疵。

## User Stories

### US1 引用 chip 内联进编辑区

输入框文本中符合 `@token` 形态(沿 `AT_QUERY_RE` 的边界规则:行首或非词字符后,`user@example.com` 不算)的路径 token,由覆盖层渲染成 chip(文件/文件夹图标 + 路径 + × 删除;× 点击删除整个 token 并保持光标)。chip 位置即 token 位置——打 `@` 补全、拖拽、IDE 注入、粘贴文件,统一改为**在光标处插入 `@path ` token**(IDE 注入无光标语义时追加到文本尾部)。

- 拖拽/IDE 注入不再进独立 `refs` 数组:`pendingPrompt.refs`(ide 事件 `kind:"refs"` 连续右键合并)改为追加 token;`kind:"prompt"` 带 `files` 同理。
- 发送:`doSend` 直接发 textarea 原文;删除 refs 首行拼装;空正文 + 仅有 token 也可发送(token 本身就是文本)。
- Backspace 光标紧贴 chip 右缘时整体删除 token(一次退格删整枚,不做逐字符吃掉)。
- 多个相同路径的 token 不去重(文本即事实源,重复引用无害)。
- chip 视觉:圆角胶囊、不透明底(盖住下方 token 原文)、与 IDE 主题色对齐的强调色描边;目录/文件图标区分沿 015。

### US2 图片缩略图卡 + 点击预览

图片仍不进文本流,保持独立条,但 chip 升级为缩略图卡:约 64px 圆角缩略图(本地 dataURL 直接渲染)+ 文件名(截断)+ × 移除;点击缩略图打开 `ImagePreview` 模态(模态加外部图片列表入口,composer 内多图可 ←/→ 切换;composer 图片不进 transcript 的 `collectImages`)。粘贴/拖入/回形针的图片入口与数据链路不变(仍 base64,仍走 `sendImages`)。

### US3 粘贴/拖拽识别收紧(缺陷修复)

- **粘贴纯文本永远不当引用**,除非剪贴板文本 payload 恰为**单行、不含空白、且 `looksLikePath` 命中**(覆盖「IDEA 项目树复制文件 → 粘贴」合法场景);多行 markdown 一律按纯文本插入光标,零 chip。
- 拖拽侧:`text/uri-list`(文件 flavor)保留逐行 `file://` 解析;text/plain 兜底改为同样的单行规则(整段 payload 单行、无空白、像路径才成引用);`webkitGetAsEntry`/`files.takeDrop` 通道不变。
- 粘贴/拖入文件项(剪贴板/拖拽携带真实 File 对象)仍走引用通道;图片仍优先走图片卡。

### US4 消息表格弱边框

消息区 Markdown 表格(`styles.css` 现状:零表格样式,浏览器默认无边框)加弱色边框,纯 CSS、随主题:

- 单元格 `1px solid var(--border)`,`border-collapse: collapse`(亮色 `#e4e7ec` / 暗色 `#393b40`,与气泡/卡片边框同一套弱色体系)。
- 表头行与主体的分隔线用 `var(--border-strong)`,不加底纹(用户只要边框)。
- 非目标:超宽表格的横向滚动/包裹容器(现网如遇溢出另列)、表格内斑马纹。

### US5 模型选择器按供应商折叠

011 US2 的供应商分组(组标题 + 计数、当前组置顶)之上,组标题可点击折叠/展开:

- 点击组标题整行切换折叠;chevron 指示方向,`aria-expanded` 同步;折叠后只留标题行(计数保留)。
- **索引事实源切换**:高亮/键盘/回车/打开定位一律基于「可见条目」的 flat 序列(DOM 顺序),折叠组的条目从索引中消失;折叠/展开时高亮夹取到最近的可见条目。`buildPickerData` 扩展 `collapsed` 输入而非在组件里拼装。
- **搜索时忽略折叠**:过滤关键词非空 → 全部组强制展开(否则「搜到了却看不见」)。
- **打开定位**:当前模型所在组若被折叠,打开时自动展开该组再定位(011 US1 的 locate 语义不变,目标是可见的)。
- **记忆**:折叠集合存 localStorage(读写失败降级为组件生命周期内记忆);不进 store、不进桥接。
- 200 条上限与 hidden 计数逻辑不变。

### US6 扩展包管理:全部升级 + 移除确认 + i18n 漏网

包管理面板(`PackagesPanel`)现状:每行已有「更新/移除」按钮(001 交付,`pi update <source>` / `pi remove <source>`)。本条补三处:

- **全部升级**:工具栏加「全部升级」按钮 → 新 RPC `manage.packageUpdateAll`(无参)→ Kotlin 侧 `pi update --extensions` 一条命令升全部(001 调研已实测该 flag 原生存在;`envUpdateArgs` 的 `update --self` 同模式)。结果沿 FR-007 逐字展示 CLI 输出,完成后 refresh。**降级方案**:真机取证若发现 `--extensions` 不覆盖某来源(git/http/本地路径),改为前端顺序循环逐个 `packageUpdate`(可用性优先,逐条 outcome 汇总)。桥接四处同步:types.ts / manage.ts / BridgeService.kt / bridge/mock.ts。
- **移除确认**:单个「移除」接 007 ConfirmDialog(现状误点即删);单个更新不加确认(非破坏性)。
- **i18n 漏网**:面板残留硬编码英文收进字典(en + zh_CN):`No packages installed.`、`The installed version may still be the old one.`、安装输入框 placeholder、更新结果横幅文案。
- busy 门控沿用单一 `busy` 状态:全部升级进行中,安装/刷新/逐行按钮一并禁用。

### US7 fork 会话标题后缀

fork(`runForkSession` / `runForkAtItem`)成功后,新会话标题(pi clone 沿用父标题)结尾追加后缀,列表里与父会话可区分:

- 后缀 i18n:en `(fork)` / zh_CN `(分支)`(键 `session.forkSuffix`);文案跟随**语言设置**(008 `languagePref`):显式选择的语言优先,仅当设置为 `system`(跟随 IDE)时才由 IDE locale 决定。实现上 `useT()` 解析出的生效语言天然满足,无需额外判断。
- 追加规则:取 `syncAfterBranch()` 同步回的 `sessionName`,**不以后缀结尾才追加**(fork 一条已是 fork 的会话不出现双重后缀);标题为空(父会话未命名)不追加,交给既有自动命名。
- 以 `renameSession(name, false)` 落盘:`sessionName` 非空后既有的两条自动命名路径(`maybeAutoTitle` / `maybeLlmTitle`)自然跳过,后缀不会被覆盖。
- 已知边界:若 pi 侧后续有自己的自动改名(session_info_changed),以 pi 为准,插件不再补写后缀。
- 「复制的会话」(完整拷贝)现无此功能;若后续新增「复制会话」动作,复用同一机制、后缀用 `(copy)` / `(副本)`(另立需求时再排)。

## 非目标

- contenteditable / markdown 富文本语法(加粗、标题、列表)——mention 式 chip 即本次「富文本」的全部。
- 「添加文件引用」文件选择器入口(用户已定不做;回形针维持只收图片)。
- token 对应路径的存在性校验/标红(沿 015 口径「只给路径,agent 自己探索」)。
- 重复 token 去重、含空格路径的 `@` 转义(沿 015 non-goal)。
- 选中高亮穿透 chip 的渲染优化(可接受瑕疵,记录在案)。

## e2e 与回归面

- `composer-refs.spec.ts` 的 ref-chips 行断言改写为行内 token-chip 断言(位置、删除、发送报文)。
- `model-picker.spec.ts` 默认全展开零回归;新增折叠用例(折叠后键盘跳过、搜索强制展开、打开自动展开当前组、localStorage 记忆)。
- `manage.spec.ts` 新增:全部升级按钮调用 `packageUpdateAll` 并刷新(mock);移除需确认框拦截、确认后才调用;面板无裸英文断言。Kotlin 单测:`packageUpdateAllArgs == listOf("update", "--extensions")`(沿 `envUpdateArgs` 测试模式)。
- 其余 composer 相关套件(composer 输入、autosize 几何、IME、ui-polish)textarea 不变,预期零回归;镜像覆盖层不参与测量(autosize 仍只读 textarea)。
- 报文契约:`{type:"prompt", message}` 不变,message 内容从「首行 refs + 正文」变为「原样文本」——对 pi 无协议变化(015 已证 `@` 不展开、原样进 user message)。
