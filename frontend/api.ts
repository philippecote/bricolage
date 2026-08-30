import type { BuildSummary, ModelPreset, SystemStatus, WorkshopApp } from './types';

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const method = options.method || 'GET';
    const endpoint = path.split('?')[0];
    const trace = (event: string, extra: Record<string, unknown> = {}) => console.info('[Workshop trace]', event, { method, endpoint, at: Date.now(), ...extra });
    trace('request:start', { hasBody: Boolean(options.body), query: path.includes('?') });
    xhr.open(method, path);
    xhr.timeout = 10_000;
    // Keep bodyless GETs simple; the embedded browser can reject non-simple headers.
    const headers = new Headers(options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers);
    headers.forEach((value, name) => xhr.setRequestHeader(name, value));
    xhr.onload = () => {
      trace('request:load', { status: xhr.status });
      let body: Record<string, unknown>;
      try { body = JSON.parse(xhr.responseText); }
      catch { reject(new Error(`Workshop returned an unreadable response (${xhr.status}).`)); return; }
      if (xhr.status < 200 || xhr.status >= 300) { reject(new Error(String(body.error || `Request failed (${xhr.status})`))); return; }
      resolve(body as T);
    };
    xhr.onerror = () => { trace('request:error'); reject(new Error('Workshop’s local builder is offline.')); };
    xhr.ontimeout = () => { trace('request:timeout'); reject(new Error('Workshop’s local builder did not respond.')); };
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
    const trace = (event: string, extra: Record<string, unknown> = {}) => console.info('[Workshop trace]', event, { method: 'FORM-POST', endpoint, at: Date.now(), ...extra });
    trace('request:form:start', { fields: Object.keys(fields) });
    const cleanup = () => { clearTimeout(timeout); frame.remove(); form?.remove(); form = null; };
    const timeout = window.setTimeout(() => { trace('request:form:timeout'); cleanup(); reject(new Error('Workshop’s local builder did not respond.')); }, 10_000);
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
        reject(new Error('Workshop returned an unreadable response.'));
      }
    };
    frame.onerror = () => { trace('request:form:error'); cleanup(); reject(new Error('Workshop’s local builder is offline.')); };
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
  create: (prompt: string, model: ModelPreset) => {
    console.info('[Workshop trace] create:submit', { model, promptChars: prompt.length, at: Date.now() });
    return requestViaForm<{ appId: string; buildId: string; app: WorkshopApp; build: BuildSummary }>('/workshop/build', { prompt, model });
  },
  edit: (id: string, prompt: string, model: ModelPreset) => request<{ buildId: string; build: BuildSummary }>(`/api/apps/${id}/messages`, { method: 'POST', body: JSON.stringify({ prompt, model }) }),
  patch: (id: string, patch: Partial<Pick<WorkshopApp, 'name' | 'pinned' | 'archived' | 'model'>>) => request<{ app: WorkshopApp }>(`/api/apps/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  duplicate: (id: string) => request<{ app: WorkshopApp }>(`/api/apps/${id}/duplicate`, { method: 'POST', body: '{}' }),
  restore: (id: string, revision: number) => request<{ app: WorkshopApp }>(`/api/apps/${id}/revisions/${revision}/restore`, { method: 'POST', body: '{}' }),
  approval: (id: string, accepted: boolean) => request(`/api/approvals/${id}`, { method: 'POST', body: JSON.stringify({ accepted }) }),
  answerBuild: (id: string, answers: Record<string, string>) => request<{ build: BuildSummary }>(`/api/builds/${id}/answers`, { method: 'POST', body: JSON.stringify({ answers }) }),
  cancelBuild: (id: string) => request<{ build: BuildSummary }>(`/api/builds/${id}/cancel`, { method: 'POST', body: '{}' }),
  action: (id: string, name: string, payload: unknown) => request(`/api/apps/${id}/actions/${name}`, { method: 'POST', body: JSON.stringify({ payload }) }),
  storage: (id: string, operation: 'get' | 'set', payload: unknown) => request(`/api/apps/${id}/storage/${operation}`, { method: 'POST', body: JSON.stringify(payload) }),
};
