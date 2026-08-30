import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { BuildEvent, BuildQuestion, ModelPreset, SystemStatus, WorkshopApp } from './types';

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
  const maxZ = useRef(Math.max(2, ...windows.map((win) => win.z)));
  const streams = useRef(new Map<string, EventSource>());
  const nativeCreatePending = useRef(false);
  const nativeCreateFrame = useRef<HTMLIFrameElement>(null);
  const nativeCreateTimer = useRef<number | null>(null);
  const nativeCreatePoller = useRef<number | null>(null);

  const inspectorApp = apps.find((app) => app.id === inspectorAppId) || null;
  const currentEvents = inspectorAppId ? builds[inspectorAppId] || [] : [];
  const codexReady = Boolean(status?.codex.available && status?.codex.authenticated);

  useEffect(() => {
    let mounted = true;
    refresh().catch(() => setCreateError(builderMessage('Workshop’s local builder is offline.')));
    api.status().then((next) => {
      if (!mounted) return;
      setStatus(next); setCreateError('');
      next.activeBuilds.forEach((build) => { seedBuild(build.appId, build.id, build.events || []); watchBuild(build.appId, build.id); });
    }).catch(() => { setStatus(null); setCreateError(builderMessage('Workshop’s local builder is offline.')); });
    const timer = setInterval(() => setClock(new Date()), 30_000);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSpotlight((value) => !value); }
      if (event.key === 'Escape') { setSpotlight(false); setLibrary(false); setSettings(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => { mounted = false; clearInterval(timer); if (nativeCreateTimer.current) window.clearTimeout(nativeCreateTimer.current); if (nativeCreatePoller.current) window.clearInterval(nativeCreatePoller.current); window.removeEventListener('keydown', onKey); streams.current.forEach((stream) => stream.close()); };
  }, []);

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
      const result = await api.create(clean, model);
      console.info('[Workshop trace] create:success', { appId: result.appId, buildId: result.buildId, at: Date.now() });
      adoptCreated(result);
    } catch (error) {
      console.info('[Workshop trace] create:error', { message: error instanceof Error ? error.message : String(error), at: Date.now() });
      setCreateError(builderMessage(error instanceof Error ? error.message : 'Could not create app'));
    }
    finally { setCreating(false); }
  }

  function submitComposer(event: FormEvent<HTMLFormElement>) {
    const clean = composer.trim();
    if (!clean || creating) { event.preventDefault(); return; }
    console.info('[Workshop trace] create:native-submit', { model, promptChars: clean.length, at: Date.now() });
    nativeCreatePending.current = true; setCreating(true); setCreateError(''); setSpotlight(false); setComposer(clean);
    if (nativeCreateTimer.current) window.clearTimeout(nativeCreateTimer.current);
    if (nativeCreatePoller.current) window.clearInterval(nativeCreatePoller.current);
    nativeCreatePoller.current = window.setInterval(receiveNativeCreate, 120);
    nativeCreateTimer.current = window.setTimeout(() => {
      if (!nativeCreatePending.current) return;
      nativeCreatePending.current = false; setCreating(false); setCreateError(builderMessage('Workshop did not receive the create response in time.'));
      if (nativeCreatePoller.current) window.clearInterval(nativeCreatePoller.current);
      console.info('[Workshop trace] create:native-timeout', { at: Date.now() });
    }, 10_000);
  }

  function receiveNativeCreate() {
    const frame = nativeCreateFrame.current;
    let frameUrl = '';
    try { frameUrl = frame?.contentWindow?.location.href || ''; } catch { frameUrl = 'unreadable'; }
    const text = frame?.contentDocument?.body?.textContent || frame?.contentWindow?.document?.body?.textContent || '';
    console.info('[Workshop trace] create:native-frame-load', { pending: nativeCreatePending.current, frameUrl, textChars: text.length, at: Date.now() });
    if (!nativeCreatePending.current || frameUrl === 'about:blank' || !text.trim()) return;
    try {
      const result = JSON.parse(text) as { appId?: string; buildId?: string; app?: WorkshopApp; build?: { events?: BuildEvent[] }; error?: string };
      if (result.error || !result.appId || !result.buildId || !result.app) throw new Error(result.error || 'Workshop returned an incomplete response.');
      nativeCreatePending.current = false; if (nativeCreateTimer.current) window.clearTimeout(nativeCreateTimer.current); if (nativeCreatePoller.current) window.clearInterval(nativeCreatePoller.current); console.info('[Workshop trace] create:native-success', { appId: result.appId, buildId: result.buildId, at: Date.now() });
      adoptCreated(result as { appId: string; buildId: string; app: WorkshopApp; build: { events?: BuildEvent[] } }); setCreating(false);
    } catch (error) {
      nativeCreatePending.current = false; if (nativeCreateTimer.current) window.clearTimeout(nativeCreateTimer.current); if (nativeCreatePoller.current) window.clearInterval(nativeCreatePoller.current); console.info('[Workshop trace] create:native-error', { message: error instanceof Error ? error.message : String(error), at: Date.now() });
      setCreateError(builderMessage(error instanceof Error ? error.message : 'Could not create app')); setCreating(false);
    }
  }

  function watchBuild(appId: string, buildId: string) {
    if (streams.current.has(buildId)) return;
    setBuildForApp((current) => ({ ...current, [appId]: buildId }));
    const stream = new EventSource(`/api/builds/${buildId}/events`); streams.current.set(buildId, stream);
    stream.onmessage = (message) => {
      const event: BuildEvent = JSON.parse(message.data);
      setBuilds((current) => ({ ...current, [appId]: [...(current[appId] || []).filter((item) => item.id !== event.id), event] }));
      if (!['questions', 'complete', 'failed', 'cancelled'].includes(event.phase)) setApps((items) => items.map((app) => app.id === appId ? { ...app, status: 'building' } : app));
      if (['complete', 'failed', 'cancelled'].includes(event.phase)) {
        stream.close(); streams.current.delete(buildId); refresh(); loadDetails(appId);
        if (event.phase === 'complete') showToast('Your app is ready ✦');
      }
    };
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
    try {
      const result = await api.app(id);
      setApps((items) => items.map((app) => app.id === id ? result.app : app));
      setRevisions((value) => ({ ...value, [id]: result.revisions }));
      if (result.latestBuild) seedBuild(id, result.latestBuild.id, result.latestBuild.events || []);
    } catch { /* app may still be creating */ }
  }

  function focusWindow(id: string) { setWindows((current) => current.map((win) => win.id === id ? { ...win, z: ++maxZ.current } : win)); }
  function closeWindow(id: string) { setWindows((current) => current.filter((win) => win.id !== id)); if (inspectorAppId === id) setInspectorAppId(null); }
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
  async function restoreRevision(app: WorkshopApp, revision: number) { await api.restore(app.id, revision); refresh(); windowPatch(app.id, { z: ++maxZ.current }); showToast(`Restored version ${revision}`); }

  const pinned = useMemo(() => apps.filter((app) => app.pinned && !app.archived).slice(0, 7), [apps]);
  const visibleApps = apps.filter((app) => !app.archived);

  return <main className="desktop" aria-label="Workshop desktop">
    <div className="wallpaper-orb orb-one" /><div className="wallpaper-orb orb-two" />
    <header className="menu-bar">
      <div className="menu-left"><button className="wordmark" onClick={() => setLibrary(false)} aria-label="Workshop home"><span>W</span> Workshop</button><button onClick={() => setLibrary(true)}>Library</button><button onClick={() => setSpotlight(true)}>Create</button></div>
      <div className="menu-right"><button className={`codex-state ${codexReady ? 'online' : ''}`} onClick={() => setSettings(true)}><i />{codexReady ? 'Codex ready' : 'Setup needed'}</button><button onClick={() => setSpotlight(true)} className="shortcut">⌘ K</button><time>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} &nbsp; {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
    </header>

    <section className="desktop-content">
      <div className="welcome">
        <span className="eyebrow">YOUR WORKBENCH</span><h1>What should we make?</h1>
        <form className="hero-composer" action="/workshop/build" method="post" target="workshop-create-result" onSubmit={submitComposer}>
          <textarea name="prompt" value={composer} readOnly={creating} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={creating ? 'Starting your app…' : 'Ask for an app…'} aria-label="Describe an app" />
          <input type="hidden" name="model" value={model} />
          <div className="composer-foot"><ModelPicker value={model} onChange={setModel} compact /><button className={`build-arrow ${creating ? 'creating' : ''}`} aria-label={creating ? 'Creating app' : 'Build app'} disabled={!composer.trim()}>{creating ? '✦' : '↑'}</button></div>
        </form>
        <iframe ref={nativeCreateFrame} name="workshop-create-result" title="Workshop create response" onLoad={receiveNativeCreate} hidden />
        {createError && <div className="create-error" role="alert"><div><strong>Couldn’t start that app</strong><span>{createError} Start Workshop with <code>npm start</code>, then try again.</span></div><button onClick={() => { setCreateError(''); create(); }}>Try again</button></div>}
        <div className="starter-list">{STARTERS.map(([name, prompt]) => <button key={name} onClick={() => create(prompt)}><span>{name}</span><small>{prompt}</small><b>↗</b></button>)}</div>
      </div>
    </section>

    <div className="desktop-apps" aria-label="Apps">{visibleApps.slice(0, 12).map((app, index) => {
      const position = iconPositions[app.id] || { x: Math.max(12, innerWidth - 112 - (index % 3) * 112), y: 62 + Math.floor(index / 3) * 96 };
      return <button key={app.id} className="desktop-icon" style={{ left: position.x, top: position.y, animationDelay: `${index * 45}ms` }} onPointerDown={(event) => startIconDrag(event, app, position)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openApp(app); }}><AppIcon app={app} /><span>{app.name}</span>{app.status === 'building' && <i className="build-dot" />}</button>;
    })}</div>

    {windows.map((win) => {
      const app = apps.find((item) => item.id === win.id); if (!app || win.minimized) return null;
      const inspectorOpen = inspectorAppId === app.id;
      return <section key={win.id} className={`app-window ${win.maximized ? 'maximized' : ''}`} style={win.maximized ? { zIndex: win.z } : { left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }} onPointerDown={() => focusWindow(win.id)} aria-label={`${app.name} window`}>
        <header className="window-bar" onPointerDown={(event) => startWindowDrag(event, win)} onDoubleClick={() => windowPatch(win.id, { maximized: !win.maximized })}>
          <div className="traffic"><button className="close" onClick={() => closeWindow(win.id)} aria-label="Close" /><button className="min" onClick={() => windowPatch(win.id, { minimized: true })} aria-label="Minimize" /><button className="max" onClick={() => windowPatch(win.id, { maximized: !win.maximized })} aria-label="Maximize" /></div>
          <span className="window-title"><AppIcon app={app} compact />{app.name}</span>
          <button className={`inspector-toggle ${inspectorOpen ? 'active' : ''}`} onClick={() => setInspectorAppId(inspectorOpen ? null : app.id)} aria-label="Open build studio" title="Build studio">✦</button>
        </header>
        <div className="window-body"><iframe title={app.name} src={`/runtime/${app.id}?v=${app.revision}`} sandbox="allow-scripts allow-forms allow-popups" />{inspectorOpen && <Inspector app={app} events={currentEvents} buildId={buildForApp[app.id]} revisions={revisions[app.id] || []} editing={editing} setEditing={setEditing} improve={improve} answer={(answers) => answerBuild(app.id, answers)} cancel={() => cancelBuild(app.id)} setModel={(next) => setAppModel(app, next)} pin={() => togglePin(app)} duplicate={() => duplicate(app)} archive={() => archive(app)} restore={(revision) => restoreRevision(app, revision)} approve={async (id, accepted) => { await api.approval(id, accepted); }} />}</div>
      </section>;
    })}

    <nav className="dock" aria-label="Dock"><button className="dock-item creator" onClick={() => setSpotlight(true)} aria-label="Create app"><span>✦</span><em>Create</em></button><i className="dock-separator" />{pinned.map((app) => <button key={app.id} className="dock-item" onClick={() => openApp(app)} aria-label={`Open ${app.name}`}><AppIcon app={app} /><em>{app.name}</em>{windows.some((win) => win.id === app.id) && <b />}</button>)}<i className="dock-separator" /><button className="dock-item" onClick={() => setLibrary(true)} aria-label="App library"><span className="library-icon">⌘</span><em>Library</em></button><button className="dock-item" onClick={() => setSettings(true)} aria-label="Settings"><span className="settings-icon">⚙</span><em>Settings</em></button></nav>
    {spotlight && <Spotlight apps={visibleApps} onClose={() => setSpotlight(false)} onCreate={create} onOpen={(app) => { openApp(app); setSpotlight(false); }} />}
    {library && <Library apps={apps} onClose={() => setLibrary(false)} onOpen={openApp} onRestore={async (app) => { await api.patch(app.id, { archived: false }); refresh(); }} />}
    {settings && <Settings status={status} theme={theme} setTheme={setTheme} sounds={sounds} setSounds={setSounds} onClose={() => setSettings(false)} />}
    {toast && <div className="toast" role="status">{toast}</div>}
    {creating && <div className="creation-status" role="status" aria-live="polite"><div className="build-creature working"><i /><i /><span>⌁</span></div><div><strong>Making a cozy spot for your app</strong><span>Just a moment…</span></div></div>}
  </main>;
}

function AppIcon({ app, compact = false }: { app: WorkshopApp; compact?: boolean }) { return <span className={`app-icon ${compact ? 'compact' : ''}`} style={{ '--accent': app.accent } as React.CSSProperties}><i>{app.icon}</i></span>; }

function ModelPicker({ value, onChange, compact = false }: { value: ModelPreset; onChange: (value: ModelPreset) => void; compact?: boolean }) {
  const options: Array<[ModelPreset, string, string, string]> = [
    ['luna-high', 'Luna', 'High', 'Quick, thoughtful, and the best value'],
    ['luna-max', 'Luna', 'Max', 'Same model thinking as hard as it can'],
    ['sol-medium', 'Sol', 'Medium', 'Flagship quality, balanced pace'],
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
    {!awaitingAnswers && events.length > 0 && <div className="activity-peek"><span className="eyebrow">RIGHT NOW</span>{events.slice(-3).reverse().map((event, index) => <p key={event.id} className={index === 0 ? 'latest' : ''}><i />{event.message}<time>{new Date(event.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>{event.approval && <span className="approval"><button onClick={() => approve(event.approval!.id, false)}>Not now</button><button onClick={() => approve(event.approval!.id, true)}>Allow</button></span>}</p>)}</div>}
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
  const ready = Boolean(status?.codex.available && status?.codex.authenticated);
  return <div className="overlay sheet-overlay" onMouseDown={onClose}><section className="settings-sheet" onMouseDown={(e) => e.stopPropagation()}><header><div><span className="eyebrow">WORKSHOP</span><h2>Settings</h2></div><button onClick={onClose}>Done</button></header><div className="setting-row"><div><strong>Appearance</strong><small>Choose the desktop surface.</small></div><div className="segmented"><button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>Light</button><button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>Dark</button></div></div><div className="setting-row"><div><strong>Completion sounds</strong><small>Play a quiet chime when work finishes.</small></div><button className={`switch ${sounds ? 'on' : ''}`} onClick={() => setSounds(!sounds)} aria-label="Toggle sounds"><i /></button></div><div className="codex-panel"><div className={`large-state ${ready ? 'ok' : ''}`}><i />{ready ? 'Codex is ready' : 'Codex setup needed'}</div><p>{ready ? 'Workshop is connected to your local Codex session.' : status?.codex.error || 'Install and sign in to Codex CLI to build new apps.'}</p>{!status?.codex.available && <code>npm install -g @openai/codex</code>}</div></section></div>;
}
