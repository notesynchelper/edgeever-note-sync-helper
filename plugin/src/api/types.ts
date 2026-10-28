export interface RemoteLabel {
  id?: string;
  name: string;
  color?: string;
}

export interface RemoteItem {
  id: string;
  title?: string;
  url?: string;
  originalArticleUrl?: string;
  slug?: string;
  author?: string;
  savedAt: string;
  updatedAt?: string;
  publishedAt?: string;
  archivedAt?: string;
  readAt?: string;
  pageType?: string;
  contentReader?: string;
  description?: string;
  image?: string;
  wordsCount?: number;
  readingProgressPercent?: number;
  isArchived?: boolean;
  siteName?: string;
  content?: string;
  highlights?: unknown[];
  labels?: RemoteLabel[];
}

/** An article that passed `validateItems`: the fields sync depends on are present. */
export interface ValidatedItem extends RemoteItem {
  updatedAt: string;
  content: string;
  labels: RemoteLabel[];
}

/** Why a request failed, which decides whether another entry point is tried. */
export type FailureKind = "network" | "gateway" | "app_5xx" | "rate_limit" | "business";

export class ApiRequestError extends Error {
  readonly kind: FailureKind;
  readonly status?: number;
  readonly endpoint?: string;

  constructor(message: string, kind: FailureKind, status?: number, endpoint?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.kind = kind;
    this.status = status;
    this.endpoint = endpoint;
  }
}

/** Raised before any request when no access key has been configured. */
export class MissingKeyError extends ApiRequestError {
  constructor() {
    super("缺少密钥", "business");
    this.name = "MissingKeyError";
  }
}
