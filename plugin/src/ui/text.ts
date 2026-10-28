/**
 * Every string a user can see. Kept in one module so the copy blacklist test
 * can scan it, and so wording changes never need to touch sync logic.
 *
 * `reasons` are bare clauses: the `notices` templates own the leading
 * 「同步失败：」 prefix, so a reason is never prefixed twice.
 */

export interface RunSummary {
  created: number;
  updated: number;
  skipped: number;
}

const count = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

export function formatSummary(summary: RunSummary): string {
  return [
    `新增 ${count(summary.created)} 篇`,
    `更新 ${count(summary.updated)} 篇`,
    `跳过 ${count(summary.skipped)} 篇`,
  ].join("，");
}

export const USER_FACING_TEXT = {
  pluginName: "笔记同步助手",
  command: {
    sync: "同步笔记",
  },
  reasons: {
    missingKey: "请先在插件设置里填写密钥",
    invalidKey: "密钥无效，请确认后重新填写",
    rateLimited: "请求过于频繁，请稍后再试",
    network: "网络连接失败，请检查网络后重试",
    service: "服务暂时不可用，请稍后再试",
    template: "模板无法渲染，请检查模板内容",
    stillSaving: "笔记还没有保存到云端，稍后会自动继续",
    unknown: "出现未知问题，请稍后再试",
  },
  notices: {
    running: "正在同步笔记…",
    success: (summary: RunSummary) => `同步完成：${formatSummary(summary)}`,
    partial: (summary: RunSummary, failed: number) =>
      `同步完成：${formatSummary(summary)}；另有 ${count(failed)} 篇未完成，稍后会重试`,
    failure: (reason: string) => `同步失败：${reason}`,
  },
} as const;
