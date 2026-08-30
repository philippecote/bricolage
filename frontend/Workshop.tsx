import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AgentState, BuildEvent, BuildQuestion, CatalogEntry, Connection, DesktopReply, PendingAct, ModelPreset, Store, StoreServer, SystemStatus, Turn, WorkshopApp } from './types';

const STARTERS = [
  ['Daily pulse', 'Build a daily habit tracker with streaks and a calm weekly view'],
  ['Trip ledger', 'Create a shared-looking travel expense splitter with multiple currencies'],
  ['Tiny arcade', 'Make a beautiful keyboard-friendly block puzzle game with scores'],
  ['City air', 'Build an air quality dashboard using a public data API'],
];
const JOURNEY = [
  ['questions', 'Shape'], ['planning', 'Plan'], ['editing', 'Make'], ['checking', 'Check'], ['previewing', 'Preview'], ['complete', 'Done'],
] as const;

type WindowState = { id: string; x: number; y: number; width: number; height: number; minimized: boolean; maximized: boolean; z: number; file?: { grant: string; name: string } };
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

// An action's own return value is what an app asked for. Handing back the HTTP
// envelope meant `result.root` was undefined while `result.ok === false` was
// also false, so a failure looked like success and the app stalled. `output` is
// kept as a self-reference so apps that unwrap it keep working.
function actionResult(envelope: unknown) {
  const body = envelope as { output?: unknown; logs?: unknown; meta?: unknown };
  const output = body?.output;
  if (!output || typeof output !== 'object' || Array.isArray(output)) return envelope;
  return { ...(output as Record<string, unknown>), output, logs: body.logs, meta: body.meta };
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
  const [store, setStore] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('workshop-theme') || 'light');
  const [sounds, setSounds] = useState(localStorage.getItem('workshop-sounds') === 'true');
  const [dockHides, setDockHides] = useState(localStorage.getItem('workshop-dock-autohide') === 'true');
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
  const [turns, setTurns] = useState<Turn[]>([]);
  const conversationId = useRef<string | undefined>(undefined);
  const maxZ = useRef(Math.max(2, ...windows.map((win) => win.z)));
  const streams = useRef(new Map<string, EventSource>());
  const detailsLoaded = useRef(new Set<string>());
  // Read inside the keydown listener, which is bound once on mount.
  const spotlightRef = useRef(false); const libraryRef = useRef(false); const settingsRef = useRef(false); const storeRef = useRef(false);

  const inspectorApp = apps.find((app) => app.id === inspectorAppId) || null;
  const currentEvents = inspectorAppId ? builds[inspectorAppId] || [] : [];
  const ready = (state?: AgentState) => Boolean(state?.available && state?.authenticated);
  const agentsReady = [ready(status?.agents?.codex ?? status?.codex), ready(status?.agents?.claude)].filter(Boolean).length;
  const codexReady = agentsReady > 0;
  const agentLabel = agentsReady === 0 ? 'Setup needed' : agentsReady === 1 ? '1 agent ready' : `${agentsReady} agents ready`;

  useEffect(() => {
    let mounted = true;
    refresh().catch(() => setCreateError(builderMessage('Bricolage’s local builder is offline.')));
    api.status().then((next) => {
      if (!mounted) return;
      setStatus(next); setCreateError('');
      next.activeBuilds.forEach((build) => { seedBuild(build.appId, build.id, build.events || []); watchBuild(build.appId, build.id); });
    }).catch(() => { setStatus(null); setCreateError(builderMessage('Bricolage’s local builder is offline.')); });
    const timer = setInterval(() => setClock(new Date()), 30_000);
    const reconciler = setInterval(() => { reconcile(); }, 20_000);
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', onResize);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); setSpotlight((value) => !value); }
      if (event.key === 'Escape') {
        const overlayOpen = spotlightRef.current || libraryRef.current || settingsRef.current || storeRef.current;
        setSpotlight(false); setLibrary(false); setSettings(false); setStore(false); setActivityOpen(false);
        if (!overlayOpen) setWindows((current) => current.map((win) => (win.maximized ? { ...win, maximized: false } : win)));
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') { event.preventDefault(); setWindows((current) => { const top = [...current].filter((win) => !win.minimized).sort((a, b) => b.z - a.z)[0]; return top ? current.filter((win) => win.id !== top.id) : current; }); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'm') { event.preventDefault(); setWindows((current) => { const top = [...current].filter((win) => !win.minimized).sort((a, b) => b.z - a.z)[0]; return top ? current.map((win) => win.id === top.id ? { ...win, minimized: true } : win) : current; }); }
    };
    window.addEventListener('keydown', onKey);
    return () => { mounted = false; clearInterval(timer); clearInterval(reconciler); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', onResize); streams.current.forEach((stream) => stream.close()); };
  }, []);

  useEffect(() => {
    windows.forEach((win) => { if (!detailsLoaded.current.has(win.id)) loadDetails(win.id); });
  }, [windows]);

  useEffect(() => { spotlightRef.current = spotlight; libraryRef.current = library; settingsRef.current = settings; storeRef.current = store; }, [spotlight, library, settings, store]);

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('workshop-theme', theme); }, [theme]);
  useEffect(() => { localStorage.setItem('workshop-sounds', String(sounds)); }, [sounds]);
  useEffect(() => { localStorage.setItem('workshop-dock-autohide', String(dockHides)); }, [dockHides]);
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
        if (message.type === 'action') result = actionResult(await api.action(message.appId, message.payload.name, message.payload.payload));
        else if (message.type === 'storage.get') result = await api.storage(message.appId, 'get', { key: message.payload.key });
        else if (message.type === 'storage.set') result = await api.storage(message.appId, 'set', message.payload);
        else if (message.type === 'focus') { focusWindow(message.appId); return; }
        else if (message.type === 'open') { result = await openFile(message.payload); }
        else if (message.type === 'readFile') {
          // The desktop is same-origin with the host, so it can read the grant
          // and hand the text down to an app that cannot fetch anything itself.
          const response = await fetch(`/api/files/${encodeURIComponent(String(message.payload.grant))}`);
          if (!response.ok) throw new Error('That file could not be read.');
          result = { text: await response.text() };
        }
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
    console.info('[Bricolage trace] create:handler', { model, promptChars: clean.length, at: Date.now() });
    setCreating(true); setCreateError(''); setSpotlight(false);
    try {
      let result;
      try { result = await api.createDirect(clean, model); }
      catch { result = await api.create(clean, model); }
      console.info('[Bricolage trace] create:success', { appId: result.appId, buildId: result.buildId, at: Date.now() });
      adoptCreated(result);
    } catch (error) {
      console.info('[Bricolage trace] create:error', { message: error instanceof Error ? error.message : String(error), at: Date.now() });
      setCreateError(builderMessage(error instanceof Error ? error.message : 'Could not create app'));
    }
    finally { setCreating(false); }
  }

  // Everything the desktop agent does that lands on screen: a build starts and
  // streams, an edit reopens its window, an app comes to the front.
  function applyEffect(effect: DesktopReply['effect']) {
    if (!effect) return;
    if (effect.type === 'build' && effect.app && effect.buildId) {
      setApps((items) => [effect.app as WorkshopApp, ...items]);
      seedBuild(effect.appId!, effect.buildId, effect.build?.events || []);
      openApp(effect.app as WorkshopApp, true);
      watchBuild(effect.appId!, effect.buildId);
      return;
    }
    const app = apps.find((item) => item.id === effect.appId);
    if (!app) return;
    if (effect.type === 'edit' && effect.buildId) {
      setApps((items) => items.map((item) => item.id === app.id ? { ...item, status: 'building', error: null } : item));
      seedBuild(app.id, effect.buildId, effect.build?.events || []);
      openApp(app, true);
      watchBuild(app.id, effect.buildId);
      return;
    }
    if (effect.type === 'open') openApp(app);
    if (effect.type === 'action') loadDetails(app.id);
  }

  function receive(result: DesktopReply) {
    conversationId.current = result.conversationId;
    const looked = [...new Set(result.performed.map((step) => step.args.appId).filter(Boolean))] as string[];
    setTurns((current) => [...current, { id: result.conversationId + current.length, from: 'workshop', text: result.reply, looked, pending: result.pending }]);
    applyEffect(result.effect);
  }

  async function sayToDesktop(message: string) {
    setTurns((current) => [...current, { id: `you-${Date.now()}`, from: 'you', text: message }]);
    setComposer('');
    setRouting(true);
    try { receive(await api.say(message, conversationId.current, model)); }
    catch (error) { setTurns((current) => [...current, { id: `err-${Date.now()}`, from: 'workshop', text: error instanceof Error ? error.message : 'Something went wrong.' }]); }
    finally { setRouting(false); }
  }

  async function approveAct(pending: PendingAct) {
    setTurns((current) => current.map((turn) => turn.pending?.callId === pending.callId ? { ...turn, pending: null } : turn));
    setRouting(true);
    try { receive(await api.approve(pending, conversationId.current!, model)); }
    catch (error) { setTurns((current) => [...current, { id: `err-${Date.now()}`, from: 'workshop', text: error instanceof Error ? error.message : 'Could not do that.' }]); }
    finally { setRouting(false); }
  }

  function declineAct(pending: PendingAct) {
    setTurns((current) => current.map((turn) => turn.pending?.callId === pending.callId ? { ...turn, pending: null } : turn));
    sayToDesktop('No, not that.');
  }

  function submitComposer(event: FormEvent<HTMLFormElement>) {
    const clean = composer.trim();
    event.preventDefault();
    if (!clean || creating || routing) return;
    setCreateError('');
    sayToDesktop(clean);
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
      const result = await api.edit(inspectorApp.id, prompt, inspectorApp.model);
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

  // Resolving a handler is the host's job, so a finder does not have to know how
  // to render anything — and when nothing handles the type, that is a moment to
  // offer to build one rather than an error.
  async function openFile(ref: { connection?: string; path?: string }) {
    if (!ref?.connection || !ref?.path) throw new Error('open needs { connection, path }.');
    const result = await api.openFile(ref.connection, ref.path);
    if (!result.handler) {
      showToast(`Nothing opens .${result.ext} yet`);
      sayToDesktop(`I tried to open ${result.name} and nothing on my desktop handles .${result.ext} files. Would a small viewer for them be worth building?`);
      return { opened: false, reason: 'no-handler', ext: result.ext };
    }
    const app = apps.find((item) => item.id === result.handler!.id);
    if (!app) throw new Error('That viewer is no longer installed.');
    setWindows((current) => {
      const rest = current.filter((win) => win.id !== app.id);
      const memory = stored<Record<string, WindowState>>('workshop-window-positions', {})[app.id];
      const base = memory || { id: app.id, x: 92, y: 88, width: Math.min(app.window.width, innerWidth - 48), height: Math.min(app.window.height, innerHeight - 120), minimized: false, maximized: false, z: 0 };
      return [...rest, { ...base, id: app.id, minimized: false, z: ++maxZ.current, file: { grant: result.grant, name: result.name } }];
    });
    loadDetails(app.id);
    return { opened: true, handler: app.name, name: result.name };
  }

  function tidyIcons() { setIconPositions({}); showToast('Icons tidied'); }

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
      <div className="menu-left"><button className="wordmark" onClick={() => setLibrary(false)} aria-label="Bricolage home"><span>B</span> Bricolage</button><button onClick={() => setLibrary(true)}>Library</button><button onClick={() => setStore(true)}>Connections</button><button onClick={() => setSpotlight(true)}>Create</button></div>
      <div className="menu-right">{activity.length > 0 && <button className={`working-chip ${activity.some((item) => item.waiting) ? 'waiting' : ''}`} onClick={() => setActivityOpen((value) => !value)} aria-label="Show desktop activity"><i />{activity.some((item) => item.waiting) ? 'Needs you' : `${activity.length} working`}</button>}<button className={`codex-state ${codexReady ? 'online' : ''}`} onClick={() => setSettings(true)}><i />{agentLabel}</button><button onClick={() => setSpotlight(true)} className="shortcut">⌘ K</button><time>{clock.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} &nbsp; {clock.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></div>
    </header>

    <section className="desktop-content">
      <div className="welcome">
        <span className="eyebrow">YOUR WORKBENCH</span><h1>What should we make?</h1>
        <form className="hero-composer" onSubmit={submitComposer}>
          <textarea name="prompt" value={composer} readOnly={creating} onChange={(event) => setComposer(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={creating ? 'Starting your app…' : turns.length ? 'Say more…' : 'Ask for an app, or just think out loud…'} aria-label="Describe an app" />
          <input type="hidden" name="model" value={model} />
          <div className="composer-foot"><ModelPicker value={model} onChange={setModel} compact /><button className={`build-arrow ${creating || routing ? 'creating' : ''}`} aria-label={creating ? 'Creating app' : routing ? 'Thinking' : 'Build app'} disabled={!composer.trim() || creating || routing}>{creating || routing ? '✦' : '↑'}</button></div>
        </form>
        {(turns.length > 0 || routing) && <Conversation turns={turns} thinking={routing} apps={apps} onApprove={approveAct} onDecline={declineAct} onClear={() => { setTurns([]); conversationId.current = undefined; }} />}
        {createError && <div className="create-error" role="alert"><div><strong>Couldn’t start that app</strong><span>{createError} Start Bricolage with <code>npm start</code>, then try again.</span></div><button onClick={() => { setCreateError(''); create(); }}>Try again</button></div>}
        <div className="starter-list">{STARTERS.map(([name, prompt]) => <button key={name} onClick={() => sayToDesktop(prompt)}><span>{name}</span><small>{prompt}</small><b>↗</b></button>)}</div>
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
      return <section key={win.id} className={`app-window ${win.maximized ? 'maximized fullscreen' : ''} ${building ? 'building' : ''} ${activeWindowId === win.id ? 'active' : 'inactive'}`} style={win.maximized ? { zIndex: win.z } : { left: win.x, top: win.y, width: win.width, height: win.height, zIndex: win.z }} onPointerDown={() => focusWindow(win.id)} aria-label={`${app.name} window`}>
        <header className="window-bar" onPointerDown={(event) => startWindowDrag(event, win)} onDoubleClick={() => windowPatch(win.id, { maximized: !win.maximized })}>
          <div className="traffic"><button className="close" onClick={() => closeWindow(win.id)} aria-label="Close" /><button className="min" onClick={() => minimizeWindow(win.id)} aria-label="Minimize" /><button className="max" onClick={() => windowPatch(win.id, { maximized: !win.maximized })} aria-label="Maximize" /></div>
          <span className="window-title"><AppIcon app={app} compact />{app.name}</span>
          <button className={`inspector-toggle ${inspectorOpen ? 'active' : ''}`} onClick={() => setInspectorAppId(inspectorOpen ? null : app.id)} aria-label="Open build studio" title="Build studio">✦</button>
        </header>
        <div className="window-body"><iframe title={app.name} src={`/runtime/${app.id}?v=${app.revision}.${previewNonce[app.id] || 0}${win.file ? `&file=${encodeURIComponent(win.file.grant)}&name=${encodeURIComponent(win.file.name)}` : ''}`} sandbox="allow-scripts allow-forms allow-popups" />{inspectorOpen && <Inspector app={app} events={currentEvents} buildId={buildForApp[app.id]} revisions={revisions[app.id] || []} editing={editing} setEditing={setEditing} improve={improve} answer={(answers) => answerBuild(app.id, answers)} cancel={() => cancelBuild(app.id)} setModel={(next) => setAppModel(app, next)} pin={() => togglePin(app)} duplicate={() => duplicate(app)} archive={() => archive(app)} restore={(revision) => restoreRevision(app, revision)} approve={async (id, accepted) => { await api.approval(id, accepted); }} />}</div>
      </section>;
    })}

    <nav className={`dock ${dockHides ? 'autohide' : ''}`} aria-label="Dock">
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
      <button className="dock-item" onClick={() => setStore(true)} aria-label="Connections"><span className="store-icon">⇄</span><em>Connections</em></button>
      <button className="dock-item" onClick={() => setSettings(true)} aria-label="Settings"><span className="settings-icon">⚙</span><em>Settings</em></button>
    </nav>
    {activityOpen && <ActivityRail items={activity} onClose={() => setActivityOpen(false)} onOpen={(app) => { openApp(app, true); setActivityOpen(false); }} onApprove={resolveApproval} />}
    {spotlight && <Spotlight apps={visibleApps} onClose={() => setSpotlight(false)} onCreate={(prompt) => { setSpotlight(false); sayToDesktop(prompt); }} onOpen={(app) => { openApp(app); setSpotlight(false); }} />}
    {library && <Library apps={apps} onClose={() => setLibrary(false)} onTidy={tidyIcons} onOpen={openApp} onRestore={async (app) => { await api.patch(app.id, { archived: false }); refresh(); }} />}
    {store && <McpStore onClose={() => setStore(false)} />}
    {settings && <Settings status={status} theme={theme} setTheme={setTheme} sounds={sounds} setSounds={setSounds} dockHides={dockHides} setDockHides={setDockHides} onClose={() => setSettings(false)} onOpenStore={() => { setSettings(false); setStore(true); }} />}
    {toast && <div className="toast" role="status">{toast}</div>}
    {creating && <div className="creation-status" role="status" aria-live="polite"><div className="build-creature working"><i /><i /><span>⌁</span></div><div><strong>Making a cozy spot for your app</strong><span>Just a moment…</span></div></div>}
  </main>;
}

// Models reach for markdown whatever the instructions say. Rendered as React
// nodes rather than innerHTML, so a reply can never inject markup.
function RichText({ text }: { text: string }) {
  const lines = text.split('\n');
  return <>{lines.map((line, index) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const body = bullet ? bullet[1] : line;
    const parts = body.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean).map((chunk, i) => {
      if (chunk.startsWith('**') && chunk.endsWith('**')) return <b key={i}>{chunk.slice(2, -2)}</b>;
      if (chunk.startsWith('`') && chunk.endsWith('`')) return <code key={i}>{chunk.slice(1, -1)}</code>;
      return <span key={i}>{chunk}</span>;
    });
    if (!body.trim()) return <br key={index} />;
    return bullet ? <span key={index} className="bullet">{parts}</span> : <span key={index} className="line">{parts}</span>;
  })}</>;
}

const ACT_LABELS: Record<string, string> = {
  build_app: 'Build it',
  edit_app: 'Make that change',
  run_app_action: 'Go ahead',
  open_app: 'Open it',
};

// The conversation lives under the composer rather than in a panel of its own,
// so the desktop stays the thing on screen and the exchange stays close to where
// it was typed.
function Conversation({ turns, thinking, apps, onApprove, onDecline, onClear }: { turns: Turn[]; thinking: boolean; apps: WorkshopApp[]; onApprove: (pending: PendingAct) => void; onDecline: (pending: PendingAct) => void; onClear: () => void }) {
  const foot = useRef<HTMLDivElement>(null);
  useEffect(() => { foot.current?.scrollIntoView({ block: 'nearest' }); }, [turns.length, thinking]);

  return <section className="conversation" aria-label="Conversation" aria-live="polite">
    <header><span className="eyebrow">TOGETHER</span><button onClick={onClear}>Clear</button></header>
    <div className="turns">
      {turns.map((turn) => <article key={turn.id} className={turn.from}>
        {turn.looked && turn.looked.length > 0 && <p className="looked">Looked at {turn.looked.map((id) => apps.find((app) => app.id === id)?.name || id).join(', ')}</p>}
        {turn.text && <p className="said"><RichText text={turn.text} /></p>}
        {turn.pending && <div className="act">
          <button className="primary" onClick={() => onApprove(turn.pending!)}>{ACT_LABELS[turn.pending.tool] || 'Go ahead'}</button>
          <button onClick={() => onDecline(turn.pending!)}>No</button>
        </div>}
      </article>)}
      {thinking && <article className="workshop"><p className="thinking"><i /><i /><i /></p></article>}
      <div ref={foot} />
    </div>
  </section>;
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
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [storeOpen, setStoreOpen] = useState(false); const complete = questions.every((question) => answers[question.id]);
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
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const matches = useMemo(() => apps.filter((app) => app.name.toLowerCase().includes(query.toLowerCase())).slice(0, 6), [apps, query]);

  // One flat list, so the arrow keys move through exactly what you can see.
  const rows: Array<{ key: string; run: () => void }> = [
    ...matches.map((app) => ({ key: `app-${app.id}`, run: () => onOpen(app) })),
    ...(query.trim() ? [{ key: 'make', run: () => onCreate(query) }] : []),
  ];
  const active = Math.min(cursor, Math.max(0, rows.length - 1));
  useEffect(() => { setCursor(0); }, [query]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') { event.preventDefault(); setCursor((c) => (rows.length ? (c + 1) % rows.length : 0)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setCursor((c) => (rows.length ? (c - 1 + rows.length) % rows.length : 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); rows[active]?.run(); }
  }

  return <div className="overlay" onMouseDown={onClose}><section className="spotlight" onMouseDown={(e) => e.stopPropagation()}>
    <div className="spotlight-input">
      <span>✦</span>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Open an app, or describe a new one" aria-label="Search or create" />
      <kbd>esc</kbd>
    </div>
    <div className="spotlight-results" role="listbox">
      {matches.map((app, index) => <button key={app.id} role="option" aria-selected={rows[active]?.key === `app-${app.id}`} className={rows[active]?.key === `app-${app.id}` ? 'cursor' : ''} onMouseEnter={() => setCursor(index)} onClick={() => onOpen(app)}>
        <AppIcon app={app} compact /><div><strong>{app.name}</strong><small>{app.description}</small></div><b>Open</b>
      </button>)}
      {query.trim() && <button role="option" aria-selected={rows[active]?.key === 'make'} className={rows[active]?.key === 'make' ? 'cursor' : ''} onMouseEnter={() => setCursor(matches.length)} onClick={() => onCreate(query)}>
        <span className="result-symbol">＋</span><div><strong>Ask for “{query}”</strong><small>Talk to Bricolage about making it</small></div><b>↵</b>
      </button>}
      {!query.trim() && !matches.length && <p className="spotlight-hint">Type to find an app, or describe something new.</p>}
    </div>
  </section></div>;
}

const CATEGORY_LABELS: Record<string, string> = {
  utilities: 'Utilities', productivity: 'Productivity', creativity: 'Creativity', games: 'Games',
  information: 'Information', data: 'Data', wellbeing: 'Wellbeing', other: 'Other',
};

// A launcher rather than a list: scattered desktop icons stop scaling at about a
// dozen, and the categories come from what each app is actually for, because the
// shaping turn assigned one when it was built.
function Library({ apps, onClose, onOpen, onRestore, onTidy }: { apps: WorkshopApp[]; onClose: () => void; onOpen: (app: WorkshopApp) => void; onRestore: (app: WorkshopApp) => void; onTidy: () => void }) {
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [category, setCategory] = useState('all');
  const [cursor, setCursor] = useState(0);

  const pool = useMemo(() => apps.filter((app) => app.archived === archived), [apps, archived]);
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const app of pool) counts.set(app.category || 'other', (counts.get(app.category || 'other') || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [pool]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return pool
      .filter((app) => (category === 'all' || (app.category || 'other') === category))
      .filter((app) => !needle || app.name.toLowerCase().includes(needle) || (app.description || '').toLowerCase().includes(needle))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [pool, category, query]);

  useEffect(() => { setCursor(0); }, [query, category, archived]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (!shown.length) return;
    const perRow = 6;
    const moves: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow };
    if (event.key in moves) { event.preventDefault(); setCursor((c) => Math.max(0, Math.min(shown.length - 1, c + moves[event.key]))); }
    else if (event.key === 'Enter') { event.preventDefault(); const app = shown[cursor]; if (app) (archived ? onRestore(app) : onOpen(app)); }
  }

  return <div className="overlay launcher-overlay" onMouseDown={onClose}>
    <section className="launcher" onMouseDown={(event) => event.stopPropagation()}>
      <div className="launcher-search">
        <span>✦</span>
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search your apps" aria-label="Search apps" />
        <button onClick={onTidy} title="Reset dragged desktop icons back to the grid">Tidy icons</button>
        <button onClick={onClose}>Done</button>
      </div>

      <div className="launcher-cats">
        <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>All <b>{pool.length}</b></button>
        {categories.map(([name, count]) => <button key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>{CATEGORY_LABELS[name] || name} <b>{count}</b></button>)}
        <button className={`launcher-archive ${archived ? 'active' : ''}`} onClick={() => setArchived(!archived)}>{archived ? 'Archive' : 'Show archive'}</button>
      </div>

      <div className="launcher-grid">
        {shown.map((app, index) => <button key={app.id} className={index === cursor ? 'cursor' : ''} onMouseEnter={() => setCursor(index)} onClick={() => (archived ? onRestore(app) : onOpen(app))}>
          <AppIcon app={app} />
          <span>{app.name}</span>
          <small>{app.description}</small>
        </button>)}
      </div>
      {!shown.length && <p className="launcher-empty">{archived ? 'Nothing archived.' : 'Nothing matches that.'}</p>}
    </section>
  </div>;
}

function Settings({ status, theme, setTheme, sounds, setSounds, dockHides, setDockHides, onClose, onOpenStore }: { status: SystemStatus | null; theme: string; setTheme: (v: string) => void; sounds: boolean; setSounds: (v: boolean) => void; dockHides: boolean; setDockHides: (v: boolean) => void; onClose: () => void; onOpenStore: () => void }) {
  const agents: Array<[string, string, AgentState | undefined]> = [
    ['Codex', 'npm install -g @openai/codex', status?.agents?.codex ?? status?.codex],
    ['Claude Code', 'npm install -g @anthropic-ai/claude-code', status?.agents?.claude],
  ];
  return <div className="overlay sheet-overlay" onMouseDown={onClose}><section className="settings-sheet" onMouseDown={(e) => e.stopPropagation()}><header><div><span className="eyebrow">BRICOLAGE</span><h2>Settings</h2></div><button onClick={onClose}>Done</button></header><div className="setting-row"><div><strong>Appearance</strong><small>Choose the desktop surface.</small></div><div className="segmented"><button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>Light</button><button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>Dark</button></div></div><div className="setting-row"><div><strong>Hide the Dock</strong><small>Slides away until you reach the bottom of the screen.</small></div><button className={`switch ${dockHides ? 'on' : ''}`} onClick={() => setDockHides(!dockHides)} aria-label="Toggle dock auto-hide"><i /></button></div><div className="setting-row"><div><strong>Completion sounds</strong><small>Play a quiet chime when work finishes.</small></div><button className={`switch ${sounds ? 'on' : ''}`} onClick={() => setSounds(!sounds)} aria-label="Toggle sounds"><i /></button></div><div className="agent-panels">{agents.map(([name, install, state]) => {
    const ready = Boolean(state?.available && state?.authenticated);
    return <div key={name} className="codex-panel">
      <div className={`large-state ${ready ? 'ok' : ''}`}><i />{name}{ready && state?.accountType ? <em>{state.accountType}</em> : null}</div>
      <p>{ready ? `Bricolage can build with ${name}.` : state?.error || `Install and sign in to ${name} to build with it.`}</p>
      {state && !state.available && <code>{install}</code>}
    </div>;
  })}</div><Connections onOpenStore={onOpenStore} /></section></div>;
}

// Outside services the desktop can reach. Workshop holds whatever the server
// needs; an app gets a scoped caller and only for connections it declares.
function Connections({ onOpenStore }: { onOpenStore: () => void }) {
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
    <header><div><strong>Connections</strong><small>Services your apps can reach. Added once here, granted per app.</small></div><button className="primary" onClick={onOpenStore}>Browse catalog</button></header>
    {items.map((item) => <div key={item.id} className="connection-row">
      <div><strong>{item.label}</strong><small>{item.tools.length ? `${item.tools.length} tools · ${item.tools.slice(0, 3).join(', ')}${item.tools.length > 3 ? '…' : ''}` : item.error || 'Not started yet'}</small>
      {item.secrets?.length ? <small className="connection-secrets">{item.secrets.map((secret) => <span key={secret.key} className={secret.missing ? 'missing' : ''}>{secret.key} · {secret.missing ? `${secret.from} not set` : secret.from}</span>)}</small> : null}</div>
      <code>{item.id}</code>
      <button className="danger" onClick={() => remove(item.id)}>Remove</button>
    </div>)}
    {!items.length && !adding && <p className="connections-empty">No connections yet. Apps can still use the web and the model.</p>}
    <button type="button" className="catalog-manual" onClick={() => { setAdding((value) => !value); setPicked(null); setError(''); }}>{adding ? 'Never mind' : 'Or add one manually…'}</button>
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

// The Docker MCP Catalog as a grid you browse, not a command you type.
function McpStore({ onClose }: { onClose: () => void }) {
  const [store, setStore] = useState<Store | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [opened, setOpened] = useState<StoreServer | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => { api.store().then(setStore).catch(() => setError('Could not read the Docker catalog.')); }, []);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const server of store?.servers || []) counts.set(server.category, (counts.get(server.category) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, [store]);

  const shown = useMemo(() => (store?.servers || []).filter((server) => {
    if (category !== 'all' && server.category !== category) return false;
    const needle = query.trim().toLowerCase();
    return !needle || server.title.toLowerCase().includes(needle) || server.description.toLowerCase().includes(needle) || server.name.includes(needle);
  }).slice(0, 60), [store, query, category]);

  async function install(server: StoreServer) {
    setBusy(server.name); setError('');
    try {
      const result = await api.install(server.name, Object.fromEntries(server.secrets.map((secret) => [secret.name, secrets[secret.name] || ''])));
      if (result.error) setError(result.error);
      setStore(await api.store());
      setOpened(null); setSecrets({});
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not install that.'); }
    finally { setBusy(''); }
  }

  async function remove(server: StoreServer) {
    setBusy(server.name);
    try { await api.uninstall(server.name); setStore(await api.store()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not remove that.'); }
    finally { setBusy(''); }
  }

  const isOn = (server: StoreServer) => (store?.enabled || []).includes(server.name);

  return <div className="overlay sheet-overlay" onMouseDown={onClose}><section className="store-sheet" onMouseDown={(event) => event.stopPropagation()}>
    <header>
      <div><span className="eyebrow">DOCKER MCP CATALOG</span><h2>{store ? `${store.servers.length} servers` : 'Loading…'}</h2></div>
      <button onClick={onClose}>Done</button>
    </header>

    {store && !store.available && <p className="store-unavailable">{store.error || 'Docker Desktop is not running.'} Start Docker Desktop and reopen this.</p>}

    {store?.available && <>
      <div className="store-tools">
        <input placeholder="Search servers" value={query} onChange={(event) => setQuery(event.target.value)} />
        <div className="store-cats">
          <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>All</button>
          {categories.map(([name, count]) => <button key={name} className={category === name ? 'active' : ''} onClick={() => setCategory(name)}>{name} <b>{count}</b></button>)}
        </div>
      </div>

      <div className="store-grid">
        {shown.map((server) => <article key={server.name} className={isOn(server) ? 'installed' : ''}>
          <header>
            {server.icon ? <img src={server.icon} alt="" loading="lazy" /> : <span className="store-fallback">{server.title.slice(0, 1)}</span>}
            <div><strong>{server.title}</strong><small>{server.tools.length} tools · {compact(server.pulls)} pulls</small></div>
          </header>
          <p>{server.description}</p>
          <footer>
            {server.secrets.length > 0 && !isOn(server) && <span className="needs-key" title={server.secrets.map((secret) => secret.env).join(', ')}>needs a key</span>}
            {isOn(server)
              ? <button className="remove" disabled={busy === server.name} onClick={() => remove(server)}>{busy === server.name ? '…' : 'Remove'}</button>
              : <button className="primary" disabled={Boolean(busy)} onClick={() => (server.secrets.length ? setOpened(server) : install(server))}>{busy === server.name ? 'Installing…' : 'Install'}</button>}
          </footer>
        </article>)}
        {!shown.length && <p className="store-unavailable">Nothing matches that.</p>}
      </div>
    </>}

    {opened && <div className="store-keys">
      <strong>{opened.title} needs a key</strong>
      {opened.secrets.map((secret) => <label key={secret.name}>
        <span>{secret.env}</span>
        <input type="password" placeholder={secret.example || 'paste it here'} value={secrets[secret.name] || ''} onChange={(event) => setSecrets({ ...secrets, [secret.name]: event.target.value })} />
        {secret.description && <small>{stripLinks(secret.description)}</small>}
      </label>)}
      <small className="store-note">Stored by Docker Desktop, not by Bricolage.</small>
      <div><button onClick={() => { setOpened(null); setSecrets({}); }}>Cancel</button><button className="primary" disabled={Boolean(busy)} onClick={() => install(opened)}>{busy ? 'Installing…' : 'Install'}</button></div>
    </div>}

    {error && <p className="connection-error">{error}</p>}
  </section></div>;
}

function compact(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
// Catalog descriptions are markdown; the grid shows plain text.
function stripLinks(text: string) { return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)'); }
