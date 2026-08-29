'use strict';

const STORAGE_KEY = 'shiftapp_v1';

const DEFAULT_STATE = {
  workplaces: [],
  shifts: [],
  settings: { yearLimitEnabled: false, yearLimitValue: 1030000 },
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return structuredClone(DEFAULT_STATE);
    const parsed = JSON.parse(raw);
    return {
      workplaces: parsed.workplaces || [],
      shifts: parsed.shifts || [],
      settings: Object.assign({}, DEFAULT_STATE.settings, parsed.settings || {}),
    };
  } catch (e) {
    console.error('state load failed', e);
    return structuredClone(DEFAULT_STATE);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

let state = loadState();

// ---- date helpers ----
function pad2(n) { return String(n).padStart(2, '0'); }
function toDateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function todayKey() {
  const t = new Date();
  return toDateKey(t.getFullYear(), t.getMonth(), t.getDate());
}

let viewYear, viewMonth; // viewMonth: 0-11
{
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
}

let currentDayKey = null;
let editingShiftId = null;
let editingWorkplaceId = null;

// ---- shift calculations ----
function shiftDurationHours(start, end, breakMin) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let startMin = sh * 60 + sm;
  let endMin = eh * 60 + em;
  if (endMin <= startMin) endMin += 24 * 60; // overnight shift
  const worked = (endMin - startMin) - (Number(breakMin) || 0);
  return Math.max(0, worked) / 60;
}

function effectiveShiftTimes(shift) {
  if (shift.hasActual) {
    return { start: shift.actualStart, end: shift.actualEnd, breakMin: shift.actualBreakMin };
  }
  return { start: shift.start, end: shift.end, breakMin: shift.breakMin };
}

function effectiveShiftHours(shift) {
  const t = effectiveShiftTimes(shift);
  return shiftDurationHours(t.start, t.end, t.breakMin);
}

function effectiveShiftIncome(shift) {
  const wp = state.workplaces.find(w => w.id === shift.workplaceId);
  if (!wp) return 0;
  return effectiveShiftHours(shift) * wp.wage;
}

function shiftsForDate(dateKey) {
  return state.shifts.filter(s => s.date === dateKey).sort((a, b) => a.start.localeCompare(b.start));
}

function shiftsForMonth(y, m) {
  const prefix = `${y}-${pad2(m + 1)}-`;
  return state.shifts.filter(s => s.date.startsWith(prefix));
}

function shiftsForYear(y) {
  const prefix = `${y}-`;
  return state.shifts.filter(s => s.date.startsWith(prefix));
}

function fmtYen(n) {
  return '¥' + Math.round(n).toLocaleString('ja-JP');
}

function fmtHours(h) {
  return h.toFixed(1) + 'h';
}

// ---- rendering: calendar ----
const monthLabelEl = document.getElementById('monthLabel');
const calendarEl = document.getElementById('calendar');

function renderMonthLabel() {
  monthLabelEl.textContent = `${viewYear}年${viewMonth + 1}月`;
}

function renderCalendar() {
  renderMonthLabel();
  calendarEl.innerHTML = '';

  const firstOfMonth = new Date(viewYear, viewMonth, 1);
  const startWeekday = firstOfMonth.getDay(); // 0=Sun
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();
  const today = todayKey();

  const cells = [];
  // leading days from previous month
  for (let i = 0; i < startWeekday; i++) {
    const d = daysInPrevMonth - startWeekday + 1 + i;
    const pm = viewMonth === 0 ? 11 : viewMonth - 1;
    const py = viewMonth === 0 ? viewYear - 1 : viewYear;
    cells.push({ y: py, m: pm, d, otherMonth: true });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ y: viewYear, m: viewMonth, d, otherMonth: false });
  }
  const remainder = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= remainder; i++) {
    const nm = viewMonth === 11 ? 0 : viewMonth + 1;
    const ny = viewMonth === 11 ? viewYear + 1 : viewYear;
    cells.push({ y: ny, m: nm, d: i, otherMonth: true });
  }

  cells.forEach((cell, idx) => {
    const key = toDateKey(cell.y, cell.m, cell.d);
    const col = idx % 7;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-cell';
    if (cell.otherMonth) btn.classList.add('other-month');
    if (key === today) btn.classList.add('today');
    if (col === 0) btn.classList.add('sun-col');
    if (col === 6) btn.classList.add('sat-col');

    const num = document.createElement('div');
    num.className = 'day-num';
    num.textContent = cell.d;
    btn.appendChild(num);

    const dayShifts = shiftsForDate(key);
    dayShifts.slice(0, 3).forEach(s => {
      const wp = state.workplaces.find(w => w.id === s.workplaceId);
      const t = effectiveShiftTimes(s);
      const chip = document.createElement('div');
      chip.className = 'day-chip';
      chip.style.background = wp ? wp.color : '#888';
      chip.textContent = `${s.hasActual ? '✓ ' : ''}${t.start}${wp ? ' ' + wp.name : ''}`;
      btn.appendChild(chip);
    });
    if (dayShifts.length > 3) {
      const more = document.createElement('div');
      more.className = 'day-chip';
      more.style.background = '#888';
      more.textContent = `+${dayShifts.length - 3}`;
      btn.appendChild(more);
    }
    if (dayShifts.length > 0) {
      const dayIncome = dayShifts.reduce((sum, s) => sum + effectiveShiftIncome(s), 0);
      const inc = document.createElement('div');
      inc.className = 'day-income';
      inc.textContent = fmtYen(dayIncome);
      btn.appendChild(inc);
    }

    btn.addEventListener('click', () => openDayModal(key));
    calendarEl.appendChild(btn);
  });
}

// ---- rendering: summary ----
const monthIncomeEl = document.getElementById('monthIncome');
const monthHoursEl = document.getElementById('monthHours');
const yearLimitCard = document.getElementById('yearLimitCard');
const yearLimitYearEl = document.getElementById('yearLimitYear');
const yearIncomeEl = document.getElementById('yearIncome');
const limitBarFill = document.getElementById('limitBarFill');
const limitSub = document.getElementById('limitSub');

function renderSummary() {
  const monthShifts = shiftsForMonth(viewYear, viewMonth);
  const monthIncome = monthShifts.reduce((sum, s) => sum + effectiveShiftIncome(s), 0);
  const monthHours = monthShifts.reduce((sum, s) => sum + effectiveShiftHours(s), 0);
  monthIncomeEl.textContent = fmtYen(monthIncome);
  monthHoursEl.textContent = fmtHours(monthHours);

  if (state.settings.yearLimitEnabled && state.settings.yearLimitValue > 0) {
    yearLimitCard.hidden = false;
    const yearShifts = shiftsForYear(viewYear);
    const yearIncome = yearShifts.reduce((sum, s) => sum + effectiveShiftIncome(s), 0);
    yearLimitYearEl.textContent = viewYear;
    yearIncomeEl.textContent = fmtYen(yearIncome);
    const limit = state.settings.yearLimitValue;
    const ratio = Math.min(1, yearIncome / limit);
    limitBarFill.style.width = (ratio * 100) + '%';
    limitBarFill.classList.remove('warn', 'over');
    if (yearIncome >= limit) {
      limitBarFill.classList.add('over');
      limitSub.textContent = `上限（${fmtYen(limit)}）を超えています`;
    } else if (ratio >= 0.85) {
      limitBarFill.classList.add('warn');
      limitSub.textContent = `上限まで残り ${fmtYen(limit - yearIncome)}`;
    } else {
      limitSub.textContent = `上限まで残り ${fmtYen(limit - yearIncome)}`;
    }
  } else {
    yearLimitCard.hidden = true;
  }
}

function renderAll() {
  renderCalendar();
  renderSummary();
}

// ---- month navigation ----
document.getElementById('prevMonth').addEventListener('click', () => {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  renderAll();
});
document.getElementById('nextMonth').addEventListener('click', () => {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  renderAll();
});
document.getElementById('monthLabel').addEventListener('click', () => {
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
  renderAll();
});

// ---- day modal ----
const dayModal = document.getElementById('dayModal');
const dayModalTitle = document.getElementById('dayModalTitle');
const dayShiftList = document.getElementById('dayShiftList');

function openDayModal(dateKey) {
  currentDayKey = dateKey;
  const [y, m, d] = dateKey.split('-').map(Number);
  const dow = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  dayModalTitle.textContent = `${y}年${m}月${d}日（${dow}）`;
  renderDayShiftList();
  dayModal.showModal();
}

function renderDayShiftList() {
  dayShiftList.innerHTML = '';
  const shifts = shiftsForDate(currentDayKey);
  if (shifts.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'この日の予定はまだありません';
    dayShiftList.appendChild(hint);
    return;
  }
  shifts.forEach(s => {
    const wp = state.workplaces.find(w => w.id === s.workplaceId);
    const row = document.createElement('div');
    row.className = 'shift-row';

    const dot = document.createElement('span');
    dot.className = 'shift-color-dot';
    dot.style.background = wp ? wp.color : '#888';

    const main = document.createElement('div');
    main.className = 'shift-row-main';
    const name = document.createElement('span');
    name.className = 'shift-row-name';
    name.textContent = (wp ? wp.name : '（削除された職場）') + (s.hasActual ? '　✓実績' : '');
    const sub = document.createElement('span');
    sub.className = 'shift-row-sub';
    const t = effectiveShiftTimes(s);
    sub.textContent = `${t.start} - ${t.end}` + (t.breakMin ? `（休憩${t.breakMin}分）` : '') +
      (s.hasActual && (s.start !== s.actualStart || s.end !== s.actualEnd) ? `　（予定 ${s.start}-${s.end}）` : '') +
      (s.memo ? ` ・ ${s.memo}` : '');
    main.appendChild(name);
    main.appendChild(sub);

    const income = document.createElement('span');
    income.className = 'shift-row-income';
    income.textContent = fmtYen(effectiveShiftIncome(s));

    row.appendChild(dot);
    row.appendChild(main);
    row.appendChild(income);

    row.addEventListener('click', () => openShiftModal(s.id));
    dayShiftList.appendChild(row);
  });
}

document.getElementById('addShiftBtn').addEventListener('click', () => {
  if (state.workplaces.length === 0) {
    dayModal.close();
    alert('先に「職場」を登録してください。');
    openWorkplaceModal();
    return;
  }
  openShiftModal(null);
});

document.getElementById('fab').addEventListener('click', () => {
  openDayModal(currentDayKey || todayKey());
});

// ---- shift edit modal ----
const shiftModal = document.getElementById('shiftModal');
const shiftModalTitle = document.getElementById('shiftModalTitle');
const shiftWorkplaceSel = document.getElementById('shiftWorkplace');
const shiftBreakInput = document.getElementById('shiftBreak');
const shiftMemoInput = document.getElementById('shiftMemo');
const shiftCalcPreview = document.getElementById('shiftCalcPreview');
const deleteShiftBtn = document.getElementById('deleteShiftBtn');
const actualToggleInput = document.getElementById('actualToggle');
const actualSection = document.getElementById('actualSection');
const actualBreakInput = document.getElementById('actualBreak');

function updateShiftCalcPreview() {
  const wp = state.workplaces.find(w => w.id === shiftWorkplaceSel.value);
  if (!wp) { shiftCalcPreview.textContent = ''; return; }
  const planned = plannedWheel.getTimes();
  const plannedHours = TimeWheel.durationHours(planned.startMin, planned.endMin, Number(shiftBreakInput.value) || 0);
  let text = `予定：${fmtHours(plannedHours)} ・ ${fmtYen(plannedHours * wp.wage)}`;
  if (actualToggleInput.checked) {
    const actual = actualWheel.getTimes();
    const actualHours = TimeWheel.durationHours(actual.startMin, actual.endMin, Number(actualBreakInput.value) || 0);
    text += `\n実績：${fmtHours(actualHours)} ・ ${fmtYen(actualHours * wp.wage)}`;
  }
  shiftCalcPreview.textContent = text;
}

const plannedWheel = TimeWheel.mount(document.getElementById('plannedWheel'), {
  accent: 'var(--accent)',
  startLabel: '出勤（予定）',
  endLabel: '退勤（予定）',
  onChange: updateShiftCalcPreview,
});
const actualWheel = TimeWheel.mount(document.getElementById('actualWheel'), {
  accent: 'var(--accent-actual)',
  startLabel: '出勤（実績）',
  endLabel: '退勤（実績）',
  onChange: updateShiftCalcPreview,
});

function populateWorkplaceSelect() {
  shiftWorkplaceSel.innerHTML = '';
  state.workplaces.forEach(wp => {
    const opt = document.createElement('option');
    opt.value = wp.id;
    opt.textContent = `${wp.name}（¥${wp.wage.toLocaleString()}/時）`;
    shiftWorkplaceSel.appendChild(opt);
  });
}

function openShiftModal(shiftId) {
  editingShiftId = shiftId;
  populateWorkplaceSelect();
  if (shiftId) {
    const s = state.shifts.find(x => x.id === shiftId);
    shiftModalTitle.textContent = 'シフトを編集';
    shiftWorkplaceSel.value = s.workplaceId;
    plannedWheel.setTimes(TimeWheel.timeToMin(s.start), TimeWheel.timeToMin(s.end));
    shiftBreakInput.value = s.breakMin;
    plannedWheel.setBreakMinutes(s.breakMin);
    shiftMemoInput.value = s.memo || '';
    actualToggleInput.checked = !!s.hasActual;
    actualSection.hidden = !s.hasActual;
    if (s.hasActual) {
      actualWheel.setTimes(TimeWheel.timeToMin(s.actualStart), TimeWheel.timeToMin(s.actualEnd));
      actualBreakInput.value = s.actualBreakMin || 0;
    } else {
      actualWheel.setTimes(TimeWheel.timeToMin(s.start), TimeWheel.timeToMin(s.end));
      actualBreakInput.value = s.breakMin;
    }
    actualWheel.setBreakMinutes(actualBreakInput.value);
    deleteShiftBtn.hidden = false;
  } else {
    shiftModalTitle.textContent = 'シフトを追加';
    plannedWheel.setTimes(9 * 60, 17 * 60);
    shiftBreakInput.value = 0;
    plannedWheel.setBreakMinutes(0);
    shiftMemoInput.value = '';
    actualToggleInput.checked = false;
    actualSection.hidden = true;
    actualWheel.setTimes(9 * 60, 17 * 60);
    actualBreakInput.value = 0;
    actualWheel.setBreakMinutes(0);
    deleteShiftBtn.hidden = true;
  }
  updateShiftCalcPreview();
  shiftModal.showModal();
}

shiftWorkplaceSel.addEventListener('change', updateShiftCalcPreview);

function syncPlannedBreak() {
  plannedWheel.setBreakMinutes(shiftBreakInput.value);
  updateShiftCalcPreview();
}
shiftBreakInput.addEventListener('input', syncPlannedBreak);
shiftBreakInput.addEventListener('change', syncPlannedBreak);

function syncActualBreak() {
  actualWheel.setBreakMinutes(actualBreakInput.value);
  updateShiftCalcPreview();
}
actualBreakInput.addEventListener('input', syncActualBreak);
actualBreakInput.addEventListener('change', syncActualBreak);

actualToggleInput.addEventListener('change', () => {
  actualSection.hidden = !actualToggleInput.checked;
  if (actualToggleInput.checked) {
    const planned = plannedWheel.getTimes();
    actualWheel.setTimes(planned.startMin, planned.endMin);
    actualBreakInput.value = shiftBreakInput.value;
    actualWheel.setBreakMinutes(actualBreakInput.value);
  }
  updateShiftCalcPreview();
});

document.getElementById('closeShiftModal').addEventListener('click', () => shiftModal.close());

document.getElementById('shiftForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!shiftWorkplaceSel.value) return;
  const planned = plannedWheel.getTimes();
  const data = {
    date: currentDayKey,
    workplaceId: shiftWorkplaceSel.value,
    start: TimeWheel.minToTime(planned.startMin),
    end: TimeWheel.minToTime(planned.endMin),
    breakMin: Number(shiftBreakInput.value) || 0,
    memo: shiftMemoInput.value.trim(),
    hasActual: actualToggleInput.checked,
  };
  if (actualToggleInput.checked) {
    const actual = actualWheel.getTimes();
    data.actualStart = TimeWheel.minToTime(actual.startMin);
    data.actualEnd = TimeWheel.minToTime(actual.endMin);
    data.actualBreakMin = Number(actualBreakInput.value) || 0;
  }
  if (editingShiftId) {
    const s = state.shifts.find(x => x.id === editingShiftId);
    Object.assign(s, data);
    if (!data.hasActual) {
      delete s.actualStart;
      delete s.actualEnd;
      delete s.actualBreakMin;
    }
  } else {
    data.id = uid();
    state.shifts.push(data);
  }
  saveState();
  shiftModal.close();
  renderDayShiftList();
  renderAll();
});

deleteShiftBtn.addEventListener('click', () => {
  if (!editingShiftId) return;
  if (!confirm('このシフトを削除しますか？')) return;
  state.shifts = state.shifts.filter(s => s.id !== editingShiftId);
  saveState();
  shiftModal.close();
  renderDayShiftList();
  renderAll();
});

// ---- workplace list modal ----
const workplaceModal = document.getElementById('workplaceModal');
const workplaceList = document.getElementById('workplaceList');

function openWorkplaceModal() {
  renderWorkplaceList();
  workplaceModal.showModal();
}

function renderWorkplaceList() {
  workplaceList.innerHTML = '';
  if (state.workplaces.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'まだ職場が登録されていません';
    workplaceList.appendChild(hint);
    return;
  }
  state.workplaces.forEach(wp => {
    const row = document.createElement('div');
    row.className = 'workplace-row';
    const dot = document.createElement('span');
    dot.className = 'shift-color-dot';
    dot.style.background = wp.color;
    const main = document.createElement('div');
    main.className = 'workplace-row-main';
    const name = document.createElement('span');
    name.className = 'workplace-row-name';
    name.textContent = wp.name;
    const sub = document.createElement('span');
    sub.className = 'workplace-row-sub';
    sub.textContent = `時給 ¥${wp.wage.toLocaleString()}`;
    main.appendChild(name);
    main.appendChild(sub);
    row.appendChild(dot);
    row.appendChild(main);
    row.addEventListener('click', () => openWorkplaceEditModal(wp.id));
    workplaceList.appendChild(row);
  });
}

document.getElementById('btnWorkplaces').addEventListener('click', openWorkplaceModal);
document.getElementById('addWorkplaceBtn').addEventListener('click', () => openWorkplaceEditModal(null));

// ---- workplace edit modal ----
const workplaceEditModal = document.getElementById('workplaceEditModal');
const workplaceEditTitle = document.getElementById('workplaceEditTitle');
const workplaceNameInput = document.getElementById('workplaceName');
const workplaceWageInput = document.getElementById('workplaceWage');
const workplaceColorInput = document.getElementById('workplaceColor');
const deleteWorkplaceBtn = document.getElementById('deleteWorkplaceBtn');

const PALETTE = ['#4f46e5', '#e0473f', '#1f9d63', '#e8a020', '#3068c8', '#9333ea', '#0d9488'];

function openWorkplaceEditModal(workplaceId) {
  editingWorkplaceId = workplaceId;
  if (workplaceId) {
    const wp = state.workplaces.find(w => w.id === workplaceId);
    workplaceEditTitle.textContent = '職場を編集';
    workplaceNameInput.value = wp.name;
    workplaceWageInput.value = wp.wage;
    workplaceColorInput.value = wp.color;
    deleteWorkplaceBtn.hidden = false;
  } else {
    workplaceEditTitle.textContent = '職場を追加';
    workplaceNameInput.value = '';
    workplaceWageInput.value = '';
    workplaceColorInput.value = PALETTE[state.workplaces.length % PALETTE.length];
    deleteWorkplaceBtn.hidden = true;
  }
  workplaceEditModal.showModal();
}

document.getElementById('closeWorkplaceEditModal').addEventListener('click', () => workplaceEditModal.close());

workplaceEditModal.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = workplaceNameInput.value.trim();
  const wage = Number(workplaceWageInput.value);
  if (!name || !(wage >= 0)) return;
  if (editingWorkplaceId) {
    const wp = state.workplaces.find(w => w.id === editingWorkplaceId);
    wp.name = name; wp.wage = wage; wp.color = workplaceColorInput.value;
  } else {
    state.workplaces.push({ id: uid(), name, wage, color: workplaceColorInput.value });
  }
  saveState();
  workplaceEditModal.close();
  renderWorkplaceList();
  renderAll();
});

deleteWorkplaceBtn.addEventListener('click', () => {
  if (!editingWorkplaceId) return;
  const usedCount = state.shifts.filter(s => s.workplaceId === editingWorkplaceId).length;
  const msg = usedCount > 0
    ? `この職場を使用しているシフトが${usedCount}件あります。職場を削除すると、それらのシフトも削除されます。続行しますか？`
    : 'この職場を削除しますか？';
  if (!confirm(msg)) return;
  state.shifts = state.shifts.filter(s => s.workplaceId !== editingWorkplaceId);
  state.workplaces = state.workplaces.filter(w => w.id !== editingWorkplaceId);
  saveState();
  workplaceEditModal.close();
  renderWorkplaceList();
  renderAll();
});

// ---- settings modal ----
const settingsModal = document.getElementById('settingsModal');
const yearLimitEnabledInput = document.getElementById('yearLimitEnabled');
const yearLimitPresetSel = document.getElementById('yearLimitPreset');
const yearLimitValueInput = document.getElementById('yearLimitValue');

document.getElementById('btnSettings').addEventListener('click', () => {
  yearLimitEnabledInput.checked = state.settings.yearLimitEnabled;
  yearLimitValueInput.value = state.settings.yearLimitValue || '';
  const presetMatch = Array.from(yearLimitPresetSel.options).find(o => Number(o.value) === state.settings.yearLimitValue);
  yearLimitPresetSel.value = presetMatch ? presetMatch.value : (state.settings.yearLimitValue ? 'custom' : '');
  settingsModal.showModal();
});

yearLimitPresetSel.addEventListener('change', () => {
  if (yearLimitPresetSel.value && yearLimitPresetSel.value !== 'custom') {
    yearLimitValueInput.value = yearLimitPresetSel.value;
  }
});

settingsModal.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  state.settings.yearLimitEnabled = yearLimitEnabledInput.checked;
  state.settings.yearLimitValue = Number(yearLimitValueInput.value) || 0;
  saveState();
  settingsModal.close();
  renderAll();
});

// ---- close dialogs by tapping outside ----
document.querySelectorAll('dialog.modal').forEach(dialog => {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
});

// ---- init ----
renderAll();

// ---- service worker ----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('SW registration failed', err);
    });
  });
}
