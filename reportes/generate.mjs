/**
 * GA4 report generator — pulls live data and rewrites reportes/index.html
 * Requires env vars: GA4_PROPERTY_ID, GA4_SERVICE_ACCOUNT_JSON
 * Optional:         GA4_CTA_PARAM (default: button_text), REPORT_PASSWORD_HASH
 */

import { BetaAnalyticsDataClient } from '@google-analytics/data';
import { OAuth2Client } from 'google-auth-library';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROPERTY_ID = process.env.GA4_PROPERTY_ID;
const CTA_PARAM   = process.env.GA4_CTA_PARAM || 'button_text';
const PW_HASH     = process.env.REPORT_PASSWORD_HASH
  || '752a8aa3af1aecd0d9e548623687f278d115c4188f00e87e193b085c0dbf8bc4';

if (!PROPERTY_ID) {
  console.error('Error: GA4_PROPERTY_ID is required (numeric property ID, not G-XXXXXXX)');
  process.exit(1);
}

function buildAuth() {
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    const oauth2 = new OAuth2Client(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return { authClient: oauth2 };
  }
  if (process.env.GA4_SERVICE_ACCOUNT_JSON) {
    return { credentials: JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON) };
  }
  return {};
}

const client   = new BetaAnalyticsDataClient(buildAuth());
const property = `properties/${PROPERTY_ID}`;

// ─── Date helpers ────────────────────────────────────────────────────────────

function getDateRange() {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const fmt   = d => d.toISOString().split('T')[0];
  return { startDate: fmt(start), endDate: 'today' };
}

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];

function formatDateLabel({ startDate }) {
  const now   = new Date();
  const start = new Date(startDate + 'T12:00:00');
  return `${start.getDate()} ${MONTHS_ES[start.getMonth()]} – ${now.getDate()} ${MONTHS_ES[now.getMonth()]} ${now.getFullYear()}`;
}

function formatGeneratedDate() {
  const now = new Date();
  return `${now.getDate()} de ${MONTHS_ES[now.getMonth()]} ${now.getFullYear()}`;
}

// ─── GA4 fetchers ─────────────────────────────────────────────────────────────

async function fetchOverview(dateRange) {
  const [res] = await client.runReport({
    property,
    dateRanges: [dateRange],
    metrics: [
      { name: 'activeUsers' },
      { name: 'newUsers' },
      { name: 'sessions' },
      { name: 'screenPageViews' },
      { name: 'engagementRate' },
      { name: 'engagedSessions' },
      { name: 'userEngagementDuration' },
    ],
  });
  const v  = i => parseFloat(res.rows?.[0]?.metricValues?.[i]?.value || '0');
  const au = v(0), nu = v(1), se = v(2), pv = v(3), er = v(4), es = v(5), dur = v(6);
  const avgSec = au > 0 ? dur / au : 0;
  return {
    activeUsers:    Math.round(au),
    newUsers:       Math.round(nu),
    sessions:       Math.round(se),
    pageViews:      Math.round(pv),
    pagesPerSession: se > 0 ? (pv / se).toFixed(2) : '0.00',
    avgDuration:    `${Math.floor(avgSec / 60)}m ${String(Math.floor(avgSec % 60)).padStart(2,'0')}s`,
    engagementRate: (er * 100).toFixed(2),
    engagedPerUser: au > 0 ? (es / au).toFixed(2) : '0.00',
  };
}

async function fetchChannels(dateRange) {
  const [res] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }],
    orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
    limit: 8,
  });
  const COLORS = {
    'Organic Search': '#378ADD', 'Direct': '#1D9E75', 'Paid Social': '#D85A30',
    'Organic Shopping': '#EF9F27', 'Referral': '#534AB7', 'Organic Social': '#888780',
    'Paid Search': '#B04AB7', 'Email': '#27B4EF',
  };
  const PALETTE = ['#378ADD','#1D9E75','#D85A30','#EF9F27','#534AB7','#888780','#27B4EF','#B04AB7'];
  let idx = 0;
  return (res.rows || []).map(r => ({
    label: r.dimensionValues[0].value,
    value: parseInt(r.metricValues[0].value || '0'),
    color: COLORS[r.dimensionValues[0].value] || PALETTE[idx++ % PALETTE.length],
  }));
}

async function fetchTopPages(dateRange) {
  const [res] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'pageTitle' }],
    metrics: [{ name: 'screenPageViews' }],
    orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
    limit: 8,
    dimensionFilter: {
      notExpression: {
        filter: { fieldName: 'pageTitle', stringFilter: { matchType: 'EXACT', value: '(not set)' } },
      },
    },
  });
  return (res.rows || []).map(r => ({
    title: r.dimensionValues[0].value,
    views: parseInt(r.metricValues[0].value || '0'),
  }));
}

async function fetchCountries(dateRange) {
  const [res] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'country' }],
    metrics: [{ name: 'activeUsers' }],
    orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
    limit: 10,
  });
  return (res.rows || []).map(r => ({
    country: r.dimensionValues[0].value,
    users:   parseInt(r.metricValues[0].value || '0'),
  }));
}

async function fetchCtaClicks(dateRange) {
  const baseFilter = {
    filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'cta_click' } },
  };
  try {
    const [[res], [totalRes]] = await Promise.all([
      client.runReport({
        property,
        dateRanges: [dateRange],
        dimensions: [{ name: `customEvent:${CTA_PARAM}` }],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: baseFilter,
        orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
        limit: 10,
      }),
      client.runReport({
        property,
        dateRanges: [dateRange],
        metrics: [{ name: 'eventCount' }],
        dimensionFilter: baseFilter,
      }),
    ]);
    const total = parseInt(totalRes.rows?.[0]?.metricValues?.[0]?.value || '0');
    const rows  = (res.rows || [])
      .map(r => ({ button: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value || '0') }))
      .filter(r => r.button !== '(not set)');
    return { total, rows, paramRegistered: rows.length > 0 };
  } catch (e) {
    console.warn('cta_click fetch error:', e.message);
    return { total: 0, rows: [], paramRegistered: false };
  }
}

async function fetchActivityWindows() {
  const [[r30], [r7], [r1]] = await Promise.all([
    client.runReport({ property, dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    client.runReport({ property, dateRanges: [{ startDate: '7daysAgo',  endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    client.runReport({ property, dateRanges: [{ startDate: 'yesterday', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
  ]);
  const g = r => parseInt(r.rows?.[0]?.metricValues?.[0]?.value || '0');
  const mau = g(r30), wau = g(r7), dau = g(r1);
  return { mau, wau, dau, stickiness: mau > 0 ? ((dau / mau) * 100).toFixed(1) : '0.0' };
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmtK(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 10_000)    return Math.round(n / 1_000) + 'K';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString('es');
}

const FLAG_MAP = {
  'Costa Rica': '🇨🇷', 'United States': '🇺🇸', 'Mexico': '🇲🇽', 'Spain': '🇪🇸',
  'Panama': '🇵🇦', 'Colombia': '🇨🇴', 'Canada': '🇨🇦', 'Guatemala': '🇬🇹',
  'Nicaragua': '🇳🇮', 'Indonesia': '🇮🇩', 'Argentina': '🇦🇷', 'Chile': '🇨🇱',
  'Peru': '🇵🇪', 'Venezuela': '🇻🇪', 'Ecuador': '🇪🇨', 'Honduras': '🇭🇳',
  'El Salvador': '🇸🇻', 'Bolivia': '🇧🇴', 'Dominican Republic': '🇩🇴',
  'United Kingdom': '🇬🇧', 'Germany': '🇩🇪', 'France': '🇫🇷', 'Brazil': '🇧🇷',
  'Puerto Rico': '🇵🇷', 'Cuba': '🇨🇺', 'Paraguay': '🇵🇾', 'Uruguay': '🇺🇾',
};
const NAME_ES = {
  'United States': 'Estados Unidos', 'Mexico': 'México', 'Spain': 'España',
  'Panama': 'Panamá', 'Colombia': 'Colombia', 'Canada': 'Canadá',
  'Germany': 'Alemania', 'France': 'Francia', 'United Kingdom': 'Reino Unido',
  'Dominican Republic': 'Rep. Dominicana', 'El Salvador': 'El Salvador',
};

function countryDisplay(c) {
  return `${FLAG_MAP[c] || '🌍'} ${NAME_ES[c] || c}`;
}

// ─── HTML generator ───────────────────────────────────────────────────────────

function buildHTML(data) {
  const { overview, channels, topPages, countries, cta, activity, dateLabel, generatedDate } = data;

  const maxUsers = countries[0]?.users || 1;
  const geoRows  = countries.map(c => {
    const pct = ((c.users / maxUsers) * 100).toFixed(2);
    return `      <div class="geo-row"><span class="geo-name">${countryDisplay(c.country)}</span><div class="geo-bar-bg"><div class="geo-bar" style="width:${pct}%"></div></div><span class="geo-val">${c.users.toLocaleString('es')}</span></div>`;
  }).join('\n');

  const pageRows = topPages.map(p =>
    `          <tr><td>${p.title}</td><td style="text-align:right;">${fmtK(p.views)}</td></tr>`
  ).join('\n');

  const ctaSection = buildCtaSection(cta);

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reporte de Audiencia GA4</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f3; color: #1a1a18; padding: 1.25rem; }
    .container { max-width: 960px; margin: 0 auto; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 10px; margin-bottom: 1.5rem; }
    .header-title { font-size: 20px; font-weight: 500; color: #1a1a18; }
    .header-sub { font-size: 12px; color: #888780; margin-top: 3px; }
    .badge { background: #e8e8e4; border-radius: 8px; padding: 6px 12px; font-size: 12px; color: #5f5e5a; white-space: nowrap; }
    .section-title { font-size: 11px; font-weight: 500; color: #888780; text-transform: uppercase; letter-spacing: 0.07em; margin: 1.5rem 0 0.75rem; }
    .metric-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; }
    .metric-card { background: #ebebea; border-radius: 8px; padding: 0.8rem 0.9rem; }
    .metric-label { font-size: 11px; color: #888780; margin-bottom: 4px; }
    .metric-value { font-size: 20px; font-weight: 500; color: #1a1a18; }
    .metric-sub { font-size: 11px; color: #b4b2a9; margin-top: 2px; }
    .chart-wrap { background: #fff; border: 0.5px solid rgba(0,0,0,0.12); border-radius: 12px; padding: 1rem; margin-bottom: 1rem; }
    .chart-title { font-size: 13px; font-weight: 500; color: #1a1a18; margin-bottom: 10px; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    .top-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .top-table th { text-align: left; color: #888780; font-weight: 500; padding: 5px 4px; border-bottom: 0.5px solid rgba(0,0,0,0.1); }
    .top-table td { padding: 6px 4px; border-bottom: 0.5px solid rgba(0,0,0,0.07); color: #1a1a18; }
    .top-table tr:last-child td { border-bottom: none; }
    .geo-row { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 0.5px solid rgba(0,0,0,0.07); font-size: 12px; }
    .geo-row:last-child { border-bottom: none; }
    .geo-name { width: 130px; color: #1a1a18; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex-shrink: 0; }
    .geo-bar-bg { flex: 1; background: #ebebea; border-radius: 3px; height: 5px; min-width: 20px; }
    .geo-bar { height: 5px; background: #378ADD; border-radius: 3px; }
    .geo-val { width: 52px; text-align: right; color: #888780; font-size: 11px; flex-shrink: 0; }
    .legend-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; font-size: 11px; color: #888780; }
    .ldot { width: 9px; height: 9px; border-radius: 2px; display: inline-block; margin-right: 3px; vertical-align: middle; flex-shrink: 0; }
    .activity-grid { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .activity-item .alabel { font-size: 11px; color: #888780; }
    .activity-item .avalue { font-size: 18px; font-weight: 500; color: #1a1a18; }
    .footnote { font-size: 11px; color: #b4b2a9; margin-top: 8px; }
    .notice { font-size: 11px; color: #888780; background: #f5f5f3; border-radius: 6px; padding: 8px 10px; margin-top: 8px; }
    .footer { margin-top: 2rem; padding-top: 1rem; border-top: 0.5px solid rgba(0,0,0,0.1); font-size: 11px; color: #b4b2a9; text-align: center; }
    .canvas-wrap { position: relative; width: 100%; }
    @media (max-width: 580px) {
      .two-col { grid-template-columns: 1fr; }
      body { padding: 0.85rem; }
    }
  </style>
  <style>
    #auth-overlay { position: fixed; inset: 0; z-index: 9999; background: #f5f5f3; display: flex; align-items: center; justify-content: center; }
    #auth-box { background: #fff; border: 0.5px solid rgba(0,0,0,0.12); border-radius: 14px; padding: 2rem 2.25rem; width: 100%; max-width: 340px; text-align: center; }
    #auth-box h2 { font-size: 16px; font-weight: 500; color: #1a1a18; margin-bottom: 4px; }
    #auth-box p { font-size: 12px; color: #888780; margin-bottom: 1.5rem; }
    #auth-input { width: 100%; padding: 0.6rem 0.9rem; border: 1px solid rgba(0,0,0,0.15); border-radius: 8px; font-size: 14px; outline: none; background: #fafafa; color: #1a1a18; }
    #auth-input:focus { border-color: #378ADD; }
    #auth-btn { margin-top: 0.75rem; width: 100%; padding: 0.65rem; background: #1a1a18; color: #fff; border: none; border-radius: 8px; font-size: 14px; cursor: pointer; }
    #auth-btn:hover { background: #333; }
    #auth-error { margin-top: 0.6rem; font-size: 12px; color: #D85A30; min-height: 16px; }
  </style>
</head>
<body>
<div id="auth-overlay">
  <div id="auth-box">
    <h2>Acceso restringido</h2>
    <p>Uso interno del equipo — ingresa la contraseña</p>
    <input id="auth-input" type="password" placeholder="Contraseña" autocomplete="current-password" />
    <button id="auth-btn">Entrar</button>
    <div id="auth-error"></div>
  </div>
</div>
<div class="container" id="main-content" style="display:none;">

  <div class="header">
    <div>
      <div class="header-title">Reporte de audiencia</div>
      <div class="header-sub">Google Analytics 4 — uso interno</div>
    </div>
    <div class="badge">📅 ${dateLabel}</div>
  </div>

  <div class="section-title">Métricas generales</div>
  <div class="metric-grid">
    <div class="metric-card"><div class="metric-label">Usuarios activos</div><div class="metric-value">${fmtK(overview.activeUsers)}</div><div class="metric-sub">período completo</div></div>
    <div class="metric-card"><div class="metric-label">Nuevos usuarios</div><div class="metric-value">${fmtK(overview.newUsers)}</div><div class="metric-sub">primer acceso</div></div>
    <div class="metric-card"><div class="metric-label">Sesiones</div><div class="metric-value">${fmtK(overview.sessions)}</div><div class="metric-sub">session_start</div></div>
    <div class="metric-card"><div class="metric-label">Páginas vistas</div><div class="metric-value">${fmtK(overview.pageViews)}</div><div class="metric-sub">total views</div></div>
    <div class="metric-card"><div class="metric-label">Págs por sesión</div><div class="metric-value">${overview.pagesPerSession}</div><div class="metric-sub">${fmtK(overview.pageViews)} / ${fmtK(overview.sessions)}</div></div>
    <div class="metric-card"><div class="metric-label">Duración promedio</div><div class="metric-value">${overview.avgDuration}</div><div class="metric-sub">por usuario activo</div></div>
    <div class="metric-card"><div class="metric-label">Engagement rate</div><div class="metric-value">${overview.engagementRate}%</div><div class="metric-sub">sesiones engaged</div></div>
  </div>

  <div class="section-title">Canales de adquisición (sesiones)</div>
  <div class="chart-wrap">
    <div class="legend-row" id="ch-legend"></div>
    <div class="canvas-wrap" id="channelWrap">
      <canvas id="channelChart"></canvas>
    </div>
  </div>

  <div class="two-col">
    <div class="chart-wrap">
      <div class="chart-title">Páginas más vistas</div>
      <table class="top-table">
        <thead><tr><th>Página</th><th style="text-align:right;">Vistas</th></tr></thead>
        <tbody>
${pageRows}
        </tbody>
      </table>
    </div>
    <div class="chart-wrap">
      <div class="chart-title">Usuarios activos por país</div>
${geoRows}
      <div class="footnote">Total: ${countries.reduce((s,c) => s + c.users, 0).toLocaleString('es')} usuarios</div>
    </div>
  </div>

  <div class="section-title">Actividad de usuarios</div>
  <div class="chart-wrap">
    <div class="activity-grid">
      <div class="activity-item"><div class="alabel">Usuarios activos 30 días</div><div class="avalue">${fmtK(activity.mau)}</div></div>
      <div class="activity-item"><div class="alabel">Usuarios activos 7 días</div><div class="avalue">${fmtK(activity.wau)}</div></div>
      <div class="activity-item"><div class="alabel">Usuarios activos 1 día</div><div class="avalue">${fmtK(activity.dau)}</div></div>
      <div class="activity-item"><div class="alabel">Stickiness DAU/MAU</div><div class="avalue">${activity.stickiness}%</div></div>
      <div class="activity-item"><div class="alabel">Engagement rate</div><div class="avalue">${overview.engagementRate}%</div></div>
    </div>
  </div>

${ctaSection}

  <div class="footer">Generado el ${generatedDate} · Google Analytics 4 · Uso interno del equipo</div>
</div>

<script>
  (function () {
    const HASH = '${PW_HASH}';
    const SESSION_KEY = 'tdmax_reportes_auth';
    async function sha256(str) {
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    function unlock() {
      document.getElementById('auth-overlay').style.display = 'none';
      document.getElementById('main-content').style.display = '';
    }
    if (sessionStorage.getItem(SESSION_KEY) === '1') { unlock(); return; }
    const input = document.getElementById('auth-input');
    const btn   = document.getElementById('auth-btn');
    const err   = document.getElementById('auth-error');
    async function attempt() {
      const hash = await sha256(input.value);
      if (hash === HASH) { sessionStorage.setItem(SESSION_KEY, '1'); unlock(); }
      else { err.textContent = 'Contraseña incorrecta'; input.value = ''; input.focus(); }
    }
    btn.addEventListener('click', attempt);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
    input.focus();
  })();
</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  const isMobile = window.innerWidth < 580;
  const channels = ${JSON.stringify(channels)};

  const legend = document.getElementById('ch-legend');
  channels.forEach(d => {
    const s = document.createElement('span');
    s.style.cssText = 'display:flex;align-items:center;gap:3px;';
    s.innerHTML = '<span class="ldot" style="background:' + d.color + '"></span>' + d.label + ' ' + (d.value >= 1000 ? (d.value/1000).toFixed(1)+'K' : d.value);
    legend.appendChild(s);
  });

  const chWrap  = document.getElementById('channelWrap');
  chWrap.style.height = (isMobile ? channels.length * 36 + 40 : 220) + 'px';

  new Chart(document.getElementById('channelChart'), {
    type: 'bar',
    data: {
      labels: channels.map(d => d.label),
      datasets: [{ data: channels.map(d => d.value), backgroundColor: channels.map(d => d.color), borderRadius: 4 }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => ' ' + (ctx.raw >= 1000 ? (ctx.raw/1000).toFixed(1)+'K' : ctx.raw) + ' sesiones' } }
      },
      scales: {
        x: { ticks: { callback: v => v >= 1000 ? (v/1000).toFixed(0)+'K' : v, color: '#888780', font: { size: isMobile ? 10 : 12 } }, grid: { color: 'rgba(0,0,0,0.06)' } },
        y: { ticks: { color: '#888780', font: { size: isMobile ? 10 : 12 } }, grid: { display: false } }
      }
    }
  });
</script>
</body>
</html>`;
}

function buildCtaSection(cta) {
  const totalStr = cta.total.toLocaleString('es');
  if (cta.rows.length > 0) {
    const rows = cta.rows.map(r =>
      `        <tr><td>${r.button}</td><td style="text-align:right;">${r.count.toLocaleString('es')}</td></tr>`
    ).join('\n');
    return `  <div class="section-title">Eventos GTM — cta_click</div>
  <div class="chart-wrap">
    <div class="chart-title">Top botones / CTAs clicados <span style="font-weight:400;color:#888780;">(${totalStr} eventos totales)</span></div>
    <table class="top-table">
      <thead><tr><th>Botón / CTA</th><th style="text-align:right;">Clics</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
  </div>`;
  }
  return `  <div class="section-title">Eventos GTM — cta_click</div>
  <div class="chart-wrap">
    <p style="font-size:13px;font-weight:500;color:#1a1a18;margin-bottom:8px;">Total eventos cta_click: <strong>${totalStr}</strong></p>
    <p class="notice">Para ver el desglose por botón, registra el parámetro <code>${CTA_PARAM}</code> como dimensión personalizada en GA4 → Admin → Definiciones personalizadas.</p>
  </div>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dateRange = getDateRange();
  console.log(`Fetching GA4 data for property ${PROPERTY_ID} (${dateRange.startDate} → ${dateRange.endDate})…`);

  const [overview, channels, topPages, countries, cta, activity] = await Promise.all([
    fetchOverview(dateRange),
    fetchChannels(dateRange),
    fetchTopPages(dateRange),
    fetchCountries(dateRange),
    fetchCtaClicks(dateRange),
    fetchActivityWindows(),
  ]);

  const html = buildHTML({
    overview, channels, topPages, countries, cta, activity,
    dateLabel:     formatDateLabel(dateRange),
    generatedDate: formatGeneratedDate(),
  });

  writeFileSync(join(__dirname, 'index.html'), html, 'utf-8');
  console.log('✓ reportes/index.html updated');
  console.log(`  Active users : ${overview.activeUsers.toLocaleString()}`);
  console.log(`  Sessions     : ${overview.sessions.toLocaleString()}`);
  console.log(`  cta_click    : ${cta.total.toLocaleString()} total${cta.rows.length ? `, ${cta.rows.length} buttons` : ' (no custom dim yet)'}`);
}

main().catch(err => { console.error(err); process.exit(1); });
