const $ = id => document.getElementById(id);
const state = { token: '', users: [], user: '', area: 'profile', dirty: false, inputs: [], isNew: false, creatingUser: false, generation: 0, busy: 0, resource: '', record: '' };
const pretty = value => JSON.stringify(value, null, 2);
const day = () => new Date().toISOString().slice(0, 10);
const id = () => `manual-${Date.now()}`;
function notify(message, kind = '') { $('status').textContent = message; $('status').className = `status ${kind}`; }
function dirty(value) { state.dirty = value; $('dirty').classList.toggle('hidden', !value); }
function discard() { return !state.dirty || window.confirm('Discard the unsaved changes in this editor?'); }
function showEditor(value, readOnly = false) { $('editor').value = pretty(value); $('editor').readOnly = readOnly; $('save').classList.toggle('hidden', readOnly); $('format').classList.toggle('hidden', readOnly); $('import').disabled = readOnly; dirty(false); }
function options(select, entries) { select.replaceChildren(...entries.map(([value, label]) => { const option = document.createElement('option'); option.value = value; option.textContent = label; return option; })); }
async function request(path, method = 'GET', data) {
  if (!state.token) throw new Error('Connect the workspace first.');
  const response = await fetch(path, { method, headers: { Authorization: `Bearer ${state.token}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data), cache: 'no-store', credentials: 'omit' });
  const result = await response.json();
  if (!response.ok) throw new Error(`${result.error || 'Request failed'}${result.issues ? '\n' + result.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('\n') : ''}`);
  return result;
}
async function run(action) { notify('Working…'); state.busy++; document.querySelectorAll('button,select').forEach(button => button.disabled = true); try { await action(); if (document.getElementById('status').textContent === 'Working…') notify('Workspace ready.', 'success'); } catch (error) { notify(error.message || 'Unable to complete the request.', 'error'); } finally { state.busy--; document.querySelectorAll('button,select').forEach(button => button.disabled = false); updateInterviewLink(); if (!state.token) { $('refresh').disabled = true; $('new-user').disabled = true; } } }
function base() { if (!state.user) throw new Error('Select a person first.'); return `/users/${encodeURIComponent(state.user)}`; }
function renderUsers() { updateInterviewLink(); const filtered = state.users.filter(user => user.includes($('search').value.toLowerCase())); $('user-list').replaceChildren(...filtered.map(user => { const button = document.createElement('button'); button.textContent = user; button.classList.toggle('active', user === state.user); button.addEventListener('click', () => { if (state.busy || !discard()) return; void run(async () => { state.user = user; state.creatingUser = false; $('selected-metric').textContent = user; renderUsers(); await loadArea(); }); }); return button; })); if (!filtered.length) $('user-list').textContent = 'No matching profiles.'; }
async function refreshUsers() { const result = await request('/users'); state.users = result.users; $('profile-count').textContent = state.users.length; renderUsers(); }
async function updateConflicts() { const current = state.user; try { const data = await request(`${base()}/context`); if (current === state.user) $('conflict-count').textContent = data.resolved.conflicts.length; } catch { $('conflict-count').textContent = 'Unknown'; } }
const bankResources = [['bank/accounts', 'Accounts & balances'], ['bank/transactions', 'Movements (first 100)'], ['bank/events', 'Event history (first 50)'], ['bank/runtime', 'Background feed status'], ['create-account', 'Create bank account'], ['import-transactions', 'Import movements'], ['update-account', 'Update bank account'], ['update-transaction', 'Update movement'], ['delete-transaction', 'Delete movement']];
async function loadArea() {
  updateInterviewLink();
  showEditor(null, true);
  state.creatingUser = false; state.generation++; const generation = state.generation;
  $('empty').classList.toggle('hidden', !!state.user); $('editor-panel').classList.toggle('hidden', !state.user);
  $('source-controls').classList.add('hidden'); $('record-label').classList.add('hidden'); $('new-record').classList.add('hidden'); $('delete').classList.add('hidden'); $('runtime-controls').classList.add('hidden');
  document.querySelectorAll('[data-area]').forEach(button => button.classList.toggle('active', button.dataset.area === state.area));
  const titles = { profile: ['Profile documents', 'Saved household information, preferences and bank snapshot.'], inputs: ['Source inputs', 'Edit partial records while preserving source, time and confirmation.'], context: ['Resolved context', 'Inspect provenance, unresolved conflicts and recommendation readiness.'], bank: ['Bank & activity', 'Inspect the separate synthetic ledger and control the background feed.'] };
  $('area-title').textContent = titles[state.area][0]; $('area-subtitle').textContent = state.user ? `${state.user} · ${titles[state.area][1]}` : titles[state.area][1];
  if (!state.user) return;
  if (state.area === 'profile') options($('resource'), [['details', 'Personal details'], ['preferences', 'Housing preferences'], ['bank-account', 'Bank snapshot']]);
  if (state.area === 'context') options($('resource'), [['context', 'Resolved context & provenance']]);
  if (state.area === 'bank') options($('resource'), bankResources);
  if (state.area === 'inputs') { options($('resource'), [['inputs', 'Source records']]); $('record-label').classList.remove('hidden'); $('new-record').classList.remove('hidden'); const result = await request(`${base()}/inputs`); if (generation !== state.generation) return; state.inputs = result.inputs; options($('record'), state.inputs.map(input => [input.id, `${input.source} · ${input.id}`])); if (!state.inputs.length) { await newInput(); return; } }
  await loadResource(); void updateConflicts();
}
async function newInput() { state.isNew = true; $('source-controls').classList.remove('hidden'); $('delete').classList.add('hidden'); $('save').textContent = 'Add input'; $('editor-hint').textContent = 'Enter a partial source record. Add any supported housing, household, school, transport, finance, location or rural fields. Values are validated by the API. Profile source is reserved.'; showEditor({ id: id(), source: $('source').value, observedAt: new Date().toISOString(), confirmed: false, synthetic: true, data: { housing: { tenure: 'buy', budgetCents: 18000000, homeSizeM2: 80 } } }); dirty(true); }
async function loadResource() {
  showEditor(null, true);
  state.isNew = false; const resource = $('resource').value; state.resource = resource; state.record = $('record').value; $('runtime-controls').classList.toggle('hidden', resource !== 'bank/runtime' || state.area !== 'bank'); $('delete').classList.add('hidden'); $('source-controls').classList.toggle('hidden', state.area !== 'inputs'); $('save').textContent = 'Save document'; $('editor-hint').textContent = 'Edit the JSON document, then save. Unknown facts should remain missing or null. Money is in euro cents.';
  if (state.area === 'inputs') { const input = state.inputs.find(value => value.id === $('record').value); if (!input) return newInput(); $('source').value = input.source; $('confirmed').checked = input.confirmed; $('delete').classList.remove('hidden'); $('save').textContent = 'Save input'; showEditor(input); return; }
  if (state.area === 'bank') {
    $('editor-hint').textContent = 'Synthetic ledger data. Balances are distinct from profile snapshots. Movements show the first 100 records; use the API for full pagination.';
    const templates = {
      'create-account': { id: `account-${Date.now()}`, name: 'Fictional current account', currency: 'EUR', openingBalanceCents: 0, openingDate: day(), synthetic: true },
      'import-transactions': { transactions: [{ id: `movement-${Date.now()}`, accountId: 'replace-with-account-id', date: day(), description: 'Fictional grocery purchase', amountCents: -4500, currency: 'EUR', category: 'food', status: 'booked', synthetic: true }] },
      'update-account': { id: 'replace-with-account-id', name: 'Fictional current account', currency: 'EUR', openingBalanceCents: 0, openingDate: day(), synthetic: true },
      'update-transaction': { id: 'replace-with-movement-id', accountId: 'replace-with-account-id', date: day(), description: 'Fictional grocery purchase', amountCents: -4500, currency: 'EUR', category: 'food', status: 'booked', synthetic: true },
      'delete-transaction': { id: 'replace-with-movement-id' }
    };
    if (templates[resource]) { showEditor(templates[resource]); $('save').textContent = resource === 'delete-transaction' ? 'Delete movement' : 'Submit to ledger'; $('editor-hint').textContent = 'Use an existing record ID for updates/deletions. Account IDs and transaction IDs must match your selected person’s ledger. Review the payload before submitting.'; return; }
  }
  showEditor(await request(`${base()}/${resource}`), state.area === 'context' || state.area === 'bank');
}
$('connect-form').addEventListener('submit', event => { event.preventDefault(); if (!discard()) return; void run(async () => { state.token = $('token').value.trim(); try { await refreshUsers(); } catch (error) { state.token = ''; throw error; } $('token').value = ''; $('token').required = false; $('connect-form').querySelector('button[type=submit]').textContent = 'Reconnect'; $('disconnect').classList.remove('hidden'); $('search').disabled = false; state.user = state.users[0] || ''; $('selected-metric').textContent = state.user || '—'; await loadArea(); notify('Workspace connected. Changes will update local runtime data.', 'success'); }); });
$('disconnect').addEventListener('click', () => { if (!discard()) return; state.token = ''; state.users = []; state.user = ''; updateInterviewLink(); state.generation++; dirty(false); $('token').value = ''; $('token').required = true; $('search').value = ''; $('search').disabled = true; $('refresh').disabled = true; $('new-user').disabled = true; $('disconnect').classList.add('hidden'); $('editor').value = ''; $('user-list').textContent = 'No workspace connected.'; $('profile-count').textContent = '—'; $('selected-metric').textContent = '—'; $('conflict-count').textContent = '—'; $('editor-panel').classList.add('hidden'); $('empty').classList.remove('hidden'); notify('Disconnected. The access token has been cleared from this tab.'); });
$('search').addEventListener('input', renderUsers);
document.querySelectorAll('[data-area]').forEach(button => button.addEventListener('click', () => { if (!discard()) return; void run(async () => { state.area = button.dataset.area; await loadArea(); }); }));
$('resource').addEventListener('change', () => { if (!discard()) { $('resource').value = state.resource; return; } void run(loadResource); });
$('record').addEventListener('change', () => { if (!discard()) { $('record').value = state.record; return; } void run(loadResource); });
$('reload').addEventListener('click', () => { if (!discard()) return; void run(loadArea); });
$('refresh').addEventListener('click', () => { if (!discard()) return; void run(async () => { await refreshUsers(); await loadArea(); notify('Workspace refreshed.', 'success'); }); });
$('editor').addEventListener('input', () => dirty(true));
$('new-record').addEventListener('click', () => { if (discard()) void newInput(); });
$('apply-source').addEventListener('click', () => { void run(async () => { const value = JSON.parse($('editor').value); value.source = $('source').value; value.confirmed = $('confirmed').checked; value.observedAt = new Date().toISOString(); $('editor').value = pretty(value); dirty(true); }); });
$('save').addEventListener('click', () => { void run(async () => {
  const value = JSON.parse($('editor').value); const resource = $('resource').value;
  if (state.creatingUser) { await request('/users', 'POST', value); state.user = value.details.id; state.creatingUser = false; await refreshUsers(); $('selected-metric').textContent = state.user; await loadArea(); }
  else if (state.area === 'profile') { await request(`${base()}/${resource}`, 'PUT', value); dirty(false); }
  else if (state.area === 'inputs') { await request(`${base()}/inputs${state.isNew ? '' : '/' + encodeURIComponent(state.record)}`, state.isNew ? 'POST' : 'PUT', state.isNew ? { inputs: [value] } : value); await loadArea(); }
  else if (state.area === 'bank') { const routes = { 'create-account': ['POST', '/bank/accounts'], 'import-transactions': ['POST', '/bank/transactions'], 'update-account': ['PUT', `/bank/accounts/${encodeURIComponent(value.id)}`], 'update-transaction': ['PUT', `/bank/transactions/${encodeURIComponent(value.id)}`], 'delete-transaction': ['DELETE', `/bank/transactions/${encodeURIComponent(value.id)}`] }; const route = routes[resource]; if (!route) throw new Error('Choose a write operation.'); if (route[0] === 'DELETE' && !window.confirm(`Delete movement ${value.id} from ${state.user}?`)) return; await request(base() + route[1], route[0], route[0] === 'DELETE' ? undefined : value); dirty(false); }
  void updateConflicts(); notify('Saved successfully to local runtime storage.', 'success');
}); });
$('delete').addEventListener('click', () => { if (!window.confirm(`Delete input ${$('record').value} from ${state.user}?`)) return; void run(async () => { await request(`${base()}/inputs/${encodeURIComponent($('record').value)}`, 'DELETE'); await loadArea(); notify('Input deleted. Context has been recalculated.', 'success'); }); });
$('format').addEventListener('click', () => { void run(async () => { $('editor').value = pretty(JSON.parse($('editor').value)); }); });
$('export').addEventListener('click', () => { void run(async () => { const content = pretty(JSON.parse($('editor').value)); const url = URL.createObjectURL(new Blob([content + '\n'], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${state.user || 'new-user'}-${$('resource').value.replaceAll('/', '-')}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }); });
$('import').addEventListener('change', event => { const file = event.target.files[0]; if (!file) return; if (!discard()) { event.target.value = ''; return; } void run(async () => { if (file.size > 262144) throw new Error('Import must be at most 256 KiB.'); const value = JSON.parse(await file.text()); $('editor').value = pretty(value); dirty(true); notify('JSON loaded into the editor. Review it, then save to write to the API.'); }); event.target.value = ''; });
for (const [button, suffix, payload] of [['runtime-enable', '', { enabled: true, intervalMs: 5000 }], ['runtime-disable', '', { enabled: false }], ['runtime-tick', '/tick', {}]]) $(button).addEventListener('click', () => { void run(async () => { const result = await request(`${base()}/bank/runtime${suffix}`, 'POST', payload); showEditor(result, true); notify(button === 'runtime-tick' ? 'A synthetic movement was generated.' : button === 'runtime-enable' ? 'Synthetic feed enabled. It continues while the API is running.' : 'Synthetic feed paused.', 'success'); }); });
$('new-user').addEventListener('click', () => { if (!discard()) return; state.creatingUser = true; $('empty').classList.add('hidden'); $('editor-panel').classList.remove('hidden'); $('area-title').textContent = 'Create a fictional profile'; $('area-subtitle').textContent = 'Three separate documents are required. Choose a unique details.id.'; options($('resource'), [['new-profile', 'New profile']]); $('record-label').classList.add('hidden'); $('source-controls').classList.add('hidden'); $('delete').classList.add('hidden'); $('runtime-controls').classList.add('hidden'); $('new-record').classList.add('hidden'); $('save').textContent = 'Create profile'; $('editor-hint').textContent = 'Use a unique lowercase ID containing letters, numbers and hyphens. Add your fictional household details, housing preferences and bank snapshot.'; showEditor({ details: { schemaVersion: 1, synthetic: true, id: `user-${Date.now()}`, displayName: 'Fictional household', snapshotDate: day() }, preferences: { schemaVersion: 1, synthetic: true, goal: 'buy_primary_home' }, 'bank-account': { schemaVersion: 1, synthetic: true, snapshotDate: day(), currency: 'EUR' } }); dirty(true); });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });



function updateInterviewLink() {
  const selected = /^[a-z0-9][a-z0-9-]{0,63}$/.test(state.user);
  $('interviewer-link').href = selected ? `/interviewer/?userId=${encodeURIComponent(state.user)}` : '/interviewer/';
  $('interviewer-link').textContent = selected ? `Tell us what you need · ${state.user}` : 'Tell us what you need';
  $('review-interview').disabled = !selected || !state.token;
  $('export-interview').disabled = !selected || !state.token;
}
function readInterview() {
  if (!state.user || !state.token) throw new Error('Connect and select a person first.');
  let raw;
  try { raw = localStorage.getItem(`homebuying-interviewer-v1:${state.user}`); }
  catch { throw new Error('Browser storage is unavailable. Use the interviewer on this same origin and allow browser storage.'); }
  if (!raw) throw new Error(`No interview saved for ${state.user} on this origin. Open “Tell us what you need” for this person, complete and save their answers, then return here. Unscoped interviews are not imported.`);
  const interview = JSON.parse(raw);
  if (!interview || typeof interview !== 'object' || !interview.profile || typeof interview.profile !== 'object' || Array.isArray(interview.profile)) throw new Error('The saved interview does not contain a valid profile object.');
  return interview;
}
function interviewDraft(interview) {
  const profile = interview.profile;
  const data = {};
  const warnings = [];
  const mappings = { saved: 'currentSavingsCents', target: 'targetCashCents', confirmedSalary: 'monthlyIncomeCents' };
  if (Object.hasOwn(profile, 'householdSize')) {
    if (Number.isSafeInteger(profile.householdSize) && profile.householdSize >= 1 && profile.householdSize <= 30) data.household = { size: profile.householdSize };
    else warnings.push('profile.householdSize omitted: expected an integer between 1 and 30.');
  }
  const currency = interview.profileCurrency ?? interview.currency;
  for (const [field, canonical] of Object.entries(mappings)) {
    if (!Object.hasOwn(profile, field)) continue;
    const amount = profile[field];
    const cents = Math.round(amount * 100);
    if (currency !== 'EUR') { warnings.push(`profile.${field} omitted: financial currency is ${String(currency ?? 'unknown')}; only EUR is supported, with no currency conversion.`); continue; }
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(cents) || cents > 100000000000) { warnings.push(`profile.${field} omitted: expected a finite nonnegative amount within API limits.`); continue; }
    (data.finance ??= {})[canonical] = cents;
  }
  const supported = new Set(['householdSize', ...Object.keys(mappings)]);
  const unsupported = Object.keys(profile).filter(field => !supported.has(field) && profile[field] !== null && profile[field] !== undefined && profile[field] !== '');
  if (unsupported.length) warnings.push(`Unsupported interview fields: ${unsupported.map(field => 'profile.' + field).join(', ')}. These remain in the browser interview and raw export; they are not applied as municipality filters.`);
  if (interview.cash != null) warnings.push('cash: the browser cash-flow summary remains in the raw interview; it is not imported as ledger transactions or canonical finance values.');
  if (interview.classification) warnings.push('classification: merchant classification metadata remains in the raw interview only.');
  if (!Object.keys(data).length) throw new Error(`No supported interview values can be imported. ${warnings.join(' ')}`);
  return { input: { id: `interview-${Date.now()}`, source: 'interview', observedAt: new Date().toISOString(), confirmed: false, synthetic: true, data }, warnings };
}
$('review-interview').addEventListener('click', () => {
  if (!discard()) return;
  void run(async () => {
    const interview = readInterview();
    const draft = interviewDraft(interview);
    state.area = 'inputs';
    await loadArea();
    await newInput();
    $('source').value = 'interview';
    $('confirmed').checked = false;
    showEditor(draft.input);
    dirty(true);
    $('save').textContent = 'Save reviewed interview input';
    $('editor-hint').textContent = `Draft for ${state.user}. Nothing has been written to the API. Review this input, then press Save to persist it. Confirmation stays false unless you explicitly change it. ${draft.warnings.join(' ')} Original raw interview remains unchanged in this person’s browser storage and is available through Export raw interview.`;
    notify(`Interview draft ready for ${state.user}. Review before saving. ${draft.warnings.join(' ')}`, draft.warnings.length ? '' : 'success');
  });
});
$('export-interview').addEventListener('click', () => {
  void run(async () => {
    const interview = readInterview();
    const url = URL.createObjectURL(new Blob([pretty(interview) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${state.user}-raw-interview.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notify('Raw interview exported from this person’s browser storage. No API data was changed.', 'success');
  });
});
updateInterviewLink();

