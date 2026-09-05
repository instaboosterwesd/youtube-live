import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, Route, Switch, useLocation, Router as WouterRouter } from "wouter";
import {
  Activity as ActivityIcon, ArrowRight, BookOpen, Check, CircleHelp, Clipboard,
  Download, FileVideo, FolderOpen, Gauge, LayoutDashboard,
  Link2, Menu, MonitorPlay, Pencil, Play, Plus, Radio, Search, Settings,
  ShieldCheck, Square, Trash2, Upload, Video, X,
} from "lucide-react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import NotFound from "@/pages/not-found";
import { downloadYoutubeVideo, getStreamStatus, startStream, stopStream } from "@workspace/api-client-react";

type LiveStatus = "live" | "scheduled" | "stopped";
type VideoStatus = "published" | "draft" | "archived";
type AspectRatio = "shorts" | "full" | "square";
type FacePosition = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "center";
type LiveChannel = {
  id: string; title: string; platform: string; status: LiveStatus; groupId: string;
  streamUrl: string; streamKey: string; viewers: number; startedAt: string | null;
  thumbnailColor: string; createdAt: string; aspectRatio?: AspectRatio; playbackSpeed?: number; faceGroupId?: string;
  facePosition?: FacePosition; faceSize?: number; durationHours?: number; autoRestart?: boolean;
};
type VideoItem = {
  id: string; title: string; duration: string; status: VideoStatus; groupId: string;
  sourceUrl: string; serverSource?: string; thumbnailColor: string; views: number; createdAt: string;
};
type VideoGroup = { id: string; name: string; description: string; videoIds: string[]; createdAt: string };
type Activity = { id: string; type: string; message: string; time: string };
type DataState = { channels: LiveChannel[]; videos: VideoItem[]; groups: VideoGroup[]; activities: Activity[] };
type LicenseSession = { licenseId: string; key: string; name: string; expiresAt: string; active: boolean; clientId?: string };

const queryClient = new QueryClient();
const now = () => new Date().toISOString();
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
const isLicenseActive = (license: LicenseSession | null) => Boolean(license && license.active && new Date(license.expiresAt).getTime() > Date.now());
const getClientId = () => {
  const existing = localStorage.getItem("signal-desk-client-id");
  if (existing) return existing;
  const next = `client-${crypto.randomUUID()}`;
  localStorage.setItem("signal-desk-client-id", next);
  return next;
};
async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
  const payload = await response.json().catch(() => ({})) as { error?: string } & T;
  if (!response.ok) throw new Error(payload.error || "The request could not be completed.");
  return payload;
}
const fmtTime = (date: string | null) => {
  if (!date) return "—";
  const mins = Math.max(1, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
};
const fmtNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);
const colors = ["#2c8b88", "#da814b", "#607a98", "#788d52", "#9a6591", "#3f6d66"];
// These demo files are intentionally not bundled in the public repository.
// Users can add a video through the upload or YouTube download flow instead.
const gtaVideoUrl = "";
const gtv5FaceVideoUrl = "";
const platformFromUrl = (url: string) => {
  const value = url.toLowerCase();
  if (value.includes("youtube")) return "YouTube";
  if (value.includes("twitch")) return "Twitch";
  if (value.includes("vimeo")) return "Vimeo";
  return "Custom RTMP";
};

const seed: DataState = {
  channels: [],
  videos: [
    {
      id: "vid-gta-local",
      title: "Local GTA video",
      duration: "00:00",
      status: "published",
      groupId: "gta",
      sourceUrl: gtaVideoUrl,
      serverSource: "__asset:gta",
      thumbnailColor: "#2c8b88",
      views: 0,
      createdAt: now(),
    },
    {
      id: "vid-gtv5-face",
      title: "WhatsApp Video 2026-09-04 at 11.30.43 PM",
      duration: "00:00",
      status: "published",
      groupId: "gtv5face",
      sourceUrl: gtv5FaceVideoUrl,
      serverSource: "__asset:gtv5face",
      thumbnailColor: "#9a6591",
      views: 0,
      createdAt: now(),
    },
  ],
  groups: [
    { id: "gta", name: "GTA", description: "Local GTA video category.", videoIds: ["vid-gta-local"], createdAt: now() },
    { id: "gtv5face", name: "GTV 5 face", description: "Face recording overlay video.", videoIds: ["vid-gtv5-face"], createdAt: now() },
  ],
  activities: [
    { id: "a-gtv5-face", type: "video", message: "GTV 5 face video is ready", time: "Just now" },
    { id: "a-gta", type: "group", message: "GTA category is ready with the local video", time: "Just now" },
  ],
};

function ensureBundledFaceVideo(value: DataState): DataState {
  const normalizedValue = {
    ...value,
    videos: value.videos.map((item) => item.id === "vid-gta-local" ? { ...item, serverSource: item.serverSource || "__asset:gta" } : item),
  };
  const existingGroup = normalizedValue.groups.find((group) => ["gtv5face", "gtv 5 face"].includes(group.name.trim().toLowerCase()));
  const groupId = existingGroup?.id || "gtv5face";
  const existingVideo = normalizedValue.videos.find((video) => video.id === "vid-gtv5-face" || video.title.toLowerCase() === "whatsapp video 2026-09-04 at 11.30.43 pm");
  const video = existingVideo || {
    id: "vid-gtv5-face",
    title: "WhatsApp Video 2026-09-04 at 11.30.43 PM",
    duration: "00:00",
    status: "published" as VideoStatus,
    groupId,
    sourceUrl: gtv5FaceVideoUrl,
    serverSource: "__asset:gtv5face",
    thumbnailColor: "#9a6591",
    views: 0,
    createdAt: now(),
  };
  const groups = existingGroup
    ? normalizedValue.groups.map((group) => group.id === groupId ? { ...group, videoIds: group.videoIds.includes(video.id) ? group.videoIds : [...group.videoIds, video.id] } : group)
    : [...normalizedValue.groups, { id: groupId, name: "GTV 5 face", description: "Face recording overlay video.", videoIds: [video.id], createdAt: now() }];
  const videos = existingVideo
    ? normalizedValue.videos.map((item) => item.id === video.id ? { ...item, groupId, sourceUrl: item.sourceUrl || gtv5FaceVideoUrl, serverSource: item.serverSource || "__asset:gtv5face" } : item)
    : [...normalizedValue.videos, video];
  const alreadyAnnounced = normalizedValue.activities.some((activity) => activity.message.toLowerCase().includes("gtv 5 face video"));
  return { ...normalizedValue, groups, videos, activities: alreadyAnnounced ? normalizedValue.activities : [{ id: uid("act"), type: "video", message: "GTV 5 face video is ready", time: "Just now" }, ...normalizedValue.activities].slice(0, 8) };
}

function normalizeWorkspace(value: unknown): DataState {
  if (!value || typeof value !== "object") return seed;
  const candidate = value as Partial<DataState>;
  return ensureBundledFaceVideo({
    channels: Array.isArray(candidate.channels) ? candidate.channels : [],
    videos: Array.isArray(candidate.videos) ? candidate.videos : [],
    groups: Array.isArray(candidate.groups) ? candidate.groups : [],
    activities: Array.isArray(candidate.activities) ? candidate.activities : [],
  });
}

function useLicense() {
  const [clientId] = useState(getClientId);
  const [license, setLicense] = useState<LicenseSession | null>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("signal-desk-license") || "null") as LicenseSession | null;
      return stored ? { ...stored, clientId: stored.clientId || getClientId() } : null;
    } catch { return null; }
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activate = async (key: string) => {
    setBusy(true); setError("");
    try {
      const result = await apiJson<LicenseSession>("/api/licenses/validate", { method: "POST", body: JSON.stringify({ key: key.trim(), clientId }) });
      const next = { ...result, clientId };
      setLicense(next); localStorage.setItem("signal-desk-license", JSON.stringify(next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This license could not be activated.");
      throw reason;
    } finally { setBusy(false); }
  };
  const renew = async () => {
    if (!license) return;
    setBusy(true); setError("");
    try {
      const result = await apiJson<LicenseSession>("/api/licenses/renew", { method: "POST", body: JSON.stringify({ key: license.key, clientId, days: 30 }) });
      const next = { ...result, clientId };
      setLicense(next); localStorage.setItem("signal-desk-license", JSON.stringify(next));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This license could not be renewed.");
    } finally { setBusy(false); }
  };
  const clear = () => { setLicense(null); localStorage.removeItem("signal-desk-license"); };
  return { clientId, license, busy, error, activate, renew, clear, setError };
}

function useWorkspace(license: LicenseSession | null, clearLicense: () => void) {
  const [data, setData] = useState<DataState>(seed);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState("");
  const user = license?.name || "";
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    if (!license || !isLicenseActive(license)) {
      setData(seed); setReady(true);
      return () => { cancelled = true; };
    }
    void apiJson<{ data: DataState | null }>("/api/licenses/workspace/get", {
      method: "POST",
      body: JSON.stringify({ key: license.key, clientId: license.clientId }),
    }).then((result) => {
      if (!cancelled) { setData(normalizeWorkspace(result.data)); setReady(true); }
    }).catch((reason) => {
      if (!cancelled) { setData(seed); setToast(reason instanceof Error ? reason.message : "Could not load the workspace."); setReady(true); }
    });
    return () => { cancelled = true; };
  }, [license?.licenseId, license?.key, license?.clientId]);
  useEffect(() => {
    if (!ready || !license || !isLicenseActive(license)) return;
    const timer = window.setTimeout(() => {
      void apiJson("/api/licenses/workspace", {
        method: "PUT",
        body: JSON.stringify({ key: license.key, clientId: license.clientId, data }),
      }).catch((reason) => setToast(reason instanceof Error ? reason.message : "Could not save the workspace."));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [data, ready, license?.licenseId, license?.key, license?.clientId]);
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2600); return () => clearTimeout(timer); }, [toast]);
  const addActivity = (message: string, type = "edit") => ({ id:uid("act"), type, message, time:"Just now" });
  const update = (next: Partial<DataState>, activity?: { message: string; type?: string }) => {
    setData((old) => ({ ...old, ...next, activities: activity ? [addActivity(activity.message, activity.type), ...old.activities].slice(0, 8) : old.activities }));
    if (activity) setToast(activity.message);
  };
  const logout = () => { clearLicense(); };
  return { data, user, toast, ready, update, logout, setToast, license };
}

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand" data-testid="brand">
    <div className="brand-mark"><Radio size={18} strokeWidth={2.5} /></div>
    {!compact && <div><div className="brand-name">Signal Desk</div><div className="brand-note">licensed control room</div></div>}
  </div>;
}

function Sidebar({ path, open, onClose, user, onLogout, data }: { path:string; open:boolean; onClose:()=>void; user:string; onLogout:()=>void; data:DataState }) {
  const nav = [
    { href:"/dashboard", label:"Overview", icon:LayoutDashboard },
    { href:"/live", label:"Live channels", icon:MonitorPlay, count:data.channels.filter(c=>c.status==="live").length || undefined },
    { href:"/videos", label:"Video library", icon:FileVideo },
  ];
  return <aside className={`sidebar ${open ? "open" : ""}`} data-testid="sidebar">
    <Brand />
    <div className="nav-label">Control room</div>
    <nav className="nav">
      {nav.map(({href,label,icon:Icon,count}) => <Link key={href} href={href} onClick={onClose} className={`nav-link ${path === href ? "active" : ""}`} data-testid={`link-${label.toLowerCase().replaceAll(" ","-")}`}><Icon size={16}/><span>{label}</span>{count !== undefined && <span className="nav-count">{count}</span>}</Link>)}
    </nav>
    <div className="nav-label" style={{marginTop:28}}>Workspace</div>
    <nav className="nav">
      <Link href="/settings" onClick={onClose} className={`nav-link ${path === "/settings" ? "active" : ""}`} data-testid="link-settings"><Settings size={16}/><span>Settings</span></Link>
      <button className="nav-link" onClick={() => { onLogout(); onClose(); }} data-testid="button-sign-out"><ShieldCheck size={16}/><span>Sign out</span></button>
    </nav>
    <div className="sidebar-bottom">
      <div className="workspace-card"><strong>Private workspace</strong><p>Your control room is saved in your Firebase license workspace.</p></div>
      <div className="mini-user"><span className="avatar">{user.slice(0,2).toUpperCase()}</span><span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{user}</span></div>
    </div>
  </aside>;
}

function Header({ title, onMenu }: { title:string; onMenu:()=>void }) {
  return <header className="topbar">
    <div className="crumb"><button className="icon-button mobile-menu" onClick={onMenu} data-testid="button-open-menu"><Menu size={18}/></button><span className="crumb-label">Signal Desk /</span><span className="crumb-title">{title}</span></div>
    <div className="top-actions"><div className="live-pulse"><span className="pulse"/><span>Broadcast monitor</span></div><button className="icon-button" data-testid="button-help" title="Help"><CircleHelp size={17}/></button></div>
  </header>;
}

function AppShell({ children, title, workspace }: { children:ReactNode; title:string; workspace:ReturnType<typeof useWorkspace> }) {
  const [path] = useLocation();
  const [menu, setMenu] = useState(false);
  return <div className="shell"><Sidebar path={path} open={menu} onClose={()=>setMenu(false)} user={workspace.user} onLogout={workspace.logout} data={workspace.data}/><main className="main"><Header title={title} onMenu={()=>setMenu(true)}/>{children}</main>{workspace.toast && <div className="toast" data-testid="status-toast"><Check size={14} style={{verticalAlign:"-2px", marginRight:7}}/>{workspace.toast}</div>}</div>;
}

function LicenseGate({ license, busy, error, onActivate, onRenew }: { license:LicenseSession|null; busy:boolean; error:string; onActivate:(key:string)=>Promise<void>; onRenew:()=>Promise<void> }) {
  const [key, setKey] = useState(license?.key || "");
  useEffect(() => { setKey(license?.key || ""); }, [license?.key]);
  const expired = Boolean(license && !isLicenseActive(license));
  const submit = (event:FormEvent) => {
    event.preventDefault();
    if (key.trim()) void onActivate(key).catch(() => undefined);
  };
  return <div className="login-page license-page">
    <section className="login-visual">
      <div className="login-logo"><div className="brand-mark"><Radio size={18}/></div><div><div className="brand-name">Signal Desk</div><div className="brand-note">licensed control room</div></div></div>
      <div className="login-copy"><div className="signal-line"><span/>LICENSED ACCESS · READY</div><h1>Bring your<br/><em>room on air.</em></h1><p>Enter your license key to open your private live control room. Your channels, videos, and settings stay separate from every other license.</p></div>
      <div className="signal-line"><span/>ONE LICENSE · ONE PRIVATE WORKSPACE</div>
    </section>
    <section className="login-panel"><div className="login-card">
      <p className="eyebrow">{expired ? "License expired" : "Enter your license"}</p>
      <h2>{expired ? "Renew your key." : "Unlock the room."}</h2>
      <p className="subtle">{expired ? "Your workspace is waiting. Renew this same key for 30 more days, or enter a different active key." : "Use the license key provided by the owner to continue."}</p>
      {error && <div className="error-note" data-testid="status-license-error">{error}</div>}
      <form className="login-form" onSubmit={submit}>
        <div className="field"><label htmlFor="license-key">License key</label><input id="license-key" value={key} onChange={e=>setKey(e.target.value)} placeholder="SD-XXXXXXXXXXXX" autoComplete="off" data-testid="input-license-key"/></div>
        <button className="button login-submit" type="submit" disabled={busy || !key.trim()} data-testid="button-activate-license">{busy ? "Checking…" : "Open workspace"} <ArrowRight size={16}/></button>
      </form>
      {expired && <button className="button secondary license-renew" onClick={()=>void onRenew()} disabled={busy} data-testid="button-renew-license">{busy ? "Renewing…" : "Renew your key · 30 days"} <Check size={14}/></button>}
      {license && <div className="license-status"><strong>{license.name}</strong><span>Key: <span className="mono">{license.key}</span></span><span>Expired {new Date(license.expiresAt).toLocaleDateString()}</span></div>}
    </div></section>
  </div>;
}

function OwnerPage() {
  const [password, setPassword] = useState("");
  const [authorizedPassword, setAuthorizedPassword] = useState("");
  const [licenses, setLicenses] = useState<LicenseSession[]>([]);
  const [name, setName] = useState("");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = async (ownerPassword: string) => {
    const result = await apiJson<{ licenses: LicenseSession[] }>("/api/licenses", { headers: { "X-Owner-Password": ownerPassword } });
    setLicenses(result.licenses);
  };
  const signIn = async (event:FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try { await load(password); setAuthorizedPassword(password); } catch (reason) { setError(reason instanceof Error ? reason.message : "Owner access was denied."); } finally { setBusy(false); }
  };
  const create = async (event:FormEvent) => {
    event.preventDefault(); if (!name.trim()) return;
    setBusy(true); setError("");
    try {
      await apiJson<LicenseSession>("/api/licenses", { method:"POST", headers: { "X-Owner-Password": authorizedPassword }, body: JSON.stringify({ name: name.trim(), days: Number(days) }) });
      setName(""); await load(authorizedPassword);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not create the license."); } finally { setBusy(false); }
  };
  const renew = async (licenseId:string) => {
    setBusy(true); setError("");
    try { await apiJson<LicenseSession>(`/api/licenses/${encodeURIComponent(licenseId)}/renew`, { method:"POST", headers: { "X-Owner-Password": authorizedPassword }, body: JSON.stringify({ days: 30 }) }); await load(authorizedPassword); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not renew the license."); } finally { setBusy(false); }
  };
  const remove = async (license:LicenseSession) => {
    if (!window.confirm(`Delete ${license.name} and its workspace data?`)) return;
    setBusy(true); setError("");
    try { await apiJson(`/api/licenses/${encodeURIComponent(license.licenseId)}`, { method:"DELETE", headers: { "X-Owner-Password": authorizedPassword } }); await load(authorizedPassword); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not delete the license."); } finally { setBusy(false); }
  };
  if (!authorizedPassword) return <div className="login-page owner-login-page"><section className="login-visual"><div className="login-logo"><div className="brand-mark"><Radio size={18}/></div><div><div className="brand-name">Signal Desk</div><div className="brand-note">owner console</div></div></div><div className="login-copy"><div className="signal-line"><span/>OWNER CONSOLE · PRIVATE</div><h1>Keep every<br/><em>key in hand.</em></h1><p>Create, renew, and remove license access for the control rooms you manage.</p></div><div className="signal-line"><span/>LICENSE ADMINISTRATION</div></section><section className="login-panel"><div className="login-card"><p className="eyebrow">Owner access</p><h2>Welcome, owner.</h2><p className="subtle">Enter the owner password to manage license keys.</p>{error&&<div className="error-note">{error}</div>}<form className="login-form" onSubmit={signIn}><div className="field"><label htmlFor="owner-password">Owner password</label><input id="owner-password" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoFocus data-testid="input-owner-password"/></div><button className="button login-submit" type="submit" disabled={busy||!password} data-testid="button-owner-login">{busy?"Checking…":"Open owner console"} <ArrowRight size={16}/></button></form><div className="demo-note"><ShieldCheck size={15}/><span>Public license access is enabled by the Firebase Realtime Database rules.</span></div><a href="/" className="section-link">Back to license access</a></div></section></div>;
  return <div className="owner-page"><header className="owner-topbar"><Brand/><a href="/" className="button secondary">Open license gate <ArrowRight size={14}/></a></header><main className="owner-content"><div className="page-head"><div><p className="eyebrow">Owner console</p><h1>License keys</h1><p className="subtle">Create access keys and keep each customer workspace separate.</p></div><div className="status live"><span className="status-dot"/>Firebase connected</div></div>{error&&<div className="error-note">{error}</div>}<section className="card section-card owner-create"><div className="section-head"><div><h2 className="section-title">Create license</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>The generated key can be used by more than one browser; each browser gets its own workspace.</p></div><Plus size={17} color="#6c8b83"/></div><form className="owner-create-form" onSubmit={create}><div className="field"><label>Customer / workspace name</label><input value={name} onChange={e=>setName(e.target.value)} placeholder="Studio A" data-testid="input-license-name"/></div><div className="field"><label>Valid for days</label><input type="number" min="1" max="3650" value={days} onChange={e=>setDays(e.target.value)} data-testid="input-license-days"/></div><button className="button" type="submit" disabled={busy||!name.trim()} data-testid="button-create-license"><Plus size={15}/> Create license</button></form></section><section className="card section-card owner-list"><div className="section-head"><div><h2 className="section-title">{licenses.length} license{licenses.length===1?"":"s"}</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>Existing access keys and renewal controls.</p></div><Clipboard size={17} color="#6c8b83"/></div>{licenses.length===0?<EmptyState icon={<ShieldCheck size={21}/>} title="No licenses yet" copy="Create the first key above to give a workspace access."/>:<div className="license-list">{licenses.map(license=>{const active=isLicenseActive(license);return <div className="license-row" key={license.licenseId}><div className="license-row-main"><div className="license-key-badge"><ShieldCheck size={15}/></div><div><strong>{license.name}</strong><span className="mono">{license.key}</span></div></div><div className={`status ${active?"live":"stopped"}`}><span className="status-dot"/>{active?"Active":"Expired"} · {new Date(license.expiresAt).toLocaleDateString()}</div><div className="actions"><button className="button secondary small" onClick={()=>void renew(license.licenseId)} disabled={busy}>Renew 30 days</button><button className="icon-button" onClick={()=>void remove(license)} disabled={busy} title="Delete license" data-testid={`button-delete-license-${license.licenseId}`}><Trash2 size={13}/></button></div></div>})}</div>}</section></main></div>;
}

function Metric({ label, value, detail, dim }: { label:string; value:string|number; detail:string; dim?:boolean }) { return <div className="card metric" data-testid={`metric-${label.toLowerCase().replaceAll(" ","-")}`}><div className="metric-kicker">{label}</div><div className="metric-value">{value}</div><div className={`metric-delta ${dim ? "dim":""}`}>{detail}</div></div>; }

function ActivityList({ activities }: { activities:Activity[] }) {
  const Icon = ({type}:{type:string}) => type==="live" ? <Radio size={14}/> : type==="video" ? <FileVideo size={14}/> : type==="group" ? <FolderOpen size={14}/> : <Pencil size={14}/>;
  return <div className="activity">{activities.map(a=><div className="activity-item" key={a.id} data-testid={`activity-${a.id}`}><div className="activity-icon"><Icon type={a.type}/></div><div><p className="activity-message">{a.message}</p><div className="activity-time">{a.time}</div></div></div>)}</div>;
}

function Dashboard({ workspace }: { workspace:ReturnType<typeof useWorkspace> }) {
  const {data, update} = workspace;
  const live = data.channels.filter(c=>c.status==="live"); const viewers = live.reduce((a,c)=>a+c.viewers,0);
  return <AppShell title="Overview" workspace={workspace}><div className="page"><div className="page-head"><div><p className="eyebrow">Tuesday · 21 May 2024</p><h1>Good morning, {workspace.user.split("@")[0]}.</h1><p className="subtle">The room is quiet. One channel is currently on air.</p></div><Link href="/live" className="button" data-testid="link-go-live"><Radio size={15}/> Manage live room</Link></div>
    <div className="metric-grid"><Metric label="On air now" value={live.length} detail={live.length ? "Signal is healthy" : "Nothing is live"} /><Metric label="Current viewers" value={fmtNumber(viewers)} detail={live.length ? "Across live channels" : "Ready when you are"} dim={!live.length}/><Metric label="Library videos" value={data.videos.length} detail={`${data.videos.filter(v=>v.status==="published").length} published`} /><Metric label="This month" value={fmtNumber(data.videos.reduce((a,v)=>a+v.views,0))} detail="Total library views" /> </div>
    <div className="split-grid"><section className="card section-card"><div className="section-head"><div><h2 className="section-title">Live channels</h2><p className="subtle" style={{margin: "5px 0 0", fontSize:11}}>Your broadcast surface, at a glance.</p></div><Link href="/live" className="section-link" data-testid="link-view-all-live">View all <ArrowRight size={12} style={{verticalAlign:"-2px"}}/></Link></div>{live.length ? <div className="live-list">{live.map(c=><div className="live-row" key={c.id} data-testid={`live-row-${c.id}`}><div className="thumb" style={{background:c.thumbnailColor}}><Radio size={16}/></div><div><div className="row-title">{c.title}</div><div className="row-meta">{c.platform} · live for {fmtTime(c.startedAt)}</div></div><div className="status live"><span className="status-dot"/>Live</div><div className="row-viewers">{fmtNumber(c.viewers)}<br/><span style={{fontSize:9,color:"#93a09a"}}>viewers</span></div></div>)}</div> : <EmptyState icon={<Radio size={21}/>} title="Nothing is live" copy="Start a channel when the room is ready." action="Open live room" href="/live"/>}<div className="quick-actions"><Link href="/live" className="quick" data-testid="quick-new-channel"><Plus size={15}/> New channel</Link><Link href="/videos" className="quick" data-testid="quick-add-video"><Upload size={15}/> Add to library</Link></div></section>
      <section className="card section-card"><div className="section-head"><div><h2 className="section-title">Recent activity</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>A small paper trail for the room.</p></div><ActivityIcon size={17} color="#6c8b83"/></div><ActivityList activities={data.activities}/></section></div>
    </div></AppShell>;
}

function EmptyState({ icon, title, copy, action, href, onClick }: {icon:ReactNode; title:string; copy:string; action?:string; href?:string; onClick?:()=>void}) { return <div className="empty"><div className="empty-art">{icon}</div><h3>{title}</h3><p className="subtle">{copy}</p>{action && (href ? <Link href={href} className="button secondary" data-testid="link-empty-action">{action} <ArrowRight size={14}/></Link> : <button className="button secondary" onClick={onClick} data-testid="button-empty-action">{action} <ArrowRight size={14}/></button>)}</div>; }

function Modal({ title, children, footer, onClose }: {title:string; children:ReactNode; footer:ReactNode; onClose:()=>void}) { return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><h2>{title}</h2><button className="icon-button" onClick={onClose} data-testid="button-close-modal"><X size={17}/></button></div><div className="modal-body">{children}</div><div className="modal-foot">{footer}</div></div></div>; }

function ChannelPreview({ mainUrl, faceUrl, ratio, facePosition, faceSize }: { mainUrl?: string; faceUrl?: string; ratio:AspectRatio; facePosition:FacePosition; faceSize:number }) {
  return <div className={`channel-preview preview-${ratio}`}>
    <div className="preview-grid" />
    {mainUrl ? <video className="preview-main-video" src={mainUrl} autoPlay muted loop playsInline /> : <div className="preview-empty"><Video size={18}/><span>Select a main video category</span></div>}
    {faceUrl && <video className={`preview-face-video position-${facePosition}`} style={{width:`${faceSize}%`}} src={faceUrl} autoPlay muted loop playsInline />}
    <div className="preview-label"><span className="pulse" />Live composition preview</div>
    <div className="preview-ratio">{ratio === "shorts" ? "9:16 Shorts" : ratio === "square" ? "1:1 Square" : "16:9 Full"}</div>
  </div>;
}

function ChannelModal({ channel, groups, videos, onSave, onClose }: {channel?:LiveChannel; groups:VideoGroup[]; videos:VideoItem[]; onSave:(c:LiveChannel)=>void; onClose:()=>void}) {
  const [form,setForm] = useState({
    groupId:channel?.groupId||"",
    streamUrl:channel?.streamUrl||"https://a.upload.youtube.com/http_upload_hls?cid=&copy=0&file=",
    aspectRatio:channel?.aspectRatio||"full" as AspectRatio,
    playbackSpeed:channel?.playbackSpeed||1,
    faceGroupId:channel?.faceGroupId||"",
    facePosition:channel?.facePosition||"bottom-right" as FacePosition,
    faceSize:channel?.faceSize||25,
    durationHours:channel?.durationHours||1,
    autoRestart:channel?.autoRestart||false,
  });
  const set=(key:string,value:string|number|boolean)=>setForm(f=>({...f,[key]:value}));
  const selectedGroup = groups.find(g=>g.id===form.groupId);
  const faceGroup = groups.find(g=>g.id===form.faceGroupId);
  const mainVideos = selectedGroup?.videoIds.map(id=>videos.find(v=>v.id===id)).filter((video): video is VideoItem=>Boolean(video)) || [];
  const faceVideos = faceGroup?.videoIds.map(id=>videos.find(v=>v.id===id)).filter((video): video is VideoItem=>Boolean(video)) || [];
  const mainVideo = mainVideos[0];
  const faceVideo = faceVideos[0];
  const mainServerReady = mainVideos.length > 0 && mainVideos.every(video=>Boolean(video.serverSource));
  const faceServerReady = !form.faceGroupId || (faceVideos.length > 0 && faceVideos.every(video=>Boolean(video.serverSource)));
  const submit=(e:FormEvent)=>{
    e.preventDefault();
    if(!form.streamUrl.trim() || !form.groupId) return;
    const platform=platformFromUrl(form.streamUrl);
    onSave({
      id:channel?.id||uid("ch"), title:channel?.title||`${platform} channel`, platform,
      status:channel?.status||"stopped", groupId:form.groupId, streamUrl:form.streamUrl.trim(),
      streamKey:channel?.streamKey||"", viewers:channel?.viewers||0, startedAt:channel?.startedAt||null,
      thumbnailColor:channel?.thumbnailColor||colors[0], createdAt:channel?.createdAt||now(),
       aspectRatio:form.aspectRatio, playbackSpeed:Number(form.playbackSpeed), faceGroupId:form.faceGroupId || undefined,
      facePosition:form.facePosition, faceSize:Number(form.faceSize), durationHours:Number(form.durationHours),
      autoRestart:form.autoRestart,
    });
  };
  return <Modal title={channel ? "Update channel" : "Add live channel"} onClose={onClose} footer={<><button className="button ghost" onClick={onClose} data-testid="button-cancel-channel">Cancel</button><button className="button" type="submit" form="channel-form" data-testid="button-save-channel">{channel ? "Save changes" : "Add channel"} <Check size={14}/></button></>}><form id="channel-form" onSubmit={submit}>
    <div className="form-grid">
      <div className="field full"><label>Live URL</label><input autoFocus required value={form.streamUrl} onChange={e=>set("streamUrl",e.target.value)} placeholder="https://a.upload.youtube.com/http_upload_hls?...&file=" data-testid="input-stream-url"/></div>
      <div className="field"><label>Main video category</label><select required value={form.groupId} onChange={e=>set("groupId",e.target.value)} data-testid="select-channel-group"><option value="">Select a category</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
       <div className="field"><label>Live format</label><select value={form.aspectRatio} onChange={e=>set("aspectRatio",e.target.value as AspectRatio)} data-testid="select-channel-ratio"><option value="shorts">Shorts · 9:16 vertical</option><option value="full">Big live · 16:9 landscape</option><option value="square">Square · 1:1</option></select></div>
       <div className="field"><label>Video speed</label><select value={form.playbackSpeed} onChange={e=>set("playbackSpeed",Number(e.target.value))} data-testid="select-channel-speed"><option value="0.5">0.5× slow</option><option value="0.75">0.75×</option><option value="1">1× normal</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2× fast</option></select></div>
      <div className="field full"><label>Face video category <span className="label-optional">optional overlay</span></label><select value={form.faceGroupId} onChange={e=>set("faceGroupId",e.target.value)} data-testid="select-channel-face-group"><option value="">No face overlay</option>{groups.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></div>
      <div className="field"><label>Face position</label><select disabled={!form.faceGroupId} value={form.facePosition} onChange={e=>set("facePosition",e.target.value as FacePosition)} data-testid="select-face-position"><option value="top-left">Top left</option><option value="top-right">Top right</option><option value="bottom-left">Bottom left</option><option value="bottom-right">Bottom right</option><option value="center">Center</option></select></div>
      <div className="field"><label>Face size · {form.faceSize}%</label><input disabled={!form.faceGroupId} type="range" min="10" max="60" step="1" value={form.faceSize} onChange={e=>set("faceSize",Number(e.target.value))} data-testid="input-face-size"/></div>
      <div className="field"><label>Stream duration</label><select value={form.durationHours} onChange={e=>set("durationHours",Number(e.target.value))} data-testid="select-stream-duration"><option value="0.5">30 minutes</option><option value="1">1 hour</option><option value="2">2 hours</option><option value="4">4 hours</option><option value="8">8 hours</option><option value="12">12 hours</option><option value="24">24 hours</option></select></div>
      <div className="field field-check"><label>After duration</label><label className="check-control"><input type="checkbox" checked={form.autoRestart} onChange={e=>set("autoRestart",e.target.checked)} data-testid="toggle-auto-restart"/><span><strong>Auto-start again</strong><small>Restart the stream after the selected duration.</small></span></label></div>
    </div>
    <ChannelPreview mainUrl={mainVideo?.sourceUrl} faceUrl={faceVideo?.sourceUrl} ratio={form.aspectRatio} facePosition={form.facePosition} faceSize={Number(form.faceSize)} />
    {(!mainServerReady || !faceServerReady) && <div className="error-note stream-source-warning"><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>Preview is ready, but Start needs this category to be server-ready. Re-add the video from Video library once so the local stream server can use it.</div>}
     <div className="form-note"><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>Videos in the selected category play in their saved order and loop back to the first after the last. Face placement and size are shown in the preview. Browser-added videos are available for preview here; server streaming currently requires a server-side source.</div>
  </form></Modal>;
}

function ConfirmModal({title, copy, onConfirm, onClose}: {title:string;copy:string;onConfirm:()=>void;onClose:()=>void}) { return <Modal title={title} onClose={onClose} footer={<><button className="button ghost" onClick={onClose} data-testid="button-cancel-confirm">Keep it</button><button className="button danger" onClick={onConfirm} data-testid="button-confirm-delete"><Trash2 size={14}/> Delete</button></>}><p className="confirm-copy">{copy}</p><div className="form-note"><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>This action cannot be undone from the workspace.</div></Modal>; }

function LivePage({workspace}:{workspace:ReturnType<typeof useWorkspace>}) {
  const {data,update}=workspace; const [editing,setEditing]=useState<LiveChannel|undefined>(); const [showForm,setShowForm]=useState(false); const [deleting,setDeleting]=useState<LiveChannel|undefined>(); const [busy,setBusy]=useState<string[]>([]);
  const save=(channel:LiveChannel)=>{const exists=data.channels.some(c=>c.id===channel.id); update({channels:exists?data.channels.map(c=>c.id===channel.id?channel:c):[channel,...data.channels]}, {message:exists?`${channel.title} was updated`:`${channel.title} was added`,type:"edit"}); setShowForm(false);setEditing(undefined);};
  const start=async(c:LiveChannel)=>{if(busy.includes(c.id))return;setBusy(ids=>[...ids,c.id]);try{
    const category=data.groups.find(g=>g.id===c.groupId)?.name;
    const faceCategory=c.faceGroupId?data.groups.find(g=>g.id===c.faceGroupId)?.name:undefined;
    if(!category)throw new Error("Choose a video category before starting.");
     const mainGroup=data.groups.find(g=>g.id===c.groupId);
     const faceGroup=c.faceGroupId?data.groups.find(g=>g.id===c.faceGroupId):undefined;
     const mainVideos=(mainGroup?.videoIds||[]).map(id=>data.videos.find(v=>v.id===id)).filter((video): video is VideoItem=>Boolean(video));
     const faceVideos=(faceGroup?.videoIds||[]).map(id=>data.videos.find(v=>v.id===id)).filter((video): video is VideoItem=>Boolean(video));
     const mainVideo=mainVideos[0];
     const faceVideo=faceVideos[0];
     if(!mainVideos.length)throw new Error("Choose a category with at least one video before starting.");
     if(!mainVideos.every(video=>video.serverSource))throw new Error("Every video in the selected category must be server-ready before starting.");
     if(faceVideos.length&&!faceVideos.every(video=>video.serverSource))throw new Error("Every video in the face category must be server-ready before starting.");
    const result=await startStream({
       streamId:c.id, ingestUrl:c.streamUrl, category, videoSource:mainVideo?.serverSource,
       videoSources:mainVideos.map(video=>video.serverSource).filter((source): source is string=>Boolean(source)),
       faceCategory, faceSource:faceVideo?.serverSource,
       faceSources:faceVideos.map(video=>video.serverSource).filter((source): source is string=>Boolean(source)),
       playbackSpeed:c.playbackSpeed||1, aspectRatio:c.aspectRatio||"full", facePosition:c.facePosition||"bottom-right",
      faceScale:(c.faceSize||25)/100, durationMinutes:(c.durationHours||1)*60,
      autoRestart:Boolean(c.autoRestart),
    });
    if(result.status!=="running")throw new Error(result.message);
    update({channels:data.channels.map(x=>x.id===c.id?{...x,status:"live",viewers:0,startedAt:now()}:x)},{message:`${c.title} is now streaming from the ${category} video`,type:"live"});
  }catch(error){workspace.setToast(error instanceof Error?error.message:"Could not start the real stream.");}finally{setBusy(ids=>ids.filter(id=>id!==c.id));}};
  const stop=async(c:LiveChannel)=>{if(busy.includes(c.id))return;setBusy(ids=>[...ids,c.id]);try{await stopStream({streamId:c.id});update({channels:data.channels.map(x=>x.id===c.id?{...x,status:"stopped",viewers:0}:x)},{message:`${c.title} was taken off air`,type:"edit"});}catch(error){workspace.setToast(error instanceof Error?error.message:"Could not stop the stream.");}finally{setBusy(ids=>ids.filter(id=>id!==c.id));}};
  useEffect(()=>{const liveChannels=data.channels.filter(c=>c.status==="live");if(!liveChannels.length)return;const timer=window.setInterval(()=>{void Promise.all(liveChannels.map(async c=>{try{const result=await getStreamStatus(c.id);if(result.status!=="running"){update({channels:data.channels.map(x=>x.id===c.id?{...x,status:result.status==="failed"?"stopped":"stopped",viewers:0}:x)},{message:`${c.title} stream process ${result.status}`,type:"edit"});}}catch{ /* Keep the visible state until the API is reachable again. */ }}));},5000);return()=>window.clearInterval(timer);},[data.channels,update]);
  const groupsById=useMemo(()=>Object.fromEntries(data.groups.map(g=>[g.id,g.name])),[data.groups]);
  return <AppShell title="Live channels" workspace={workspace}><div className="page"><div className="page-head"><div><p className="eyebrow">Broadcast operations</p><h1>Live channels</h1><p className="subtle">Prepare your destinations, then take the room live with confidence.</p></div><button className="button" onClick={()=>{setEditing(undefined);setShowForm(true)}} data-testid="button-add-channel"><Plus size={16}/> Add channel</button></div>
    <div className="card section-card"><div className="section-head"><div><h2 className="section-title">{data.channels.length} channel{data.channels.length===1?"":"s"}</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>{data.channels.filter(c=>c.status==="live").length} currently broadcasting · {data.channels.filter(c=>c.status==="scheduled").length} scheduled</p></div><div className="status live"><span className="status-dot"/>{data.channels.filter(c=>c.status==="live").length ? "Room monitored" : "Room quiet"}</div></div>{data.channels.length===0?<EmptyState icon={<MonitorPlay size={21}/>} title="Your live room is empty" copy="Add a destination to start preparing your first broadcast." action="Add first channel" onClick={()=>setShowForm(true)}/>:<div className="table-wrap"><table className="data-table"><thead><tr><th>Channel</th><th>Platform</th><th>Status</th><th>Audience</th><th>Category</th><th>Live URL</th><th/></tr></thead><tbody>{data.channels.map(c=><tr key={c.id} data-testid={`row-channel-${c.id}`}><td><div style={{display:"flex",alignItems:"center",gap:10}}><div className="thumb" style={{background:c.thumbnailColor,width:34,height:34}}><Radio size={14}/></div><div><div className="table-title">{c.title}</div><div className="table-sub">{c.status==="live" ? `Live for ${fmtTime(c.startedAt)}` : "Ready to broadcast"}</div></div></div></td><td><span className="mono" style={{fontSize:11}}>{c.platform}</span></td><td><div className={`status ${c.status}`}><span className="status-dot"/>{c.status}</div></td><td><span className="mono">{c.status==="live"?fmtNumber(c.viewers):"—"}</span></td><td><span className="table-sub">{groupsById[c.groupId]||"Unassigned"}</span></td><td><span className="table-sub url-cell" title={c.streamUrl}>{c.streamUrl}</span></td><td><div className="actions">{c.status==="live"?<button className="button warn small" onClick={()=>stop(c)} data-testid={`button-stop-${c.id}`}><Square size={12}/> Stop</button>:<button className="button secondary small" onClick={()=>start(c)} data-testid={`button-start-${c.id}`}><Play size={12}/> Start</button>}<button className="icon-button" style={{width:30,height:30}} onClick={()=>{setEditing(c);setShowForm(true)}} title="Edit channel" data-testid={`button-edit-channel-${c.id}`}><Pencil size={13}/></button><button className="icon-button" style={{width:30,height:30}} onClick={()=>setDeleting(c)} title="Delete channel" data-testid={`button-delete-channel-${c.id}`}><Trash2 size={13}/></button></div></td></tr>)}</tbody></table></div>}</div>
    <div className="card section-card" style={{marginTop:18}}><div className="section-head"><div><h2 className="section-title">Signal checklist</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>A few calm checks before you go on air.</p></div><Clipboard size={17} color="#6c8b83"/></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(190px,1fr))",gap:10}}>{["Live URL is saved locally","At least one destination is ready","Stream process status is monitored"].map((t)=><div key={t} style={{display:"flex",gap:9,alignItems:"center",fontSize:11,color:"#60736c",padding:11,background:"#f5f8f1",borderRadius:8}}><span style={{width:20,height:20,borderRadius:"50%",display:"grid",placeItems:"center",background:"#dcefe1",color:"#2a7a72"}}><Check size={12}/></span>{t}</div>)}</div></div>
  </div>{showForm&&<ChannelModal channel={editing} groups={data.groups} videos={data.videos} onSave={save} onClose={()=>{setShowForm(false);setEditing(undefined)}}/>}{deleting&&<ConfirmModal title="Delete this channel?" copy={`“${deleting.title}” and its stream settings will be removed from this workspace. Any live signal must be stopped first.`} onClose={()=>setDeleting(undefined)} onConfirm={()=>{update({channels:data.channels.filter(c=>c.id!==deleting.id)},{message:`${deleting.title} was deleted`,type:"edit"});setDeleting(undefined)}}/>}</AppShell>;
}

function VideoModal({video,groups,defaultGroupId="",onSave,onClose}:{video?:VideoItem;groups:VideoGroup[];defaultGroupId?:string;onSave:(v:VideoItem)=>void;onClose:()=>void}) {
  const [form,setForm]=useState({title:video?.title||"",duration:video?.duration||"",status:video?.status||"published",groupId:video?.groupId||defaultGroupId,sourceUrl:video?.sourceUrl||"",thumbnailColor:video?.thumbnailColor||colors[1]});
  const [fileName,setFileName]=useState(""); const [file,setFile]=useState<File>(); const [uploading,setUploading]=useState(false); const [uploadError,setUploadError]=useState("");
  const set=(key:string,value:string)=>setForm(f=>({...f,[key]:value}));
  const submit=async(e:FormEvent)=>{
    e.preventDefault(); if(!form.title.trim() || uploading)return;
    setUploadError("");
    let sourceUrl=form.sourceUrl; let serverSource=video?.serverSource;
    if(file){
      setUploading(true);
      try{
        const response=await fetch("/api/media/upload",{method:"POST",headers:{"Content-Type":file.type||"application/octet-stream","X-File-Name":file.name},body:file});
        const payload=await response.json() as {sourcePath?:string;playbackUrl?:string;error?:string};
        if(!response.ok || !payload.sourcePath || !payload.playbackUrl) throw new Error(payload.error||"Video upload failed.");
        serverSource=payload.sourcePath; sourceUrl=payload.playbackUrl;
      }catch(error){setUploadError(error instanceof Error?error.message:"Video upload failed.");setUploading(false);return;}
      setUploading(false);
    }
    onSave({id:video?.id||uid("vid"),title:form.title.trim(),duration:form.duration||"00:00",status:form.status as VideoStatus,groupId:form.groupId,sourceUrl,serverSource,thumbnailColor:form.thumbnailColor,views:video?.views||0,createdAt:video?.createdAt||now()});
  };
  return <Modal title={video?"Edit video":"Add video"} onClose={onClose} footer={<><button className="button ghost" onClick={onClose} disabled={uploading} data-testid="button-cancel-video">Cancel</button><button className="button" type="submit" form="video-form" disabled={uploading} data-testid="button-save-video">{uploading ? "Uploading…" : video ? "Save changes" : "Add video"} {!uploading&&<Check size={14}/>}</button></>}><form id="video-form" onSubmit={submit}><div className="form-grid"><div className="field full"><label>{video?"Replace video file (optional)":"Choose video file"}</label><input autoFocus required={!form.sourceUrl} type="file" accept="video/*" onChange={e=>{const next=e.target.files?.[0];if(!next)return;setFile(next);setFileName(next.name);setForm(f=>({...f,title:f.title||next.name.replace(/\.[^.]+$/,""),sourceUrl:URL.createObjectURL(next)}))}} data-testid="input-video-file"/>{fileName&&<span className="file-picked"><Check size={13}/> {fileName} · server-ready upload</span>}{uploadError&&<div className="error-note">{uploadError}</div>}</div><div className="field full"><label>Video title</label><input required value={form.title} onChange={e=>set("title",e.target.value)} placeholder="Title for this video" data-testid="input-video-title"/></div><div className="field"><label>Video category</label><select required value={form.groupId} onChange={e=>set("groupId",e.target.value)} data-testid="select-video-group"><option value="">Select a category</option>{groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select></div><div className="field"><label>Duration</label><input value={form.duration} onChange={e=>set("duration",e.target.value)} placeholder="24:18" data-testid="input-video-duration"/></div></div><div className="form-note"><Upload size={14} style={{verticalAlign:"-3px",marginRight:6}}/>Videos in a category play in their saved order and loop back to the first video after the last one.</div></form></Modal>;
}

function YoutubeDownloadModal({groups,defaultGroupId="",onSave,onClose}:{groups:VideoGroup[];defaultGroupId?:string;onSave:(v:VideoItem)=>void;onClose:()=>void}) {
  const [url,setUrl]=useState(""); const [groupId,setGroupId]=useState(defaultGroupId); const [downloading,setDownloading]=useState(false); const [error,setError]=useState("");
  const submit=async(e:FormEvent)=>{
    e.preventDefault();
    if(!url.trim()||!groupId||downloading)return;
    setDownloading(true);setError("");
    try{
      const result=await downloadYoutubeVideo({url:url.trim()});
      onSave({id:uid("vid"),title:result.title,duration:result.duration,status:"published",groupId,sourceUrl:result.playbackUrl,serverSource:result.sourcePath,thumbnailColor:"#c95c4c",views:0,createdAt:now()});
    }catch(error){setError(error instanceof Error?error.message:"YouTube video download failed.");}
    finally{setDownloading(false);}
  };
  return <Modal title="YouTube video downloader" onClose={onClose} footer={<><button className="button ghost" onClick={onClose} disabled={downloading} data-testid="button-cancel-youtube-download">Cancel</button><button className="button" type="submit" form="youtube-download-form" disabled={downloading} data-testid="button-start-youtube-download">{downloading?"Downloading…":"Download video"} {!downloading&&<Download size={14}/>}</button></>}><form id="youtube-download-form" onSubmit={submit}><div className="form-grid"><div className="field full"><label>YouTube video URL</label><input autoFocus required type="url" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" data-testid="input-youtube-url"/><span className="field-hint">YouTube Shorts and regular videos are supported.</span></div><div className="field full"><label>Save in category / folder</label><select required value={groupId} onChange={e=>setGroupId(e.target.value)} data-testid="select-youtube-group"><option value="">Select a category</option>{groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select></div></div>{error&&<div className="error-note">{error}</div>}<div className="form-note"><Download size={14} style={{verticalAlign:"-3px",marginRight:6}}/>The highest available video and audio quality will be downloaded, merged into MP4, and added as a server-ready video.</div></form></Modal>;
}

function GroupModal({group,onSave,onClose}:{group?:VideoGroup;onSave:(g:VideoGroup)=>void;onClose:()=>void}) {
  const [name,setName]=useState(group?.name||"");const [description,setDescription]=useState(group?.description||"");
  return <Modal title={group?"Edit group":"New group"} onClose={onClose} footer={<><button className="button ghost" onClick={onClose} data-testid="button-cancel-group">Cancel</button><button className="button" onClick={()=>name.trim()&&onSave({id:group?.id||uid("grp"),name:name.trim(),description,videoIds:group?.videoIds||[],createdAt:group?.createdAt||now()})} data-testid="button-save-group">Save group <Check size={14}/></button></>}><div className="form-grid"><div className="field full"><label>Group name</label><input autoFocus value={name} onChange={e=>setName(e.target.value)} placeholder="GD5" data-testid="input-group-name"/></div><div className="field full"><label>Description</label><textarea value={description} onChange={e=>setDescription(e.target.value)} placeholder="What belongs in this collection?" data-testid="input-group-description"/></div></div></Modal>;
}

function VideosPage({workspace}:{workspace:ReturnType<typeof useWorkspace>}) {
  const {data,update}=workspace;
  const [search,setSearch]=useState(""); const [status,setStatus]=useState("all"); const [group,setGroup]=useState("all");
  const [tab,setTab]=useState<"library"|"groups">("groups"); const [videoModal,setVideoModal]=useState(false); const [youtubeModal,setYoutubeModal]=useState(false);
  const [videoGroupId,setVideoGroupId]=useState(""); const [groupModal,setGroupModal]=useState(false);
  const [editingGroup,setEditingGroup]=useState<VideoGroup|undefined>(); const [editingVideo,setEditingVideo]=useState<VideoItem|undefined>(); const [deleting,setDeleting]=useState<{kind:"video"|"group";id:string;name:string}|undefined>();
  const filtered=useMemo(()=>data.videos.filter(v=>(!search||v.title.toLowerCase().includes(search.toLowerCase()))&&(status==="all"||v.status===status)&&(group==="all"||v.groupId===group)),[data.videos,search,status,group]);
  const openAddVideo=(groupId="")=>{setVideoGroupId(groupId);setVideoModal(true);};
  const openGroup=(groupId:string)=>{setGroup(groupId);setTab("library");};
  const saveVideo=(v:VideoItem)=>{const existing=data.videos.find(x=>x.id===v.id);const moved=existing&&existing.groupId!==v.groupId;let groups=data.groups;if(!existing||moved){groups=data.groups.map(g=>({...g,videoIds:g.videoIds.filter(id=>id!==v.id)}));if(v.groupId)groups=groups.map(g=>g.id===v.groupId?{...g,videoIds:[...g.videoIds,v.id]}:g);}update({videos:existing?data.videos.map(x=>x.id===v.id?v:x):[v,...data.videos],groups},{message:existing?`${v.title} was updated`:`${v.title} was added to the library`,type:"video"});setVideoModal(false);setVideoGroupId("");setEditingVideo(undefined);};
  const openEditVideo=(video:VideoItem)=>{setEditingVideo(video);setVideoGroupId(video.groupId);setVideoModal(true);};
  const saveGroup=(g:VideoGroup)=>{const exists=data.groups.some(x=>x.id===g.id);update({groups:exists?data.groups.map(x=>x.id===g.id?g:x):[...data.groups,g]},{message:exists?`${g.name} was updated`:`${g.name} was created`,type:"group"});setGroupModal(false);setEditingGroup(undefined);};
  const remove=()=>{if(!deleting)return;if(deleting.kind==="video")update({videos:data.videos.filter(v=>v.id!==deleting.id),groups:data.groups.map(g=>({...g,videoIds:g.videoIds.filter(id=>id!==deleting.id)}))},{message:`${deleting.name} was deleted`,type:"video"});else update({groups:data.groups.filter(g=>g.id!==deleting.id),videos:data.videos.map(v=>v.groupId===deleting.id?{...v,groupId:""}:v)},{message:`${deleting.name} was deleted`,type:"group"});setDeleting(undefined);};
  const library=<div className="card section-card"><div className="section-head"><div><h2 className="section-title">{filtered.length} video{filtered.length===1?"":"s"}</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>{search||status!=="all"||group!=="all"?"Filtered library":"Your local media index"}</p></div><div className="table-sub">{fmtNumber(data.videos.reduce((a,v)=>a+v.views,0))} total views</div></div>{filtered.length===0?<EmptyState icon={<Search size={21}/>} title="No videos found" copy="Try a different search, or add a new piece to your library." action="Add video" onClick={()=>openAddVideo(group!=="all"?group:"")}/>:<div className="table-wrap"><table className="data-table"><thead><tr><th>Video</th><th>Status</th><th>Category</th><th>Views</th><th>Source</th><th/></tr></thead><tbody>{filtered.map(v=><tr key={v.id} data-testid={`row-video-${v.id}`}><td><div style={{display:"flex",alignItems:"center",gap:10}}><div className="thumb" style={{background:v.thumbnailColor,width:52,height:34}}><Video size={14}/><span style={{fontSize:9,marginLeft:-3}}>{v.duration}</span></div><div><div className="table-title">{v.title}</div><div className="table-sub">Added {new Date(v.createdAt).toLocaleDateString()}</div></div></div></td><td><span className={`status ${v.status==="published"?"live":v.status==="draft"?"scheduled":"stopped"}`}><span className="status-dot"/>{v.status}</span></td><td><span className="table-sub">{data.groups.find(g=>g.id===v.groupId)?.name||"Unassigned"}</span></td><td><span className="mono">{fmtNumber(v.views)}</span></td><td>{v.sourceUrl?<a href={v.sourceUrl} target="_blank" rel="noreferrer" className="section-link" data-testid={`link-source-${v.id}`}><Link2 size={12} style={{verticalAlign:"-2px"}}/> {v.serverSource?"Server-ready":"Preview only"}</a>:<span className="table-sub">Not attached</span>}</td><td><div className="actions"><button className="icon-button" style={{width:30,height:30}} onClick={()=>openEditVideo(v)} title="Edit video" data-testid={`button-edit-video-${v.id}`}><Pencil size={13}/></button><button className="icon-button" style={{width:30,height:30}} onClick={()=>setDeleting({kind:"video",id:v.id,name:v.title})} title="Delete video" data-testid={`button-delete-video-${v.id}`}><Trash2 size={13}/></button></div></td></tr>)}</tbody></table></div>}</div>;
  const groups=<div>{data.groups.length===0?<div className="card"><EmptyState icon={<FolderOpen size={21}/>} title="No categories yet" copy="Create a category to organize videos into a series or collection." action="Create category" onClick={()=>setGroupModal(true)}/></div>:<div className="group-grid">{data.groups.map(g=><div className="card group-card" key={g.id} data-testid={`card-group-${g.id}`}><button className="group-open" onClick={()=>openGroup(g.id)} data-testid={`button-open-group-${g.id}`}><h3>{g.name}</h3><p>{g.description||"No description yet."}</p><span className="group-open-label">Open category <ArrowRight size={12}/></span></button><div className="group-foot"><span>{g.videoIds.length} video{g.videoIds.length===1?"":"s"}</span><button onClick={()=>setDeleting({kind:"group",id:g.id,name:g.name})} className="section-link" style={{color:"#a05b45"}} data-testid={`button-delete-group-${g.id}`}>Delete</button></div></div>)}</div>}</div>;
  return <AppShell title="Video library" workspace={workspace}><div className="page"><div className="page-head"><div><p className="eyebrow">Archive & distribution</p><h1>Video library</h1><p className="subtle">Start with a category, then open it to manage the videos inside.</p></div><div style={{display:"flex",gap:8,flexWrap:"wrap",justifyContent:"flex-end"}}>{tab==="groups"&&<button className="button secondary" onClick={()=>setGroupModal(true)} data-testid="button-add-group"><Plus size={15}/> New category</button>}<button className="button secondary" onClick={()=>setYoutubeModal(true)} data-testid="button-youtube-downloader"><Download size={15}/> YouTube downloader</button><button className="button" onClick={()=>openAddVideo(group!=="all"?group:"")} data-testid="button-add-video"><Plus size={15}/> Add video</button></div></div><div className="toolbar"><div className="filter-row"><button className={`button small ${tab==="library"?"":"ghost"}`} onClick={()=>setTab("library")} data-testid="button-tab-library"><FileVideo size={13}/> Videos</button><button className={`button small ${tab==="groups"?"":"ghost"}`} onClick={()=>setTab("groups")} data-testid="button-tab-groups"><FolderOpen size={13}/> Categories</button></div>{tab==="library"&&<div className="filter-row"><div className="input-wrap"><Search size={14} color="#899791"/><input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search videos…" data-testid="input-search-videos"/></div><select value={status} onChange={e=>setStatus(e.target.value)} data-testid="select-filter-status"><option value="all">All statuses</option><option value="published">Published</option><option value="draft">Draft</option><option value="archived">Archived</option></select><select value={group} onChange={e=>setGroup(e.target.value)} data-testid="select-filter-group"><option value="all">All categories</option>{data.groups.map(g=><option value={g.id} key={g.id}>{g.name}</option>)}</select></div>}</div>{tab==="library"?library:groups}</div>{videoModal&&<VideoModal video={editingVideo} groups={data.groups} defaultGroupId={videoGroupId} onSave={saveVideo} onClose={()=>{setVideoModal(false);setVideoGroupId("");setEditingVideo(undefined)}}/>}{youtubeModal&&<YoutubeDownloadModal groups={data.groups} defaultGroupId={group!=="all"?group:""} onSave={(video)=>{saveVideo(video);setYoutubeModal(false)}} onClose={()=>setYoutubeModal(false)}/>} {groupModal&&<GroupModal group={editingGroup} onSave={saveGroup} onClose={()=>{setGroupModal(false);setEditingGroup(undefined)}}/>}{deleting&&<ConfirmModal title={`Delete this ${deleting.kind}?`} copy={`“${deleting.name}” will be removed from the ${deleting.kind==="video"?"library":"workspace"}. ${deleting.kind==="group"?"Videos inside it will remain in your library.":""}`} onClose={()=>setDeleting(undefined)} onConfirm={remove}/>}</AppShell>;
}

function SettingsPage({workspace}:{workspace:ReturnType<typeof useWorkspace>}) {
  const [autoSave,setAutoSave]=useState(()=>localStorage.getItem("signal-desk-autosave")!=="off");
  const [compact,setCompact]=useState(()=>localStorage.getItem("signal-desk-compact")==="on");
  const [cookieFile,setCookieFile]=useState<File>();
  const [cookieBusy,setCookieBusy]=useState(false);
  const [cookieConfigured,setCookieConfigured]=useState(false);
  const [cookieError,setCookieError]=useState("");
  const toggle=(key:string,value:boolean,setter:(v:boolean)=>void)=>{setter(value);localStorage.setItem(key,value?"on":"off");workspace.setToast(value?"Preference enabled":"Preference disabled")};
  const cookieHeaders={"X-License-Key":workspace.license?.key||"","X-Client-Id":workspace.license?.clientId||""};
  useEffect(()=>{
    if(!workspace.license?.key||!workspace.license.clientId)return;
    void fetch("/api/media/youtube-cookies",{headers:cookieHeaders})
      .then(async response=>response.ok?response.json() as Promise<{configured?:boolean}>:null)
      .then(result=>setCookieConfigured(Boolean(result?.configured)))
      .catch(()=>undefined);
  },[workspace.license?.key,workspace.license?.clientId]);
  const importCookies=async()=>{
    if(!cookieFile||!workspace.license?.key||!workspace.license.clientId)return;
    setCookieBusy(true);setCookieError("");
    try{
      const response=await fetch("/api/media/youtube-cookies",{method:"POST",headers:{"Content-Type":"text/plain",...cookieHeaders},body:cookieFile});
      const payload=await response.json() as {error?:string};
      if(!response.ok)throw new Error(payload.error||"Cookie import failed.");
      setCookieConfigured(true);setCookieFile(undefined);workspace.setToast("YouTube cookies imported on the server");
    }catch(error){setCookieError(error instanceof Error?error.message:"Cookie import failed.");}
    finally{setCookieBusy(false);}
  };
  const clearCookies=async()=>{
    if(!workspace.license?.key||!workspace.license.clientId)return;
    setCookieBusy(true);setCookieError("");
    try{
      const response=await fetch("/api/media/youtube-cookies",{method:"DELETE",headers:cookieHeaders});
      const payload=await response.json() as {error?:string};
      if(!response.ok)throw new Error(payload.error||"Could not remove cookies.");
      setCookieConfigured(false);workspace.setToast("YouTube cookies removed");
    }catch(error){setCookieError(error instanceof Error?error.message:"Could not remove cookies.");}
    finally{setCookieBusy(false);}
  };
  return (
    <AppShell title="Settings" workspace={workspace}>
      <div className="page">
        <div className="page-head"><div><p className="eyebrow">Workspace preferences</p><h1>Settings</h1><p className="subtle">Tune the room and configure server tools for your workspace.</p></div></div>
        <div className="settings-grid">
          <section className="card setting-section">
            <div className="section-head"><div><h2 className="section-title">Workspace</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>Simple controls for a focused desk.</p></div><Settings size={17} color="#6c8b83"/></div>
            <div className="setting-row"><div><h3>Save changes automatically</h3><p>Keep channel and library edits in the licensed workspace.</p></div><button className={`toggle ${autoSave?"on":""}`} onClick={()=>toggle("signal-desk-autosave",!autoSave,setAutoSave)} data-testid="toggle-autosave"><span/></button></div>
            <div className="setting-row"><div><h3>Compact data tables</h3><p>Use a denser row height when the library gets busy.</p></div><button className={`toggle ${compact?"on":""}`} onClick={()=>toggle("signal-desk-compact",!compact,setCompact)} data-testid="toggle-compact"><span/></button></div>
            <div className="setting-row"><div><h3>Storage status</h3><p>Your workspace data is persisted in the licensed workspace.</p></div><span className="status live"><span className="status-dot"/>Connected</span></div>
          </section>
          <section className="card setting-section">
            <div className="section-head"><div><h2 className="section-title">YouTube downloader</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>Import browser cookies when YouTube asks the server to sign in.</p></div><Download size={17} color="#6c8b83"/></div>
            <div className="field full"><label htmlFor="youtube-cookies-file">YouTube cookies.txt or browser JSON</label><input id="youtube-cookies-file" type="file" accept=".txt,.json,text/plain,application/json" disabled={cookieBusy} onChange={event=>setCookieFile(event.target.files?.[0])} data-testid="input-youtube-cookies"/><span className="field-hint">Your attached JSON cookie export is supported and will be converted securely on the server.</span></div>
            <div style={{display:"flex",gap:8,alignItems:"center",marginTop:14,flexWrap:"wrap"}}><button className="button" onClick={()=>void importCookies()} disabled={!cookieFile||cookieBusy} data-testid="button-import-youtube-cookies">{cookieBusy?"Saving…":"Import cookies"} <Upload size={14}/></button>{cookieConfigured&&<><span className="status live"><span className="status-dot"/>Configured</span><button className="button ghost small" onClick={()=>void clearCookies()} disabled={cookieBusy} data-testid="button-clear-youtube-cookies">Remove</button></>}</div>
            {cookieError&&<div className="error-note" style={{marginTop:12}}>{cookieError}</div>}
            <div className="form-note" style={{marginTop:17}}><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>The file is sent to the server and is not saved in browser storage. Re-import it after a redeploy if the server filesystem is reset.</div>
          </section>
        </div>
      </div>
    </AppShell>
  );
  /*
  const clearCookies=async()=>{
    if(!workspace.license?.key||!workspace.license.clientId)return;
    setCookieBusy(true);setCookieError("");
    try{
      const response=await fetch("/api/media/youtube-cookies",{method:"DELETE",headers:cookieHeaders});
      const payload=await response.json() as {error?:string};
      if(!response.ok)throw new Error(payload.error||"Could not remove cookies.");
      setCookieConfigured(false);workspace.setToast("YouTube cookies removed");
    }catch(error){setCookieError(error instanceof Error?error.message:"Could not remove cookies.");}
    finally{setCookieBusy(false);}
  };
  return <AppShell title="Settings" workspace={workspace}><div className="page"><div className="page-head"><div><p className="eyebrow">Workspace preferences</p><h1>Settings</h1><p className="subtle">Tune the room and configure server tools for your workspace.</p></div></div><div className="settings-grid"><section className="card setting-section"><div className="section-head"><div><h2 className="section-title">Workspace</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>Simple controls for a focused desk.</p></div><Settings size={17} color="#6c8b83"/></div><div className="setting-row"><div><h3>Save changes automatically</h3><p>Keep channel and library edits in local storage as you make them.</p></div><button className={`toggle ${autoSave?"on":""}`} onClick={()=>toggle("signal-desk-autosave",!autoSave,setAutoSave)} data-testid="toggle-autosave"><span/></button></div><div className="setting-row"><div><h3>Compact data tables</h3><p>Use a denser row height when the library gets busy.</p></div><button className={`toggle ${compact?"on":""}`} onClick={()=>toggle("signal-desk-compact",!compact,setCompact)} data-testid="toggle-compact"><span/></button></div><div className="setting-row"><div><h3>Storage status</h3><p>Your workspace data is persisted in the licensed workspace.</p></div><span className="status live"><span className="status-dot"/>Connected</span></div></section><section className="card setting-section"><div className="section-head"><div><h2 className="section-title">YouTube downloader</h2><p className="subtle" style={{margin:"5px 0 0",fontSize:11}}>Import browser cookies when YouTube asks the server to sign in.</p></div><Download size={17} color="#6c8b83"/></div><div className="field full"><label htmlFor="youtube-cookies-file">YouTube cookies.txt or browser JSON</label><input id="youtube-cookies-file" type="file" accept=".txt,.json,text/plain,application/json" disabled={cookieBusy} onChange={event=>setCookieFile(event.target.files?.[0])} data-testid="input-youtube-cookies"/><span className="field-hint">Your attached JSON cookie export is supported and will be converted securely on the server.</span></div><div style={{display:"flex",gap:8,alignItems:"center",marginTop:14,flexWrap:"wrap"}}><button className="button" onClick={()=>void importCookies()} disabled={!cookieFile||cookieBusy} data-testid="button-import-youtube-cookies">{cookieBusy?"Saving…":"Import cookies"} <Upload size={14}/></button>{cookieConfigured&&<><span className="status live"><span className="status-dot"/>Configured</span><button className="button ghost small" onClick={()=>void clearCookies()} disabled={cookieBusy} data-testid="button-clear-youtube-cookies">Remove</button></>}</div>{cookieError&&<div className="error-note" style={{marginTop:12}}>{cookieError}</div>}<div className="form-note" style={{marginTop:17}}><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>The file is sent to the server and is not saved in browser storage. Re-import it after a redeploy if the server filesystem is reset.</div></section><section className="card setting-section"><div className="section-head"><div><h2 className="section-title">Stream tools</h2><p className="subtle" style={{margin:"5px 0 0,fontSize:11}}>Useful links for getting the room ready.</p></div><Download size={17} color="#6c8b83"/></div><div className="download-list"><a className="download" href="https://obsproject.com/download" target="_blank" rel="noreferrer" data-testid="link-download-obs"><div className="download-icon"><Download size={15}/></div><div className="download-copy"><strong>OBS Studio</strong><span>Open source broadcast software</span></div><ArrowRight size={14} color="#80908a"/></a><a className="download" href="https://vdo.ninja/" target="_blank" rel="noreferrer" data-testid="link-open-vdo"><div className="download-icon"><Link2 size={15}/></div><div className="download-copy"><strong>VDO.Ninja</strong><span>Browser guests and remote feeds</span></div><ArrowRight size={14} color="#80908a"/></a><a className="download" href="https://support.google.com/youtube/answer/2907883" target="_blank" rel="noreferrer" data-testid="link-stream-guide"><div className="download-icon"><Download size={15}/></div><div className="download-copy"><strong>Streaming guide</strong><span>Platform setup reference</span></div><ArrowRight size={14} color="#80908a"/></a></div><div className="form-note" style={{marginTop:17}}><ShieldCheck size={14} style={{verticalAlign:"-3px",marginRight:6}}/>Keep private live URLs out of public chat.</div></section></div><section className="card setting-section" style={{marginTop:18}}><div className="section-head"><div><h2 className="section-title">About this demo</h2><p className="subtle" style={{margin:"5px 0 0,fontSize:11}}>Signal Desk runs with a licensed workspace and server-side media tools.</p></div><Gauge size={17} color="#6c8b83"/></div><div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:22}}><div><div className="metric-kicker">Environment</div><div style={{fontWeight:800,fontSize:13,marginTop:8}}>Railway-ready</div></div><div><div className="metric-kicker">Data layer</div><div style={{fontWeight:800,fontSize:13,marginTop:8}}>Licensed workspace</div></div><div><div className="metric-kicker">Workspace owner</div><div style={{fontWeight:800,fontSize:13,marginTop:8}}>{workspace.user}</div></div></div></section></div></AppShell>;
  */
}

function Routed({workspace}:{workspace:ReturnType<typeof useWorkspace>}) {
  return <Switch><Route path="/dashboard"><Dashboard workspace={workspace}/></Route><Route path="/live"><LivePage workspace={workspace}/></Route><Route path="/videos"><VideosPage workspace={workspace}/></Route><Route path="/settings"><SettingsPage workspace={workspace}/></Route><Route><NotFound/></Route></Switch>;
}

function App() {
  const license = useLicense();
  const workspace=useWorkspace(license.license, license.clear); const [location,setLocation]=useLocation();
  useEffect(() => { if (isLicenseActive(license.license) && location === "/") setLocation("/dashboard"); }, [license.license, location, setLocation]);
  if (location === "/owner") return <OwnerPage/>;
  if (!license.license || !isLicenseActive(license.license)) return <LicenseGate license={license.license} busy={license.busy} error={license.error} onActivate={license.activate} onRenew={license.renew}/>;
  if (!workspace.ready) return <div className="workspace-loading"><Radio size={20}/><span>Loading your private workspace…</span></div>;
  return <Routed workspace={workspace}/>;
}

export default function RootApp() {
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/,"")}><App/></WouterRouter><Toaster/></TooltipProvider></QueryClientProvider>;
}