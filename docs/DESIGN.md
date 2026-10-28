# 「笔记同步助手」EdgeEver 插件设计

> 目标宿主：EdgeEver v2.12.0（Web 版为主，桌面端复用同一套代码）。
> 标记约定：`[实测]` = 2026-10-28 在宿主源码/真实接口上验证过；`[决策]` = 本插件自己的取舍；`[后续]` = 当前不做、留了位置。

## 1. 核心决策

- `[决策]` 插件源码放在仓库的 `plugin/` 目录，稳定 ID `com.bijitongbu.note-sync-helper`，显示名「笔记同步助手」，`apiVersion: "2"`，`platforms: ["web", "desktop"]`。
- `[实测]` 宿主以 `import(blobURL)` 加载单文件 bundle，`manifest.entry` 固定 `./main.js`；GitHub 分发要求仓库根 `manifest.json` 且 Release 资产里同时有 `manifest.json` + `main.js`（`apps/web/src/lib/plugins/github-plugin-distribution.ts` 的 `assertBundledEntry` 与 `assertReleaseManifest`）。因此仓库根 `manifest.json` 是唯一真源，构建时复制到 `plugin/dist/`。
- `[实测]` 设置项键名只接受 `^[a-z][a-z0-9._-]*$`（`packages/plugin-api/src/index.ts` 的 `SETTING_KEY_PATTERN`），camelCase 会被宿主在安装时直接拒绝 —— 因此所有设置键都用 kebab-case（`api-key`、`folder-template`…）。
- `[决策]` 首版范围：只读拉取、分页、增量游标、远端 ID 去重、多级笔记本、标题/正文/属性模板、图片本地化接力、手动命令 + 桌面端定时 + 启动同步。不做云端删除、消息合并、日记反链、Templater 接力。
- `[实测]` 笔记是数据库行：没有文件路径/文件名的概念。「文章文件夹」= 笔记本路径模板，「文章文件名」= 笔记标题模板（沿用其它宿主版本的用户措辞）。
- `[实测]` `notes.create` 没有 externalId 幂等；去重必须自建（见 §4.3）。
- `[实测]` 笔记标题上限 160 字符（`apps/api/src/memo-service.ts:1046`），超长直接 400。
- `[实测]` 图片资源 URL 形如 `/api/v1/resources/<id>/blob`（`apps/api/src/resource-service.ts:76`），可直接放进 Markdown，宿主自己会解析。
- `[实测]` `network.fetch(..., {transport:"public"})` 只允许无凭据 GET/HEAD、仅 443、响应 ≤ 2 MB（`public-network-adapter.ts`）；必须当作图片兜底而不是主路径。
- `[实测]` `schedules.*` 在 Web 宿主直接抛 "only available in the EdgeEver desktop app"；必须吞掉并按手动同步工作。
- `[实测]` `networkHosts` 允许 `*.example.com` 通配（`parseExtensionManifest`），只是披露用途、不做运行时拦截。
- `[实测]` **宿主是 local-first**：`notebooks.create` / `notes.create` 只写本地镜像并排队，返回的是 `local_<uuid>`
  （桌面端 `nb_local_*` / `memo_local_*`）这种只属于本设备的 id。队列冲刷后宿主只给**笔记**换 id
  （`lib/local-mirror.ts:375 replaceLocalMemoId`）并广播 `edgeever:memo-id-remapped`（detail `Map<local,remote>`）；
  笔记本换 id 只广播 `edgeever:notebook-id-remapped`（detail `{temporaryId, remoteId}`，
  `hooks/useWorkspaceQueuedSync.ts:170-173`），**不会**回头改写队列里其它条目 payload 的
  `parentId` / `notebookId`。因此临时 id 一旦被用作父级或上传目标，服务端永远 404。详见 §4.9。

## 2. 验收边界

| 能力 | 验收标准 | 依据 |
|---|---|---|
| 只读拉取 | POST 4 个候选入口的 `/api/graphql`，只执行 Search 查询 | `[实测]` 21 篇文章、8 次请求拉完 |
| 分页 | `after` 从 0 开始，按**实际返回条数**递增 | `[实测]` 服务端可能少返 |
| 增量 | 初次全量；之后 `updated:<cursor>`；整轮成功才提交 | `[实测]` 过滤是闭区间，边界文章会再取一次 |
| 去重 | 同一远端 ID 永远只对应一条笔记；索引丢失也不重复 | 属性块锚点 + 本地索引双保险 |
| 目录 | 逐级按 (父, 名称) 查找/创建 | `[实测]` `notebooks.list/create` |
| 临时 id | 每一级笔记本、每条新笔记都等到云端 id 才继续；超时算本篇失败（不提交游标） | `[实测]` 宿主 local-first 队列，见 §4.9 |
| 标题 | 模板渲染 → 去控制字符 → 截断 160 | `[实测]` 服务端上限 |
| 内容 | Mustache 渲染后是合法 Markdown | `[实测]` 真实文章渲染 |
| 属性 | 渲染结果 + 固定锚点组成 YAML 头 | `[实测]` 宿主属性面板识别 `edgeever-frontmatter` |
| 图片 | direct → 镜像 → public 中继 → 保留远程 | `[实测]` 图床不回 CORS |
| 更新保护 | 用户改过的笔记不覆盖 | hash 比对 |
| 完成信号 | 每轮 `ui.showNotice` 以「同步完成」/「同步失败」开头，并写 `lastRun` | E2E 断言 |

## 3. 其它宿主版本 → EdgeEver 映射

| 已有能力 | EdgeEver 实现 | 说明 |
|---|---|---|
| 密钥 | 设置项 `api-key`（secret），请求头 `x-api-key` | 宿主加密保存，仅本设备 |
| 四候选入口 | `api/endpoints.ts`，缓存上次成功的入口 | 只认官方 4 个域名，缓存值不合法就忽略 |
| 增量游标 | `storage["sync.cursor"]` | 不加 1 秒（见 §4.4） |
| 去重锚点 | 笔记属性区 `notehelper-id` + 本地索引 | Obsidian 是正文 HTML 注释，这里用属性区：不进摘要、可折叠 |
| 目录/文件名 | 笔记本路径 / 笔记标题 | 数据库模型 |
| 前置元数据 | YAML front matter（宿主原生支持） | 不再映射到宿主字段，直接写属性区 |
| 图片本地化 | 下载字节 → `resources.upload` → 正文替换 | `![alt](url)` 与宿主一致 |
| 正文模板 | Mustache，变量表对齐 joplin/zotero 版 | 老模板可直接迁移 |
| 定时同步 | `schedules.upsert`（桌面端）、`setTimeout` 启动同步 | Web 端优雅降级 |
| 合并消息 / 日记 / Templater | 不做 | `[后续]` |

## 4. 数据模型与不变量

### 4.1 笔记本路径

- `[决策]` 模板渲染后按 `/` 拆段；每段去掉控制字符、把残留 `/` 与 `\` 变全角 `／`、trim、截断 160。
- `[决策]` 空段、`.`、`..` 丢弃；整条路径为空时回退到 `笔记同步助手`。
- `[决策]` 每轮 `notebooks.list()` 一次并缓存，按 `(parentId, name)` 精确匹配；不存在就 `notebooks.create`。
- `[实测]` 宿主允许不同父级下有同名笔记本，所以必须带 parent 一起比较。
- `[决策]` 匹配时云端 id 优先：remap 之后本地镜像里可能短暂同时存在临时节点和云端节点，取非 `local_` 的那个。

### 4.2 标题

- `[决策]` 标题模板与文件夹模板共用 `folder-date-format`（合同里没有单独的文件名日期格式）。
- `[决策]` 渲染结果去掉控制字符与 `/\:*?"<>|`、合并空白、按字符（非 UTF-16 码元）截断到 160；为空时 `无标题-<远端 id 前 8 位>`。

### 4.3 远端身份与去重

两层：

1. **笔记内锚点（权威）**：属性区固定一行 `notehelper-id: "<远端 id>"`。它跟着笔记走，跨设备、跨重装都在。
2. **本地索引（快路径）**：`storage["sync.index"] = { [远端 id]: { noteId, writtenHash, renderedHash, remoteUpdatedAt } }`，按设备保存。

规则：

- 有索引 → 直接按 `noteId` 处理。
- 无索引 → 本轮扫描一次工作区（`notes.queryContent` 每页 200，最多 15 页 = 3000 条），从属性区读锚点重建映射；找不到才新建。
- 索引指向的笔记被删除（404）→ 丢掉索引，按新笔记重建。
- `[决策]` 索引里若留着临时 id（上一轮等到超时），下一次处理这篇时先解析：`notes.get(临时 id)` 会由宿主映射到云端
  id；映射不到就退回锚点扫描。解析完仍拿不到云端 id 就照常写这篇，但本轮结束的自检会把它算作未完成。
- `[后续]` 超过 3000 条的库，扫描只覆盖最近更新的部分；索引存在时不受影响。

### 4.4 游标

- `[决策]` 整轮成功（没有任何一篇失败）后才把游标推进到本轮 `max(updatedAt)`。
- `[实测]` 远端时间戳带毫秒且过滤是闭区间：**不加 1 秒**，边界文章下一轮会再取一次，由去重判成「未变化」。加 1 秒会永久跳过 (max, max+1s) 之间的文章。
- `[决策]` 有失败就不提交游标，宁可下一轮重复拉取。
- `[决策]` 分页 `after += 实际返回条数`（服务端可能少返，按固定 pageSize 递增会漏文章）。

### 4.5 用户编辑保护

三个 hash：

- `renderedHash` = hash(标题 + 文件夹 + 渲染后的 Markdown)：检测「模板改了」。
- `writtenHash` = hash(实际写进笔记的 Markdown，图片替换之后)：检测「用户改过」。
- 当前笔记的 `contentHash`（宿主提供）与 `writtenHash` 比较。

判定顺序（`sync/dedupe.ts` 的 `planSync`）：

1. 没有索引条目 → 新建。
2. `remoteUpdatedAt` 与 `renderedHash` 都没变 → 跳过（不读笔记）。
3. 笔记内容 ≠ `writtenHash` → **冲突**：只记录新的 `remoteUpdatedAt`，正文/标题/位置一律不动。
   `writtenHash` 为空（索引丢失后靠锚点重建的条目）同样按冲突处理 —— 无法证明笔记是我们写的，就不覆盖。
4. 否则更新。

`[决策]` 冲突时不重试、不提示刷屏：用户拥有这条笔记。若用户把内容改回插件写过的版本，hash 重新吻合，后续同步恢复。

### 4.6 属性块

- `[决策]` 最终 Markdown = `---\n<属性模板渲染结果>\nnotehelper-id: "<id>"\n---\n\n<正文>`。
- `[决策]` 模板渲染结果里若自带 `notehelper-id` 行会被剔除后再追加，保证幂等。
- `[决策]` 模板为空时仍然写出只有锚点的属性块 —— 去重依赖它。
- `[实测]` 属性区不参与摘要与字数统计；宿主把它渲染成可折叠的「笔记属性」面板。
- `[决策]` 属性里的 `tags`（数组或逗号分隔）同时作为笔记标签写入：新建时写入，更新时与现有标签取并集（不删用户的标签）。

### 4.7 图片本地化

顺序（创建时）：建笔记（远程链接）→ 逐张下载 → `resources.upload(noteId, File)` → 用返回的 `url` 重写正文 → `notes.update`。必须先有 noteId 才能上传，所以新笔记会有第二次写。

线路：

1. direct 请求原地址（浏览器 fetch）。
2. direct 请求镜像地址（`relay-1/2/4` ↔ `pic.clipfx.app` / `media.clipfx.app` / `media30d.clipfx.app`）。
3. `transport: "public"` 中继（≤2 MB）。
4. 都失败 → 保留远程链接。

有界收敛：

- 单篇单轮最多 24 张，单张最多 6 次尝试（direct 4 次 + public 2 次，public 名额不会被镜像列表挤掉）、总预算 25 秒。
- 失败分三类：`permanent`（4xx / 不是图片）、`too_large`、`transient`（网络 / 超时 / 不完整）。
- `permanent` / `too_large` 不再重试；`transient` 每次同步最多重试 3 轮，跨轮记录在 `storage["images.pending"]`。
- 续传只对「笔记内容仍等于 `writtenHash`」的笔记执行；用户改过就放弃这条笔记的图片重试。
- 图片映射按笔记保存（`storage["images.map"]`），远端文章更新时老图片不会重复上传。

完整性：按文件头判断 PNG/JPEG/GIF/WebP/BMP/SVG，并校验结束标记；HTML 错误页与半截图不会被当成图片存进去。

### 4.8 插件存储键

| key | 内容 | 说明 |
|---|---|---|
| `lastRun` | `{startedAt, finishedAt, ok, created, updated, skipped, imagesLocal, imagesRemote, error?}` | 合同要求的完成信号 |
| `sync.cursor` | ISO 时间 | 增量游标 |
| `sync.index` | `{[远端 id]: {noteId, writtenHash, renderedHash, remoteUpdatedAt}}` | 去重快路径 |
| `sync.endpoint` | 上次成功的入口 | 下次优先尝试 |
| `images.map` | `{[noteId]: {[远程图片]: 本地地址}}` | 避免重复上传 |
| `images.pending` | `{[noteId]: {failures: {[url]: {kind, attempts}}}}` | 失败重试预算（旧版本多出的 `attempts` 字段会被忽略） |
| `sync.devEndpoint` | `http://127.0.0.1:<port>` / `http://localhost:<port>` | **开发用**，不暴露在设置界面；只接受带端口的 loopback 明文地址，插到候选最前，且永不写回 `sync.endpoint`（见 §4.10） |

### 4.9 临时 id（local-first 宿主）

宿主新建笔记本 / 笔记时先写本地镜像、再把请求排进队列，返回的 id 只在本设备有效（Web `local_*`，
桌面 `nb_local_*` / `memo_local_*`）。队列冲刷后宿主给笔记换 id，但**不会**改写队列里其它条目里引用它的
`parentId` / `notebookId`，所以临时 id 一旦被当作父级或上传目标，服务端会一直 404。

`[决策]` 每次拿到临时 id 都等它变成云端 id 再继续：

- **笔记本**：`NotebookResolver.ensure()` 每建一级就等。兜底靠 `notebooks.list()` 轮询，按 `(parentId, name)`
  找到非临时节点；同时监听 `window` 上的 `edgeever:notebook-id-remapped` 加速（宿主同窗口；没有 `window` 时跳过）。
- **笔记**：`notes.create()` 之后等云端 id 才 `resources.upload` / `notes.update`。轮询走 `notes.get(临时 id)`
  ——宿主自己会把临时 id 映射到云端笔记 —— 再听 `edgeever:memo-id-remapped`（detail 是 `Map<local, remote>`）。
- 上限 30 秒；超时抛 `TemporaryIdTimeoutError`，**本篇算失败**，游标不提交（绝不静默成功）。
- 一轮里第一次等待超时就认定队列卡住，后续文章立即失败，不再各等 30 秒。
- 结束前自检：本轮写过（新建/更新）的笔记若仍指向临时 id，从计数里剔除并按「未完成」上报。
- 索引里的临时 id 下一轮按 §4.3 的规则自愈。

### 4.10 开发入口 `sync.devEndpoint`

`[决策]` 纯开发用、用户界面不暴露：storage 里放 `http://127.0.0.1:<port>` 或 `http://localhost:<port>`
（必带端口、无路径/查询/凭据）时，把它插到候选入口最前并跳过官方域名校验；其它值一律忽略。
它的成败**不写入** `sync.endpoint`，所以真实用户与正式入口不受影响。E2E 预置的 localStorage 值需按插件
存储的惯例 JSON 编码（`"http://127.0.0.1:19341"`）。mock 不可达时按传输错误照常回落到官方入口。

## 5. 目录结构

```
manifest.json              # 真源；宿主安装时读取
plugin/
  src/
    main.ts                # 命令注册、启动同步、桌面端定时
    edgeever.ts            # 最小宿主类型（按公开文档自写）
    settings.ts            # 设置键与默认值
    api/                   # 入口选择、错误分类、分页客户端
    template/              # Mustache 上下文、helper、属性块
    sync/                  # 游标、去重、笔记本、单篇处理、编排
    resources/             # 图片链接解析、镜像、下载、本地化
    ui/text.ts             # 所有用户可见文案（reasons 原因 + notices 通知模板）
    util/                  # hash（SHA-256 / FNV-1a 回退）、URL/日期/记录解析助手
  tests/                   # vitest + 假宿主
  scripts/                 # build.mjs / smoke.mjs
  dist/                    # 构建产物（不入库）
docs/DESIGN.md
```

## 6. 设置项

见 `manifest.json`（`settings.fields`）与 `src/settings.ts`：`api-key`、`folder-template`、`folder-date-format`、`title-template`、`front-matter-template`、`article-template`、`image-mode`、`sync-on-start`、`frequency`。

`[实测]` secret 字段不能声明默认值；number 默认值必须落在 min/max 内；select 默认值必须在 options 里 —— 均写进单测。

## 7. 模板变量

- 文章：`id`、`title`、`author`、`siteName`、`originalUrl`、`slug`、`description`、`content`、`labels`、`type`、`state`、`wordsCount`。
- 时间：`date`/`dateSaved`、`datePublished`、`dateRead`、`dateArchived`、`savedAt`、`publishedAt`、`updatedAt`，以及 `yearSaved`/`monthSaved`/`daySaved` 等同族变量。
- 函数：`lowerCase`、`upperCase`、`upperCaseFirst`、`formatDate`、`mapValue`。
- 文件夹模板里的 `/`、`\` 会被替换成全角，标题模板同样处理（标题还会再清洗一次）。

## 8. 同步流程

```
读设置 → 无密钥则「同步失败：请先在插件设置里填写密钥」
  → 读游标/索引/上次入口/开发入口
  → 逐入口拉取（网络错误与 404/405/502/503/504 换下一个；401/403/422/429/500 立即停止）
  → 逐篇：planSync → 新建/更新/跳过/冲突
      · 每一级笔记本等到云端 id 再建下一级
      · 新笔记等到云端 id 再做图片/正文写入
  → 自检：本轮写过的笔记是否都已是云端 id（否则算未完成）
  → 失败篇数 > 0：不推进游标，通知「同步完成…另有 N 篇未完成」
  → 全部成功：推进游标 + 记录入口（开发入口不记录）
  → 图片续传（最多 10 篇）
  → 写 lastRun + showNotice
```

完成信号文案：`同步完成：新增 X 篇，更新 Y 篇，跳过 Z 篇` / `同步失败：<原因>`。

## 9. 交互

- 命令「同步笔记」（id `com.bijitongbu.note-sync-helper.sync`），命令面板触发。
- 同一时刻只跑一轮，重复触发复用进行中的 Promise。
- 设置页全部由宿主渲染，插件不提供自定义面板。
- 定时：`frequency` 分钟 → cron（<60 分钟用 `*/N`，整小时用 `0 */H`，≥24 小时每天一次）；Web 宿主无定时能力时静默跳过。

## 10. 已知限制 / 后续

- `[后续]` 只处理 `kind: "text"` 的普通笔记；不读特殊笔记。
- `[后续]` 不做远端删除同步（会删用户笔记，风险太高）。
- `[后续]` 图片本地化串行按笔记推进；首次同步大量文章时耗时与图片数成正比。
- `[后续]` 大工作区（>3000 条）索引丢失时只能扫描最近更新的部分。
- `[后续]` 若将来宿主提供 externalId 幂等，应替换掉自建索引。
- `[后续]` 宿主同步队列长期卡住时，每轮会白等一次 30 秒再整体失败；界面上只有「未完成」文案，
  没有单独的「宿主队列没在走」提示（新增文案要走黑名单单测）。

## 11. 变更记录

### 2026-10-28 · 修复 local-first 临时 id 阻断 + 开发入口

1. **等待云端 id**（§4.9）：`sync/ids.ts` 判定临时 id（`local_` / `nb_local_` / `memo_local_`），
   `sync/remap.ts` 提供「事件加速 + 轮询兜底 + 30 秒上限」的等待器；`NotebookResolver.ensure()` 逐级等，
   `processItem` 新建笔记后等，超时抛 `TemporaryIdTimeoutError`（本篇失败、游标不提交）。
   一轮内首次超时后其余文章立即失败，避免每篇各等 30 秒。
2. **索引自愈**：处理一篇前若索引里是临时 id，先用 `notes.get` 的宿主映射、再用锚点扫描解析；
   结束前自检本轮写过的笔记是否都已拿到云端 id，未拿到的不计入「新增/更新」并按未完成上报。
   新增文案 `reasons.stillSaving`「笔记还没有保存到云端，稍后会自动继续」，通过 `ui/text.ts` 黑名单单测。
3. **开发入口 `sync.devEndpoint`**（§4.10）：只接受带端口的 loopback 明文地址，插到候选最前，
   不写入 `sync.endpoint`；用户界面不暴露、manifest 不新增字段。
4. 单测从 98 条增加到 114 条：临时 id 判定、事件解析、轮询超时、逐级等待、图片上传目标、
   索引自愈、自检上报、开发入口解析/排序/回落/不缓存。
5. 与 E2E 相关的宿主事实见 §4.9/§4.10 和 `e2e/README.md`。
