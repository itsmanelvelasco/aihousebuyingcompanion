import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import { VoiceInterview } from './workspace-voice-widget.tsx';

type Json = any;
type Area = 'profile' | 'interview' | 'inputs' | 'context' | 'bank' | 'towns';
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
type Envelope = { isError?: boolean; content?: { type: string; text?: string }[]; structuredContent?: Json; _meta?: { workspace?: Json } };
const localPreview = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) && /^\/workspace\/?$/.test(location.pathname);
const app = window.parent !== window && !localPreview ? new App({ name: 'ReloCat workspace', version: '1.0.0' }) : null;
const pretty = (value: Json) => JSON.stringify(value, null, 2);
const today = () => new Date().toISOString().slice(0, 10);
const freshId = (prefix: string) => `${prefix}-${Date.now()}`;
const requestedUser = new URLSearchParams(location.search).get('userId') ?? '';
let firstUser = localPreview && /^[a-z0-9][a-z0-9-]{0,63}$/.test(requestedUser) ? requestedUser : '';
const openingListeners = new Set<(value: Json) => void>();
if (app) app.ontoolresult = result => {
  const initial = result.structuredContent;
  if (initial?.userId && typeof initial.userId === 'string') firstUser = initial.userId;
  openingListeners.forEach(listener => listener(initial));
};
const connected = app ? app.connect() : Promise.resolve();
function errorText(result: Envelope) {
  return result.content?.filter(value => value.type === 'text').map(value => value.text).join('\n') || 'The request could not complete.';
}
async function workspace(path: string, method: Method = 'GET', body?: Json) {
  await connected;
  const args = { path, method, ...(body === undefined ? {} : { body }) };
  const result: Envelope = app ? await app.callServerTool({ name: 'workspace_request', arguments: args })
    : await (await fetch('/workspace/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(args), credentials: 'omit' })).json();
  if (result.isError) throw new Error(errorText(result));
  if (!result._meta || !Object.hasOwn(result._meta, 'workspace')) throw new Error('This server does not expose the connected workspace. Refresh the MCP connection after upgrading.');
  return result._meta.workspace;
}
async function domainTool(name: string, args: Record<string, Json> = {}) {
  await connected;
  const result: Envelope = app ? await app.callServerTool({ name, arguments: args })
    : await (await fetch('/workspace/tools', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tool: name, args }), credentials: 'omit' })).json();
  if (result.isError) throw new Error(errorText(result));
  return result.structuredContent;
}
const areas: [Area, string][] = [['profile', 'Profiles'], ['interview', 'Interview'], ['inputs', 'Source inputs'], ['context', 'Context'], ['bank', 'Bank & activity'], ['towns', 'Towns']];
const resources: Record<string, [string, string][]> = {
  profile: [['details', 'Personal details'], ['preferences', 'Housing preferences'], ['bank-account', 'Bank snapshot']],
  bank: [['bank/accounts', 'Accounts & balances'], ['bank/transactions?limit=100', 'Movements (first 100)'], ['bank/events?limit=50', 'Events (first 50)'], ['bank/runtime', 'Background feed'], ['create-account', 'Create account'], ['import-transactions', 'Import movements'], ['update-account', 'Update account'], ['update-transaction', 'Update movement'], ['delete-transaction', 'Delete movement']],
  inputs: [['inputs', 'Source records']], context: [['context', 'Resolved context & provenance']],
};
const newRecord = () => ({ id: freshId('input'), source: 'manual', observedAt: new Date().toISOString(), confirmed: false, synthetic: true, data: { housing: { tenure: 'buy' } } });
const templates = (): Record<string, Json> => ({
  'create-account': { id: freshId('account'), name: 'Fictional current account', currency: 'EUR', openingBalanceCents: 0, openingDate: today(), synthetic: true },
  'update-account': { id: 'replace-with-account-id', name: 'Fictional current account', currency: 'EUR', openingBalanceCents: 0, openingDate: today(), synthetic: true },
  'import-transactions': { transactions: [{ id: freshId('movement'), accountId: 'replace-with-account-id', date: today(), description: 'Fictional purchase', amountCents: -4500, currency: 'EUR', category: 'food', status: 'booked', synthetic: true }] },
  'update-transaction': { id: 'replace-with-movement-id', accountId: 'replace-with-account-id', date: today(), description: 'Fictional purchase', amountCents: -4500, currency: 'EUR', category: 'food', status: 'booked', synthetic: true },
  'delete-transaction': { id: 'replace-with-movement-id' },
});
const interviewFields: [string, string, string][] = [
  ['household.size', 'People living in the home', 'number'], ['household.dependants', 'Dependants', 'number'], ['household.employmentStatus', 'Employment status', 'text'],
  ['housing.budgetCents', 'Maximum home price or monthly rent (€)', 'money'], ['housing.homeSizeM2', 'Minimum floor area (m²)', 'number'], ['housing.minimumBedrooms', 'Minimum bedrooms', 'number'],
  ['finance.currentSavingsCents', 'Savings available (€)', 'money'], ['finance.monthlyIncomeCents', 'Monthly household income (€)', 'money'], ['finance.monthlyExpensesCents', 'Monthly living expenses excluding debt (€)', 'money'],
  ['finance.debtPaymentsCents', 'Monthly debt payments (€)', 'money'], ['finance.targetCashCents', 'Upfront cash target (€)', 'money'], ['finance.emergencyReserveCents', 'Emergency reserve to keep (€)', 'money'],
  ['transport.destinationCode', 'Commute destination · six-digit code', 'code'], ['transport.maxCommuteMinutes', 'Maximum commute (minutes)', 'number'], ['location.currentMunicipality', 'Current municipality', 'text'],
];

function Workspace() {
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const lock = useRef(false), sequence = useRef(0), inputDraft = useRef<Json>(null);
  const [status, setStatus] = useState('Connecting to ReloCat…'), [statusKind, setStatusKind] = useState('');
  const [users, setUsers] = useState<string[]>([]), [user, setUser] = useState(''), [search, setSearch] = useState('');
  const [area, setArea] = useState<Area>('profile'), [resource, setResource] = useState('details'), [record, setRecord] = useState('');
  const [records, setRecords] = useState<Json[]>([]), [editor, setEditor] = useState(''), [dirty, setDirty] = useState(false), [readOnly, setReadOnly] = useState(false);
  const [revision, setRevision] = useState(0), [creating, setCreating] = useState(false), [source, setSource] = useState('manual'), [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; action: () => void } | null>(null);
  const [interview, setInterview] = useState<Record<string, string>>({}), [tenure, setTenure] = useState('buy'), [stages, setStages] = useState<string[]>([]), [schoolMode, setSchoolMode] = useState(''), [allowEstimate, setAllowEstimate] = useState(false), [rural, setRural] = useState(false);
  const [towns, setTowns] = useState<Json[]>([]), [town, setTown] = useState(''), [townResult, setTownResult] = useState<Json>(null), [context, setContext] = useState<Json>(null);
  const [voiceData, setVoiceData] = useState<Json>({}), [fullscreen, setFullscreen] = useState(false);
  function notice(text: string, kind = '') { setStatus(text); setStatusKind(kind); }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); notice('Working…');
    try { await action(); } catch (error) { notice(error instanceof Error ? error.message : 'The request could not complete.', 'error'); }
    finally { lock.current = false; setBusy(false); }
  }
  function guard(action: () => void) {
    if (dirty) setConfirmation({ text: 'Discard the unsaved changes before continuing?', action: () => { inputDraft.current = null; setDirty(false); action(); } });
    else action();
  }
  function selectArea(next: Area) {
    guard(() => { setCreating(false); setArea(next); setResource(resources[next]?.[0]?.[0] || ''); setRecord(''); setTownResult(null); });
  }
  function selectUser(value: string) { guard(() => { inputDraft.current = null; setVoiceData({}); setUser(value); setCreating(false); setRecord(''); setInterview({}); setStages([]); setSchoolMode(''); setTenure('buy'); setAllowEstimate(false); setRural(false); setTownResult(null); }); }
  function show(value: Json, readonly = false) { setEditor(pretty(value)); setReadOnly(readonly); setDirty(false); }
  const base = `/users/${encodeURIComponent(user)}`;
  async function refreshUsers() {
    const result = await workspace('/users');
    if (!Array.isArray(result.users)) throw new Error('The profile list is unavailable.');
    setUsers(result.users); return result.users as string[];
  }
  useEffect(() => {
    let live = true;
    const initial = (value: Json) => { if (value?.userId && typeof value.userId === 'string') setUser(current => current || value.userId); };
    openingListeners.add(initial);
    void connected.then(async () => {
      const result = await workspace('/users');
      if (!live) return;
      const list = Array.isArray(result.users) ? result.users : [];
      setUsers(list); setUser(current => current || (list.includes(firstUser) ? firstUser : list[0]) || '');
      setReady(true); notice('Workspace connected. Changes update the same synthetic runtime data as the website.', 'success');
    }).catch(error => { if (live) { setReady(true); notice(error.message || 'The workspace is not configured. Set the server-side profile API connection and refresh.', 'error'); } });
    return () => { live = false; openingListeners.delete(initial); };
  }, []);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
  useEffect(() => {
    if (!ready || !user || creating || area === 'interview') return;
    const current = ++sequence.current;
    setLoading(true);
    setEditor(''); setReadOnly(true);
    let cancelled = false;
    const apply = (action: () => void) => { if (!cancelled && sequence.current === current) action(); };
    void (async () => {
      if (area === 'towns') {
        const [list, profileContext] = await Promise.all([domainTool('list_catalonia_municipalities'), workspace(`${base}/context`)]);
        apply(() => { const items = list.municipalities || list.towns || []; setTowns(items); setTown(value => value || items[0]?.code || ''); setContext(profileContext); }); return;
      }
      if (area === 'inputs') {
        const result = await workspace(`${base}/inputs`);
        apply(() => {
          setRecords(result.inputs);
          const selected = result.inputs.find((value: Json) => value.id === record) || (record === '__new__' ? null : result.inputs[0]);
          if (selected) { setRecord(selected.id); setSource(selected.source); setConfirmed(selected.confirmed); show(selected); }
          else { const draft = inputDraft.current || newRecord(); setRecord('__new__'); setSource(draft.source); setConfirmed(draft.confirmed); show(draft); if (inputDraft.current) setDirty(true); }
        }); return;
      }
      const template = area === 'bank' ? templates()[resource] : undefined;
      if (template) { apply(() => show(template)); return; }
      const value = await workspace(`${base}/${resource}`);
      apply(() => show(value, area === 'context' || area === 'bank'));
    })().catch(error => apply(() => notice(error.message, 'error'))).finally(() => apply(() => setLoading(false)));
    return () => { cancelled = true; };
  }, [ready, user, area, resource, record, revision, creating]);
  function newInput(value = newRecord()) { guard(() => { inputDraft.current = value; setArea('inputs'); setResource('inputs'); setRecord('__new__'); setCreating(false); setSource(value.source); setConfirmed(value.confirmed); show(value); setDirty(true); }); }
  async function save() {
    const value = JSON.parse(editor);
    if (creating) {
      await workspace('/users', 'POST', value); await refreshUsers(); setUser(value.details.id); setCreating(false); setArea('profile'); setResource('details'); setDirty(false); setRevision(value => value + 1);
    } else if (area === 'profile') { await workspace(`${base}/${resource}`, 'PUT', value); setDirty(false); }
    else if (area === 'inputs') {
      await workspace(`${base}/inputs${record === '__new__' ? '' : '/' + encodeURIComponent(record)}`, record === '__new__' ? 'POST' : 'PUT', record === '__new__' ? { inputs: [value] } : value);
      inputDraft.current = null; setRecord(value.id); setDirty(false); setRevision(value => value + 1);
    } else if (area === 'bank') {
      const paths: Record<string, [Method, string]> = { 'create-account': ['POST', '/bank/accounts'], 'import-transactions': ['POST', '/bank/transactions'], 'update-account': ['PUT', `/bank/accounts/${encodeURIComponent(value.id)}`], 'update-transaction': ['PUT', `/bank/transactions/${encodeURIComponent(value.id)}`], 'delete-transaction': ['DELETE', `/bank/transactions/${encodeURIComponent(value.id)}`] };
      const action = paths[resource]; if (!action) throw new Error('Choose a ledger write operation.');
      await workspace(base + action[1], action[0], action[0] === 'DELETE' ? undefined : value); setDirty(false);
    }
    notice('Saved to synthetic runtime storage.', 'success');
  }
  function download(value: string, name: string) {
    const link = document.createElement('a'), url = URL.createObjectURL(new Blob([value + '\n'], { type: 'application/json' }));
    link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reviewInterview() {
    const data: Json = structuredClone(voiceData);
    data.housing = { ...(data.housing || {}), tenure };
    for (const [path, , type] of interviewFields) {
      const raw = interview[path]?.trim(); if (!raw) continue;
      const [group, key] = path.split('.'); let value: string | number = raw;
      if (type === 'money' || type === 'number') { const amount = Number(raw); if (!Number.isFinite(amount) || amount < 0) throw new Error('Use finite, nonnegative financial and household values.'); value = type === 'money' ? Math.round(amount * 100) : amount; }
      if (type === 'code' && !/^\d{6}$/.test(raw)) throw new Error('Municipality codes have six digits, including leading zeros.');
      (data[group] ??= {})[key] = value;
    }
    if (stages.length) data.school = { ...(data.school || {}), stages, ...(schoolMode ? { mode: schoolMode } : {}) };
    if (allowEstimate) data.housing.allowComarcaEstimate = true;
    if (rural) data.rural = { required: true };
    setArea('inputs'); setResource('inputs'); setRecord('__new__'); setCreating(false); setSource('interview'); setConfirmed(false);
    inputDraft.current = { id: freshId('interview'), source: 'interview', observedAt: new Date().toISOString(), confirmed: false, synthetic: true, data };
    show(inputDraft.current); setDirty(true);
    notice('Interview draft ready. Review the source record, then Save. No values have been written yet. Comarca price estimates require explicit confirmation before matching.');
  }
  function createUser() {
    guard(() => { setCreating(true); setArea('profile'); setResource('new-profile'); show({ details: { schemaVersion: 1, synthetic: true, id: freshId('user'), name: 'Fictional household', snapshotDate: today() }, preferences: { schemaVersion: 1, synthetic: true }, 'bank-account': { schemaVersion: 1, synthetic: true, currency: 'EUR', snapshotDate: today() } }); setDirty(true); });
  }
  async function callVoice(sdp: string) {
    const result: Envelope = app ? await app.callServerTool({ name: 'workspace_voice_session', arguments: { sdp } })
      : await (await fetch('/workspace/voice', { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: sdp, credentials: 'omit' })).json();
    if (result.isError) throw new Error(errorText(result));
    const answer = (result._meta as { voiceSdp?: string } | undefined)?.voiceSdp;
    if (!answer) throw new Error('The voice service did not return a session answer.');
    return answer;
  }
  function voiceAnswers(data: Record<string, Json>) {
    setVoiceData((current: Json) => { const next = { ...current }; for (const [group, fields] of Object.entries(data)) next[group] = { ...(next[group] || {}), ...fields }; return next; });
    setInterview(current => { const next = { ...current }; for (const [path, , type] of interviewFields) { const [group, field] = path.split('.'); const value = data[group]?.[field]; if (value !== null && value !== undefined) next[path] = String(type === 'money' ? value / 100 : value); } return next; });
    if (data.housing?.tenure) setTenure(data.housing.tenure);
    if (data.school?.stages) setStages(data.school.stages);
    if (data.school?.mode) setSchoolMode(data.school.mode);
    if (typeof data.housing?.allowComarcaEstimate === 'boolean') setAllowEstimate(data.housing.allowComarcaEstimate);
    if (typeof data.rural?.required === 'boolean') setRural(data.rural.required);
    setDirty(true); notice('Voice answers added to your unsaved interview. Review the guided fields, then review and save the source record.');
  }
  const editable = !readOnly && !!editor;
  const title = creating ? 'Create a fictional profile' : areas.find(value => value[0] === area)?.[1];
  return <main className="ws">
    <header className="ws-header"><div className="ws-brand">relo.cat</div><span className="ws-tag">Synthetic data · React workspace</span>{app && <button onClick={() => void run(async () => { const result = await app.requestDisplayMode({ mode: fullscreen ? 'inline' : 'fullscreen' }); setFullscreen(result.mode === 'fullscreen'); notice('Display updated.'); })}>{fullscreen ? 'Collapse' : 'Expand'}</button>}<button disabled={busy || loading || !ready} onClick={() => guard(() => void run(async () => { const list = await refreshUsers(); if (!user) setUser(list[0] || ''); setRevision(value => value + 1); notice('Workspace refreshed.', 'success'); }))}>Refresh</button></header>
    <h1>Your next home starts with a clearer picture.</h1><p>Profiles, interviews, financial inputs and sourced Catalan towns — together in ChatGPT.</p>
    <nav className="ws-nav" aria-label="Workspace areas">{areas.map(([key, label]) => <button key={key} aria-selected={area === key} disabled={busy || loading} onClick={() => selectArea(key)}>{label}</button>)}</nav>
    <div className={`ws-status ${statusKind}`} role="status" aria-live="polite">{status}{!users.length && ready && <div className="ws-retry"><button disabled={busy || loading} onClick={() => void run(async () => { const list = await refreshUsers(); setUser(list[0] || ''); notice(list.length ? 'Workspace connected.' : 'No profiles yet. Create a fictional profile.'); })}>Retry connection</button></div>}</div>
    <div className="ws-grid"><section className="ws-people"><div className="ws-row"><h2>People</h2><small className="ws-count">{users.length}</small></div><label>Find a profile<input value={search} placeholder="Search user ID" onChange={event => setSearch(event.target.value)} /></label><div className="ws-user-list">{users.filter(value => value.includes(search.toLowerCase())).map(value => <button key={value} disabled={busy || loading} aria-pressed={user === value} onClick={() => selectUser(value)}>{value}</button>)}{!!users.length && !users.some(value => value.includes(search.toLowerCase())) && <p>No matching profiles.</p>}</div><button disabled={busy || loading || !ready} onClick={createUser}>New profile</button></section>
      <section className="ws-main"><div className="ws-row"><div><h2>{title}</h2><small className="ws-meta">{creating ? 'Review all three documents before creating.' : user || 'Choose a person to begin.'}</small></div>{dirty && <span className="ws-dirty">Unsaved changes</span>}</div>
        {!user && !creating ? <div className="ws-empty">Connect the server-side profile API to manage your fictional households.</div> : <fieldset disabled={busy || loading || !ready}>
          {area === 'interview' ? <><VoiceInterview key={user} call={callVoice} onAnswers={voiceAnswers} onError={message => notice(message, 'error')} /><p>Tell us what you need. Leave unknown values blank. This form creates a reviewable source record.</p><div className="ws-form"><label>Housing goal<select value={tenure} onChange={event => { setTenure(event.target.value); setDirty(true); }}><option value="buy">Buy</option><option value="rent">Rent</option></select></label>{interviewFields.map(([key, label, type]) => <label key={key}>{label}<input value={interview[key] || ''} type={type === 'number' || type === 'money' ? 'number' : 'text'} min={type === 'number' || type === 'money' ? 0 : undefined} step={type === 'money' ? '.01' : '1'} placeholder="Unknown" onChange={event => { setInterview({ ...interview, [key]: event.target.value }); setDirty(true); }} /></label>)}<div className="ws-full"><span className="ws-meta">School stages needed</span><div className="ws-actions">{['nursery', 'infantil', 'primary', 'eso', 'batxillerat', 'fp'].map(value => <label className="ws-check" key={value}><input type="checkbox" checked={stages.includes(value)} onChange={event => { setStages(event.target.checked ? [...stages, value] : stages.filter(item => item !== value)); setDirty(true); }} />{value}</label>)}</div></div><label>School travel mode<select value={schoolMode} onChange={event => { setSchoolMode(event.target.value); setDirty(true); }}><option value="">Unknown</option><option value="car_free">Car-free</option><option value="rail">Rail</option></select></label><label className="ws-check"><input type="checkbox" checked={rural} onChange={event => { setRural(event.target.checked); setDirty(true); }} />Rural towns required</label><label className="ws-check ws-full"><input type="checkbox" checked={allowEstimate} onChange={event => { setAllowEstimate(event.target.checked); setDirty(true); }} />Allow clearly labelled comarca purchase-price estimates</label></div><div className="ws-actions"><button className="primary" onClick={() => { try { reviewInterview(); } catch (error) { notice((error as Error).message, 'error'); } }}>Review interview inputs</button>{app && <button onClick={() => void run(async () => { const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: `Continue the ReloCat homebuying interview for fictional profile ${user}. Ask one unresolved question at a time. I will use ChatGPT Voice if it is available in my client. Do not assume any finances or import bank records.` }] }); if (result.isError) throw new Error('The host did not accept the interview request.'); notice('Interview requested in ChatGPT. Use the host’s Voice control where available. No microphone or paid API session was started by this widget.'); })}>Continue interview in ChatGPT voice</button>}</div><div className="ws-notice">Microphone permission depends on your host. If voice is unavailable, use the guided interview or the host Voice control. Only pressing Start voice can open a paid API session.</div></> : area === 'towns' ? <><p>Explore sourced municipalities, school access, transport and incentives. A town screen is not a verified property match.</p><div className="ws-toolbar"><label className="ws-control">Municipality<select value={town} onChange={event => setTown(event.target.value)}><option value="">Choose a town</option>{towns.map((value: Json) => <option key={value.code} value={value.code}>{value.name} · {value.code}</option>)}</select></label><button disabled={!town} onClick={() => void run(async () => { const result = await domainTool('get_town_profile', { municipalityCode: town }); setTownResult(result); notice('Sourced town profile loaded. Inspect dates and evidence links.', 'success'); })}>View profile</button><button disabled={!context?.recommendation?.ready} onClick={() => void run(async () => { const result = await domainTool('recommend_towns', context.recommendation.input); setTownResult(result); notice('Town screening complete. Property availability and bedroom requirements still need verification.', 'success'); })}>Recommend from saved inputs</button></div>{context && !context.recommendation?.ready && <div className="ws-notice">Matching needs: {context.recommendation?.missingFields?.join(', ') || 'resolve input conflicts or unsupported hard requirements'}. Unsupported fields: {context.recommendation?.unsupportedFields?.join(', ') || 'None reported'}. Review Context and Interview before matching.</div>}{townResult && <><SourceLinks value={townResult} /><pre className="ws-result">{pretty(townResult)}</pre></>}</> : <>
            <div className="ws-toolbar">{!creating && <label className="ws-control">Document<select value={resource} onChange={event => { const value = event.target.value; guard(() => { setResource(value); setRecord(''); }); }}>{(resources[area] || []).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}{area === 'inputs' && <label className="ws-control">Record<select value={record} onChange={event => { const value = event.target.value; guard(() => setRecord(value)); }}><option value="__new__">New source record</option>{records.map(value => <option key={value.id} value={value.id}>{value.source} · {value.id}</option>)}</select></label>}<button onClick={() => guard(() => setRevision(value => value + 1))}>Reload</button>{area === 'inputs' && <button onClick={() => newInput()}>New input</button>}</div>
            {area === 'inputs' && <div className="ws-input-head"><label>Source<select value={source} onChange={event => setSource(event.target.value)}>{['manual', 'interview', 'bank', 'listing'].map(value => <option key={value}>{value}</option>)}</select></label><label className="ws-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Confirmed by person</label><button onClick={() => { try { const value = JSON.parse(editor); value.source = source; value.confirmed = confirmed; value.observedAt = new Date().toISOString(); setEditor(pretty(value)); setDirty(true); } catch { notice('Enter a valid JSON record first.', 'error'); } }}>Apply source & time</button></div>}
            <p className="ws-meta">{area === 'context' ? 'Resolved values, provenance, conflicts and recommendation readiness. Read only.' : area === 'bank' ? 'The ledger is separate from the profile bank snapshot. Money uses integer euro cents.' : 'Edit the JSON, review it, then save explicitly. Unknown facts should stay missing or null.'}</p>
            <label className="ws-control">JSON document<textarea className="ws-editor" value={editor} readOnly={readOnly} spellCheck={false} onChange={event => { setEditor(event.target.value); setDirty(true); }} /></label><div className="ws-actions">{editable && <button className="primary" onClick={() => { if (resource === 'delete-transaction') { setConfirmation({ text: `Delete this fictional movement from ${user}?`, action: () => void run(save) }); } else void run(save); }}>{creating ? 'Create profile' : area === 'inputs' && record === '__new__' ? 'Save reviewed input' : 'Save document'}</button>}{area === 'inputs' && record && record !== '__new__' && <button className="danger" onClick={() => setConfirmation({ text: `Delete source input ${record} from ${user}?`, action: () => void run(async () => { await workspace(`${base}/inputs/${encodeURIComponent(record)}`, 'DELETE'); setRecord(''); setDirty(false); setRevision(value => value + 1); notice('Input deleted. Context will be recalculated.', 'success'); }) })}>Delete input</button>}{editable && <button onClick={() => { try { setEditor(pretty(JSON.parse(editor))); } catch { notice('This document is not valid JSON.', 'error'); } }}>Format JSON</button>}<button disabled={!editor} onClick={() => { try { download(pretty(JSON.parse(editor)), `${user || 'new-profile'}-${resource.replaceAll('/', '-')}.json`); } catch { notice('Export needs valid JSON.', 'error'); } }}>Export JSON</button>{editable && <label className="ws-control">Import JSON<input type="file" accept=".json,application/json" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (!file) return; guard(() => void run(async () => { if (file.size > 262144) throw new Error('Choose a JSON file at most 256 KiB.'); show(JSON.parse(await file.text())); setDirty(true); notice('Imported into the editor. Review and save to write to the API.'); })); }} /></label>}</div>
            {area === 'bank' && resource === 'bank/runtime' && <div className="ws-actions">{[['Enable synthetic feed', '', { enabled: true, intervalMs: 5000 }], ['Pause feed', '', { enabled: false }], ['Generate one movement', '/tick', {}]].map(([label, suffix, payload]) => <button key={String(label)} onClick={() => void run(async () => { show(await workspace(`${base}/bank/runtime${suffix}`, 'POST', payload), true); notice(`${label}: completed for ${user}.`, 'success'); })}>{String(label)}</button>)}</div>}
            <div className="ws-notice">Fictional data only. Source inputs preserve time, confirmation and unresolved conflicts. No bank connection, mortgage approval or guaranteed aid is implied.</div>
          </>}
        </fieldset>}
      </section></div><footer className="ws-footer">ReloCat · Connected through MCP · API credentials remain on the server.</footer>
    {confirmation && <div className="ws-modal-backdrop"><section role="dialog" aria-modal="true" aria-labelledby="confirmation-title" className="ws-modal"><h2 id="confirmation-title">Review this action</h2><p>{confirmation.text}</p><div className="ws-actions"><button autoFocus onClick={() => setConfirmation(null)}>Keep current state</button><button className="primary" onClick={() => { const action = confirmation.action; setConfirmation(null); action(); }}>Confirm</button></div></section></div>}
  </main>;
}
function SourceLinks({ value }: { value: Json }) {
  const urls = new Set<string>();
  function visit(item: Json, depth = 0) {
    if (depth > 12 || urls.size >= 20) return;
    if (typeof item === 'string' && /^https:\/\//.test(item)) { try { const parsed = new URL(item); if (!parsed.username && !parsed.password) urls.add(parsed.href); } catch { /* ignore non-URLs */ } }
    else if (Array.isArray(item)) item.forEach(entry => visit(entry, depth + 1));
    else if (item && typeof item === 'object') Object.values(item).forEach(entry => visit(entry, depth + 1));
  }
  visit(value);
  return <div className="ws-town-source">{[...urls].map((url, index) => <a key={url} href={url} target="_blank" rel="noopener noreferrer">Evidence {index + 1} · {new URL(url).hostname}</a>)}</div>;
}

createRoot(document.getElementById('workspace-root')!).render(<Workspace />);
