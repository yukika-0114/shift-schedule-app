'use strict';

const STORAGE_KEY = 'shiftapp_v1';

const DEFAULT_STATE = {
  workplaces: [],
  shifts: [],
  settings: { yearLimitEnabled: false, yearLimitValue: 1030000 },
  actualMonthlyIncome: {},
  timePresets: [],
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
      timePresets: parsed.timePresets || [],
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

// makes a numeric field's existing value select automatically on focus, so
// tapping it lets you overtype immediately instead of needing to clear it.
function selectOnFocus(el) {
  el.addEventListener('focus', () => el.select());
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
let editingPresetId = null;

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

// ---- multi-date selection (long-press a day to batch-add the same shift) ----
let selectionMode = false;
let selectedDates = new Set();
const selectionBar = document.getElementById('selectionBar');
const selectionCountLabel = document.getElementById('selectionCountLabel');

function updateSelectionCountLabel() {
  selectionCountLabel.textContent = `${selectedDates.size}日を選択中`;
}

function enterSelectionMode(key) {
  selectionMode = true;
  selectedDates = new Set([key]);
  selectionBar.hidden = false;
  updateSelectionCountLabel();
  renderCalendar();
}

function toggleDateSelection(key) {
  if (selectedDates.has(key)) selectedDates.delete(key);
  else selectedDates.add(key);
  if (selectedDates.size === 0) { exitSelectionMode(); return; }
  updateSelectionCountLabel();
  renderCalendar();
}

function exitSelectionMode() {
  selectionMode = false;
  selectedDates = new Set();
  selectionBar.hidden = true;
  renderCalendar();
}

document.getElementById('selectionCancelBtn').addEventListener('click', exitSelectionMode);
document.getElementById('selectionDeleteBtn').addEventListener('click', () => {
  const dates = [...selectedDates];
  const count = state.shifts.filter(s => dates.includes(s.date)).length;
  const msg = count > 0
    ? `選択した${dates.length}日分のシフト（${count}件）を削除しますか？`
    : `選択した${dates.length}日にはシフトがありません。選択を解除しますか？`;
  if (!confirm(msg)) return;
  state.shifts = state.shifts.filter(s => !dates.includes(s.date));
  saveState();
  exitSelectionMode();
  renderSummary();
});
document.getElementById('selectionConfirmBtn').addEventListener('click', () => {
  const dates = [...selectedDates].sort();
  exitSelectionMode();
  if (state.workplaces.length === 0) {
    alert('先に「職場」を登録してください。');
    openWorkplaceModal();
    return;
  }
  currentDayKey = dates[0];
  openShiftModal(null, dates.slice(1));
});

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
    btn.dataset.dateKey = key;
    if (cell.otherMonth) btn.classList.add('other-month');
    if (key === today) btn.classList.add('today');
    if (col === 0) btn.classList.add('sun-col');
    if (col === 6) btn.classList.add('sat-col');
    if (selectedDates.has(key)) btn.classList.add('selected');

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

    btn.addEventListener('click', () => {
      if (longPressTriggered) { longPressTriggered = false; return; }
      if (selectionMode) toggleDateSelection(key);
      else openDayModal(key);
    });
    calendarEl.appendChild(btn);
  });
}

// ---- long-press detection on the calendar (enters/extends selection mode) ----
let longPressTimer = null;
let longPressTriggered = false;
let longPressStartX = 0, longPressStartY = 0;

function cancelLongPress() {
  if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
}

calendarEl.addEventListener('pointerdown', (e) => {
  const cell = e.target.closest('.day-cell');
  if (!cell) return;
  longPressTriggered = false;
  longPressStartX = e.clientX;
  longPressStartY = e.clientY;
  longPressTimer = window.setTimeout(() => {
    longPressTriggered = true;
    const key = cell.dataset.dateKey;
    if (selectionMode) toggleDateSelection(key);
    else enterSelectionMode(key);
  }, 500);
});
calendarEl.addEventListener('pointerup', cancelLongPress);
calendarEl.addEventListener('pointercancel', cancelLongPress);
calendarEl.addEventListener('pointerleave', cancelLongPress);
calendarEl.addEventListener('pointermove', (e) => {
  if (!longPressTimer) return;
  if (Math.abs(e.clientX - longPressStartX) > 10 || Math.abs(e.clientY - longPressStartY) > 10) cancelLongPress();
});

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
  monthIncomeLabelEl.textContent = hasOverride ? '今月の実績収入' : '今月の収入見込み';
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
const timeBlockList = document.getElementById('timeBlockList');
const addTimeBlockBtn = document.getElementById('addTimeBlockBtn');
const shiftMemoInput = document.getElementById('shiftMemo');
const shiftCalcPreview = document.getElementById('shiftCalcPreview');
const deleteShiftBtn = document.getElementById('deleteShiftBtn');
const actualToggleInput = document.getElementById('actualToggle');
const actualSection = document.getElementById('actualSection');
const actualStartInput = document.getElementById('actualStart');
const actualEndInput = document.getElementById('actualEnd');
const actualBreakInput = document.getElementById('actualBreak');
const actualToggleWrap = document.getElementById('actualToggleWrap');
const batchSection = document.getElementById('batchSection');
const batchDateList = document.getElementById('batchDateList');
let batchDates = [];

selectOnFocus(actualBreakInput);

function renderBatchDateList() {
  batchDateList.innerHTML = '';
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
      batchSection.hidden = batchDates.length === 0;
      updateActualToggleVisibility();
    });
    chip.appendChild(rm);
    batchDateList.appendChild(chip);
  });
}

function updateActualToggleVisibility() {
  const hide = getTimeBlocks().length > 1 || batchDates.length > 0;
  actualToggleWrap.hidden = hide;
  if (hide && actualToggleInput.checked) {
    actualToggleInput.checked = false;
    actualSection.hidden = true;
  }
}

// ---- time blocks (the "＋" repeatable start/end/break rows) ----
function buildPresetChipList(row) {
  const startInput = row.querySelector('.tb-start');
  const endInput = row.querySelector('.tb-end');
  const breakInput = row.querySelector('.tb-break');
  const chipsWrap = row.querySelector('.tb-preset-chips');
  chipsWrap.innerHTML = '';
  state.timePresets.forEach(p => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'tb-preset-chip';
    chip.textContent = (p.label ? p.label + '　' : '') + `${p.start}-${p.end}`;
    chip.addEventListener('click', () => {
      startInput.value = p.start;
      endInput.value = p.end;
      breakInput.value = p.breakMin;
      updateShiftCalcPreview();
    });
    chipsWrap.appendChild(chip);
  });
}

function refreshAllPresetChipLists() {
  timeBlockList.querySelectorAll('.time-block-row').forEach(buildPresetChipList);
}

function updateTimeBlockRemoveButtons() {
  const rows = timeBlockList.querySelectorAll('.time-block-row');
  rows.forEach(row => {
    row.querySelector('.tb-remove-btn').hidden = rows.length <= 1;
  });
}

function createTimeBlockRow(data) {
  data = data || { start: '09:00', end: '17:00', breakMin: 0 };
  const row = document.createElement('div');
  row.className = 'time-block-row';

  const presetChips = document.createElement('div');
  presetChips.className = 'tb-preset-chips';
  row.appendChild(presetChips);

  const fieldRow = document.createElement('div');
  fieldRow.className = 'field-row';

  const startLabel = document.createElement('label');
  startLabel.className = 'field';
  const startSpan = document.createElement('span');
  startSpan.textContent = '開始';
  const startInput = document.createElement('input');
  startInput.type = 'time';
  startInput.className = 'tb-start';
  startInput.required = true;
  startInput.value = data.start;
  startLabel.appendChild(startSpan);
  startLabel.appendChild(startInput);

  const endLabel = document.createElement('label');
  endLabel.className = 'field';
  const endSpan = document.createElement('span');
  endSpan.textContent = '終了';
  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.className = 'tb-end';
  endInput.required = true;
  endInput.value = data.end;
  endLabel.appendChild(endSpan);
  endLabel.appendChild(endInput);

  fieldRow.appendChild(startLabel);
  fieldRow.appendChild(endLabel);
  row.appendChild(fieldRow);

  const breakLabel = document.createElement('label');
  breakLabel.className = 'field';
  const breakSpan = document.createElement('span');
  breakSpan.textContent = '休憩（分）';
  const breakInput = document.createElement('input');
  breakInput.type = 'number';
  breakInput.className = 'tb-break';
  breakInput.min = '0';
  breakInput.step = '5';
  breakInput.value = data.breakMin;
  selectOnFocus(breakInput);
  breakLabel.appendChild(breakSpan);
  breakLabel.appendChild(breakInput);
  row.appendChild(breakLabel);

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'tb-remove-btn';
  removeBtn.textContent = '× この時間帯を削除';
  removeBtn.addEventListener('click', () => {
    row.remove();
    updateTimeBlockRemoveButtons();
    updateActualToggleVisibility();
    updateShiftCalcPreview();
  });
  row.appendChild(removeBtn);

  [startInput, endInput, breakInput].forEach(el => {
    el.addEventListener('input', updateShiftCalcPreview);
    el.addEventListener('change', updateShiftCalcPreview);
  });

  buildPresetChipList(row);

  return row;
}

function resetTimeBlocks(blocks) {
  timeBlockList.innerHTML = '';
  const list = blocks && blocks.length ? blocks : [{ start: '09:00', end: '17:00', breakMin: 0 }];
  list.forEach(b => timeBlockList.appendChild(createTimeBlockRow(b)));
  updateTimeBlockRemoveButtons();
}

function getTimeBlocks() {
  return [...timeBlockList.querySelectorAll('.time-block-row')].map(row => ({
    start: row.querySelector('.tb-start').value,
    end: row.querySelector('.tb-end').value,
    breakMin: Number(row.querySelector('.tb-break').value) || 0,
  }));
}

addTimeBlockBtn.addEventListener('click', () => {
  timeBlockList.appendChild(createTimeBlockRow());
  updateTimeBlockRemoveButtons();
  updateActualToggleVisibility();
  updateShiftCalcPreview();
});

function updateShiftCalcPreview() {
  const wp = state.workplaces.find(w => w.id === shiftWorkplaceSel.value);
  if (!wp) { shiftCalcPreview.textContent = ''; return; }
  const blocks = getTimeBlocks();
  let totalHours = 0;
  blocks.forEach(b => {
    if (b.start && b.end) totalHours += shiftDurationHours(b.start, b.end, b.breakMin);
  });
  let text = `予定：${fmtHours(totalHours)} ・ ${fmtYen(totalHours * wp.wage)}`;
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

function openShiftModal(shiftId, presetBatchDates) {
  editingShiftId = shiftId;
  populateWorkplaceSelect();
  batchDates = [];
  batchSection.hidden = true;
  renderBatchDateList();

  if (shiftId) {
    const s = state.shifts.find(x => x.id === shiftId);
    shiftModalTitle.textContent = 'シフトを編集';
    shiftWorkplaceSel.value = s.workplaceId;
    resetTimeBlocks([{ start: s.start, end: s.end, breakMin: s.breakMin }]);
    addTimeBlockBtn.hidden = true;
    shiftMemoInput.value = s.memo || '';
    actualToggleInput.checked = !!s.hasActual;
    actualSection.hidden = !s.hasActual;
    actualStartInput.value = s.hasActual ? s.actualStart : s.start;
    actualEndInput.value = s.hasActual ? s.actualEnd : s.end;
    actualBreakInput.value = s.hasActual ? (s.actualBreakMin || 0) : s.breakMin;
    deleteShiftBtn.hidden = false;
  } else {
    shiftModalTitle.textContent = 'シフトを追加';
    resetTimeBlocks();
    addTimeBlockBtn.hidden = false;
    shiftMemoInput.value = '';
    actualToggleInput.checked = false;
    actualSection.hidden = true;
    actualStartInput.value = '09:00';
    actualEndInput.value = '17:00';
    actualBreakInput.value = 0;
    deleteShiftBtn.hidden = true;

    if (presetBatchDates && presetBatchDates.length > 0) {
      batchDates = presetBatchDates.slice();
      batchSection.hidden = false;
      renderBatchDateList();
    }
  }
  updateActualToggleVisibility();
  updateShiftCalcPreview();
  shiftModal.showModal();
}

shiftWorkplaceSel.addEventListener('change', updateShiftCalcPreview);
[actualStartInput, actualEndInput, actualBreakInput].forEach(el => {
  el.addEventListener('input', updateShiftCalcPreview);
  el.addEventListener('change', updateShiftCalcPreview);
});

actualToggleInput.addEventListener('change', () => {
  actualSection.hidden = !actualToggleInput.checked;
  if (actualToggleInput.checked) {
    const first = getTimeBlocks()[0] || { start: '09:00', end: '17:00', breakMin: 0 };
    actualStartInput.value = first.start;
    actualEndInput.value = first.end;
    actualBreakInput.value = first.breakMin;
  }
  updateShiftCalcPreview();
});

document.getElementById('closeShiftModal').addEventListener('click', () => shiftModal.close());

// saves the form as one shift (editing) or one shift per date × time-block
// (adding, combining the batch dates with every time block entered).
function saveShiftForm() {
  const blocks = getTimeBlocks();
  if (!shiftWorkplaceSel.value || blocks.length === 0 || blocks.some(b => !b.start || !b.end)) return false;
  const shared = {
    workplaceId: shiftWorkplaceSel.value,
    memo: shiftMemoInput.value.trim(),
  };

  if (editingShiftId) {
    const s = state.shifts.find(x => x.id === editingShiftId);
    const block = blocks[0];
    Object.assign(s, shared, {
      date: currentDayKey,
      start: block.start,
      end: block.end,
      breakMin: block.breakMin,
      hasActual: actualToggleInput.checked,
    });
    if (actualToggleInput.checked) {
      s.actualStart = actualStartInput.value;
      s.actualEnd = actualEndInput.value;
      s.actualBreakMin = Number(actualBreakInput.value) || 0;
    } else {
      delete s.actualStart;
      delete s.actualEnd;
      delete s.actualBreakMin;
    }
  } else {
    const targetDates = batchDates.length > 0
      ? [currentDayKey, ...batchDates]
      : [currentDayKey];
    const hasActual = blocks.length === 1 && actualToggleInput.checked;
    targetDates.forEach(date => {
      blocks.forEach(block => {
        const data = Object.assign(
          { id: uid(), date, start: block.start, end: block.end, breakMin: block.breakMin, hasActual },
          shared
        );
        if (hasActual) {
          data.actualStart = actualStartInput.value;
          data.actualEnd = actualEndInput.value;
          data.actualBreakMin = Number(actualBreakInput.value) || 0;
        }
        state.shifts.push(data);
      });
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

// ---- 時間帯プリセット ----
const presetListModal = document.getElementById('presetListModal');
const presetListEl = document.getElementById('presetList');
const presetEditModal = document.getElementById('presetEditModal');
const presetEditTitle = document.getElementById('presetEditTitle');
const presetNameInput = document.getElementById('presetName');
const presetStartInput = document.getElementById('presetStart');
const presetEndInput = document.getElementById('presetEnd');
const presetBreakInput = document.getElementById('presetBreak');
const deletePresetBtn = document.getElementById('deletePresetBtn');

selectOnFocus(presetBreakInput);

function renderPresetList() {
  presetListEl.innerHTML = '';
  if (state.timePresets.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'まだプリセットが登録されていません';
    presetListEl.appendChild(hint);
    return;
  }
  state.timePresets.forEach(p => {
    const row = document.createElement('div');
    row.className = 'workplace-row';
    const main = document.createElement('div');
    main.className = 'workplace-row-main';
    const name = document.createElement('span');
    name.className = 'workplace-row-name';
    name.textContent = p.label || `${p.start} - ${p.end}`;
    const sub = document.createElement('span');
    sub.className = 'workplace-row-sub';
    sub.textContent = `${p.start} - ${p.end}` + (p.breakMin ? `（休憩${p.breakMin}分）` : '');
    main.appendChild(name);
    main.appendChild(sub);
    row.appendChild(main);
    row.addEventListener('click', () => openPresetEditModal(p.id));
    presetListEl.appendChild(row);
  });
}

document.getElementById('openPresetListBtn').addEventListener('click', () => {
  renderPresetList();
  presetListModal.showModal();
});
document.getElementById('closePresetList').addEventListener('click', () => presetListModal.close());
document.getElementById('addPresetBtn').addEventListener('click', () => openPresetEditModal(null));

function openPresetEditModal(presetId) {
  editingPresetId = presetId;
  if (presetId) {
    const p = state.timePresets.find(x => x.id === presetId);
    presetEditTitle.textContent = 'プリセットを編集';
    presetNameInput.value = p.label || '';
    presetStartInput.value = p.start;
    presetEndInput.value = p.end;
    presetBreakInput.value = p.breakMin;
    deletePresetBtn.hidden = false;
  } else {
    presetEditTitle.textContent = 'プリセットを追加';
    presetNameInput.value = '';
    presetStartInput.value = '09:00';
    presetEndInput.value = '17:00';
    presetBreakInput.value = 0;
    deletePresetBtn.hidden = true;
  }
  presetEditModal.showModal();
}

document.getElementById('closePresetEditModal').addEventListener('click', () => presetEditModal.close());

presetEditModal.querySelector('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!presetStartInput.value || !presetEndInput.value) return;
  const data = {
    label: presetNameInput.value.trim(),
    start: presetStartInput.value,
    end: presetEndInput.value,
    breakMin: Number(presetBreakInput.value) || 0,
  };
  if (editingPresetId) {
    const p = state.timePresets.find(x => x.id === editingPresetId);
    Object.assign(p, data);
  } else {
    state.timePresets.push(Object.assign({ id: uid() }, data));
  }
  saveState();
  presetEditModal.close();
  renderPresetList();
  refreshAllPresetChipLists();
});

deletePresetBtn.addEventListener('click', () => {
  if (!editingPresetId) return;
  if (!confirm('このプリセットを削除しますか？')) return;
  state.timePresets = state.timePresets.filter(p => p.id !== editingPresetId);
  saveState();
  presetEditModal.close();
  renderPresetList();
  refreshAllPresetChipLists();
});

// ---- shared year-chart rendering (used by 年間収入) ----
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

function saveYearLimit() {
  state.settings.yearLimitEnabled = yearLimitEnabledInput.checked;
  state.settings.yearLimitValue = Number(yearLimitValueInput.value) || 0;
  saveState();
  renderAll();
}

yearLimitPresetSel.addEventListener('change', () => {
  if (yearLimitPresetSel.value && yearLimitPresetSel.value !== 'custom') {
    yearLimitValueInput.value = yearLimitPresetSel.value;
  }
  saveYearLimit();
});
yearLimitEnabledInput.addEventListener('change', saveYearLimit);
yearLimitValueInput.addEventListener('input', saveYearLimit);
yearLimitValueInput.addEventListener('change', saveYearLimit);

document.getElementById('closeYearLimit').addEventListener('click', () => yearLimitModal.close());

// ---- 月次レポート ----
const monthlyReportModal = document.getElementById('monthlyReportModal');
const reportMonthLabel = document.getElementById('reportMonthLabel');
const reportWorkDaysEl = document.getElementById('reportWorkDays');
const reportPlannedHoursEl = document.getElementById('reportPlannedHours');
const reportWorkHoursEl = document.getElementById('reportWorkHours');
const reportHoursDiffEl = document.getElementById('reportHoursDiff');
const reportPredictedIncomeEl = document.getElementById('reportPredictedIncome');
const reportActualIncomeInput = document.getElementById('reportActualIncomeInput');
let reportYear = viewYear;
let reportMonth = viewMonth;

selectOnFocus(reportActualIncomeInput);

function renderMonthlyReport() {
  reportMonthLabel.textContent = `${reportYear}年${reportMonth + 1}月`;
  const shifts = shiftsForMonth(reportYear, reportMonth);
  const workDays = new Set(shifts.map(s => s.date)).size;
  // 予定勤務時間: always the scheduled start/end, regardless of any actual record.
  const plannedHours = shifts.reduce((sum, s) => sum + shiftDurationHours(s.start, s.end, s.breakMin), 0);
  // 勤務時間: the actual record when present, otherwise the plan (same as everywhere else in the app).
  const workHours = shifts.reduce((sum, s) => sum + effectiveShiftHours(s), 0);
  const hoursDiff = workHours - plannedHours;

  reportWorkDaysEl.textContent = `${workDays}日`;
  reportPlannedHoursEl.textContent = fmtHours(plannedHours);
  reportWorkHoursEl.textContent = fmtHours(workHours);
  reportHoursDiffEl.textContent = (hoursDiff >= 0 ? '+' : '') + hoursDiff.toFixed(1) + 'h';
  reportHoursDiffEl.classList.remove('diff-positive', 'diff-negative');
  if (hoursDiff > 0.05) reportHoursDiffEl.classList.add('diff-positive');
  else if (hoursDiff < -0.05) reportHoursDiffEl.classList.add('diff-negative');

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

function saveReportActualIncome() {
  const key = monthKeyFor(reportYear, reportMonth);
  const rawVal = reportActualIncomeInput.value.trim();
  if (rawVal === '') {
    delete state.actualMonthlyIncome[key];
  } else {
    state.actualMonthlyIncome[key] = Number(rawVal) || 0;
  }
  saveState();
  renderAll();
}
reportActualIncomeInput.addEventListener('input', saveReportActualIncome);
reportActualIncomeInput.addEventListener('change', saveReportActualIncome);

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
