import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AgentState, BuildEvent, BuildQuestion, CatalogEntry, Connection, DesktopRoute, ModelPreset, SystemStatus, WorkshopApp } from './types';

const STARTERS = [
  ['Daily pulse', 'Build a daily habit tracker with streaks and a calm weekly view'],
  ['Trip ledger', 'Create a shared-looking travel expense splitter with multiple currencies'],
  ['Tiny arcade', 'Make a beautiful keyboard-friendly block puzzle game with scores'],
  ['City air', 'Build an air quality dashboard using a public data API'],
];
const JOURNEY = [
  ['questions', 'Shape'], ['planning', 'Plan'], ['editing', 'Make'], ['checking', 'Check'], ['previewing', 'Preview'], ['complete', 'Done'],
] as const;

type WindowState = { id: string; x: number; y: number; width: number; height: number; minimized: boolean; maximized: boolean; z: number };
type Point = { x: number; y: number };

// Column-major from the right edge: fill down, then step left. The old default
// derived x from innerWidth and clamped at 12, so every icon past the fold piled
// up in the same spot on a narrow window.
function defaultIconPosition(index: number, viewport: { width: number; height: number }): Point {
  const CELL_W = 104, CELL_H = 100, EDGE = 20, CHROME = 36 + 96;
  const rows = Math.max(1, Math.floor((viewport.height - CHROME - EDGE) / CELL_H));
  const column = Math.floor(index / rows), row = index % rows;
  return { x: Math.max(EDGE, viewport.width - EDGE - CELL_W * (column + 1)), y: EDGE + row * CELL_H };
}

function stored<T>(key: string, fallback: T): T { try { return JSON.parse(localStorage.getItem(key) || '') as T; } catch { return fallback; } }
function builderMessage(message: string) {
  return window.location.port === '4100' ? `${message} This tab is on :4100, while this project’s npm start server uses :4000.` : message;
}

export function Workshop() {
  const [apps, setApps] = useState<WorkshopApp[]>([]);
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [windows, setWindows] = useState<WindowState[]>(() => stored('workshop-open-windows', []));
  const [iconPositions, setIconPositions] = useState<Record<string, Point>>(() => stored('workshop-icon-positions', {}));
  const [inspectorAppId, setInspectorAppId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [editing, setEditing] = useState('');
  const [model, setModel] = useState<ModelPreset>(() => (localStorage.getItem('workshop-model') as ModelPreset) || 'luna-high');
  const [builds, setBuilds] = useState<Record<string, BuildEvent[]>>({});
  const [buildForApp, setBuildForApp] = useState<Record<string, string>>({});
  const [revisions, setRevisions] = useState<Record<string, number[]>>({});
  const [spotlight, setSpotlight] = useState(false);
  const [library, setLibrary] = useState(false);
  const [settings, setSettings] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('workshop-theme') || 'light');
  const [sounds, setSounds] = useState(localStorage.getItem('workshop-sounds') === 'true');
  const [toast, setToast] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [clock, setClock] = useState(new Date());
  const [viewport, setViewport] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [activityOpen, setActivityOpen] = useState(false);
  const [handledApprovals, setHandledApprovals] = useState<string[]>([]);
  // Bumped every time the agent finishes writing a runtime file, so the preview
  // reloads mid-build and you watch the app appear.
  const [previewNonce, setPreviewNonce] = useState<Record<string, number>>({});
  const [routing, setRouting] = useState(false);
  const [proposal, setProposal] = useState<DesktopRoute | null>(null);
  const maxZ = useRef(Math.max(2, ...windows.map((win) => win.z)));
  const streams = useRef(new Map<string, EventSource>());
  const detailsLoaded = useRef(new Set<string>());

  const inspectorApp = apps.find((app) => app.id === inspectorAppId) || null;
  const currentEvents = inspectorAppId ? builds[inspectorAppId] || [] : [];
  const ready = (state?: AgentState) => Boolean(state?.available && state?.authenticated);
  const agentsReady = [ready(status?.agents?.codex ?? status?.codex), ready(status?.agents?.claude)].filter(Boolean).length;
  const codexReady = agentsReady > 0;
  const agentLabel = agentsReady === 0 ? 'Setup needed' : agentsReady === 1 ? '1 agent ready' : `${agentsReady} agents ready`;

  useEffect(() => {
    let mounted = true;
    refresh().catch(() => setCreateError(builderMessage('Workshop’s local builder is offline.')));
    api.status().then((next) => {
      if (!mounted) return;
      setStatus(next); setCreateError('');
      next.activeBuilds.forEach((build) => { seedBuild(build.appId, build.id, build.events || []); watchBuild(build.appId, build.id); });
    }).catch(() => { setStatus(null); setCreateError(builderMessage('Workshop’s local builder is offline.')); });
    const timer = setInterval(() => setClock(new Date()), 30_000);
    const reconciler = setInterval(() => { reconcile(); }, 20_000);
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSpotlight((value) => !value); }
      if (event.key === 'Escape') { setSpotlight(false); setLibrary(false); setSettings(false); setActivityOpen(false); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); setWindows((current) => { const top = [...current].filter((win) => !win.minimized).sort((a, b) => b.z - a.z)[0]; return top ? current.filter((win) => win.id !== top.id) : current; }); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'm') { event.preventDefault(); setWindows((current) => { const top = [...current].filter((win) => !win.minimized).sort((a, b) => b.z - a.z)[0]; return top ? current.map((win) => win.id === top.id ? { ...win, minimized: true } : win) : current; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => { mounted = false; clearInterval(timer); clearInterval(reconciler); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); streams.current.forEach((stream) => stream.close()); };
  }, []);

  useEffect(() => {
    windows.forEach((win) => { if (!detailsLoaded.current.has(win.id)) loadDetails(win.id); });
  }, [windows]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('workshop-theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('workshop-sounds', String(sounds)); }, [sounds]);
  useEffect(() => { localStorage.setItem('workshop-model', model); }, [model]);
  useEffect(() => { localStorage.setItem('workshop-icon-positions', JSON.stringify(iconPositions)); }, [iconPositions]);
  useEffect(() => {
    localStorage.setItem('workshop-open-windows', JSON.stringify(windows));
    const memory = stored<Record<string, WindowState>>('workshop-window-positions', {});
    windows.forEach((win) => { memory[win.id] = win; });
    localStorage.setItem('workshop-window-positions', JSON.stringify(memory));
  }, [windows]);

  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      const message = event.data;
      if (!message || message.source !== 'workshop-app' || !apps.some((app) => app.id === message.appId)) return;
      try {
        let result: unknown;
        if (message.type === 'action') result = await api.action(message.appId, message.payload.name, message.payload.payload);
        else if (message.type === 'storage.get') result = await api.storage(message.appId, 'get', { key: message.payload.key });
        else if (message.type === 'storage.set') result = await api.storage(message.appId, 'set', message.payload);
        else if (message.type === 'focus') { focusWindow(message.appId); return; }
        else if (message.type === 'notify') { showToast(String(message.payload.message)); result = true; }
        else if (message.type === 'title') { await renameApp(message.appId, String(message.payload.title)); result = true; }
        else if (message.type === 'link') { const url = new URL(message.payload.url); if (url.protocol !== 'https:') throw new Error('Only HTTPS links are allowed.'); window.open(url, '_blank', 'noopener,noreferrer'); result = true; }
        event.source?.postMessage({ source: 'workshop-host', id: message.id, result }, { targetOrigin: '*' });
      } catch (error) { event.source?.postMessage({ source: 'workshop-host', id: message.id, error: error instanceof Error ? error.message : String(error) }, { targetOrigin: '*' }); }
    };
    window.addEventListener('message', onMessage); return () => window.removeEventListener('message', onMessage);
  }, [apps]);

  async function refresh() { const result = await api.apps(); setApps(result.apps); }
  function showToast(message: string) { setToast(message); setTimeout(() => setToast(''), 2600); if (sounds) chime(); }
  function chime() { const audio = new AudioContext(); const oscillator = audio.createOscillator(); const gain = audio.createGain(); oscillator.frequency.value = 620; gain.gain.setValueAtTime(.04, audio.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audio.currentTime + .18); oscillator.connect(gain).connect(audio.destination); oscillator.start(); oscillator.stop(audio.currentTime + .18); }
  function seedBuild(appId: string, buildId: string, events: BuildEvent[]) { setBuildForApp((value) => ({ ...value, [appId]: buildId })); setBuilds((value) => ({ ...value, [appId]: events })); }

  function adoptCreated(result: { appId: string; buildId: string; app: WorkshopApp; build: { events?: BuildEvent[] } }) {
    setComposer(''); setApps((items) => [result.app, ...items]); seedBuild(result.appId, result.buildId, result.build?.events || []);
    openApp(result.app, true); watchBuild(result.appId, result.buildId); showToast('Let’s shape your app');
  }

  async function create(prompt = composer) {
    const clean = prompt.trim(); if (!clean || creating) return;
    console.info('[Workshop trace] create:handler', { model, promptChars: clean.length, at: Date.now() });
    setCreating(true); setCreateError(''); setSpotlight(false);
    try {
      let result;
      try { result = await api.createDirect(clean, model); }
      catch { result = await api.create(clean, model); }
      console.info('[Workshop trace] create:success', { appId: result.appId, buildId: result.buildId, at: Date.now() });
      adoptCreated(result);
    } catch (error) {
      console.info('[Workshop trace] create:error', { message: error instanceof Error ? error.message : String(error), at: Date.now() });
      setCreateError(builderMessage(error instanceof Error ? error.message : 'Could not create app'));
    }
    finally { setCreating(false); }
  }

  async function runRoute(route: DesktopRoute) {
    setProposal(null);
    if (route.intent === 'edit' && route.appId) {
      const app = apps.find((item) => item.id === route.appId);
      if (app) {
        setComposer('');
        openApp(app, true);
        try {
          const result = await api.edit(app.id, route.prompt, app.model || model);
          setApps((items) => items.map((item) => item.id === app.id ? { ...item, status: 'building', error: null } : item));
          seedBuild(app.id, result.buildId, result.build.events || []);
          watchBuild(app.id, result.buildId);
        } catch (error) { showToast(error instanceof Error ? error.message : 'Could not start that change'); }
        return;
      }
    }
    create(route.prompt || composer);
  }

  function submitComposer(event: FormEvent<HTMLFormElement>) {
    const clean = composer.trim();
    event.preventDefault();
    if (!clean || creating || routing) return;
    setCreateError('');
    setRouting(true);
    api.route(clean)
      .then(({ route }) => { if (route.intent === 'answer' || route.confirm) setProposal(route); else runRoute(route); })
      .catch(() => create(clean))
      .finally(() => setRouting(false));
  }

  function watchBuild(appId: string, buildId: string) {
    if (streams.current.has(buildId)) return;
    setBuildForApp((current) => ({ ...current, [appId]: buildId }));
    const stream = new EventSource(`/api/builds/${buildId}/events`); streams.current.set(buildId, stream);
    stream.onmessage = (message) => {
      const event: BuildEvent = JSON.parse(message.data);
      // A bare preview signal only reloads the iframe; it is not activity to show.
      if (event.preview && !event.message) { setPreviewNonce((current) => ({ ...current, [appId]: (current[appId] || 0) + 1 })); return; }
      setBuilds((current) => ({ ...current, [appId]: [...(current[appId] || []).filter((item) => item.id !== event.id), event] }));
      if (!['questions', 'complete', 'failed', 'cancelled'].includes(event.phase)) setApps((items) => items.map((app) => app.id === appId ? { ...app, status: 'building' } : app));
      if (['complete', 'failed', 'cancelled'].includes(event.phase)) {
        stream.close(); streams.current.delete(buildId); refresh(); loadDetails(appId);
        if (event.phase === 'complete') showToast('Your app is ready ✦');
      }
    };
    // EventSource stops retrying after a non-200 — which is exactly what a
    // restarted Workshop returns for a build it no longer holds. Without this the
    // window sits frozen on the last phase it happened to see.
    stream.onerror = () => {
      if (stream.readyState !== EventSource.CLOSED) return;
      stream.close(); streams.current.delete(buildId);
      refresh(); loadDetails(appId);
    };
  }

  // Safety net for anything the stream missed: re-adopt builds the server still
  // considers active, and reconcile apps left looking busy when nothing is.
  async function reconcile() {
    try {
      const next = await api.status();
      setStatus(next);
      next.activeBuilds.forEach((build) => {
        if (streams.current.has(build.id)) return;
        seedBuild(build.appId, build.id, build.events || []);
        watchBuild(build.appId, build.id);
      });
      const live = new Set(next.activeBuilds.map((build) => build.appId));
      setApps((items) => (items.some((app) => app.status === 'building' && !live.has(app.id)) ? (refresh(), items) : items));
    } catch { /* builder offline; the next tick tries again */ }
  }

  async function improve(event: FormEvent) {
    event.preventDefault(); if (!inspectorApp || !editing.trim()) return;
    const prompt = editing; setEditing('');
    try {
      setApps((items) => items.map((app) => app.id === inspectorApp.id ? { ...app, status: 'building', error: null } : app));
      const result = await api.edit(inspectorApp.id, prompt, inspectorApp.model || 'luna-high');
      seedBuild(inspectorApp.id, result.buildId, result.build.events || []); watchBuild(inspectorApp.id, result.buildId);
    } catch (error) { showToast(error instanceof Error ? error.message : 'Edit failed'); }
  }

  async function answerBuild(appId: string, answers: Record<string, string>) {
    const buildId = buildForApp[appId]; if (!buildId) return;
    try { await api.answerBuild(buildId, answers); setApps((items) => items.map((app) => app.id === appId ? { ...app, status: 'building' } : app)); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not start the build'); }
  }

  async function cancelBuild(appId: string) { const id = buildForApp[appId]; if (id) { await api.cancelBuild(id); showToast('Build stopped'); } }

  function openApp(app: WorkshopApp, showInspector = false) {
    if (showInspector) setInspectorAppId(app.id);
    loadDetails(app.id);
    setWindows((current) => {
      const existing = current.find((win) => win.id === app.id);
      if (existing) return current.map((win) => win.id === app.id ? { ...win, minimized: false, z: ++maxZ.current } : win);
      const memory = stored<Record<string, WindowState>>('workshop-window-positions', {})[app.id];
      const offset = current.length * 22;
      return [...current, memory ? { ...memory, minimized: false, z: ++maxZ.current } : { id: app.id, x: 78 + offset, y: 74 + offset, width: Math.min(app.window.width, innerWidth - 48), height: Math.min(app.window.height, innerHeight - 120), minimized: false, maximized: false, z: ++maxZ.current }];
    });
  }

  async function loadDetails(id: string) {
    detailsLoaded.current.add(id);
    try {
      const result = await api.app(id);
      setApps((items) => items.map((app) => app.id === id ? result.app : app));
      setRevisions((value) => ({ ...value, [id]: result.revisions }));
      if (result.latestBuild) seedBuild(id, result.latestBuild.id, result.latestBuild.events || []);
    } catch { /* app may still be creating */ }
  }

  function focusWindow(id: string) {
    setWindows((current) => {
      const target = current.find((win) => win.id === id);
      if (!target || target.z === maxZ.current) return current;
      return current.map((win) => win.id === id ? { ...win, z: ++maxZ.current, minimized: false } : win);
    });
  }
  function closeWindow(id: string) { setWindows((current) => current.filter((win) => win.id !== id)); if (inspectorAppId === id) setInspectorAppId(null); }
  function minimizeWindow(id: string) { windowPatch(id, { minimized: true }); }
  function restoreWindow(id: string) { setWindows((current) => current.map((win) => win.id === id ? { ...win, minimized: false, z: ++maxZ.current } : win)); }
  function windowPatch(id: string, patch: Partial<WindowState>) { setWindows((current) => current.map((win) => win.id === id ? { ...win, ...patch } : win)); }

  function startWindowDrag(event: ReactPointerEvent, win: WindowState) {
    if ((event.target as HTMLElement).closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId); const sx = event.clientX, sy = event.clientY, ox = win.x, oy = win.y;
    const move = (next: PointerEvent) => windowPatch(win.id, { x: Math.max(8, Math.min(innerWidth - 180, ox + next.clientX - sx)), y: Math.max(34, Math.min(innerHeight - 120, oy + next.clientY - sy)) });
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  function startIconDrag(event: ReactPointerEvent, app: WorkshopApp, position: Point) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId); const sx = event.clientX, sy = event.clientY, ox = position.x, oy = position.y; let moved = false;
    const move = (next: PointerEvent) => { const dx = next.clientX - sx, dy = next.clientY - sy; moved ||= Math.hypot(dx, dy) > 5; if (moved) setIconPositions((current) => ({ ...current, [app.id]: { x: Math.max(8, Math.min(innerWidth - 100, ox + dx)), y: Math.max(8, Math.min(innerHeight - 150, oy + dy)) } })); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (!moved) openApp(app); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  async function renameApp(id: string, name: string) { const result = await api.patch(id, { name }); setApps((items) => items.map((item) => item.id === id ? result.app : item)); }
  async function setAppModel(app: WorkshopApp, next: ModelPreset) { const result = await api.patch(app.id, { model: next }); setApps((items) => items.map((item) => item.id === app.id ? result.app : item)); }
  async function togglePin(app: WorkshopApp) { const result = await api.patch(app.id, { pinned: !app.pinned }); setApps((items) => items.map((item) => item.id === app.id ? result.app : item)); }
  async function archive(app: WorkshopApp) { await api.patch(app.id, { archived: true }); closeWindow(app.id); refresh(); showToast('Moved to archive'); }
  async function duplicate(app: WorkshopApp) { const result = await api.duplicate(app.id); setApps((items) => [result.app, ...items]); openApp(result.app); showToast('App duplicated'); }
  async function restoreRevision(app: WorkshopApp, revision: number) { await api.restore(app.id, revision); refresh(); loadDetails(app.id); windowPatch(app.id, { z: ++maxZ.current }); showToast(`Restored version ${revision}`); }

  const activeWindowId = useMemo(() => [...windows].filter((win) => !win.minimized).sort((a, b) => b.z - a.z)[0]?.id || null, [windows]);
  const minimized = useMemo(() => windows.filter((win) => win.minimized), [windows]);
  // The dock carries pinned apps plus anything currently open, the way a real one does.
  const docked = useMemo(() => {
    const byId = new Map(apps.filter((app) => app.pinned && !app.archived).slice(0, 7).map((app) => [app.id, app]));
    for (const win of windows) {
      if (byId.has(win.id) || win.minimized) continue;
      const app = apps.find((item) => item.id === win.id);
      if (app && !app.archived) byId.set(app.id, app);
    }
    return [...byId.values()];
  }, [apps, windows]);
  const pinned = useMemo(() => apps.filter((app) => app.pinned && !app.archived).slice(0, 7), [apps]);
  const visibleApps = apps.filter((app) => !app.archived);

  // One place that knows what the whole desktop is doing. Every surface below —
  // the menu-bar chip, the dock rings, the rail — reads from this.
  const activity = useMemo(() => visibleApps.map((app) => {
    const events = builds[app.id] || [];
    const latest = events.at(-1);
    const phase = latest?.phase || '';
    const approval = [...events].reverse().find((event) => event.approval && !handledApprovals.includes(event.approval.id))?.approval;
    const waiting = phase === 'questions' || Boolean(approval);
    const working = app.status === 'building' && !['complete', 'failed', 'cancelled'].includes(phase);
    return { app, approval, waiting, working, message: latest?.message || 'Getting started', since: events[0]?.at };
  }).filter((item) => item.working || item.waiting), [visibleApps, builds, handledApprovals]);

  async function resolveApproval(id: string, accepted: boolean) {
    setHandledApprovals((current) => [...current, id]);
    try { await api.approval(id, accepted); }
    catch (error) { showToast(error instanceof Error ? error.message : 'Could not answer that request'); }
  }

  return <main className="desktop" aria-label="Workshop desktop">
    <div className="wallpaper-orb orb-one" /><div className="wallpaper-orb orb-two" />
    <header className="menu-bar">
      <div className="menu-left"><button className="wordmark" onClick={() => setLibrary(false)} aria-label="Workshop home"><span>W</span> Workshop</button><button onClick={() => setLibrary(true)}>Library</button><button onClick={() => setSpotlight(true)}>Create</button></div>
      <div className="menu-right">{activity.length > 0 && <button className={`working-chip ${activity.some((item) => item.waiting) ? 'waiting' : ''}`} onClick={() => setActivityOpen((value) => !value)} aria-label="Show desktop activity"><i />{activity.some((item) => item.waiting) ? 'Needs you' : `${activity.length} working`}</button>}<button className={`codex-state ${codexReady ? 'online' : ''}`} onClick={() => setSettings(true)}><i />{agentLabel}</button><button onClick={() => setSpotlight(true)} className="shortcut">⌘ K</button><time>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} &nbsp; {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
    </header>

    <section className="desktop-content">
      <div className="welcome">
        <span className="eyebrow">YOUR WORKBENCH</span><h1>What should we make?</h1>
        <form className="hero-composer" onSubmit={submitComposer}>
          <textarea name="prompt" value={composer} readOnly={creating} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={creating ? 'Starting your app…' : 'Ask for an app…'} aria-label="Describe an app" />
          <input type="hidden" name="model" value={model} />
          <div className="composer-foot"><ModelPicker value={model} onChange={setModel} compact /><button className={`build-arrow ${creating || routing ? 'creating' : ''}`} aria-label={creating ? 'Creating app' : routing ? 'Thinking' : 'Build app'} disabled={!composer.trim() || creating || routing}>{creating || routing ? '✦' : '↑'}</button></div>
        </form>
        {proposal && <Proposal route={proposal} app={apps.find((item) => item.id === proposal.appId) || null} onAccept={() => runRoute(proposal)} onCreateInstead={() => { setProposal(null); create(composer); }} onDismiss={() => setProposal(null)} />}
        {createError && <div className="create-error" role="alert"><div><strong>Couldn’t start that app</strong><span>{createError} Start Workshop with <code>npm start</code>, then try again.</span></div><button onClick={() => { setCreateError(''); create(); }}>Try again</button></div>}
        <div className="starter-list">{STARTERS.map(([name, prompt]) => <button key={name} onClick={() => create(prompt)}><span>{name}</span><small>{prompt}</small><b>↗</b></button>)}</div>
      </div>
    </section>

    <div className="desktop-apps" aria-label="Apps">{visibleApps.slice(0, 12).map((app, index) => {
      const position = iconPositions[app.id] || defaultIconPosition(index, viewport);
      return <button key={app.id} className="desktop-icon" style={{ left: position.x, top: position.y, animationDelay: `${index * 45}ms` }} onPointerDown={(event) => startIconDrag(event, app, position)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openApp(app); }}><AppIcon app={app} /><span>{app.name}</span>{app.status === 'building' && <i className="build-dot" />}</button>;
    })}</div>

    {windows.map((win) => {
      const app = apps.find((item) => item.id === win.id); if (!app || win.minimized) return null;
      const inspectorOpen = inspectorAppId === app.id;
      const building = activity.some((item) => item.app.id === app.id && item.working);
      return <section key={win.id} className={`app-window ${win.maximized ? 'maximized' : ''} ${building ? 'building' : ''} ${activeWindowId === win.id ? 'active' : 'inactive'}`} style={win.maximized ? { zIndex: win.z } : { left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }} onPointerDown={() => focusWindow(win.id)} aria-label={`${app.name} window`}>
        <header className="window-bar" onPointerDown={(event) => startWindowDrag(event, win)} onDoubleClick={() => windowPatch(win.id, { maximized: !win.maximized })}>
          <div className="traffic"><button className="close" onClick={() => closeWindow(win.id)} aria-label="Close" /><button className="min" onClick={() => minimizeWindow(win.id)} aria-label="Minimize" /><button className="max" onClick={() => windowPatch(win.id, { maximized: !win.maximized })} aria-label="Maximize" /></div>
          <span className="window-title"><AppIcon app={app} compact />{app.name}</span>
          <button className={`inspector-toggle ${inspectorOpen ? 'active' : ''}`} onClick={() => setInspectorAppId(inspectorOpen ? null : app.id)} aria-label="Open build studio" title="Build studio">✦</button>
        </header>
        <div className="window-body"><iframe title={app.name} src={`/runtime/${app.id}?v=${app.revision}.${previewNonce[app.id] || 0}`} sandbox="allow-scripts allow-forms allow-popups" />{inspectorOpen && <Inspector app={app} events={currentEvents} buildId={buildForApp[app.id]} revisions={revisions[app.id] || []} editing={editing} setEditing={setEditing} improve={improve} answer={(answers) => answerBuild(app.id, answers)} cancel={() => cancelBuild(app.id)} setModel={(next) => setAppModel(app, next)} pin={() => togglePin(app)} duplicate={() => duplicate(app)} archive={() => archive(app)} restore={(revision) => restoreRevision(app, revision)} approve={async (id, accepted) => { await api.approval(id, accepted); }} />}</div>
      </section>;
    })}

    <nav className="dock" aria-label="Dock">
      <button className="dock-item creator" onClick={() => setSpotlight(true)} aria-label="Create app"><span>✦</span><em>Create</em></button>
      <i className="dock-separator" />
      {docked.map((app) => <button key={app.id} className={`dock-item ${activity.some((item) => item.app.id === app.id) ? 'working' : ''}`} onClick={() => (windows.some((win) => win.id === app.id) ? focusWindow(app.id) : openApp(app))} aria-label={`Open ${app.name}`}><AppIcon app={app} /><em>{app.name}</em>{windows.some((win) => win.id === app.id && !win.minimized) && <b />}</button>)}
      {minimized.length > 0 && <i className="dock-separator" />}
      {minimized.map((win) => {
        const app = apps.find((item) => item.id === win.id);
        if (!app) return null;
        return <button key={`min-${win.id}`} className="dock-item minimized" onClick={() => restoreWindow(win.id)} aria-label={`Restore ${app.name}`}><AppIcon app={app} /><em>{app.name}</em></button>;
      })}
      <i className="dock-separator" />
      <button className="dock-item" onClick={() => setLibrary(true)} aria-label="App library"><span className="library-icon">⌘</span><em>Library</em></button>
      <button className="dock-item" onClick={() => setSettings(true)} aria-label="Settings"><span className="settings-icon">⚙</span><em>Settings</em></button>
    </nav>
    {activityOpen && <ActivityRail items={activity} onClose={() => setActivityOpen(false)} onOpen={(app) => { openApp(app, true); setActivityOpen(false); }} onApprove={resolveApproval} />}
    {spotlight && <Spotlight apps={visibleApps} onClose={() => setSpotlight(false)} onCreate={create} onOpen={(app) => { openApp(app); setSpotlight(false); }} />}
    {library && <Library apps={apps} onClose={() => setLibrary(false)} onOpen={openApp} onRestore={async (app) => { await api.patch(app.id, { archived: false }); refresh(); }} />}
    {settings && <Settings status={status} theme={theme} setTheme={setTheme} sounds={sounds} setSounds={setSounds} onClose={() => setSettings(false)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
    {creating && <div className="creation-status" role="status" aria-live="polite"><div className="build-creature working"><i /><i /><span>⌁</span></div><div><strong>Making a cozy spot for your app</strong><span>Just a moment…</span></div></div>}
  </main>;
}

// The desktop agent speaks only when it has something to add: an app that already
// covers this, or an answer instead of a build.
function Proposal({ route, app, onAccept, onCreateInstead, onDismiss }: { route: DesktopRoute; app: WorkshopApp | null; onAccept: () => void; onCreateInstead: () => void; onDismiss: () => void }) {
  if (route.intent === 'answer') {
    return <div className="proposal answer" role="status">
      <p>{route.reply}</p>
      <div><button className="primary" onClick={onDismiss}>Got it</button></div>
    </div>;
  }
  return <div className="proposal" role="status">
    {app && <AppIcon app={app} compact />}
    <div className="proposal-body">
      <p>{route.reason || route.reply}</p>
      {route.reason && route.reply && <small>{route.reply}</small>}
    </div>
    <div className="proposal-actions">
      <button className="primary" onClick={onAccept}>{app ? `Extend ${app.name}` : 'Go ahead'}</button>
      <button onClick={onCreateInstead}>Build new</button>
      <button className="quiet" onClick={onDismiss} aria-label="Dismiss">✕</button>
    </div>
  </div>;
}

function AppIcon({ app, compact = false }: { app: WorkshopApp; compact?: boolean }) { return <span className={`app-icon ${compact ? 'compact' : ''}`} style={{ '--accent': app.accent } as React.CSSProperties}><i>{app.icon}</i></span>; }

function ModelPicker({ value, onChange, compact = false }: { value: ModelPreset; onChange: (value: ModelPreset) => void; compact?: boolean }) {
  const options: Array<[ModelPreset, string, string, string]> = [
    ['luna-high', 'Luna', 'High', 'Quick, thoughtful, and the best value'],
    ['luna-max', 'Luna', 'Max', 'Same model thinking as hard as it can'],
    ['sol-medium', 'Sol', 'Medium', 'Flagship quality, balanced pace'],
    ['opus-5-high', 'Opus 5', 'High', 'Built by Claude Code instead of Codex'],
  ];
  return <div className={`model-picker ${compact ? 'compact' : ''}`} aria-label="Builder model">{options.map(([key, family, tier, hint]) => <button type="button" key={key} aria-pressed={value === key} className={value === key ? 'active' : ''} onClick={() => onChange(key)} title={hint}>{family} <b>{tier}</b></button>)}</div>;
}

function Inspector({ app, events, buildId, revisions, editing, setEditing, improve, answer, cancel, setModel, pin, duplicate, archive, restore, approve }: { app: WorkshopApp; events: BuildEvent[]; buildId?: string; revisions: number[]; editing: string; setEditing: (v: string) => void; improve: (e: FormEvent) => void; answer: (answers: Record<string, string>) => void; cancel: () => void; setModel: (model: ModelPreset) => void; pin: () => void; duplicate: () => void; archive: () => void; restore: (r: number) => void; approve: (id: string, accepted: boolean) => void }) {
  const latest = events.at(-1); const questions = events.find((event) => event.questions)?.questions || []; const plan = [...events].reverse().find((event) => event.plan)?.plan || [];
  const shaping = latest?.phase === 'discovering';
  const awaitingAnswers = latest?.phase === 'questions' && questions.length > 0; const busy = app.status === 'building' && !['complete', 'failed', 'cancelled'].includes(latest?.phase || '');
  const currentIndex = Math.max(0, ...events.map((event) => JOURNEY.findIndex(([phase]) => phase === event.phase)).filter((index) => index >= 0));
  const statusLabel = awaitingAnswers ? 'Let’s shape it' : shaping ? 'Thinking about your idea' : latest?.phase === 'complete' ? 'Ready to play' : latest?.phase === 'failed' ? 'Needs a little help' : latest?.phase === 'cancelled' ? 'Paused' : busy ? latest?.message || 'Making your app' : 'Ready';
  const elapsed = events.length ? Math.max(0, Date.now() - new Date(events[0].at).getTime()) : 0;
  return <aside className="inspector build-studio">
    <div className="studio-heading"><div className={`build-creature ${busy ? 'working' : latest?.phase === 'complete' ? 'happy' : ''}`}><i /><i /><span>⌁</span></div><div><span className="eyebrow">BUILD STUDIO</span><h2>{statusLabel}</h2><p>{busy && !awaitingAnswers ? `${formatElapsed(elapsed)} · still happily working` : `Version ${app.revision || 1}`}</p></div></div>
    <ModelPicker value={app.model || 'luna-high'} onChange={setModel} />
    {(events.length > 0 || app.status === 'building') && <div className="journey" aria-label="Build progress">{JOURNEY.map(([phase, label], index) => <div key={phase} className={`${index < currentIndex ? 'done' : ''} ${index === currentIndex ? 'current' : ''}`}><i>{index < currentIndex || latest?.phase === 'complete' ? '✓' : index + 1}</i><span>{label}</span></div>)}</div>}
    {awaitingAnswers && <QuestionDeck questions={questions} onSubmit={answer} />}
    {!awaitingAnswers && plan.length > 0 && <section className="build-plan"><header><span>Our little plan</span><b>{plan.length} steps</b></header>{plan.map((step, index) => <div key={step} className={index < Math.max(0, currentIndex - 1) ? 'done' : index === Math.max(0, currentIndex - 1) && busy ? 'active' : ''}><i>{index < Math.max(0, currentIndex - 1) ? '✓' : index + 1}</i><span>{step}</span></div>)}</section>}
    {!awaitingAnswers && events.length > 0 && <div className="activity-peek"><span className="eyebrow">RIGHT NOW</span>{events.slice(-8).reverse().map((event, index) => <p key={event.id} className={index === 0 ? 'latest' : ''}><i />{event.message}<time>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{event.approval && <span className="approval"><button onClick={() => approve(event.approval!.id, false)}>Not now</button><button onClick={() => approve(event.approval!.id, true)}>Allow</button></span>}</p>)}</div>}
    {app.error && <div className="error-note">{app.error}</div>}
    {!awaitingAnswers && <form className="edit-composer" onSubmit={improve}><textarea placeholder="What should we change?" value={editing} onChange={(event) => setEditing(event.target.value)} disabled={busy} /><div><span>{busy ? 'Codex is in the zone' : 'Keeps this app’s context'}</span><button disabled={!editing.trim() || busy}>Send</button></div></form>}
    {busy && !awaitingAnswers && buildId && <button className="stop-build" onClick={cancel}>Stop for now</button>}
    {!busy && !awaitingAnswers && <><div className="revision-list"><h3>Versions</h3>{revisions.slice(0, 4).map((revision, index) => <button key={revision} disabled={index === 0} onClick={() => restore(revision)}><span>Version {revision}</span><small>{index === 0 ? 'Current' : 'Restore'}</small></button>)}</div><div className="app-actions"><button onClick={pin}>{app.pinned ? 'Unpin' : 'Pin to Dock'}</button><button onClick={duplicate}>Duplicate</button><button className="danger" onClick={archive}>Archive</button></div></>}
  </aside>;
}

function QuestionDeck({ questions, onSubmit }: { questions: BuildQuestion[]; onSubmit: (answers: Record<string, string>) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({}); const complete = questions.every((question) => answers[question.id]);
  return <section className="question-deck"><header><span>{questions.length === 1 ? 'One quick choice' : `${questions.length} quick choices`}</span><small>Straight from your builder.</small></header>{questions.map((question, index) => <fieldset key={question.id}><legend><i>{index + 1}</i>{question.prompt}</legend><div>{question.options.map((option) => <button type="button" key={option} className={answers[question.id] === option ? 'selected' : ''} onClick={() => setAnswers((value) => ({ ...value, [question.id]: option }))}>{option}<span>{answers[question.id] === option ? '✓' : ''}</span></button>)}</div></fieldset>)}<button className="start-making" disabled={!complete} onClick={() => onSubmit(answers)}>Make my app <span>✦</span></button></section>;
}

type ActivityItem = { app: WorkshopApp; approval?: { id: string; summary: string }; waiting: boolean; working: boolean; message: string; since?: string };

// The desktop's answer to "what is happening right now". Builds already stream
// every phase change; this just stops that being visible only inside one window.
function ActivityRail({ items, onClose, onOpen, onApprove }: { items: ActivityItem[]; onClose: () => void; onOpen: (app: WorkshopApp) => void; onApprove: (id: string, accepted: boolean) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <aside className="activity-rail" aria-label="Desktop activity">
    <header><div><span className="eyebrow">RIGHT NOW</span><h2>{items.length === 1 ? '1 app is working' : `${items.length} apps are working`}</h2></div><button onClick={onClose} aria-label="Close activity">Done</button></header>
    <div className="activity-list">
      {items.map((item) => <article key={item.app.id} className={item.waiting ? 'needs-you' : ''}>
        <button className="activity-open" onClick={() => onOpen(item.app)}>
          <AppIcon app={item.app} compact />
          <div><strong>{item.app.name}</strong><small>{item.message}</small></div>
          <time>{item.since ? formatElapsed(Math.max(0, now - new Date(item.since).getTime())) : ''}</time>
        </button>
        {item.approval
          ? <div className="activity-approval"><p>{item.approval.summary}</p><div><button onClick={() => onApprove(item.approval!.id, false)}>Not now</button><button className="primary" onClick={() => onApprove(item.approval!.id, true)}>Allow</button></div></div>
          : item.waiting ? <p className="activity-hint">Waiting on your answers — open it to continue.</p>
          : <div className="activity-track"><i /></div>}
      </article>)}
      {!items.length && <p className="activity-empty">Nothing running. The desktop is yours.</p>}
    </div>
  </aside>;
}

function formatElapsed(ms: number) { const seconds = Math.floor(ms / 1000); return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`; }

function Spotlight({ apps, onClose, onCreate, onOpen }: { apps: WorkshopApp[]; onClose: () => void; onCreate: (prompt: string) => void; onOpen: (app: WorkshopApp) => void }) {
  const [query, setQuery] = useState(''); const matches = apps.filter((app) => app.name.toLowerCase().includes(query.toLowerCase())).slice(0, 5);
  return <div className="overlay" onMouseDown={onClose}><section className="spotlight" onMouseDown={(e) => e.stopPropagation()}><div className="spotlight-input"><span>✦</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && query.trim()) onCreate(query); }} placeholder="Create or open anything" /><kbd>esc</kbd></div><div className="spotlight-results">{query && <button onClick={() => onCreate(query)}><span className="result-symbol">＋</span><div><strong>Build “{query}”</strong><small>Create a new app with Codex</small></div><b>↵</b></button>}{matches.map((app) => <button key={app.id} onClick={() => onOpen(app)}><AppIcon app={app} compact /><div><strong>{app.name}</strong><small>{app.description}</small></div><b>Open</b></button>)}</div></section></div>;
}

function Library({ apps, onClose, onOpen, onRestore }: { apps: WorkshopApp[]; onClose: () => void; onOpen: (app: WorkshopApp) => void; onRestore: (app: WorkshopApp) => void }) {
  const [query, setQuery] = useState(''); const [archived, setArchived] = useState(false); const shown = apps.filter((app) => app.archived === archived && app.name.toLowerCase().includes(query.toLowerCase()));
  return <div className="overlay sheet-overlay" onMouseDown={onClose}><section className="library-sheet" onMouseDown={(e) => e.stopPropagation()}><header><div><span className="eyebrow">WORKSHOP</span><h2>App Library</h2></div><button onClick={onClose}>Done</button></header><div className="library-tools"><input placeholder="Search apps" value={query} onChange={(e) => setQuery(e.target.value)} /><div><button className={!archived ? 'active' : ''} onClick={() => setArchived(false)}>Apps</button><button className={archived ? 'active' : ''} onClick={() => setArchived(true)}>Archive</button></div></div><div className="library-grid">{shown.map((app) => <button key={app.id} onClick={() => archived ? onRestore(app) : onOpen(app)}><AppIcon app={app} /><div><strong>{app.name}</strong><small>{app.description}</small></div><span>{archived ? 'Restore' : 'Open'}</span></button>)}</div>{!shown.length && <div className="library-empty">Nothing here yet.</div>}</section></div>;
}

function Settings({ status, theme, setTheme, sounds, setSounds, onClose }: { status: SystemStatus | null; theme: string; setTheme: (v: string) => void; sounds: boolean; setSounds: (v: boolean) => void; onClose: () => void }) {
  const agents: Array<[string, string, AgentState | undefined]> = [
    ['Codex', 'npm install -g @openai/codex', status?.agents?.codex ?? status?.codex],
    ['Claude Code', 'npm install -g @anthropic-ai/claude-code', status?.agents?.claude],
  ];
  return <div className="overlay sheet-overlay" onMouseDown={onClose}><section className="settings-sheet" onMouseDown={(e) => e.stopPropagation()}><header><div><span className="eyebrow">WORKSHOP</span><h2>Settings</h2></div><button onClick={onClose}>Done</button></header><div className="setting-row"><div><strong>Appearance</strong><small>Choose the desktop surface.</small></div><div className="segmented"><button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>Light</button><button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>Dark</button></div></div><div className="setting-row"><div><strong>Completion sounds</strong><small>Play a quiet chime when work finishes.</small></div><button className={`switch ${sounds ? 'on' : ''}`} onClick={() => setSounds(!sounds)} aria-label="Toggle sounds"><i /></button></div><div className="agent-panels">{agents.map(([name, install, state]) => {
    const ready = Boolean(state?.available && state?.authenticated);
    return <div key={name} className="codex-panel">
      <div className={`large-state ${ready ? 'ok' : ''}`}><i />{name}{ready && state?.accountType ? <em>{state.accountType}</em> : null}</div>
      <p>{ready ? `Workshop can build with ${name}.` : state?.error || `Install and sign in to ${name} to build with it.`}</p>
      {state && !state.available && <code>{install}</code>}
    </div>;
  })}</div><Connections /></section></div>;
}

// Outside services the desktop can reach. Workshop holds whatever the server
// needs; an app gets a scoped caller and only for connections it declares.
function Connections() {
  const [items, setItems] = useState<Connection[]>([]);
  const [adding, setAdding] = useState(false);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [picked, setPicked] = useState<CatalogEntry | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState({ id: '', label: '', command: '', args: '', env: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api.connections().then((result) => setItems(result.connections)).catch(() => setError('Could not read connections.'));
    api.catalog().then((result) => setCatalog(result.catalog)).catch(() => {});
  }, []);

  async function install(event: FormEvent) {
    event.preventDefault();
    if (!picked) return;
    setBusy(true); setError('');
    try {
      const values = Object.fromEntries(picked.inputs.map((input) => [input.key, answers[input.key] || '']));
      const secrets = Object.fromEntries(picked.secrets.map((secret) => [secret.key, answers[secret.key] || '']));
      const result = await api.addFromCatalog(picked.id, values, secrets);
      if (result.error) setError(result.error);
      setItems((await api.connections()).connections);
      setPicked(null); setAnswers({});
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not connect that.'); }
    finally { setBusy(false); }
  }

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const env = Object.fromEntries(draft.env.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
        const at = line.indexOf('=');
        return at > 0 ? [line.slice(0, at).trim(), line.slice(at + 1).trim()] : [line, ''];
      }));
      const result = await api.addConnection({ id: draft.id.trim(), label: draft.label.trim() || draft.id.trim(), command: draft.command.trim(), args: draft.args.split(' ').map((part) => part.trim()).filter(Boolean), env });
      if (result.error) setError(result.error);
      setItems((await api.connections()).connections);
      setDraft({ id: '', label: '', command: '', args: '', env: '' });
      setAdding(false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not add that connection.'); }
    finally { setBusy(false); }
  }

  async function remove(id: string) {
    await api.removeConnection(id).catch(() => {});
    setItems((await api.connections()).connections);
  }

  return <section className="connections">
    <header><div><strong>Connections</strong><small>Services your apps can reach. Added once here, granted per app.</small></div><button onClick={() => { setAdding((value) => !value); setPicked(null); setError(''); }}>{adding ? 'Cancel' : 'Add'}</button></header>
    {items.map((item) => <div key={item.id} className="connection-row">
      <div><strong>{item.label}</strong><small>{item.tools.length ? `${item.tools.length} tools · ${item.tools.slice(0, 3).join(', ')}${item.tools.length > 3 ? '…' : ''}` : item.error || 'Not started yet'}</small>
      {item.secrets?.length ? <small className="connection-secrets">{item.secrets.map((secret) => <span key={secret.key} className={secret.missing ? 'missing' : ''}>{secret.key} · {secret.missing ? `${secret.from} not set` : secret.from}</span>)}</small> : null}</div>
      <code>{item.id}</code>
      <button className="danger" onClick={() => remove(item.id)}>Remove</button>
    </div>)}
    {!items.length && !adding && <p className="connections-empty">No connections yet. Apps can still use the web and the model.</p>}
    {adding && !picked && <div className="catalog">
      {catalog.filter((entry) => !items.some((item) => item.id === entry.id)).map((entry) => <button key={entry.id} type="button" className="catalog-entry" onClick={() => { setPicked(entry); setAnswers({}); setError(''); }}>
        <div><strong>{entry.label}</strong><small>{entry.summary}</small></div>
        <code title="Published under an npm scope only this vendor can publish to">{entry.publisher}</code>
      </button>)}
      <button type="button" className="catalog-manual" onClick={() => setPicked({ id: '', label: '', publisher: '', summary: '', caution: '', inputs: [], secrets: [], preview: '' })}>Add something else manually…</button>
    </div>}

    {adding && picked && picked.id && <form className="connection-form catalog-install" onSubmit={install}>
      <div className="catalog-head"><strong>{picked.label}</strong><small>{picked.summary}</small></div>
      {picked.inputs.map((input) => <label key={input.key}><span>{input.label}</span><input value={answers[input.key] || ''} placeholder={input.placeholder} onChange={(event) => setAnswers({ ...answers, [input.key]: event.target.value })} required /></label>)}
      {picked.secrets.map((secret) => <label key={secret.key}><span>{secret.label}</span><input type="password" value={answers[secret.key] || ''} placeholder={`or $${secret.key} to read it from your .env`} onChange={(event) => setAnswers({ ...answers, [secret.key]: event.target.value })} required />{secret.hint && <small>{secret.hint}</small>}</label>)}
      {picked.caution && <p className="catalog-caution">{picked.caution}</p>}
      <code className="catalog-preview">{picked.preview}</code>
      <div className="catalog-actions"><button type="button" onClick={() => setPicked(null)}>Back</button><button className="primary" disabled={busy}>{busy ? 'Connecting…' : `Connect ${picked.label}`}</button></div>
    </form>}

    {adding && picked && !picked.id && <form className="connection-form" onSubmit={add}>
      <input placeholder="id (e.g. files)" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} required />
      <input placeholder="Name (e.g. Local Files)" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} />
      <input placeholder="command (e.g. npx)" value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} required />
      <input placeholder="arguments, space separated" value={draft.args} onChange={(event) => setDraft({ ...draft, args: event.target.value })} />
      <textarea placeholder={'Secrets, one per line:\nGITHUB_TOKEN=$GITHUB_TOKEN'} value={draft.env} onChange={(event) => setDraft({ ...draft, env: event.target.value })} />
      <small className="connection-hint">A value like <code>$GITHUB_TOKEN</code> is read from Workshop's own environment, so the secret stays in your <code>.env</code>. A literal value is stored in <code>.workshop/connections.json</code> instead.</small>
      <button disabled={busy || !draft.id.trim() || !draft.command.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
    </form>}
    {error && <p className="connection-error">{error}</p>}
  </section>;
}
