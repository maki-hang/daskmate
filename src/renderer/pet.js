let state, usage, anim = 'idle', restore, revealTimer, dismissTimer;
let cardOpen = false, overPet = false, overCard = false, pointer = null, interactive;
const $ = id => document.getElementById(id);
const lang = () => state?.settings.language || 'zh-CN';
const tr = (key, values) => i18n.t(key, lang(), values);
const hoverMode = () => state?.settings.petQuotaDisplay === 'hover';

function updatePointer() {
  const target = pointer && document.elementFromPoint(pointer.x, pointer.y);
  const next = Boolean(target?.closest('[data-interactive]'));
  if (next === interactive) return;
  interactive = next;
  window.assistant.call('pet.pointer', { interactive: next }).catch(() => {});
}
function setCardOpen(open) {
  cardOpen = open;
  document.body.classList.toggle('quota-open', open);
  const visible = !hoverMode() || open;
  $('status').inert = !visible;
  $('status').setAttribute('aria-hidden', String(!visible));
  $('pet').setAttribute('aria-expanded', String(visible));
  updatePointer();
}
function focusRevealsCard() {
  return $('pet').matches(':focus-visible') || $('status').matches(':focus-visible');
}
function showCard() {
  clearTimeout(dismissTimer);
  if (!hoverMode() || cardOpen) return;
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => setCardOpen(true), 100);
}
function hideCardSoon() {
  clearTimeout(revealTimer);
  clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => {
    if (!overPet && !overCard && !focusRevealsCard()) setCardOpen(false);
  }, 180);
}
function addRow(label, value, percent, details = '') {
  const row = document.createElement('span');
  row.className = 'quota-row';
  row.title = details;
  const labelNode = document.createElement('span');
  labelNode.className = 'quota-label';
  labelNode.textContent = label;
  const amount = document.createElement('b');
  amount.textContent = value;
  row.append(labelNode, amount);
  if (Number.isFinite(percent)) {
    const progress = document.createElement('progress');
    progress.max = 100;
    progress.value = Math.max(0, Math.min(100, percent));
    progress.setAttribute('aria-label', `${label} · ${tr('remaining')} ${value}`);
    row.classList.toggle('low', percent <= 20);
    row.classList.toggle('critical', percent <= 10);
    row.append(progress);
  } else row.classList.add('no-meter');
  $('quota').append(row);
}
function render() {
  if (!state) return;
  document.documentElement.lang = lang();
  document.title = tr('appTitle');
  const mode = hoverMode() ? 'hover' : 'always';
  if (document.body.dataset.quotaDisplay !== mode) {
    document.body.dataset.quotaDisplay = mode;
    clearTimeout(revealTimer);
    clearTimeout(dismissTimer);
    setCardOpen(hoverMode() && (overPet || focusRevealsCard()));
  }
  const agent = state.settings.agent;
  const skin = state.skins.find(s => s.id === state.settings.skins[agent]) || state.skins[0];
  const source = skin.states[anim] || skin.states.idle;
  if ($('character').src !== source) $('character').src = source;
  $('character').alt = tr('petAlt');
  $('pet').ariaLabel = tr('openApp');
  document.querySelector('.drag').title = tr('drag');
  const agentName = state.agents.find(a => a.id === agent).name;
  $('agent').textContent = agentName;
  $('remaining-label').textContent = tr('remaining');
  const data = usage?.agent === agent ? usage : null;
  $('quota').replaceChildren();
  if (!data) addRow(tr('loading'), '');
  else if (data.status !== 'ok') addRow(tr('connecting'), '');
  else {
    // Show each real window independently, with the five-hour window first.
    const windows = [...data.windows].sort((a, b) => (a.minutes === 300 ? 0 : 1) - (b.minutes === 300 ? 0 : 1) || (a.minutes || 0) - (b.minutes || 0));
    for (const w of windows) {
      const label = (windows.filter(x => x.minutes === w.minutes).length > 1 ? (w.bucket || '') + ' ' : '') + i18n.duration(w, lang(), true);
      const value = Number.isFinite(w.remainingPercent) ? `${w.remainingPercent.toFixed(0)}%` : '—';
      const details = `${label}: ${tr('remaining')} ${value} · ${tr('nextReset')} ${w.resetsAt ? new Date(w.resetsAt).toLocaleString(lang()) : '—'}`;
      addRow(label, value, w.remainingPercent, details);
    }
    if (!windows.length) {
      const hasTokens = Number.isFinite(data.tokens?.today);
      addRow(tr(hasTokens ? 'todayTokens' : 'noQuota'), hasTokens ? data.tokens.today.toLocaleString(lang()) : '');
    }
  }
  $('status').classList.toggle('stale', Boolean(data?.stale));
  $('status').ariaLabel = `${agentName} · ${tr('usage')} · ${tr('remaining')} · ${$('quota').textContent}${data?.stale ? ' · ' + tr('stale') : ''}`;
  $('agent').title = data?.stale ? tr('stale') : agentName;
  $('bubble').hidden = !state.lastReminder;
  if (state.lastReminder) $('bubble').textContent = '🔔 ' + state.lastReminder.title;
  updatePointer();
}
function onUsage(value) {
  usage = value;
  if (!restore) anim = value.status !== 'ok' || value.windows.some(w => w.remainingPercent <= 10) ? 'attention' : 'idle';
  render();
}
$('pet').onpointerenter = () => { overPet = true; showCard(); };
$('pet').onpointerleave = () => { overPet = false; hideCardSoon(); };
$('status').onpointerenter = () => { overCard = true; clearTimeout(dismissTimer); };
$('status').onpointerleave = () => { overCard = false; hideCardSoon(); };
for (const element of [$('pet'), $('status')]) {
  element.onfocus = () => { if (hoverMode() && focusRevealsCard()) setCardOpen(true); };
  element.onblur = hideCardSoon;
}
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && hoverMode()) {
    clearTimeout(revealTimer);
    clearTimeout(dismissTimer);
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    setCardOpen(false);
  }
});
document.addEventListener('pointermove', event => { pointer = { x: event.clientX, y: event.clientY }; updatePointer(); });
document.documentElement.addEventListener('pointerleave', () => { pointer = null; overPet = overCard = false; hideCardSoon(); updatePointer(); });
window.addEventListener('blur', () => { overPet = overCard = false; clearTimeout(revealTimer); clearTimeout(dismissTimer); if (hoverMode()) setCardOpen(false); });
$('pet').onclick = () => {
  anim = 'happy'; render(); clearTimeout(restore);
  restore = setTimeout(() => { restore = null; onUsage(usage || { status: 'ok', windows: [] }); }, 2500);
  window.assistant.call('panel');
};
$('status').onclick = () => window.assistant.call('panel', { page: 'usage' });
$('bubble').onclick = () => window.assistant.call('panel', { page: 'agenda' });
document.oncontextmenu = event => { event.preventDefault(); window.assistant.call('menu'); };
window.assistant.on('changed', value => { state = value; render(); });
window.assistant.on('usage', onUsage);
window.assistant.on('reminder', value => { state.lastReminder = value; anim = 'reminder'; render(); });
window.assistant.call('state').then(value => { state = value; render(); return window.assistant.call('usage'); }).then(onUsage).catch(() => { $('quota').replaceChildren(); addRow(tr('connecting'), ''); });
