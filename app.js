'use strict';

/* ---------- constants ---------- */

const API = 'https://api.github.com';
const MAX_PAGES = 6; // per endpoint per repo, 100 items/page => up to 600 items
const FEED_LIMIT = 300;

// Fixed categorical roles (assigned by job, never cycled/reused for status).
const TYPE_COLOR = {
  commit:   'var(--series-1)', // blue
  prOpened: 'var(--series-3)', // aqua
  prMerged: 'var(--series-7)', // violet
  issue:    'var(--series-2)', // orange
};
const TYPE_LABEL = {
  commit: 'Commits', prOpened: 'PRs opened', prMerged: 'PRs merged', issue: 'Issues opened',
};
// Identity palette for per-user lines, in fixed order; index 8+ folds into "Other".
const USER_SLOTS = ['--series-1','--series-2','--series-3','--series-4','--series-5','--series-6','--series-7','--series-8'];

/* ---------- state ---------- */

const state = {
  repos: [],
  users: [],
  days: 30,
  token: '',
  data: null, // aggregated result
  feedFilter: 'all',
};

/* ---------- DOM refs ---------- */

const el = (id) => document.getElementById(id);
const reposInput = el('repos-input');
const usersInput = el('users-input');
const tokenInput = el('token-input');
const loadBtn = el('load-btn');
const statusEl = el('status');
const dashboard = el('dashboard');
const subtitle = el('subtitle');

/* ---------- theme toggle ---------- */

el('theme-toggle').addEventListener('click', () => {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  if (current === 'dark') root.setAttribute('data-theme', 'light');
  else if (current === 'light') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', 'dark');
});

/* ---------- range buttons ---------- */

el('range-row').addEventListener('click', (e) => {
  const btn = e.target.closest('.range-btn');
  if (!btn) return;
  document.querySelectorAll('.range-btn').forEach((b) => b.classList.remove('selected'));
  btn.classList.add('selected');
  state.days = btn.dataset.days === 'all' ? 'all' : Number(btn.dataset.days);
  el('all-time-hint').hidden = state.days !== 'all';
});

/* ---------- input parsing ---------- */

function parseList(raw) {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ---------- GitHub fetch helpers ---------- */

function ghHeaders() {
  const h = { Accept: 'application/vnd.github+json' };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

function parseLinkHeader(link) {
  if (!link) return {};
  const out = {};
  for (const part of link.split(',')) {
    const m = part.match(/<([^>]+)>;\s*rel="([^"]+)"/);
    if (m) out[m[2]] = m[1];
  }
  return out;
}

class RateLimitError extends Error {}

async function ghFetch(url) {
  const res = await fetch(url, { headers: ghHeaders() });
  if (res.status === 403 || res.status === 429) {
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (remaining === '0') throw new RateLimitError('GitHub API rate limit reached. Add a personal access token to continue.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.message || `${res.status} ${res.statusText}`);
  }
  return res;
}

// Fetch pages until predicate(pageItems) returns true (stop AFTER this page) or MAX_PAGES reached.
async function ghPaginate(url, stopFn) {
  let items = [];
  let next = url;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const res = await ghFetch(next);
    const page = await res.json();
    items = items.concat(page);
    pages++;
    if (stopFn && stopFn(page)) break;
    const links = parseLinkHeader(res.headers.get('link'));
    next = links.next || null;
  }
  return items;
}

/* ---------- data loading & aggregation ---------- */

function isoDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}

function userAllowed(login, name) {
  if (state.users.length === 0) return true;
  const l = (login || '').toLowerCase();
  const n = (name || '').toLowerCase();
  return state.users.some((u) => u.toLowerCase() === l || u.toLowerCase() === n);
}

async function loadRepoActivity(repo, sinceISO) {
  const sinceMs = sinceISO ? new Date(sinceISO).getTime() : -Infinity;
  const events = []; // {ts, user, type, repo, detail, url}

  // --- commits ---
  const commitUrl = `${API}/repos/${repo}/commits?per_page=100${sinceISO ? `&since=${encodeURIComponent(sinceISO)}` : ''}`;
  const commits = await ghPaginate(commitUrl, (page) => page.length < 100);
  for (const c of commits) {
    const login = c.author && c.author.login;
    const name = c.commit && c.commit.author && c.commit.author.name;
    if (!userAllowed(login, name)) continue;
    const message = (c.commit && c.commit.message ? c.commit.message.split('\n')[0] : '').slice(0, 90);
    events.push({
      ts: c.commit.author.date,
      user: login || name || 'unknown',
      type: 'commit',
      repo,
      detail: message || c.sha.slice(0, 7),
      url: c.html_url,
    });
  }

  // --- pull requests (state=all, sorted by updated desc; stop once a page is entirely stale) ---
  const prUrl = `${API}/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100`;
  const prs = await ghPaginate(prUrl, (page) => {
    if (page.length === 0) return true;
    const last = page[page.length - 1];
    return new Date(last.updated_at).getTime() < sinceMs;
  });
  for (const p of prs) {
    const login = p.user && p.user.login;
    if (!userAllowed(login)) continue;
    const title = `#${p.number} ${p.title}`.slice(0, 90);
    if (new Date(p.created_at).getTime() >= sinceMs) {
      events.push({ ts: p.created_at, user: login, type: 'prOpened', repo, detail: title, url: p.html_url });
    }
    if (p.merged_at && new Date(p.merged_at).getTime() >= sinceMs) {
      events.push({ ts: p.merged_at, user: login, type: 'prMerged', repo, detail: title, url: p.html_url });
    }
  }

  // --- issues (excludes PRs; server-side since filter on updated_at) ---
  const issueUrl = `${API}/repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=100${sinceISO ? `&since=${encodeURIComponent(sinceISO)}` : ''}`;
  const issues = await ghPaginate(issueUrl, (page) => page.length < 100);
  for (const i of issues) {
    if (i.pull_request) continue; // exclude PRs, handled above
    const login = i.user && i.user.login;
    if (!userAllowed(login)) continue;
    if (new Date(i.created_at).getTime() < sinceMs) continue;
    const title = `#${i.number} ${i.title}`.slice(0, 90);
    events.push({ ts: i.created_at, user: login, type: 'issue', repo, detail: title, url: i.html_url });
  }

  return events;
}

const TREND_CAP_DAYS = 180; // "All time" still needs a bounded window for the daily trend line

function aggregate(allEvents, days) {
  const byUser = new Map(); // user -> {commit,prOpened,prMerged,issue}
  const byRepo = new Map();
  const byUserRepo = new Map(); // "user||repo" -> counts
  const byDateUser = new Map(); // "YYYY-MM-DD" -> Map(user->count)  (commits only, for the trend chart)

  const bump = (map, key, field) => {
    if (!map.has(key)) map.set(key, { commit: 0, prOpened: 0, prMerged: 0, issue: 0 });
    map.get(key)[field]++;
  };

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  let trendDays = days;
  let trendCapped = false;
  if (days === 'all') {
    const commitTimestamps = allEvents.filter((e) => e.type === 'commit').map((e) => new Date(e.ts).getTime()).filter((t) => !Number.isNaN(t));
    if (commitTimestamps.length) {
      const earliest = new Date(Math.min(...commitTimestamps));
      earliest.setUTCHours(0, 0, 0, 0);
      const spanDays = Math.round((today - earliest) / 86400000) + 1;
      trendDays = Math.min(TREND_CAP_DAYS, Math.max(1, spanDays));
      trendCapped = spanDays > TREND_CAP_DAYS;
    } else {
      trendDays = 30;
    }
  }

  const dateKeys = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    dateKeys.push(d.toISOString().slice(0, 10));
  }
  for (const k of dateKeys) byDateUser.set(k, new Map());

  for (const ev of allEvents) {
    bump(byUser, ev.user, ev.type);
    bump(byRepo, ev.repo, ev.type);
    bump(byUserRepo, `${ev.user}||${ev.repo}`, ev.type);
    if (ev.type === 'commit') {
      const dk = ev.ts.slice(0, 10);
      if (byDateUser.has(dk)) {
        const m = byDateUser.get(dk);
        m.set(ev.user, (m.get(ev.user) || 0) + 1);
      }
    }
  }

  return { byUser, byRepo, byUserRepo, byDateUser, dateKeys, trendCapped };
}

/* ---------- load flow ---------- */

loadBtn.addEventListener('click', () => { runLoad().catch((e) => showError(e)); });

function setStatus(msg, isError) {
  statusEl.textContent = msg || '';
  statusEl.classList.toggle('error', !!isError);
}

function showError(e) {
  console.error(e);
  setStatus(e.message || String(e), true);
  loadBtn.disabled = false;
}

async function runLoad() {
  state.repos = parseList(reposInput.value).map((r) => r.replace(/^https?:\/\/github\.com\//i, '').replace(/\/$/, ''));
  state.users = parseList(usersInput.value);
  state.token = tokenInput.value.trim();

  if (state.repos.length === 0) {
    setStatus('Add at least one repository (owner/repo).', true);
    return;
  }
  for (const r of state.repos) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(r)) {
      setStatus(`"${r}" doesn't look like an owner/repo.`, true);
      return;
    }
  }

  loadBtn.disabled = true;
  dashboard.hidden = true;
  const sinceISO = state.days === 'all' ? null : isoDaysAgo(state.days);

  let allEvents = [];
  const errors = [];
  for (let i = 0; i < state.repos.length; i++) {
    const repo = state.repos[i];
    setStatus(`Loading ${repo} (${i + 1}/${state.repos.length})…`);
    try {
      const events = await loadRepoActivity(repo, sinceISO);
      allEvents = allEvents.concat(events);
    } catch (e) {
      if (e instanceof RateLimitError) { showError(e); return; }
      errors.push(`${repo}: ${e.message}`);
    }
  }

  if (allEvents.length === 0 && errors.length === state.repos.length) {
    setStatus(errors.join(' · '), true);
    loadBtn.disabled = false;
    return;
  }

  state.data = aggregate(allEvents, state.days);
  state.data.events = allEvents.sort((a, b) => new Date(b.ts) - new Date(a.ts));

  setStatus(errors.length ? `Loaded with issues: ${errors.join(' · ')}` : `Loaded ${allEvents.length} events across ${state.repos.length} repositories.`);
  loadBtn.disabled = false;
  render();
}

/* ---------- render: orchestration ---------- */

function render() {
  dashboard.hidden = false;
  const rangeText = state.days === 'all' ? 'all time' : `last ${state.days} days`;
  subtitle.textContent = `${state.repos.length} repositor${state.repos.length === 1 ? 'y' : 'ies'} · ${state.users.length ? state.users.length + ' tracked user' + (state.users.length === 1 ? '' : 's') : 'all contributors'} · ${rangeText}`;
  renderKPIs();
  renderCommitsChart();
  renderCategoryChart('users-chart', 'users-legend', state.data.byUser, 8);
  renderCategoryChart('repos-chart', 'repos-legend', state.data.byRepo, 8);
  renderFeed();
  renderTotalsTable();
}

function sumCounts(counts) {
  return counts.commit + counts.prOpened + counts.prMerged + counts.issue;
}

function renderKPIs() {
  const { byUser, byRepo } = state.data;
  let totals = { commit: 0, prOpened: 0, prMerged: 0, issue: 0 };
  for (const c of byUser.values()) {
    totals.commit += c.commit; totals.prOpened += c.prOpened; totals.prMerged += c.prMerged; totals.issue += c.issue;
  }
  const tiles = [
    { label: 'Commits', value: totals.commit },
    { label: 'PRs opened', value: totals.prOpened },
    { label: 'PRs merged', value: totals.prMerged },
    { label: 'Issues opened', value: totals.issue },
    { label: 'Active contributors', value: byUser.size },
    { label: 'Repositories', value: byRepo.size, sub: `of ${state.repos.length} configured` },
  ];
  el('kpi-row').innerHTML = tiles.map((t) => `
    <div class="kpi-tile">
      <div class="kpi-label">${t.label}</div>
      <div class="kpi-value">${t.value.toLocaleString()}</div>
      ${t.sub ? `<div class="kpi-sub">${t.sub}</div>` : ''}
    </div>`).join('');
}

/* ---------- SVG helpers ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) n.setAttribute(k, attrs[k]);
  return n;
}
function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name.replace('var(', '').replace(')', '')).trim() || name;
}
function resolveColor(v) {
  if (v.startsWith('var(')) return cssVar(v);
  return v;
}

function showTooltip(x, y, html) {
  const tt = el('tooltip');
  tt.innerHTML = html;
  tt.hidden = false;
  const pad = 14;
  let left = x + pad, top = y + pad;
  const rect = tt.getBoundingClientRect();
  if (left + rect.width > window.innerWidth) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight) top = y - rect.height - pad;
  tt.style.left = `${left}px`;
  tt.style.top = `${top}px`;
}
function hideTooltip() { el('tooltip').hidden = true; }

/* ---------- commits-over-time line chart ---------- */

function renderCommitsChart() {
  const { byDateUser, dateKeys } = state.data;
  const container = el('commits-chart');
  container.innerHTML = '';

  // top users by total commits over the range
  const totalsByUser = new Map();
  for (const m of byDateUser.values()) for (const [u, c] of m) totalsByUser.set(u, (totalsByUser.get(u) || 0) + c);
  const sortedUsers = [...totalsByUser.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const maxSeries = 8;
  const shown = sortedUsers.slice(0, maxSeries);
  const hasOther = sortedUsers.length > maxSeries;

  const capNote = state.data.trendCapped ? ` · trend limited to the most recent ${dateKeys.length} days of fetched history` : '';
  el('commits-chart-sub').textContent = `Daily commit count${hasOther ? ` · top ${maxSeries} contributors shown, rest folded into "Other"` : ''}${capNote}`;

  if (dateKeys.every((k) => sumMapValues(byDateUser.get(k)) === 0)) {
    container.innerHTML = '<div class="empty-note">No commits in this range.</div>';
    el('commits-legend').innerHTML = '';
    return;
  }

  const series = shown.map((u, idx) => ({
    name: u,
    color: `var(${USER_SLOTS[idx]})`,
    values: dateKeys.map((k) => (byDateUser.get(k).get(u)) || 0),
  }));
  if (hasOther) {
    series.push({
      name: 'Other',
      color: 'var(--text-muted)',
      values: dateKeys.map((k) => {
        const m = byDateUser.get(k);
        let sum = 0;
        for (const [u, c] of m) if (!shown.includes(u)) sum += c;
        return sum;
      }),
    });
  }

  drawLineChart(container, dateKeys, series);
  el('commits-legend').innerHTML = series.map((s) => legendItem(s.name, s.color)).join('');
}

function sumMapValues(m) { let s = 0; for (const v of m.values()) s += v; return s; }
function legendItem(name, color) {
  return `<span class="legend-item"><span class="legend-swatch" style="background:${resolveColor(color)}"></span>${escapeHtml(name)}</span>`;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function drawLineChart(container, dateKeys, series) {
  const W = 1000, H = 280, padL = 40, padR = 16, padT = 16, padB = 28;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxY = Math.max(1, ...series.flatMap((s) => s.values));
  const n = dateKeys.length;
  const xAt = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v) => padT + plotH - (v / maxY) * plotH;

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Commits over time by user' });

  // gridlines (recessive) + y ticks
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = Math.round((maxY / ticks) * t);
    const y = yAt(v);
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: cssVar('--gridline'), 'stroke-width': 1 }));
    const txt = svgEl('text', { x: padL - 8, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: cssVar('--text-muted') });
    txt.textContent = v;
    svg.appendChild(txt);
  }
  // baseline
  svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1 }));

  // x labels: first, middle, last
  [0, Math.floor((n - 1) / 2), n - 1].forEach((i) => {
    if (i < 0 || i >= n) return;
    const txt = svgEl('text', { x: xAt(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle', 'font-size': 10, fill: cssVar('--text-muted') });
    txt.textContent = dateKeys[i].slice(5);
    svg.appendChild(txt);
  });

  // lines
  for (const s of series) {
    const color = resolveColor(s.color);
    const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${xAt(i).toFixed(2)} ${yAt(v).toFixed(2)}`).join(' ');
    svg.appendChild(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  }

  // hover layer: vertical crosshair over invisible hit columns
  const hitW = plotW / Math.max(1, n - 1 || 1);
  for (let i = 0; i < n; i++) {
    const hit = svgEl('rect', {
      x: xAt(i) - hitW / 2, y: padT, width: hitW, height: plotH, fill: 'transparent',
    });
    hit.addEventListener('mouseenter', (e) => {
      const crosshair = svg.querySelector('.crosshair');
      if (crosshair) crosshair.setAttribute('x1', xAt(i)), crosshair.setAttribute('x2', xAt(i));
      const rows = series
        .map((s) => ({ name: s.name, color: resolveColor(s.color), v: s.values[i] }))
        .filter((r) => r.v > 0)
        .sort((a, b) => b.v - a.v)
        .slice(0, 8);
      const html = `<div class="tt-title">${dateKeys[i]}</div>` +
        (rows.length ? rows.map((r) => `<div class="tt-row"><span class="tt-dot" style="background:${r.color}"></span>${escapeHtml(r.name)}: ${r.v}</div>`).join('') : '<div>No commits</div>');
      const rect = container.getBoundingClientRect();
      showTooltip(rect.left + (xAt(i) / W) * rect.width, e.clientY, html);
    });
    hit.addEventListener('mousemove', (e) => {
      const tt = el('tooltip');
      if (!tt.hidden) showTooltip(e.clientX, e.clientY, tt.innerHTML);
    });
    hit.addEventListener('mouseleave', () => {
      const crosshair = svg.querySelector('.crosshair');
      if (crosshair) crosshair.setAttribute('x1', -100), crosshair.setAttribute('x2', -100);
      hideTooltip();
    });
    svg.appendChild(hit);
  }
  const crosshair = svgEl('line', { class: 'crosshair', x1: -100, x2: -100, y1: padT, y2: padT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1 });
  svg.appendChild(crosshair);

  container.appendChild(svg);
}

/* ---------- by-user / by-repo stacked bar chart ---------- */

function renderCategoryChart(containerId, legendId, dataMap, maxBars) {
  const container = el(containerId);
  container.innerHTML = '';
  const legend = el(legendId);

  let entries = [...dataMap.entries()].map(([name, c]) => ({ name, ...c, total: sumCounts(c) }));
  entries.sort((a, b) => b.total - a.total);
  let other = null;
  if (entries.length > maxBars) {
    const rest = entries.slice(maxBars);
    other = rest.reduce((acc, e) => ({ commit: acc.commit + e.commit, prOpened: acc.prOpened + e.prOpened, prMerged: acc.prMerged + e.prMerged, issue: acc.issue + e.issue }), { commit: 0, prOpened: 0, prMerged: 0, issue: 0 });
    entries = entries.slice(0, maxBars);
  }
  if (other) entries.push({ name: 'Other', ...other, total: sumCounts(other) });

  if (entries.length === 0) {
    container.innerHTML = '<div class="empty-note">No activity in this range.</div>';
    legend.innerHTML = '';
    return;
  }

  const types = ['commit', 'prOpened', 'prMerged', 'issue'];
  drawStackedBarChart(container, entries, types);
  legend.innerHTML = types.map((t) => legendItem(TYPE_LABEL[t], TYPE_COLOR[t])).join('');
}

function drawStackedBarChart(container, entries, types) {
  const n = entries.length;
  const W = 1000, barGap = 14, padL = 8, padR = 8, padT = 16, padB = 46;
  const barW = Math.max(18, Math.min(64, (W - padL - padR - barGap * (n - 1)) / n));
  const usedW = barW * n + barGap * (n - 1);
  const offsetX = padL + Math.max(0, (W - padL - padR - usedW) / 2);
  const H = 260;
  const plotH = H - padT - padB;
  const maxTotal = Math.max(1, ...entries.map((e) => e.total));

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity chart' });

  // gridlines
  const ticks = 4;
  for (let t = 0; t <= ticks; t++) {
    const v = Math.round((maxTotal / ticks) * t);
    const y = padT + plotH - (v / maxTotal) * plotH;
    svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: cssVar('--gridline'), 'stroke-width': 1 }));
    const txt = svgEl('text', { x: padL, y: y - 3, 'font-size': 9.5, fill: cssVar('--text-muted') });
    txt.textContent = v;
    svg.appendChild(txt);
  }
  svg.appendChild(svgEl('line', { x1: padL, x2: W - padR, y1: padT + plotH, y2: padT + plotH, stroke: cssVar('--baseline'), 'stroke-width': 1 }));

  entries.forEach((e, i) => {
    const x = offsetX + i * (barW + barGap);
    let yCursor = padT + plotH;
    const segGap = 2;

    types.forEach((t) => {
      const v = e[t];
      if (v <= 0) return;
      const segH = Math.max(0, (v / maxTotal) * plotH - segGap);
      const y = yCursor - segH - segGap;
      const isTop = t === types.filter((tt) => e[tt] > 0).slice(-1)[0];
      const rx = 3;
      const rect = svgEl('rect', {
        x, y, width: barW, height: Math.max(1, segH),
        fill: resolveColor(TYPE_COLOR[t]),
        rx: isTop ? rx : 0, ry: isTop ? rx : 0,
      });
      rect.addEventListener('mouseenter', (ev) => {
        const html = `<div class="tt-title">${escapeHtml(e.name)}</div>` +
          types.filter((tt) => e[tt] > 0).map((tt) => `<div class="tt-row"><span class="tt-dot" style="background:${resolveColor(TYPE_COLOR[tt])}"></span>${TYPE_LABEL[tt]}: ${e[tt]}</div>`).join('');
        showTooltip(ev.clientX, ev.clientY, html);
      });
      rect.addEventListener('mousemove', (ev) => { const tt = el('tooltip'); if (!tt.hidden) showTooltip(ev.clientX, ev.clientY, tt.innerHTML); });
      rect.addEventListener('mouseleave', hideTooltip);
      svg.appendChild(rect);
      yCursor -= segH + segGap;
    });

    // total label above bar
    const label = svgEl('text', { x: x + barW / 2, y: padT + plotH - (e.total / maxTotal) * plotH - 6, 'text-anchor': 'middle', 'font-size': 10.5, fill: cssVar('--text-primary'), 'font-weight': 650 });
    label.textContent = e.total;
    svg.appendChild(label);

    // x-axis label
    const nameLabel = svgEl('text', { x: x + barW / 2, y: H - padB + 16, 'text-anchor': 'middle', 'font-size': 10, fill: cssVar('--text-secondary') });
    const short = e.name.length > 12 ? e.name.slice(0, 11) + '…' : e.name;
    nameLabel.textContent = short;
    if (short !== e.name) nameLabel.appendChild(svgEl('title', {}));
    svg.appendChild(nameLabel);
    if (short !== e.name) {
      const titleEl = svgEl('title', {});
      titleEl.textContent = e.name;
      nameLabel.appendChild(titleEl);
    }
  });

  container.appendChild(svg);
}

/* ---------- feed ---------- */

function renderFeed() {
  const filters = ['all', 'commit', 'prOpened', 'prMerged', 'issue'];
  const filterLabels = { all: 'All', commit: 'Commits', prOpened: 'PRs opened', prMerged: 'PRs merged', issue: 'Issues' };
  el('feed-filters').innerHTML = filters.map((f) => `<button class="chip${state.feedFilter === f ? ' selected' : ''}" data-filter="${f}">${filterLabels[f]}</button>`).join('');
  el('feed-filters').querySelectorAll('.chip').forEach((btn) => {
    btn.addEventListener('click', () => { state.feedFilter = btn.dataset.filter; renderFeed(); });
  });

  const events = state.data.events.filter((e) => state.feedFilter === 'all' || e.type === state.feedFilter).slice(0, FEED_LIMIT);
  el('feed-sub').textContent = `${events.length.toLocaleString()} most recent event${events.length === 1 ? '' : 's'}${state.data.events.length > FEED_LIMIT ? ` (of ${state.data.events.length.toLocaleString()} total)` : ''}`;

  const badgeClass = { commit: 'type-commit', prOpened: 'type-pr', prMerged: 'type-pr-merged', issue: 'type-issue' };
  const badgeLabel = { commit: 'Commit', prOpened: 'PR opened', prMerged: 'PR merged', issue: 'Issue' };

  el('feed-body').innerHTML = events.map((e) => `
    <tr>
      <td>${formatRelative(e.ts)}</td>
      <td>${escapeHtml(e.user)}</td>
      <td><span class="type-badge ${badgeClass[e.type]}">${badgeLabel[e.type]}</span></td>
      <td>${escapeHtml(e.repo)}</td>
      <td><a href="${e.url}" target="_blank" rel="noopener">${escapeHtml(e.detail)}</a></td>
    </tr>`).join('') || `<tr><td colspan="5"><div class="empty-note">No events match this filter.</div></td></tr>`;
}

function formatRelative(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${Math.max(0, mins)}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const daysAgo = Math.floor(hours / 24);
  if (daysAgo < 30) return `${daysAgo}d ago`;
  return d.toISOString().slice(0, 10);
}

/* ---------- totals table ---------- */

function renderTotalsTable() {
  const rows = [...state.data.byUserRepo.entries()].map(([key, c]) => {
    const [user, repo] = key.split('||');
    return { user, repo, ...c };
  }).sort((a, b) => sumCounts(b) - sumCounts(a) || a.user.localeCompare(b.user));

  el('totals-body').innerHTML = rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.user)}</td>
      <td>${escapeHtml(r.repo)}</td>
      <td class="num">${r.commit}</td>
      <td class="num">${r.prOpened}</td>
      <td class="num">${r.prMerged}</td>
      <td class="num">${r.issue}</td>
    </tr>`).join('') || `<tr><td colspan="6"><div class="empty-note">No activity in this range.</div></td></tr>`;
}

/* ---------- re-render charts on theme change (colors are CSS vars, but SVG fills were resolved at draw time) ---------- */

const themeObserver = new MutationObserver(() => { if (state.data) render(); });
themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
darkMediaQuery.addEventListener('change', () => { if (state.data) render(); });
