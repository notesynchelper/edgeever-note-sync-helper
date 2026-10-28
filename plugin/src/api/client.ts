import type { PluginContext } from "../edgeever";
import { canFallback, classifyStatus, endpointCandidates } from "./endpoints";
import { ApiRequestError, MissingKeyError, type ValidatedItem } from "./types";
import { parseDate } from "../util/parse";

export const SEARCH_QUERY = `query Search($after: Int, $first: Int, $query: String) {
  search(after: $after, first: $first, query: $query) {
    items { id title url originalArticleUrl slug author savedAt updatedAt publishedAt archivedAt readAt pageType contentReader description image wordsCount readingProgressPercent isArchived siteName content highlights { id quote annotation } labels { id name color } }
    pageInfo { hasNextPage totalCount }
  }
}`;

export const DEFAULT_PAGE_SIZE = 20;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_PAGES_PER_RUN = 1_000;

export type FetchLike = PluginContext["network"]["fetch"];

export interface ArticleClientOptions {
  apiKey: string;
  fetchImpl: FetchLike;
  pageSize?: number;
  timeoutMs?: number;
  preferredEndpoint?: string;
  /** Loopback mock for development; see `parseDevEndpoint`. */
  devEndpoint?: string | null;
  maxPages?: number;
  onRequest?: (event: { endpoint: string; after: number; query: string }) => void;
}

const isValidDate = (value: unknown): value is string => parseDate(value) !== null;

/** Rejects a page early when the server returns something we cannot sync. */
export function validateItems(edges: unknown[], endpoint: string, status: number): ValidatedItem[] {
  return edges.map((edge, index) => {
    const node = (edge as { node?: unknown } | null)?.node as Record<string, unknown> | undefined;
    const labels = node?.labels;
    const labelsValid = labels == null
      || (Array.isArray(labels) && !labels.some((label) =>
        !label || typeof (label as { name?: unknown }).name !== "string" || !(label as { name: string }).name.trim()));
    if (
      !node
      || typeof node !== "object"
      || typeof node.id !== "string"
      || !node.id.trim()
      || !isValidDate(node.savedAt)
      || !isValidDate(node.updatedAt)
      || (node.content != null && typeof node.content !== "string")
      || !labelsValid
    ) {
      throw new ApiRequestError(`第 ${index + 1} 篇文章缺少必要字段`, "gateway", status, endpoint);
    }
    return {
      ...(node as unknown as ValidatedItem),
      content: typeof node.content === "string" ? node.content : "",
      labels: Array.isArray(labels) ? (labels as ValidatedItem["labels"]) : [],
      updatedAt: node.updatedAt,
    };
  });
}

export class ArticleClient {
  private readonly fetchImpl: FetchLike;
  private readonly pageSize: number;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(private readonly options: ArticleClientOptions) {
    this.fetchImpl = options.fetchImpl;
    this.pageSize = Math.max(1, Math.min(200, Math.trunc(options.pageSize ?? DEFAULT_PAGE_SIZE)));
    // Floor only guards against zero/negative values; callers pick the real budget.
    this.timeoutMs = Math.max(10, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    this.maxPages = Math.max(1, Math.trunc(options.maxPages ?? MAX_PAGES_PER_RUN));
  }

  private async page(endpoint: string, after: number, query: string): Promise<{ items: ValidatedItem[]; hasNextPage: boolean }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const timedOut = (): ApiRequestError | null =>
      signal.aborted ? new ApiRequestError("请求超时", "network", undefined, endpoint) : null;
    this.options.onRequest?.({ endpoint, after, query });
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": this.options.apiKey },
        body: JSON.stringify({
          query: SEARCH_QUERY,
          variables: { after, first: this.pageSize, query },
        }),
        signal,
      });
    } catch {
      throw timedOut() ?? new ApiRequestError("网络请求失败", "network", undefined, endpoint);
    }
    if (!response.ok) {
      throw new ApiRequestError(
        `服务返回错误（${response.status}）`,
        classifyStatus(response.status),
        response.status,
        endpoint,
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw timedOut() ?? new ApiRequestError("服务返回了无法识别的内容", "gateway", response.status, endpoint);
    }
    const payload = json as {
      errors?: unknown[];
      edges?: unknown;
      pageInfo?: { hasNextPage?: unknown };
      data?: { search?: { edges?: unknown; pageInfo?: { hasNextPage?: unknown } } };
    };
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      throw new ApiRequestError("服务返回了错误", "gateway", response.status, endpoint);
    }
    const flat = Array.isArray(payload?.edges) ? payload : payload?.data?.search;
    const edges = flat && Array.isArray(flat.edges) ? flat.edges : null;
    const hasNextPage = flat?.pageInfo?.hasNextPage;
    if (!edges || typeof hasNextPage !== "boolean") {
      throw new ApiRequestError("返回内容格式不正确", "gateway", response.status, endpoint);
    }
    return { items: validateItems(edges, endpoint, response.status), hasNextPage };
  }

  /** Pulls every article changed since the cursor, walking the entry points on transport errors. */
  async fetchAll(cursor = ""): Promise<{ items: ValidatedItem[]; endpoint: string; requests: number }> {
    if (!this.options.apiKey.trim()) throw new MissingKeyError();
    const search = `${cursor ? `updated:${cursor} ` : ""}sort:saved-asc`.trim();
    let lastError: unknown;
    let requests = 0;
    for (const endpoint of endpointCandidates(this.options.preferredEndpoint, this.options.devEndpoint)) {
      const items: ValidatedItem[] = [];
      let after = 0;
      try {
        for (let page = 0; page < this.maxPages; page += 1) {
          requests += 1;
          const result = await this.page(endpoint, after, search);
          items.push(...result.items);
          if (!result.hasNextPage) return { items, endpoint, requests };
          if (result.items.length === 0) {
            throw new ApiRequestError("返回为空但仍声明有下一页", "gateway", undefined, endpoint);
          }
          // Advance by what the server actually returned: a short page would
          // otherwise skip articles permanently.
          after += result.items.length;
        }
        throw new ApiRequestError("文章数量超出单次同步上限", "gateway", undefined, endpoint);
      } catch (error) {
        lastError = error;
        const kind = error instanceof ApiRequestError ? error.kind : "network";
        if (!canFallback(kind)) throw error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new ApiRequestError("所有同步入口均不可达", "network");
  }
}
