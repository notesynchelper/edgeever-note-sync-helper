# EdgeEver「笔记同步助手」E2E

对着真实 EdgeEver（podman 容器 `edgeever-e2e`，Web 版）跑黑盒 E2E：装插件 → 填设置 → 触发「同步笔记」→
用 REST 断言笔记本树 / 笔记 markdown / 属性 / 资源 → 截图。默认用 `../plugin/dist/` 的真实产物；
`--stub` 可切到 `fixtures/stub-plugin/`（同 id、同 command id 的最小桩，已在真实插件就绪前验证链路）。

## 快速开始

```bash
cd e2e
# 如需把临时目录 / npm 缓存放到别处，自行 export TMPDIR / npm_config_cache
npm install --registry=https://registry.npmjs.org

# 密码与只读测试密钥只放在 ../.work/secrets.env（已 gitignore）
set -a; source ../.work/secrets.env; set +a

npm run e2e              # tutorial + fast
npm run e2e:tutorial     # 真实 UI 安装/信任/设置，产出教程截图
npm run e2e:fast         # 免手点：catalog 预注册 + 预置信任/设置
npm run e2e:real         # 真实密钥（NOTEHELPER_API_KEY）打公网文章 API
npm run reset            # 只重建实例
```

参数：

| 参数 | 作用 |
|---|---|
| `--mode=tutorial\|fast\|real\|both` | 跑哪条路径，默认 `both` |
| `--source=<url>` | 安装来源。默认本地静态服务托管的 manifest URL；填 `https://github.com/owner/repo` 走宿主 GitHub 安装 |
| `--run=<name>` | 截图子目录，默认等于 mode |
| `--skip-reset` | 复用现有实例（调试用） |
| `--stub` | 用桩插件而不是 `plugin/dist` |
| `--route-mock` | 不用插件的 `sync.devEndpoint`，改为浏览器级路由拦截官方 GraphQL 域名（老版本插件回退） |
| `--real-key` | 用 `NOTEHELPER_API_KEY` 打真实文章 API |
| `--headful` | 有头 Chrome |

环境变量：`EDGEEVER_E2E_BASE_URL`（默认 `http://127.0.0.1:18787`）、`EDGEEVER_E2E_USERNAME`（`admin`）、
`EDGEEVER_E2E_PASSWORD`（必填）、`EDGEEVER_E2E_IMAGE`、`EDGEEVER_E2E_PORT`、`EDGEEVER_E2E_DATA_DIR`
（必须在 `.work/` 下）、`EDGEEVER_E2E_KEEP_DATA=1`、`CHROME_PATH`（默认 `/usr/bin/google-chrome`）、
`NOTEHELPER_API_KEY`（仅 real）。

## 目录

```
e2e/
  run-e2e.js              主流程
  lib/env.js              读 .work/secrets.env + 配置（密钥从不打印）
  lib/static-server.js    以 http + ACAO 托管 plugin/dist 或桩插件
  lib/mock-articles.js    mock 文章 API + 图片床 + Playwright 路由拦截（--route-mock）
  lib/edgeever-api.js     登录 + REST 断言客户端
  lib/browser.js          Chrome 启动、诊断、动画冻结
  lib/page-helpers.js     预置 storage/secret、插件菜单、notice 等待
  lib/shots.js            e2e/shots/<run>/NN-name.png
  scripts/reset-instance.sh  用全新数据目录重建容器（路径护栏）
  fixtures/stub-plugin/   桩插件（manifest + 单文件 ESM）
  shots/                  截图输出（gitignore）
```

## 1. 插件安装（两条路都实现）

宿主源码：EdgeEver 官方仓库（只读参考；本地开发机上的调研副本即可）。

### (a) 教程路径：真实 UI 粘贴 manifest URL

- `apps/web/src/lib/plugins/plugin-host.ts:649-654`：manifest URL 允许 `http:` / `https:`，
  `window.fetch(..., {credentials:"omit"})` 拉 `manifest.json`、`main.js`、可选 `styles.css`
  → 浏览器仍强制 CORS，所以本地静态服务每个响应都带 `access-control-allow-origin: *`。
- UI：`/plugins` →「GitHub 仓库或 Manifest 地址」输入框 → 行内「安装」按钮
  （`PluginManagerCard.tsx:366-379,589-601`）。
- 安装后默认 `enabled=false`（`installManifest`），点卡片开关触发信任确认：
  `plugin-trust.ts` 的 `edgeever:plugins:trusted-code:1` 不是 `acknowledged` 时弹
  「开启社区插件？」（`PluginManagerCard.tsx:431-452`）。教程这一轮**不预置**该键，专门截确认框。
- 正式 GitHub 安装：`--source=https://github.com/notesynchelper/edgeever-note-sync-helper`
  （`installFromSource` 识别仓库 URL 走 `installFromGithubRepository`）。

### (b) 免手点：catalog 预注册

- `PUT /api/v1/workspace-extensions/<id>`（`workspace-extension-routes.ts:117`）写入
  `manifestUrl/sourceKind/version/enabled=true`。
- 下次加载时 `EdgeEverPluginHost.syncFromCatalog()`（`plugin-catalog-sync.ts` 的
  `planCatalogReconcile`）自动 `installFromManifestUrl` 并启用；信任未确认时返回 `awaitTrust`。
- fast 路径用 `addInitScript` 预置信任键，所以无需点击。

## 2. 填设置

宿主设置页由 manifest `settings.fields` 驱动（`PluginSettingsSection.tsx`），支持
text/secret/number/boolean/select；插件不能自带设置 UI（`settingsUi:"host"`）。

**存储位置**（`plugin-host.ts:64-65,806-850`）：

- 非密钥：`localStorage["edgeever.plugin-settings.v1:<scope>:<pluginId>:<key>"]`，值为 JSON。
- 密钥：IndexedDB `edgeever-plugin-secrets-v1` 的 `secrets` store，记录 id
  `<scope>:<pluginId>:setting:<key>`，AES-GCM 加密，主密钥是同库 `keys` 的 `device-master-key`
  （`plugin-secret-store.ts`）。
- `<scope>` = `location.origin + "|" + userId`（`local-mirror.ts:59`）。

因此：

- 教程：真的在 `/plugins/<id>?view=settings` 表单里填（截图用）。密钥字段失焦后清空并显示
  「已配置，留空表示保持不变」。
- 自动化快路径：`addInitScript` 写非密钥项；密钥用 `seedPluginSecret()` 在页面里读主密钥、
  加密后写 IndexedDB（与宿主 `WebPluginSecretStore.set` 同构）。写完 reload 让插件激活时读到。

## 3. 触发同步

- 入口：顶栏拼图按钮（`aria-label="插件"`，`PluginToolbarMenu.tsx`）→ 菜单项「同步笔记」。
  没有独立 command palette；这就是「命令面板」。插件详情页也有同名按钮。
- 命令 id 由宿主拼成 `<pluginId>:<command.id>`。
- 完成信号：插件调 `ui.showNotice`，Web 端渲染成 **AppConfirmDialog**（标题「插件」，按钮「知道了」），
  不是 toast。E2E 以 `role=dialog` + 文本「同步完成」等待，然后点「知道了」。

## 4. 断言面（REST + IndexedDB）

登录：`POST /api/v1/auth/login {username,password}` → `Set-Cookie: edgeever_session=…`
（`auth-routes.ts:238`）。之后带 cookie：

| 用途 | 请求 | 形状 |
|---|---|---|
| 笔记本树 | `GET /api/v1/notebooks` | `{notebooks:[{id,parentId,name,…}]}` |
| 笔记列表 | `GET /api/v1/memos?limit=200` | `{memos:[{id,notebookId,title,…}],totalCount}` |
| 笔记正文 | `GET /api/v1/memos/:id` | `{memo:{contentMarkdown,contentJson,tags,…}}` |
| 资源 | `GET /api/v1/resources` | `{resources:[{id,memoId,filename,mimeType,url,…}]}`（无 memoId 过滤） |
| 安装清单 | `GET /api/v1/workspace-extensions` | `{extensions:[{extensionId,enabled,…}]}` |
| 宿主同步队列 | IndexedDB `edgeever-local` / `syncQueue` | `{kind,status,lastError,payload.notebookId}` |

EdgeEver 是 **local-first**：`notes.create` / `notebooks.create` 先返回 `local_*` 临时 id 并排队，
REST 断言必须轮询（`waitFor()`），不能拿 notice 当落库信号。

当前 mock 用例断言：

1. **多级笔记本**：默认模板 `笔记同步助手/{{{date}}}` 渲染出两级；沿 `parentId` 回溯得到
   `笔记同步助手/<日期>`。
2. **全部云端 id**：REST 里的笔记 id 不含 `local_`；宿主 `syncQueue` 最终为空（无 pending/syncing/error）。
3. **标题 / 属性 / 正文模板**：标题等于文章标题；`contentMarkdown` 含
   `author: E2E 测试作者`、`source: E2E 测试站点`、`url: …/mock-e2e-0001`、`tags: [笔记同步助手`、正文小标题。
4. **图片**：回 ACAO 的图片 → 正文改成 `/api/v1/resources/…` 且 `resources` 里有 `ok.png`（`image/png`）；
   不回 ACAO 的 `127.0.0.1` 图片和 404 图片 → 保留远程链接（本地 http 中继会拒绝，正好覆盖失败分支）。
5. **分页**：mock 固定每页 2 条，至少收到 `after=0` 与 `after=2` 两页，且都带 `x-api-key`。
6. **去重**：第二次同步笔记数不变，`lastRun.created===0 / skipped===3`。
7. **用户改过的笔记不被覆盖**：经 REST 改正文（edit-session + PATCH）→ reload 让本地镜像同步 →
   再同步，正文仍保留用户段落，`created===0`。
8. **增量**：mock 切到 `scenario:incremental` 再同步，只新增 1 篇（总数 3→4），`lastRun.created===1`。
9. `lastRun`（`edgeever.plugin-data.v1:<scope>:<id>:lastRun`）`ok===true`，`imagesLocal/imagesRemote` 符合预期。

`--mode=real` 用真实密钥、不打 mock：断言 21 篇全部落库、id 非 `local_`、`lastRun.ok===true`、
`imagesLocal>0`（relay-1/p 图片经宿主 public 中继），并打印本地化/保留远程数量与资源总数。
这条用例覆盖 mock 覆盖不到的 **public 中继**分支（`network.fetch(url,{transport:"public"})`）。

### 宿主同步队列的“事件吞噬”

EdgeEver 的 web 同步 worker 在 `syncQueuedChanges` 已经运行时，会直接返回进行中的 Promise，
**不会为新事件补一轮**。插件在 worker 活跃期间创建的笔记本/笔记可能一直 pending，直到下一次事件。
插件在等待云端 id 的每次轮询里会自己重发宿主的 `edgeever:sync-queue-changed` 事件（`plugin/src/sync/remap.ts`），
所以 E2E 默认**不再**注入补发脚本，真实用户的路径与测试一致。`--queue-nudge` 保留旧的每 750ms 补发，仅作对照。

## 5. Mock 文章服务

`lib/mock-articles.js` 起在 `127.0.0.1:<随机端口>`：

- `POST /api/graphql`：根级 `{edges:[{node}],pageInfo:{hasNextPage,endCursor,totalCount}}`
  （与真实文章接口一致，不是 GraphQL 的 `data.search`）；支持 `after/first` 分页，
  且**固定每页 2 条**，强制任何客户端走分页循环。
- 默认 3 篇：可本地化图片（回 ACAO）、不可本地化图片（一张无 ACAO、一张 404）、第二页文章。
- `scenario:incremental` 或 `mock.setScenario('incremental')` → 只回一篇增量文章；
  普通 `updated:` 仍回全量，便于测去重。
- 图片床：`/img/ok.png`（ACAO `*`）、`/img/no-cors.png`（无 ACAO）、`/img/missing.png`（404）。
- `/__requests` 可看请求记录（E2E 直接读内存 `requests`）。

插件通过 storage 键 **`sync.devEndpoint`**（仅 `http://127.0.0.1:<port>` / `http://localhost:<port>`）
指向 mock；E2E 在插件激活前用 localStorage 预置。没有该入口的旧构建可用 `--route-mock`：
Playwright 拦截 `https://relay-1|2|graph|obsidian…/api/graphql` 转发到 mock。

## 6. 截图

`lib/shots.js` 按 `e2e/shots/<run>/NN-name.png` 编号保存；viewport 1600×1000、`deviceScaleFactor=1`、
`zh-CN`、动画冻结。`shots/` 已 gitignore，教程用图后续人工挑选。

tutorial（12 张，真实 UI）：插件市场页、填 manifest URL、安装完成、信任确认、启用后、详情页、
设置空/已填、命令菜单、同步完成 notice、笔记列表、笔记详情（属性区 + 本地化图片）。
fast（5 张）：自动安装、命令菜单、notice、笔记列表、笔记详情。
real（4 张）：自动安装、命令菜单、notice、笔记列表。

## 7. 实例重置

`scripts/reset-instance.sh`：`podman rm -f edgeever-e2e` → 用全新数据目录
（默认 `../.work/e2e-data`，必须位于 `.work/` 下，否则拒绝）→ `podman unshare chown 1000:1000` →
`podman run … -p 127.0.0.1:18787:8787` → 轮询 `/api/health`。

rootless podman 把容器 uid 1000 映射成宿主 subuid，删除旧目录必须 `podman unshare rm -rf`，
否则宿主用户会 permission denied（已处理）。容器健康检查早于 DB 就绪，`EdgeEverApi.login` 会重试。

## 8. 实测结果（2026-10-28，插件 HEAD `767dbce`）

- `npm run e2e`（tutorial + fast，真实 dist + mock）：两条路径全部断言通过，各 3 篇笔记；
  tutorial 12 张截图。
- `npm run e2e:real`（真实密钥，只读）：**21 篇全部落库**，`imagesLocal=96`、`imagesRemote=0`，
  `resources=102`，`lastRun.ok=true`；笔记全部为云端 id，队列为空。
- 早前插件 `91142a9` 的 local-first 临时 id 问题（子笔记本 / 笔记卡在队列）已在 `767dbce` 修复；
  E2E 的「全部云端 id + 队列为空」断言会持续守住这个回归。
