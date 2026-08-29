'use strict';

const STORAGE_KEY = 'shiftapp_v1';

const DEFAULT_STATE = {
  workplaces: [],
  shifts: [],
  settings: { yearLimitEnabled: false, yearLimitValue: 1030000 },
  actualMonthlyIncome: {},
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
      actualMonthlyIncome: parsed.actualMonthlyIncome || {},
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

// generic left/right swipe detection, used by the calendar and monthly
// report to move between months.
function onHorizontalSwipe(el, { onSwipeLeft, onSwipeRight }) {
  let startX = 0, startY = 0, tracking = false;
  el.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onSwipeLeft(); else onSwipeRight();
    }
  }, { passive: true });
}

// slide+fade transition so moving to the next/prev month (by swipe or by
// tapping the arrow buttons) is visibly obvious, not a silent content swap.
function animateSwap(el, direction, updateFn) {
  const dist = 18;
  const outX = direction === 'left' ? -dist : dist;
  el.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
  el.style.transform = `translateX(${outX}px)`;
  el.style.opacity = '0';
  window.setTimeout(() => {
    updateFn();
    el.style.transition = 'none';
    el.style.transform = `translateX(${-outX}px)`;
    el.style.opacity = '0';
    void el.offsetWidth; // force reflow so the next transition actually animates
    el.style.transition = 'transform 0.15s ease, opacity 0.15s ease';
    el.style.transform = 'translateX(0)';
    el.style.opacity = '1';
  }, 150);
}

let state = loadState();

// ---- date helpers ----
function pad2(n) { return String(n).padStart(2, '0'); }
function toDateKey(y, m, d) { return `${y}-${pad2(m + 1)}-${pad2(d)}`; }
function monthKeyFor(y, m) { return `${y}-${pad2(m + 1)}`; }
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

function calculatedMonthIncome(y, m) {
  return shiftsForMonth(y, m).reduce((sum, s) => sum + effectiveShiftIncome(s), 0);
}

// income for a given month: a manually entered actual value wins over the
// shift-based calculation, since real pay (taxes, rounding, bonuses) can differ.
function monthlyIncomeFor(y, m) {
  const key = monthKeyFor(y, m);
  if (state.actualMonthlyIncome[key] != null) return state.actualMonthlyIncome[key];
  return calculatedMonthIncome(y, m);
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

  calendarEl.style.gridTemplateRows = `repeat(${cells.length / 7}, 1fr)`;

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
const monthIncomeLabelEl = document.getElementById('monthIncomeLabel');
const monthIncomeEl = document.getElementById('monthIncome');
const monthHoursEl = document.getElementById('monthHours');
const yearLimitCard = document.getElementById('yearLimitCard');
const yearLimitYearEl = document.getElementById('yearLimitYear');
const yearIncomeEl = document.getElementById('yearIncome');
const limitBarFill = document.getElementById('limitBarFill');
const limitSub = document.getElementById('limitSub');

function renderSummary() {
  const monthShifts = shiftsForMonth(viewYear, viewMonth);
  const monthHours = monthShifts.reduce((sum, s) => sum + effectiveShiftHours(s), 0);
  const hasOverride = state.actualMonthlyIncome[monthKeyFor(viewYear, viewMonth)] != null;
  monthIncomeLabelEl.textContent = hasOverride ? '今月の実績収入' : '今月の予想収入';
  monthIncomeEl.textContent = fmtYen(monthlyIncomeFor(viewYear, viewMonth));
  monthHoursEl.textContent = fmtHours(monthHours);

  if (state.settings.yearLimitEnabled && state.settings.yearLimitValue > 0) {
    yearLimitCard.hidden = false;
    let yearIncome = 0;
    for (let m = 0; m < 12; m++) yearIncome += monthlyIncomeFor(viewYear, m);
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
function goToPrevMonth() {
  viewMonth--;
  if (viewMonth < 0) { viewMonth = 11; viewYear--; }
  animateSwap(calendarEl, 'right', renderAll);
}
function goToNextMonth() {
  viewMonth++;
  if (viewMonth > 11) { viewMonth = 0; viewYear++; }
  animateSwap(calendarEl, 'left', renderAll);
}
document.getElementById('prevMonth').addEventListener('click', goToPrevMonth);
document.getElementById('nextMonth').addEventListener('click', goToNextMonth);
document.getElementById('monthLabel').addEventListener('click', () => {
  const t = new Date();
  viewYear = t.getFullYear();
  viewMonth = t.getMonth();
  renderAll();
});
onHorizontalSwipe(calendarEl, { onSwipeLeft: goToNextMonth, onSwipeRight: goToPrevMonth });

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

// ---- shift edit modal ----
const shiftModal = document.getElementById('shiftModal');
const shiftModalTitle = document.getElementById('shiftModalTitle');
const shiftWorkplaceSel = document.getElementById('shiftWorkplace');
const shiftStartInput = document.getElementById('shiftStart');
const shiftEndInput = document.getElementById('shiftEnd');
const shiftBreakInput = document.getElementById('shiftBreak');
const shiftMemoInput = document.getElementById('shiftMemo');
const shiftCalcPreview = document.getElementById('shiftCalcPreview');
const deleteShiftBtn = document.getElementById('deleteShiftBtn');
const actualToggleInput = document.getElementById('actualToggle');
const actualSection = document.getElementById('actualSection');
const actualStartInput = document.getElementById('actualStart');
const actualEndInput = document.getElementById('actualEnd');
const actualBreakInput = document.getElementById('actualBreak');
const actualToggleWrap = document.getElementById('actualToggleWrap');
const batchWrap = document.getElementById('batchWrap');
const batchToggleInput = document.getElementById('batchToggle');
const batchSection = document.getElementById('batchSection');
const batchDateInput = document.getElementById('batchDateInput');
const batchDateList = document.getElementById('batchDateList');
let batchDates = [];

function renderBatchDateList() {
  batchDateList.innerHTML = '';
  if (batchDates.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = '追加日はまだありません';
    batchDateList.appendChild(hint);
    return;
  }
  batchDates.slice().sort().forEach(d => {
    const chip = document.createElement('span');
    chip.className = 'batch-date-chip';
    chip.textContent = d;
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.textContent = '×';
    rm.setAttribute('aria-label', `${d}を削除`);
    rm.addEventListener('click', () => {
      batchDates = batchDates.filter(x => x !== d);
      renderBatchDateList();
    });
    chip.appendChild(rm);
    batchDateList.appendChild(chip);
  });
}

document.getElementById('batchAddDateBtn').addEventListener('click', () => {
  const val = batchDateInput.value;
  if (!val || val === currentDayKey || batchDates.includes(val)) { batchDateInput.value = ''; return; }
  batchDates.push(val);
  batchDateInput.value = '';
  renderBatchDateList();
});

batchToggleInput.addEventListener('change', () => {
  batchSection.hidden = !batchToggleInput.checked;
  if (batchToggleInput.checked) {
    actualToggleInput.checked = false;
    actualSection.hidden = true;
  }
  actualToggleWrap.hidden = batchToggleInput.checked;
  updateShiftCalcPreview();
});

function updateShiftCalcPreview() {
  const wp = state.workplaces.find(w => w.id === shiftWorkplaceSel.value);
  if (!wp || !shiftStartInput.value || !shiftEndInput.value) { shiftCalcPreview.textContent = ''; return; }
  const plannedHours = shiftDurationHours(shiftStartInput.value, shiftEndInput.value, shiftBreakInput.value);
  let text = `予定：${fmtHours(plannedHours)} ・ ${fmtYen(plannedHours * wp.wage)}`;
  if (actualToggleInput.checked && actualStartInput.value && actualEndInput.value) {
    const actualHours = shiftDurationHours(actualStartInput.value, actualEndInput.value, actualBreakInput.value);
    text += `\n実績：${fmtHours(actualHours)} ・ ${fmtYen(actualHours * wp.wage)}`;
  }
  shiftCalcPreview.textContent = text;
}

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
  batchDates = [];
  batchToggleInput.checked = false;
  batchSection.hidden = true;
  renderBatchDateList();
  actualToggleWrap.hidden = false;
  batchWrap.hidden = !!shiftId;
  if (shiftId) {
    const s = state.shifts.find(x => x.id === shiftId);
    shiftModalTitle.textContent = 'シフトを編集';
    shiftWorkplaceSel.value = s.workplaceId;
    shiftStartInput.value = s.start;
    shiftEndInput.value = s.end;
    shiftBreakInput.value = s.breakMin;
    shiftMemoInput.value = s.memo || '';
    actualToggleInput.checked = !!s.hasActual;
    actualSection.hidden = !s.hasActual;
    actualStartInput.value = s.hasActual ? s.actualStart : s.start;
    actualEndInput.value = s.hasActual ? s.actualEnd : s.end;
    actualBreakInput.value = s.hasActual ? (s.actualBreakMin || 0) : s.breakMin;
    deleteShiftBtn.hidden = false;
  } else {
    shiftModalTitle.textContent = 'シフトを追加';
    shiftStartInput.value = '09:00';
    shiftEndInput.value = '17:00';
    shiftBreakInput.value = 0;
    shiftMemoInput.value = '';
    actualToggleInput.checked = false;
    actualSection.hidden = true;
    actualStartInput.value = '09:00';
    actualEndInput.value = '17:00';
    actualBreakInput.value = 0;
    deleteShiftBtn.hidden = true;
  }
  updateShiftCalcPreview();
  shiftModal.showModal();
}

[shiftWorkplaceSel, shiftStartInput, shiftEndInput, shiftBreakInput, actualStartInput, actualEndInput, actualBreakInput].forEach(el => {
  el.addEventListener('input', updateShiftCalcPreview);
  el.addEventListener('change', updateShiftCalcPreview);
});

actualToggleInput.addEventListener('change', () => {
  actualSection.hidden = !actualToggleInput.checked;
  if (actualToggleInput.checked) {
    actualStartInput.value = shiftStartInput.value;
    actualEndInput.value = shiftEndInput.value;
    actualBreakInput.value = shiftBreakInput.value;
  }
  updateShiftCalcPreview();
});

document.getElementById('closeShiftModal').addEventListener('click', () => shiftModal.close());

// saves the form as one shift (editing) or one-per-date (adding, with the
// batch dates included when enabled). returns false if the form is invalid.
function saveShiftForm() {
  if (!shiftWorkplaceSel.value || !shiftStartInput.value || !shiftEndInput.value) return false;
  const base = {
    workplaceId: shiftWorkplaceSel.value,
    start: shiftStartInput.value,
    end: shiftEndInput.value,
    breakMin: Number(shiftBreakInput.value) || 0,
    memo: shiftMemoInput.value.trim(),
    hasActual: actualToggleInput.checked,
  };
  if (actualToggleInput.checked) {
    base.actualStart = actualStartInput.value;
    base.actualEnd = actualEndInput.value;
    base.actualBreakMin = Number(actualBreakInput.value) || 0;
  }
  if (editingShiftId) {
    const s = state.shifts.find(x => x.id === editingShiftId);
    Object.assign(s, base, { date: currentDayKey });
    if (!base.hasActual) {
      delete s.actualStart;
      delete s.actualEnd;
      delete s.actualBreakMin;
    }
  } else {
    const targetDates = batchToggleInput.checked && batchDates.length > 0
      ? [currentDayKey, ...batchDates]
      : [currentDayKey];
    targetDates.forEach(date => {
      state.shifts.push(Object.assign({ id: uid(), date }, base));
    });
  }
  saveState();
  return true;
}

document.getElementById('shiftForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!saveShiftForm()) return;
  shiftModal.close();
  dayModal.close();
  renderAll();
});

document.getElementById('saveAddAnotherBtn').addEventListener('click', () => {
  if (!saveShiftForm()) return;
  renderDayShiftList();
  renderAll();
  shiftModal.close();
  openShiftModal(null);
});

deleteShiftBtn.addEventListener('click', () => {
  if (!editingShiftId) return;
  if (!confirm('このシフトを削除しますか？')) return;
  state.shifts = state.shifts.filter(s => s.id !== editingShiftId);
  saveState();
  shiftModal.close();
  dayModal.close();
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
  workplaceModal.close();
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
  workplaceModal.close();
  renderAll();
});

// ---- settings menu ----
const settingsModal = document.getElementById('settingsModal');

document.getElementById('btnSettings').addEventListener('click', () => {
  settingsModal.showModal();
});

// ---- shared year-chart rendering (used by 年間収入 and 年間収入グラフ) ----
function computeYearlyValues(year) {
  const values = [];
  for (let m = 0; m < 12; m++) values.push(monthlyIncomeFor(year, m));
  return values;
}

function buildYearChartSvg(year, values) {
  const max = Math.max(1, ...values);
  const width = 320, height = 210, padTop = 20, padBottom = 26, barGap = 6;
  const barWidth = (width - barGap * 13) / 12;

  let bars = '';
  values.forEach((v, i) => {
    const h = max > 0 ? (v / max) * (height - padTop - padBottom) : 0;
    const x = barGap + i * (barWidth + barGap);
    const y = height - padBottom - h;
    const isCurrent = year === viewYear && i === viewMonth;
    bars += `<rect x="${x}" y="${y}" width="${barWidth}" height="${Math.max(h, 1)}" rx="3" class="year-chart-bar${isCurrent ? ' current' : ''}"></rect>`;
    if (v > 0) {
      const labelY = Math.max(padTop - 4, y - 4);
      bars += `<text x="${x + barWidth / 2}" y="${labelY}" text-anchor="middle" class="year-chart-value-label">${(v / 10000).toFixed(1)}万</text>`;
    }
    bars += `<text x="${x + barWidth / 2}" y="${height - padBottom + 16}" text-anchor="middle" class="year-chart-month-label">${i + 1}</text>`;
  });

  return `<svg viewBox="0 0 ${width} ${height}" class="year-chart-svg">${bars}</svg>`;
}

// ---- 年間収入（上限額の設定） ----
const yearLimitModal = document.getElementById('yearLimitModal');
const yearLimitEnabledInput = document.getElementById('yearLimitEnabled');
const yearLimitPresetSel = document.getElementById('yearLimitPreset');
const yearLimitValueInput = document.getElementById('yearLimitValue');
const yearLimitChartWrap = document.getElementById('yearLimitChartWrap');
const yearLimitTotalIncome = document.getElementById('yearLimitTotalIncome');
const yearLimitAvgIncome = document.getElementById('yearLimitAvgIncome');

function renderYearLimitChart() {
  const values = computeYearlyValues(viewYear);
  yearLimitChartWrap.innerHTML = buildYearChartSvg(viewYear, values);
  const total = values.reduce((a, b) => a + b, 0);
  yearLimitTotalIncome.textContent = `年間合計：${fmtYen(total)}`;
  yearLimitAvgIncome.textContent = `平均月収：${fmtYen(total / 12)}`;
}

document.getElementById('openYearLimitBtn').addEventListener('click', () => {
  yearLimitEnabledInput.checked = state.settings.yearLimitEnabled;
  yearLimitValueInput.value = state.settings.yearLimitValue || '';
  const presetMatch = Array.from(yearLimitPresetSel.options).find(o => Number(o.value) === state.settings.yearLimitValue);
  yearLimitPresetSel.value = presetMatch ? presetMatch.value : (state.settings.yearLimitValue ? 'custom' : '');
  renderYearLimitChart();
  yearLimitModal.showModal();
});

yearLimitPresetSel.addEventListener('change', () => {
  if (yearLimitPresetSel.value && yearLimitPresetSel.value !== 'custom') {
    yearLimitValueInput.value = yearLimitPresetSel.value;
  }
});

document.getElementById('closeYearLimit').addEventListener('click', () => yearLimitModal.close());

document.getElementById('saveYearLimitBtn').addEventListener('click', () => {
  state.settings.yearLimitEnabled = yearLimitEnabledInput.checked;
  state.settings.yearLimitValue = Number(yearLimitValueInput.value) || 0;
  saveState();
  yearLimitModal.close();
  renderAll();
});

// ---- 月次レポート ----
const monthlyReportModal = document.getElementById('monthlyReportModal');
const reportMonthLabel = document.getElementById('reportMonthLabel');
const reportWorkDaysEl = document.getElementById('reportWorkDays');
const reportWorkHoursEl = document.getElementById('reportWorkHours');
const reportPredictedIncomeEl = document.getElementById('reportPredictedIncome');
const reportActualIncomeInput = document.getElementById('reportActualIncomeInput');
let reportYear = viewYear;
let reportMonth = viewMonth;

function renderMonthlyReport() {
  reportMonthLabel.textContent = `${reportYear}年${reportMonth + 1}月`;
  const shifts = shiftsForMonth(reportYear, reportMonth);
  const workDays = new Set(shifts.map(s => s.date)).size;
  const workHours = shifts.reduce((sum, s) => sum + effectiveShiftHours(s), 0);
  reportWorkDaysEl.textContent = `${workDays}日`;
  reportWorkHoursEl.textContent = fmtHours(workHours);
  reportPredictedIncomeEl.textContent = fmtYen(calculatedMonthIncome(reportYear, reportMonth));
  const key = monthKeyFor(reportYear, reportMonth);
  reportActualIncomeInput.value = state.actualMonthlyIncome[key] != null ? state.actualMonthlyIncome[key] : '';
}

document.getElementById('openMonthlyReportBtn').addEventListener('click', () => {
  reportYear = viewYear;
  reportMonth = viewMonth;
  renderMonthlyReport();
  monthlyReportModal.showModal();
});
const reportPageMain = document.querySelector('#monthlyReportModal .page-main');
function reportGoToPrevMonth() {
  reportMonth--;
  if (reportMonth < 0) { reportMonth = 11; reportYear--; }
  animateSwap(reportPageMain, 'right', renderMonthlyReport);
}
function reportGoToNextMonth() {
  reportMonth++;
  if (reportMonth > 11) { reportMonth = 0; reportYear++; }
  animateSwap(reportPageMain, 'left', renderMonthlyReport);
}
document.getElementById('reportPrevMonth').addEventListener('click', reportGoToPrevMonth);
document.getElementById('reportNextMonth').addEventListener('click', reportGoToNextMonth);
document.getElementById('closeMonthlyReport').addEventListener('click', () => monthlyReportModal.close());
onHorizontalSwipe(monthlyReportModal.querySelector('.modal-form'), {
  onSwipeLeft: reportGoToNextMonth,
  onSwipeRight: reportGoToPrevMonth,
});

document.getElementById('saveReportBtn').addEventListener('click', () => {
  const key = monthKeyFor(reportYear, reportMonth);
  const rawVal = reportActualIncomeInput.value.trim();
  if (rawVal === '') {
    delete state.actualMonthlyIncome[key];
  } else {
    state.actualMonthlyIncome[key] = Number(rawVal) || 0;
  }
  saveState();
  monthlyReportModal.close();
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
