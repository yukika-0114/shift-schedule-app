'use strict';

function twMinToTime(min) {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function twTimeToMin(str) {
  const [h, m] = str.split(':').map(Number);
  return h * 60 + m;
}

function twDurationHours(startMin, endMin, breakMin) {
  let end = endMin;
  if (end <= startMin) end += 1440;
  const worked = (end - startMin) - (Number(breakMin) || 0);
  return Math.max(0, worked) / 60;
}

function twPolar(cx, cy, r, angleDeg) {
  const rad = angleDeg * Math.PI / 180;
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

function twRingPath(cx, cy, rInner, rOuter, startAngle, endAngle) {
  let a1 = startAngle, a2 = endAngle;
  if (a2 <= a1) a2 += 360;
  if (a2 - a1 >= 359.99) a2 = a1 + 359.99;
  const large = (a2 - a1) > 180 ? 1 : 0;
  const po1 = twPolar(cx, cy, rOuter, a1);
  const po2 = twPolar(cx, cy, rOuter, a2);
  const pi2 = twPolar(cx, cy, rInner, a2);
  const pi1 = twPolar(cx, cy, rInner, a1);
  return `M ${po1.x} ${po1.y} A ${rOuter} ${rOuter} 0 ${large} 1 ${po2.x} ${po2.y} ` +
         `L ${pi2.x} ${pi2.y} A ${rInner} ${rInner} 0 ${large} 0 ${pi1.x} ${pi1.y} Z`;
}

const TW_SVG_NS = 'http://www.w3.org/2000/svg';
function twEl(tag, attrs) {
  const el = document.createElementNS(TW_SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function mountTimeRangeWheel(container, options) {
  const opts = Object.assign({
    startMinutes: 9 * 60,
    endMinutes: 17 * 60,
    breakMinutes: 0,
    accent: '#4f46e5',
    onChange: () => {},
    startLabel: '開始',
    endLabel: '終了',
  }, options);

  let startMin = opts.startMinutes;
  let endMin = opts.endMinutes;
  let breakMin = Number(opts.breakMinutes) || 0;
  let dragging = null;

  container.innerHTML = '';
  container.classList.add('time-wheel');

  const labelsRow = document.createElement('div');
  labelsRow.className = 'time-wheel-labels';

  function buildLabelBlock(title) {
    const block = document.createElement('div');
    block.className = 'time-wheel-label-block';
    const titleEl = document.createElement('span');
    titleEl.className = 'time-wheel-label-title';
    titleEl.textContent = title;
    const row = document.createElement('div');
    row.className = 'time-wheel-tap';
    const input = document.createElement('input');
    input.type = 'time';
    input.step = 60;
    input.className = 'time-wheel-time-input';
    const badgeEl = document.createElement('span');
    badgeEl.className = 'time-wheel-badge';
    badgeEl.hidden = true;
    badgeEl.textContent = '翌日';
    row.appendChild(input);
    row.appendChild(badgeEl);
    block.appendChild(titleEl);
    block.appendChild(row);
    labelsRow.appendChild(block);
    return { input, badgeEl };
  }

  const startBlock = buildLabelBlock(opts.startLabel);
  const endBlock = buildLabelBlock(opts.endLabel);
  container.appendChild(labelsRow);

  const dialWrap = document.createElement('div');
  dialWrap.className = 'time-wheel-dial-wrap';
  container.appendChild(dialWrap);

  // viewBox sized with generous margin so cardinal labels (0/6/12/18) never clip.
  const size = 320;
  const cx = size / 2, cy = size / 2;
  const outerR = 116, innerR = 86, handleR = 16, hitR = 27, labelR = 138, iconR = 120;

  const svg = twEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'time-wheel-svg' });

  const trackBg = twEl('path', { d: twRingPath(cx, cy, innerR, outerR, 0, 359.99), class: 'time-wheel-track-bg' });
  svg.appendChild(trackBg);

  const arcPath = twEl('path', { class: 'time-wheel-arc' });
  arcPath.style.fill = opts.accent;
  svg.appendChild(arcPath);

  const hourGroup = twEl('g', {});
  for (let hour = 0; hour < 24; hour += 2) {
    const angle = (hour / 24) * 360;
    const p = twPolar(cx, cy, labelR, angle);
    const t = twEl('text', { x: p.x, y: p.y, class: 'time-wheel-hour-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    t.textContent = String(hour);
    hourGroup.appendChild(t);
    if (hour === 0 || hour === 12) {
      const ip = twPolar(cx, cy, iconR, angle);
      const icon = twEl('text', { x: ip.x, y: ip.y, class: 'time-wheel-hour-icon', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
      icon.textContent = hour === 0 ? '✨' : '☀️';
      hourGroup.appendChild(icon);
    }
  }
  svg.appendChild(hourGroup);

  const centerText = twEl('text', { x: cx, y: cy, class: 'time-wheel-duration', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
  svg.appendChild(centerText);

  function buildHandle(role, label) {
    const g = twEl('g', { class: 'time-wheel-handle', 'data-role': role });
    const hit = twEl('circle', { r: hitR, class: 'time-wheel-handle-hit' });
    const knob = twEl('circle', { r: handleR, class: 'time-wheel-handle-knob' });
    knob.style.fill = opts.accent;
    const txt = twEl('text', { class: 'time-wheel-handle-label', 'text-anchor': 'middle', 'dominant-baseline': 'middle' });
    txt.textContent = label;
    g.appendChild(hit);
    g.appendChild(knob);
    g.appendChild(txt);
    svg.appendChild(g);
    return g;
  }
  const startHandle = buildHandle('start', '始');
  const endHandle = buildHandle('end', '終');

  dialWrap.appendChild(svg);

  function angleForMin(min) { return (min / 1440) * 360; }

  function updateDom() {
    const sAngle = angleForMin(startMin);
    const eAngleRaw = angleForMin(endMin);
    const sp = twPolar(cx, cy, (outerR + innerR) / 2, sAngle);
    const ep = twPolar(cx, cy, (outerR + innerR) / 2, eAngleRaw);
    startHandle.setAttribute('transform', `translate(${sp.x} ${sp.y})`);
    endHandle.setAttribute('transform', `translate(${ep.x} ${ep.y})`);

    arcPath.setAttribute('d', twRingPath(cx, cy, innerR, outerR, sAngle, eAngleRaw));

    const hours = twDurationHours(startMin, endMin, breakMin);
    centerText.textContent = hours.toFixed(2).replace(/\.?0+$/, '') + '時間';

    startBlock.input.value = twMinToTime(startMin);
    endBlock.input.value = twMinToTime(endMin);
    endBlock.badgeEl.hidden = endMin > startMin;
  }

  function pointToMinutes(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const scale = size / rect.width;
    const x = (clientX - rect.left) * scale;
    const y = (clientY - rect.top) * scale;
    const dx = x - cx, dy = y - cy;
    let angle = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (angle < 0) angle += 360;
    // 1-minute resolution so fine adjustments (e.g. a few minutes) are reachable by drag.
    let min = Math.round((angle / 360) * 1440);
    if (min >= 1440) min = 0;
    return min;
  }

  function handlePointerDown(role) {
    return (e) => {
      e.preventDefault();
      dragging = role;
      if (e.target.setPointerCapture) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
    };
  }

  function onPointerMove(e) {
    if (!dragging) return;
    e.preventDefault();
    const min = pointToMinutes(e.clientX, e.clientY);
    if (dragging === 'start') startMin = min; else endMin = min;
    updateDom();
    opts.onChange({ startMin, endMin });
  }

  function onPointerUp() { dragging = null; }

  startHandle.addEventListener('pointerdown', handlePointerDown('start'));
  endHandle.addEventListener('pointerdown', handlePointerDown('end'));
  svg.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);

  startBlock.input.addEventListener('change', () => {
    if (startBlock.input.value) {
      startMin = twTimeToMin(startBlock.input.value);
      updateDom();
      opts.onChange({ startMin, endMin });
    }
  });
  endBlock.input.addEventListener('change', () => {
    if (endBlock.input.value) {
      endMin = twTimeToMin(endBlock.input.value);
      updateDom();
      opts.onChange({ startMin, endMin });
    }
  });

  updateDom();

  return {
    getTimes() { return { startMin, endMin }; },
    setTimes(s, e) {
      startMin = ((s % 1440) + 1440) % 1440;
      endMin = ((e % 1440) + 1440) % 1440;
      updateDom();
    },
    setBreakMinutes(b) {
      breakMin = Number(b) || 0;
      updateDom();
    },
  };
}

window.TimeWheel = {
  mount: mountTimeRangeWheel,
  minToTime: twMinToTime,
  timeToMin: twTimeToMin,
  durationHours: twDurationHours,
};
