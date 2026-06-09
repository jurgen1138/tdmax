/**
 * Cloudflare Worker — tdmax
 * GET /api/report?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, GA4_PROPERTY_ID
 */

const GTM_EVENTS = [
  'clic_plan_mensual', 'clic_plan_semestral', 'clic_plan_anual',
  'clic_boton_samsung', 'clic_boton_calendarioFWC26',
  'clic_boton_descargacalendarioFWC26', 'clic_lanzador_teletica',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/report') return handleReport(url, env);
    return env.ASSETS.fetch(request);
  },
};

async function handleReport(url, env) {
  const start  = url.searchParams.get('start')  || monthStart();
  const end    = url.searchParams.get('end')    || todayStr();
  const cstart = url.searchParams.get('cstart');
  const cend   = url.searchParams.get('cend');
  try {
    const token = await getAccessToken(env);
    const prev  = (cstart && cend)
      ? { startDate: cstart, endDate: cend }
      : getPreviousPeriod(start, end);
    const data  = await fetchAll(token, env.GA4_PROPERTY_ID, start, end, prev);
    return Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function getAccessToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('OAuth: ' + JSON.stringify(d));
  return d.access_token;
}

// ─── GA4 REST helper ──────────────────────────────────────────────────────────

function ga4run(token, pid, body) {
  return fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runReport`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  ).then(async r => {
    if (!r.ok) throw new Error(`GA4 ${r.status}: ${await r.text()}`);
    return r.json();
  });
}

// ─── Previous period calculation ──────────────────────────────────────────────

function getPreviousPeriod(start, end) {
  const s    = new Date(start + 'T12:00:00');
  const e    = new Date(end   + 'T12:00:00');
  const days = Math.round((e - s) / 86400000) + 1;
  const pEnd   = new Date(s); pEnd.setDate(pEnd.getDate() - 1);
  const pStart = new Date(pEnd); pStart.setDate(pStart.getDate() - days + 1);
  return { startDate: fmtDate(pStart), endDate: fmtDate(pEnd) };
}

// ─── Main data fetcher ────────────────────────────────────────────────────────

async function fetchAll(token, pid, start, end, prev) {
  const dr     = [{ startDate: start, endDate: end }];
  const drPrev = [{ startDate: prev.startDate, endDate: prev.endDate }];
  const ovM    = [
    { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' },
    { name: 'screenPageViews' }, { name: 'engagementRate' },
    { name: 'engagedSessions' }, { name: 'userEngagementDuration' },
  ];

  const [
    ovC, ovP, ch, pg, co,
    gtmC, gtmP, dayC, dayP,
    dev, a30, a7, a1,
  ] = await Promise.all([
    ga4run(token, pid, { dateRanges: dr,     metrics: ovM }),
    ga4run(token, pid, { dateRanges: drPrev, metrics: ovM }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
      metrics: [{ name: 'sessions' }],
      orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      limit: 8,
    }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'pageTitle' }],
      metrics: [{ name: 'screenPageViews' }],
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 10,
      dimensionFilter: { notExpression: { filter: {
        fieldName: 'pageTitle', stringFilter: { matchType: 'EXACT', value: '(not set)' },
      }}},
    }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'country' }],
      metrics: [{ name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
      limit: 10,
    }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: GTM_EVENTS } } },
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
    }).catch(() => ({ rows: [] })),
    ga4run(token, pid, {
      dateRanges: drPrev,
      dimensions: [{ name: 'eventName' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: { filter: { fieldName: 'eventName', inListFilter: { values: GTM_EVENTS } } },
    }).catch(() => ({ rows: [] })),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    ga4run(token, pid, {
      dateRanges: drPrev,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
    }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [{ name: 'activeUsers' }],
      orderBys: [{ metric: { metricName: 'activeUsers' }, desc: true }],
    }),
    ga4run(token, pid, { dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    ga4run(token, pid, { dateRanges: [{ startDate: '7daysAgo',  endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    ga4run(token, pid, { dateRanges: [{ startDate: 'yesterday', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
  ]);

  const fv  = (r, i) => parseFloat(r.rows?.[0]?.metricValues?.[i]?.value || '0');
  const iv  = (r, i) => Math.round(fv(r, i));
  const pct = (c, p) => p > 0 ? +((c - p) / p * 100).toFixed(1) : null;

  const acC = iv(ovC,0), acP = iv(ovP,0);
  const nuC = iv(ovC,1), nuP = iv(ovP,1);
  const seC = iv(ovC,2), seP = iv(ovP,2);
  const pvC = iv(ovC,3), pvP = iv(ovP,3);
  const erC = fv(ovC,4), erP = fv(ovP,4);
  const esC = iv(ovC,5);
  const durC = fv(ovC,6);
  const avgSec = acC > 0 ? durC / acC : 0;

  const parseDay = rows => {
    const d = { dates:[], users:[], sessions:[], pageviews:[] };
    (rows || []).forEach(r => {
      const v = r.dimensionValues[0].value;
      d.dates.push(`${v.slice(0,4)}-${v.slice(4,6)}-${v.slice(6,8)}`);
      d.users.push(parseInt(r.metricValues[0].value || '0'));
      d.sessions.push(parseInt(r.metricValues[1].value || '0'));
      d.pageviews.push(parseInt(r.metricValues[2].value || '0'));
    });
    return d;
  };

  const gtmPrevMap = {};
  (gtmP.rows || []).forEach(r => {
    gtmPrevMap[r.dimensionValues[0].value] = parseInt(r.metricValues[0].value || '0');
  });

  const CH_COLORS = {
    'Organic Search':'#378ADD','Direct':'#1D9E75','Paid Social':'#D85A30',
    'Organic Shopping':'#EF9F27','Referral':'#534AB7','Organic Social':'#888780',
    'Paid Search':'#B04AB7','Email':'#27B4EF',
  };
  const PAL = ['#378ADD','#1D9E75','#D85A30','#EF9F27','#534AB7','#888780','#27B4EF','#B04AB7'];
  let ci = 0;

  const DEV_LABEL = { mobile:'Móvil', desktop:'Escritorio', tablet:'Tablet' };
  const DEV_COLOR = { mobile:'#378ADD', desktop:'#1D9E75', tablet:'#EF9F27' };

  const mau = iv(a30,0), wau = iv(a7,0), dau = iv(a1,0);

  return {
    period: { current:{start,end}, previous:{start:prev.startDate,end:prev.endDate} },
    overview: {
      activeUsers:acC, newUsers:nuC, sessions:seC, pageViews:pvC,
      pagesPerSession: seC>0?(pvC/seC).toFixed(2):'0.00',
      avgDuration:`${Math.floor(avgSec/60)}m ${String(Math.floor(avgSec%60)).padStart(2,'0')}s`,
      engagementRate:(erC*100).toFixed(2),
      engagedPerUser: acC>0?(esC/acC).toFixed(2):'0.00',
      vs:{
        activeUsers:pct(acC,acP), newUsers:pct(nuC,nuP),
        sessions:pct(seC,seP), pageViews:pct(pvC,pvP),
        engagementRate:pct(erC,erP),
      },
    },
    daily:{ current:parseDay(dayC.rows), previous:parseDay(dayP.rows) },
    channels:(ch.rows||[]).map(r=>({
      label:r.dimensionValues[0].value,
      value:parseInt(r.metricValues[0].value||'0'),
      color:CH_COLORS[r.dimensionValues[0].value]||PAL[ci++%PAL.length],
    })),
    topPages:(pg.rows||[]).map(r=>({
      title:r.dimensionValues[0].value,
      views:parseInt(r.metricValues[0].value||'0'),
    })),
    countries:(co.rows||[]).map(r=>({
      country:r.dimensionValues[0].value,
      users:parseInt(r.metricValues[0].value||'0'),
    })),
    devices:(dev.rows||[]).map(r=>({
      device:r.dimensionValues[0].value,
      label:DEV_LABEL[r.dimensionValues[0].value]||r.dimensionValues[0].value,
      users:parseInt(r.metricValues[0].value||'0'),
      color:DEV_COLOR[r.dimensionValues[0].value]||'#888780',
    })),
    gtmEvents:(gtmC.rows||[]).map(r=>{
      const event=r.dimensionValues[0].value;
      const count=parseInt(r.metricValues[0].value||'0');
      return{event,count,vs:pct(count,gtmPrevMap[event]||0)};
    }),
    activity:{mau,wau,dau,stickiness:mau>0?((dau/mau)*100).toFixed(1):'0.0'},
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2,'0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function monthStart() { const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-01`; }
function todayStr() { return fmtDate(new Date()); }
