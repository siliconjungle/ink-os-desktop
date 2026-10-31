const api = window.inkConnections, profiles = document.querySelector('#profiles'), form = document.querySelector('#connection-form'), status = document.querySelector('#status'), label = document.querySelector('#label'), origin = document.querySelector('#origin'), credential = document.querySelector('#credential'), legacy = document.querySelector('#legacy'), submit = document.querySelector('#submit'), cancel = document.querySelector('#cancel-edit');
let snapshot, editing = null, busy = false;
function message(text, error = false) { status.textContent = text; status.classList.toggle('error', error); }
function enabled(value) { busy = !value; for (const element of document.querySelectorAll('button,input')) element.disabled = !value; if (value && editing) { label.readOnly = true; origin.readOnly = true; legacy.disabled = true; } }
function reset() { editing = null; form.reset(); label.readOnly = false; origin.readOnly = false; legacy.disabled = false; credential.required = false; document.querySelector('#form-title').textContent = 'Connect to a host'; submit.textContent = 'Connect'; cancel.hidden = true; }
function button(text, action, quiet = false) { const element = document.createElement('button'); element.type = 'button'; element.textContent = text; if (quiet) element.className = 'quiet'; element.addEventListener('click', action); return element; }
async function perform(operation, success) {
  if (busy) return; enabled(false); message('Connecting…');
  try { const response = await operation(); if (!response.ok) throw Error(response.error?.message || 'The operation could not be completed.'); if (response.result?.profiles) render(response.result); message(success); return true; }
  catch (error) { message(error.message || 'The operation could not be completed.', true); return false; }
  finally { credential.value = ''; enabled(true); }
}
function edit(profile) { reset(); editing = profile.id; label.value = profile.label; origin.value = profile.url; legacy.checked = profile.mode === 'origin-compatibility'; label.readOnly = true; origin.readOnly = true; legacy.disabled = true; credential.required = true; document.querySelector('#form-title').textContent = 'Update account credential'; submit.textContent = 'Save and open'; cancel.hidden = false; credential.focus(); message('Enter a replacement account token. Existing running commands keep their captured connection.'); }
function render(state) {
  snapshot = state; profiles.replaceChildren();
  for (const profile of state.profiles) {
    const row = document.createElement('article'); row.className = 'profile' + (profile.active ? ' active' : ''); const info = document.createElement('div'); info.className = 'profile-info';
    const title = document.createElement('strong'); title.textContent = profile.label + (profile.active ? ' · Active' : ''); info.append(title);
    const detail = document.createElement('p'); detail.textContent = profile.kind === 'local' ? 'Private local instance on this computer' : profile.url; info.append(detail);
    if (profile.kind === 'remote') { const identity = document.createElement('small'); identity.textContent = profile.mode === 'instance' ? 'Pinned instance identity' : 'Explicit origin compatibility'; info.append(identity); }
    const actions = document.createElement('div'); actions.className = 'profile-actions'; actions.append(button(profile.active ? 'Show' : 'Open', () => perform(() => api.select(profile.id), 'Connection opened.')));
    if (profile.kind === 'remote') {
      actions.append(button('Credential…', () => edit(profile), true));
      if (profile.mode === 'origin-compatibility') actions.append(button('Pin identity', () => perform(() => api.upgrade(profile.id, snapshot.revision), 'Host identity pinned and connection opened.'), true));
      if (!profile.active) actions.append(button('Remove', () => perform(() => api.remove(profile.id, snapshot.revision), 'Removed from saved connections. Existing running commands are unchanged.'), true));
    }
    row.append(info, actions); profiles.append(row);
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const payload = { label: label.value, url: origin.value, mode: legacy.checked ? 'origin-compatibility' : 'instance', ...(credential.value ? { token: credential.value } : {}) }, selected = editing, revision = snapshot.revision;
  const success = await perform(() => { const promise = selected ? api.credential(selected, payload.token, revision) : api.connect(payload); credential.value = ''; delete payload.token; return promise; }, 'Connection opened.');
  if (success) reset();
});
cancel.addEventListener('click', () => { reset(); message(''); });
document.querySelector('#done').addEventListener('click', () => { void api.close().catch(() => {}); });
api.onChanged(async () => { if (!busy) { try { const response = await api.list(); if (response.ok) render(response.result); } catch { message('Connections could not be refreshed.', true); } } });
const initial = await api.list(); if (initial.ok) render(initial.result); else message(initial.error?.message || 'Connections could not be loaded.', true);
