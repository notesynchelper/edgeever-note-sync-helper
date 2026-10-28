'use strict';

/**
 * Thin REST client for the EdgeEver instance. Used only for black-box assertions
 * and for the fast install path (`PUT /api/v1/workspace-extensions/:id`).
 * Logs in with `POST /api/v1/auth/login` (apps/api/src/auth-routes.ts:238) and
 * reuses the `edgeever_session` cookie.
 */
class EdgeEverApi {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.cookie = '';
    this.session = null;
  }

  async login(username, password) {
    // The container answers /api/health slightly before the database/session
    // path is ready, so retry transient connection failures and 5xx responses.
    let response;
    let text = '';
    let lastError;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        response = await fetch(`${this.baseUrl}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, password }),
        });
        text = await response.text();
        if (response.status < 500) break;
        lastError = new Error(`Login failed: HTTP ${response.status} ${text.slice(0, 300)}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!response) throw lastError ?? new Error('Login failed: no response');
    if (!response.ok) throw new Error(`Login failed: HTTP ${response.status} ${text.slice(0, 300)}`);
    const body = JSON.parse(text);
    const setCookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie')].filter(Boolean);
    const sessionCookie = setCookies
      .map((value) => value.split(';')[0])
      .find((value) => value.startsWith('edgeever_session='));
    if (!sessionCookie) throw new Error('Login response did not set edgeever_session');
    this.cookie = sessionCookie;
    this.session = body;
    return body;
  }

  get userId() {
    return this.session?.user?.id ?? null;
  }

  get origin() {
    return this.baseUrl;
  }

  /**
   * EdgeEver's plugin host keys all local storage by
   * `${origin}|${userId}` (apps/web/src/lib/local-mirror.ts:59).
   */
  get localScope() {
    return `${this.baseUrl}|${this.userId}`;
  }

  async request(pathname, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${this.baseUrl}${pathname}`, {
      method,
      headers: {
        cookie: this.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new Error(`${method} ${pathname} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    return parsed;
  }

  listNotebooks() {
    return this.request('/api/v1/notebooks');
  }

  listMemos({ limit = 200, notebookId } = {}) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (notebookId) query.set('notebookId', notebookId);
    return this.request(`/api/v1/memos?${query.toString()}`);
  }

  getMemo(memoId) {
    return this.request(`/api/v1/memos/${encodeURIComponent(memoId)}`);
  }

  listResources() {
    return this.request('/api/v1/resources');
  }

  listWorkspaceExtensions() {
    return this.request('/api/v1/workspace-extensions');
  }

  upsertWorkspaceExtension(extensionId, input) {
    return this.request(`/api/v1/workspace-extensions/${encodeURIComponent(extensionId)}`, {
      method: 'PUT',
      body: input,
    });
  }

  deleteWorkspaceExtension(extensionId) {
    return this.request(`/api/v1/workspace-extensions/${encodeURIComponent(extensionId)}`, {
      method: 'DELETE',
    });
  }

  /** Removes a note permanently so repeated runs on a kept instance stay clean. */
  async deleteMemoPermanently(memoId) {
    await this.request(`/api/v1/memos/${encodeURIComponent(memoId)}`, { method: 'DELETE' }).catch(() => undefined);
    await this.request(`/api/v1/memos/${encodeURIComponent(memoId)}?permanent=1`, { method: 'DELETE' }).catch(() => undefined);
  }
}

module.exports = { EdgeEverApi };
