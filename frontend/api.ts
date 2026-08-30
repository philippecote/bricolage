import type { BuildSummary, CatalogEntry, Connection, DesktopReply, PendingAct, ModelPreset, Store, SystemStatus, WorkshopApp } from './types';

async function request<T>(path: string, options: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = options.method || 'GET';
    const endpoint = path.split('?')[0];
    const trace = (event: string, extra: Record<string, unknown> = {}) => console.info('[Bricolage trace]', event, { method, endpoint, at: Date.now(), ...extra });
    trace('request:start', { hasBody: Boolean(options.body), query: path.includes('?') });
    xhr.open(method, path);
    xhr.timeout = options.timeoutMs ?? 10_000;
    // Keep bodyless GETs simple; the embedded browser can reject non-simple headers.
    const headers = new Headers(options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers);
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.onload = () => {
      trace('request:load', { status: xhr.status });
      let body: Record<string, unknown>;
      try { body = JSON.parse(xhr.responseText); }
      catch { reject(new Error(`Bricolage returned an unreadable response (${xhr.status}).`)); return; }
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(String(body.error || `Request failed (${xhr.status})`))); return; }
      resolve(body as T);
    };
    xhr.onerror = () => { trace('request:error'); reject(new Error('Bricolage’s local builder is offline.')); };
    xhr.ontimeout = () => { trace('request:timeout'); reject(new Error('Bricolage’s local builder did not respond.')); };
    const abort = () => xhr.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => options.signal?.removeEventListener('abort', abort);
    xhr.send(typeof options.body === 'string' ? options.body : null);
  });
}

// The embedded browser can hold programmatic state-changing requests before they
// leave the page. A real form submission is browser-native and keeps the prompt
// local while still returning the normal JSON response through a same-origin frame.
async function requestViaForm<T>(path: string, fields: Record<string, string>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const frame = document.createElement('iframe');
    let form: HTMLFormElement | null = null;
    const endpoint = path.split('?')[0];
    const frameName = `workshop-response-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const trace = (event: string, extra: Record<string, unknown> = {}) => console.info('[Bricolage trace]', event, { method: 'FORM-POST', endpoint, at: Date.now(), ...extra });
    trace('request:form:start', { fields: Object.keys(fields) });
    const cleanup = () => { clearTimeout(timeout); frame.remove(); form?.remove(); form = null; };
    const timeout = window.setTimeout(() => { trace('request:form:timeout'); cleanup(); reject(new Error('Bricolage’s local builder did not respond.')); }, 10_000);
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.onload = () => {
      try {
        // Appending an iframe emits an initial about:blank load before the form
        // response arrives. Ignore that bootstrap event.
        if (frame.contentWindow?.location.href === 'about:blank') return;
        const text = frame.contentDocument?.body?.textContent || '';
        const body = JSON.parse(text) as Record<string, unknown>;
        trace('request:form:load', { hasError: Boolean(body.error) });
        cleanup();
        if (body.error) { reject(new Error(String(body.error))); return; }
        resolve(body as T);
      } catch {
        cleanup();
        reject(new Error('Bricolage returned an unreadable response.'));
      }
    };
    frame.onerror = () => { trace('request:form:error'); cleanup(); reject(new Error('Bricolage’s local builder is offline.')); };
    frame.name = frameName;
    document.body.appendChild(frame);
    const nativeForm = document.createElement('form');
    form = nativeForm;
    nativeForm.method = 'POST'; nativeForm.action = path; nativeForm.target = frameName; nativeForm.style.display = 'none';
    Object.entries(fields).forEach(([name, value]) => {
      const input = document.createElement('input'); input.type = 'hidden'; input.name = name; input.value = value; nativeForm.appendChild(input);
    });
    document.body.appendChild(nativeForm);
    nativeForm.submit();
  });
}

export const api = {
  status: () => request<SystemStatus>('/api/system/status'),
  apps: (archived = false) => request<{ apps: WorkshopApp[] }>(`/api/apps${archived ? '?archived=true' : ''}`),
  app: (id: string) => request<{ app: WorkshopApp; revisions: number[]; latestBuild: BuildSummary | null }>(`/api/apps/${id}`),
  // A conversational turn may read several apps before it answers.
  say: (message: string, conversationId: string | undefined, model: ModelPreset) =>
    request<DesktopReply>('/api/desktop/message', { method: 'POST', body: JSON.stringify({ message, conversationId, model }), timeoutMs: 120_000 }),
  // The model travels with the approval too — that is the call that actually builds.
  approve: (approve: PendingAct, conversationId: string, model: ModelPreset) =>
    request<DesktopReply>('/api/desktop/message', { method: 'POST', body: JSON.stringify({ approve, conversationId, model }), timeoutMs: 120_000 }),
  // The form transport exists for an embedded browser that stalls programmatic
  // POSTs; the plain one is tried first and falls back to it.
  createDirect: (prompt: string, model: ModelPreset) =>
    request<{ appId: string; buildId: string; app: WorkshopApp; build: BuildSummary }>('/api/apps', { method: 'POST', body: JSON.stringify({ prompt, model }), timeoutMs: 30_000 }),
  create: (prompt: string, model: ModelPreset) => {
    console.info('[Bricolage trace] create:submit', { model, promptChars: prompt.length, at: Date.now() });
    return requestViaForm<{ appId: string; buildId: string; app: WorkshopApp; build: BuildSummary }>('/workshop/build', { prompt, model });
  },
  edit: (id: string, prompt: string, model: ModelPreset) => request<{ buildId: string; build: BuildSummary }>(`/api/apps/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt, model }) }),
  patch: (id: string, patch: Partial<Pick<WorkshopApp, 'name' | 'pinned' | 'archived' | 'model'>>) => request<{ app: WorkshopApp }>(`/api/apps/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  duplicate: (id: string) => request<{ app: WorkshopApp }>(`/api/apps/${id}/duplicate`, { method: 'POST', body: '{}' }),
  restore: (id: string, revision: number) => request<{ app: WorkshopApp }>(`/api/apps/${id}/revisions/${revision}/restore`, { method: 'POST', body: '{}' }),
  approval: (id: string, accepted: boolean) => request(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ accepted }) }),
  answerBuild: (id: string, answers: Record<string, string>) => request<{ build: BuildSummary }>(`/api/builds/${id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
  cancelBuild: (id: string) => request<{ build: BuildSummary }>(`/api/builds/${id}/cancel`, { method: 'POST', body: '{}' }),
  connections: () => request<{ connections: Connection[] }>('/api/connections'),
  catalog: () => request<{ catalog: CatalogEntry[] }>('/api/connections/catalog'),
  openFile: (connection: string, path: string) =>
    request<{ grant: string; name: string; ext: string; mime: string; handler: { id: string; name: string } | null }>('/api/files/open', { method: 'POST', body: JSON.stringify({ connection, path }), timeoutMs: 30_000 }),
  store: () => request<Store>('/api/store', { timeoutMs: 60_000 }),
  // Pulling an image and starting a container is well past the default budget.
  install: (name: string, secrets: Record<string, string>) =>
    request<{ installed: string; tools: number; error: string | null }>(`/api/store/${name}`, { method: 'POST', body: JSON.stringify({ secrets }), timeoutMs: 180_000 }),
  uninstall: (name: string) => request(`/api/store/${name}`, { method: 'DELETE', body: '{}', timeoutMs: 60_000 }),
  addFromCatalog: (id: string, values: Record<string, string>, secrets: Record<string, string>) =>
    request<{ connection: { id: string; label: string }; tools: string[]; error: string | null }>(`/api/connections/catalog/${id}`, { method: 'POST', body: JSON.stringify({ values, secrets }), timeoutMs: 120_000 }),
  // Starting a server can mean npx downloading a package first, which is far
  // past the default budget.
  addConnection: (definition: { id: string; label: string; command: string; args: string[]; env?: Record<string, string> }) =>
    request<{ connection: Connection; tools: string[]; error: string | null }>('/api/connections', { method: 'POST', body: JSON.stringify(definition), timeoutMs: 120_000 }),
  removeConnection: (id: string) => request(`/api/connections/${id}`, { method: 'DELETE', body: '{}' }),
  action: (id: string, name: string, payload: unknown) => request(`/api/apps/${id}/actions/${name}`, { method: 'POST', body: JSON.stringify({ payload }) }),
  storage: (id: string, operation: 'get' | 'set', payload: unknown) => request(`/api/apps/${id}/storage/${operation}`, { method: 'POST', body: JSON.stringify(payload) }),
};
