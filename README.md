# 笔记同步助手 for EdgeEver

Sync articles from your cloud space into EdgeEver notes. Each article becomes a
regular Markdown note: the folder template decides which notebook it lands in,
the title template decides its title, and the properties template writes a
front-matter block with source, author and tags.

This is a client plugin for [EdgeEver](https://github.com/tianma-if/edgeever)
(plugin API v2). It runs in the Web and desktop apps while EdgeEver is open.

## What it does

- Pulls articles incrementally — a cursor remembers the newest `updatedAt` seen,
  and the next run asks only for articles changed after it.
- Creates the notebook tree a folder template asks for, level by level.
- De-duplicates by a stable marker stored in each note's properties block, so
  re-running sync never creates a second copy of an article.
- Protects your edits: once a note no longer matches what the plugin last wrote,
  its body is left alone and the run reports it as skipped.
- Saves article images into the note itself (default), or keeps the original
  links. Failed images keep their remote link and are retried a bounded number
  of times on later runs.
- Registers one command, **同步笔记**, plus an optional desktop schedule.

## Install

1. In EdgeEver open the plugin marketplace.
2. Paste this repository URL:
   `https://github.com/notesynchelper/edgeever-note-sync-helper`
3. Install, enable, then open the plugin settings and fill in your key.

The key is stored by EdgeEver in its encrypted per-device secret store. It is
never written to notes, logs or the sync index.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Key | empty | Required. |
| Article folder | `笔记同步助手/{{{date}}}` | Notebook path; `/` separates levels. |
| Article folder date format | `yyyy-MM-dd` | Format of date variables in templates. |
| Article file name | `{{{title}}}` | Becomes the note title (capped at 160 characters). |
| Note properties template | author/source/url/saved/tags | Rendered into the note's front matter. |
| Article template | `{{{content}}}` | Becomes the note body. |
| Image handling | Save to EdgeEver | Or keep remote links. |
| Sync on start (this device) | off | One sync when EdgeEver opens. |
| Frequency (this device) | 0 | Minutes between automatic syncs; 0 = manual only; desktop only. |

Template variables: `{{id}}`, `{{{title}}}`, `{{{author}}}`, `{{{siteName}}}`,
`{{{originalUrl}}}`, `{{{description}}}`, `{{{content}}}`, `{{{date}}}`
(alias `{{{dateSaved}}}`), `{{{datePublished}}}`, `{{{yearSaved}}}`,
`{{{monthSaved}}}`, `{{{daySaved}}}` and the matching published/archived/read
variants, plus `{{#labels}}{{{name}}}{{/labels}}`. Helpers: `lowerCase`,
`upperCase`, `upperCaseFirst`, `formatDate`, `mapValue`.

## How updates are decided

Each note stores `notehelper-id` in its properties block and the plugin keeps a
per-device index with the hash of what it last wrote. A note is rewritten only
when the article changed or a template changed **and** the note still matches
that hash. If you edited the note, sync leaves it untouched and counts it as
skipped. Deleting the plugin's local data does not lose de-duplication: the
marker inside the note is used to rebuild the index.

## Network use and privacy

The plugin talks only to:

- the article service entry points it is shipped with
  (`relay-1.bijitongbu.site`, `relay-2.bijitongbu.site`,
  `graph.bijitongbu.site`, `obsidian.notebooksyncer.com`), sending your key in
  the `x-api-key` header over HTTPS;
- image hosts referenced by the articles being synced, including the image
  mirrors `relay-*.bijitongbu.site`, `pic.clipfx.app`, `media.clipfx.app`,
  `media30d.clipfx.app`, and common source CDNs such as `pbs.twimg.com`,
  `*.qpic.cn` and `findermp.video.qq.com`.

Images are fetched with the browser transport first. When a host does not allow
cross-origin reads, the request goes through EdgeEver's built-in public relay
(credential-free GET, 2 MB limit). Downloaded images are handed to EdgeEver's
resource storage and referenced by the URL EdgeEver returns.

There is no telemetry, no analytics and no third-party service beyond the hosts
listed above. Everything the plugin stores lives in EdgeEver's own per-device
plugin storage: the cursor, the de-duplication index, image bookkeeping and the
last run summary.

## Development

```bash
cd plugin
npm install
npm test          # unit tests
npm run typecheck
npm run build     # writes plugin/dist/main.js and plugin/dist/manifest.json
```

The repository root `manifest.json` is the source of truth; the build copies it
into `dist/` so a GitHub release can attach both files unchanged. `dist/` is a
build artifact and is not committed.

Layout:

```
manifest.json          plugin manifest (read by EdgeEver on install)
plugin/src/            TypeScript sources (single ESM bundle, no runtime deps)
plugin/tests/          unit tests with a fake host
plugin/scripts/        build + read-only smoke script
docs/DESIGN.md         design decisions and host facts
```

License: MIT.

## 中文说明

把云空间里的文章同步成 EdgeEver 笔记。每篇文章保存为一条普通笔记：文件夹模板决定放在哪个笔记本，文件名模板决定笔记标题，笔记属性模板决定开头的属性区。

### 功能

- 增量同步：记住上次同步到的时间，下次只拉取之后有变化的文章。
- 自动创建多级笔记本，重复同步不会重复建目录。
- 每篇笔记里带一个隐藏的同步标记，重新同步不会产生第二份；插件本地数据丢失后也能按标记找回对应关系。
- 保留你的修改：笔记内容被你改过之后，同步只跳过、不覆盖。
- 图片默认保存到笔记里；保存失败的图片保留原链接，之后有限次重试，不会卡住后面的文章。
- 提供命令「同步笔记」，桌面端还可按分钟设置自动同步。

### 安装

在 EdgeEver 的插件市场里粘贴本仓库地址即可安装；安装后打开插件设置，填入密钥。密钥由 EdgeEver 加密保存在本机。

### 设置项

- 密钥：必填。
- 文章文件夹：笔记放在哪个笔记本，用 / 分隔多级。
- 文章文件夹日期格式：模板里日期变量的格式。
- 文章文件名：笔记标题的模板，最长 160 个字符。
- 笔记属性模板：渲染后写进笔记开头的属性区。
- 文章模板：笔记正文的模板。
- 图片处理模式：保存到 EdgeEver，或保留远程链接。
- 启动时同步（本设备）：打开 EdgeEver 时同步一次。
- 频率（本设备）：自动同步的间隔分钟数，0 表示只手动同步，仅桌面端生效。

### 同步规则

第一次同步会写入全部文章，之后按时间增量拉取。文章有更新或你改了模板时，插件会重写对应笔记；如果这条笔记你自己改过，插件会保持原样并记为跳过。想重新生成某篇笔记，删掉那条笔记后下次同步会重新创建。

### 隐私

插件只访问两类地址：同步文章用的服务入口，以及文章正文里引用的图片所在地址。密钥只随文章请求发送，不会写入笔记或日志。没有统计、没有第三方分析，所有记录都保存在 EdgeEver 自己的本机插件数据里。

### 常见问题

- 提示密钥无效：请在公众号重新获取密钥后填写。
- 图片没有保存下来：部分图片不允许跨站读取或超过大小上限，正文会保留原图链接，可以稍后再次同步。
- 桌面端自动同步不生效：请确认频率大于 0；网页版没有定时能力，只能用命令手动同步。
