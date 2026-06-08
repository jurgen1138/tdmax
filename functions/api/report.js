/**
 * Cloudflare Pages Function — /api/report
 * Query params: ?start=YYYY-MM-DD&end=YYYY-MM-DD
 * Secrets needed in Pages settings: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
 *                                   GOOGLE_REFRESH_TOKEN, GA4_PROPERTY_ID
 */

export async function onRequestGet({ request, env }) {
  const url   = new URL(request.url);
  const start = url.searchParams.get('start') || monthStart();
  const end   = url.searchParams.get('end')   || todayStr();

  try {
    const token = await getAccessToken(env);
    const data  = await fetchAll(token, env.GA4_PROPERTY_ID, start, end);
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
      grant_type:    'refresh_token',
      client_id:     env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
    }),
  });
  const d = await res.json();
  if (!d.access_token) throw new Error('OAuth failed: ' + JSON.stringify(d));
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

// ─── Data fetching ────────────────────────────────────────────────────────────

async function fetchAll(token, pid, start, end) {
  const dr        = [{ startDate: start, endDate: end }];
  const ctaFilter = {
    filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'cta_click' } },
  };

  const [ov, ch, pg, co, ctaT, ctaB, a30, a7, a1] = await Promise.all([
    ga4run(token, pid, {
      dateRanges: dr,
      metrics: [
        { name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' },
        { name: 'screenPageViews' }, { name: 'engagementRate' },
        { name: 'engagedSessions' }, { name: 'userEngagementDuration' },
      ],
    }),
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
      limit: 8,
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
    ga4run(token, pid, { dateRanges: dr, metrics: [{ name: 'eventCount' }], dimensionFilter: ctaFilter }),
    ga4run(token, pid, {
      dateRanges: dr,
      dimensions: [{ name: 'customEvent:button_text' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: ctaFilter,
      orderBys: [{ metric: { metricName: 'eventCount' }, desc: true }],
      limit: 10,
    }).catch(() => ({ rows: [] })),
    // Activity windows — always relative to today
    ga4run(token, pid, { dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    ga4run(token, pid, { dateRanges: [{ startDate: '7daysAgo',  endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
    ga4run(token, pid, { dateRanges: [{ startDate: 'yesterday', endDate: 'today' }], metrics: [{ name: 'activeUsers' }] }),
  ]);

  const fv  = (r, i) => parseFloat(r.rows?.[0]?.metricValues?.[i]?.value || '0');
  const iv  = (r, i) => Math.round(fv(r, i));

  const activeUsers = iv(ov, 0);
  const sessions    = iv(ov, 2);
  const pageViews   = iv(ov, 3);
  const er          = fv(ov, 4);
  const es          = iv(ov, 5);
  const dur         = fv(ov, 6);
  const avgSec      = activeUsers > 0 ? dur / activeUsers : 0;

  const COLORS = {
    'Organic Search': '#378ADD', 'Direct': '#1D9E75', 'Paid Social': '#D85A30',
    'Organic Shopping': '#EF9F27', 'Referral': '#534AB7', 'Organic Social': '#888780',
    'Paid Search': '#B04AB7', 'Email': '#27B4EF',
  };
  const PAL = ['#378ADD','#1D9E75','#D85A30','#EF9F27','#534AB7','#888780','#27B4EF','#B04AB7'];
  let ci = 0;

  const mau = iv(a30, 0), wau = iv(a7, 0), dau = iv(a1, 0);

  return {
    overview: {
      activeUsers,
      newUsers:        iv(ov, 1),
      sessions,
      pageViews,
      pagesPerSession: sessions > 0 ? (pageViews / sessions).toFixed(2) : '0.00',
      avgDuration:     `${Math.floor(avgSec / 60)}m ${String(Math.floor(avgSec % 60)).padStart(2, '0')}s`,
      engagementRate:  (er * 100).toFixed(2),
      engagedPerUser:  activeUsers > 0 ? (es / activeUsers).toFixed(2) : '0.00',
    },
    channels: (ch.rows || []).map(r => ({
      label: r.dimensionValues[0].value,
      value: parseInt(r.metricValues[0].value || '0'),
      color: COLORS[r.dimensionValues[0].value] || PAL[ci++ % PAL.length],
    })),
    topPages: (pg.rows || []).map(r => ({
      title: r.dimensionValues[0].value,
      views: parseInt(r.metricValues[0].value || '0'),
    })),
    countries: (co.rows || []).map(r => ({
      country: r.dimensionValues[0].value,
      users:   parseInt(r.metricValues[0].value || '0'),
    })),
    cta: {
      total: iv(ctaT, 0),
      rows: (ctaB.rows || [])
        .map(r => ({ button: r.dimensionValues[0].value, count: parseInt(r.metricValues[0].value || '0') }))
        .filter(r => r.button !== '(not set)'),
    },
    activity: { mau, wau, dau, stickiness: mau > 0 ? ((dau / mau) * 100).toFixed(1) : '0.0' },
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }
function monthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
