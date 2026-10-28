/*
 * E2E stub plugin for EdgeEver.
 *
 * It implements the same contract as the real plugin:
 *   - command id `com.bijitongbu.note-sync-helper.sync`, title「同步笔记」
 *   - reads `devEndpoint` from context.storage to point at the mock article API
 *   - creates one notebook + one note per article, localizes CORS-enabled images
 *   - writes `lastRun` and shows `同步完成…` / `同步失败…` via ui.showNotice
 *
 * No imports: EdgeEver loads plugin entries as a single ESM blob URL.
 *
 * Note on EdgeEver's local-first write path: `context.notes.create` returns a
 * `local_…` id and queues the server create. Uploading a resource for that id
 * would 404, so the stub waits for the host's `edgeever:memo-id-remapped` event
 * before localizing images, then updates the note under its remote id.
 */

const NOTEBOOK_NAME = '笔记同步助手/E2E';
const DEFAULT_ENDPOINT = 'https://relay-1.bijitongbu.site/helper';
const PAGE_SIZE = 2;
const MAX_RELAY_BYTES = 2 * 1000 * 1000;

const nowIso = () => new Date().toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const extractImages = (markdown) => {
  const images = [];
  const pattern = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  while ((match = pattern.exec(markdown)) !== null) {
    if (!images.some((image) => image.url === match[2])) images.push({ alt: match[1] || 'image', url: match[2] });
  }
  return images;
};

const filenameFor = (url, contentType) => {
  try {
    const pathname = new URL(url).pathname;
    const base = pathname.split('/').filter(Boolean).pop() || 'image';
    return /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(base)
      ? base
      : `${base}.${contentType && contentType.includes('jpeg') ? 'jpg' : 'png'}`;
  } catch {
    return 'image.png';
  }
};

const localizeImage = async (context, noteId, url) => {
  const attempt = async (transport) => {
    const response = await context.network.fetch(url, transport ? { transport } : undefined);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (blob.size === 0) throw new Error('empty body');
    if (blob.size > MAX_RELAY_BYTES) throw new Error('too large');
    const file = new File([blob], filenameFor(url, blob.type), { type: blob.type || 'image/png' });
    const resource = await context.resources.upload(noteId, file);
    return resource.url;
  };
  try {
    return await attempt(null);
  } catch (directError) {
    try {
      return await attempt('public');
    } catch (relayError) {
      console.warn(`[stub] image kept remote: ${url} (direct: ${directError.message}; relay: ${relayError.message})`);
      return null;
    }
  }
};

const createSync = (context) => async () => {
  const startedAt = nowIso();
  const stats = { startedAt, finishedAt: null, ok: false, created: 0, updated: 0, skipped: 0, imagesLocal: 0, imagesRemote: 0 };
  const remappedIds = new Map();
  const onRemap = (event) => {
    const detail = event && event.detail;
    if (detail && typeof detail.forEach === 'function') {
      detail.forEach((remoteId, localId) => remappedIds.set(localId, remoteId));
    }
  };
  // Notebooks are also created locally (`local_<uuid>`) and only get a cloud id
  // after the create reaches the server; notes must reference the cloud id.
  let remappedNotebook = null;
  const onNotebookRemap = (event) => {
    const detail = event && event.detail;
    if (detail && typeof detail === 'object') remappedNotebook = detail;
  };
  window.addEventListener('edgeever:memo-id-remapped', onRemap);
  window.addEventListener('edgeever:notebook-id-remapped', onNotebookRemap);
  try {
    const settings = {
      apiKey: await context.settings.get('api-key'),
      imageMode: await context.settings.get('image-mode'),
    };
    const endpoint = (await context.storage.get('devEndpoint')) || DEFAULT_ENDPOINT;

    const fetchPage = async (after) => {
      const response = await context.network.fetch(`${endpoint}/api/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': settings.apiKey || '' },
        body: JSON.stringify({
          query: 'query Search($after: Int, $first: Int, $query: String) { search(after: $after, first: $first, query: $query) { items { id title url originalArticleUrl slug author savedAt updatedAt publishedAt archivedAt readAt pageType contentReader description image wordsCount readingProgressPercent isArchived siteName content highlights { id quote annotation } labels { id name color } } pageInfo { hasNextPage totalCount } } }',
          variables: { after, first: PAGE_SIZE, query: '' },
        }),
      });
      if (!response.ok) throw new Error(`文章接口返回 HTTP ${response.status}`);
      return response.json();
    };

    const articles = [];
    let after = 0;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = await fetchPage(after);
      const nodes = Array.isArray(page.edges) ? page.edges.map((edge) => edge.node).filter(Boolean) : null;
      if (!nodes) throw new Error('文章接口返回格式异常：缺少 edges');
      articles.push(...nodes);
      if (!page.pageInfo || !page.pageInfo.hasNextPage) break;
      after = Number(page.pageInfo.endCursor);
      if (!Number.isFinite(after)) after += nodes.length;
      if (nodes.length === 0) break;
    }

    const notebooks = await context.notebooks.list();
    let notebook = notebooks.find((item) => item.name === NOTEBOOK_NAME && !item.id.startsWith('local_'));
    if (!notebook) {
      const existingLocal = notebooks.find((item) => item.name === NOTEBOOK_NAME);
      notebook = existingLocal || await context.notebooks.create({ name: NOTEBOOK_NAME });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (!remappedNotebook || remappedNotebook.temporaryId !== notebook.id)) {
        await sleep(150);
      }
      if (!remappedNotebook || remappedNotebook.temporaryId !== notebook.id) {
        throw new Error('新建的文章文件夹还没有同步到服务器');
      }
      notebook = { ...notebook, id: remappedNotebook.remoteId };
    }

    const synced = (await context.storage.get('syncedIds')) || {};
    const created = [];

    for (const article of articles) {
      if (synced[article.id]) {
        stats.skipped += 1;
        continue;
      }
      const original = article.content || '';
      const note = await context.notes.create({
        notebookId: notebook.id,
        title: article.title || '未命名文章',
        contentMarkdown: original,
        tags: ['E2E', '笔记同步助手'],
      });
      created.push({ article, note, original });
      stats.created += 1;
    }

    // Wait for the local-first queue to create the notes server-side and remap
    // their temporary ids; resource uploads need the remote memo id.
    const waitForRemoteId = async (localId, timeoutMs = 30_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (remappedIds.has(localId)) return remappedIds.get(localId);
        await sleep(150);
      }
      return null;
    };

    for (const item of created) {
      const remoteId = await waitForRemoteId(item.note.id);
      if (!remoteId) {
        stats.imagesRemote += extractImages(item.original).length;
        console.warn(`[stub] note ${item.note.id} was not remapped; images stay remote`);
        continue;
      }
      let markdown = item.original;
      if (settings.imageMode !== 'remote') {
        for (const image of extractImages(item.original)) {
          const localizedUrl = await localizeImage(context, remoteId, image.url);
          if (localizedUrl) {
            markdown = markdown.split(image.url).join(localizedUrl);
            stats.imagesLocal += 1;
          } else {
            stats.imagesRemote += 1;
          }
        }
      } else {
        stats.imagesRemote += extractImages(item.original).length;
      }
      if (markdown !== item.original) await context.notes.update(remoteId, { contentMarkdown: markdown });
      synced[item.article.id] = remoteId;
    }

    await context.storage.set('syncedIds', synced);
    stats.finishedAt = nowIso();
    stats.ok = true;
    await context.storage.set('lastRun', stats);
    context.ui.showNotice(`同步完成：新建 ${stats.created} 篇，跳过 ${stats.skipped} 篇，本地化图片 ${stats.imagesLocal} 张。`);
  } catch (error) {
    stats.finishedAt = nowIso();
    stats.error = String(error && error.message ? error.message : error);
    await context.storage.set('lastRun', stats).catch(() => undefined);
    context.ui.showNotice(`同步失败：${stats.error}`);
  } finally {
    window.removeEventListener('edgeever:memo-id-remapped', onRemap);
    window.removeEventListener('edgeever:notebook-id-remapped', onNotebookRemap);
  }
};

export default {
  activate(context) {
    context.commands.register({
      id: 'sync',
      title: '同步笔记',
      run: createSync(context),
    });
    return () => {
      // Nothing to tear down for the stub.
    };
  },
};
