import React, { useState, useMemo, useRef, useEffect } from 'react';
import Papa from 'papaparse';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine
} from 'recharts';

const COLORS = {
  bg: '#0A0C10',
  surface: '#12161C',
  surfaceAlt: '#171C24',
  border: '#232A35',
  text: '#E7ECF2',
  textDim: '#8590A0',
  textMuted: '#566072',
  amber: '#E8A33D',
  hot: '#FF6B35',
  green: '#3FBF7F',
  red: '#E5484D',
  // Chatter uses its own palette (blue family), deliberately outside
  // the amber/hot score gradient so it never reads as part of the
  // score - it's context, not a ranking input. See CHATTER_META below.
  chatterElevated: '#4FA8E0',
  chatterNormal: '#5B6577',
  chatterLow: '#3A4150',
};

const MONO = "'IBM Plex Mono','SFMono-Regular',Menlo,Consolas,monospace";
const SANS = "'Inter','Sohne',-apple-system,BlinkMacSystemFont,sans-serif";

// Data path the daily scan (stock_scanner.py, via .github/workflows/daily-scan.yml)
// writes to. import.meta.env.BASE_URL respects Vite's configured base
// path so this also works when deployed under a GitHub Pages subpath.
const DATA_URL = `${import.meta.env.BASE_URL}data/latest.csv`;

const CHATTER_META = {
  elevated: { label: 'ELEVATED', color: COLORS.chatterElevated, dot: '●' },
  normal: { label: 'NORMAL', color: COLORS.chatterNormal, dot: '●' },
  low: { label: 'LOW', color: COLORS.chatterLow, dot: '●' },
};

// ---------- sample data generator (fallback / demo only) ----------
function makeSampleCSV() {
  const tickers = [
    { sym: 'FLNT', trend: 0.001, spike: true, chatter: 'elevated' },
    { sym: 'VRXA', trend: -0.0005, spike: false, chatter: 'low' },
    { sym: 'QBIO', trend: 0.0015, spike: true, chatter: 'elevated' },
    { sym: 'NRGX', trend: 0.0002, spike: false, chatter: 'normal' },
    { sym: 'TSLM', trend: 0.0008, spike: true, chatter: 'normal' },
    { sym: 'PWDR', trend: -0.0002, spike: false, chatter: 'low' },
  ];
  let rows = [];
  const days = 45;
  const start = new Date();
  start.setDate(start.getDate() - days);

  tickers.forEach(({ sym, trend, spike, chatter }) => {
    let price = 4 + Math.random() * 8;
    let baseVol = 400000 + Math.random() * 600000;
    for (let i = 0; i < days; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const isSpikeDay = spike && i >= days - 3;
      const noise = (Math.random() - 0.5) * 0.02;
      const drift = trend + (isSpikeDay ? 0.035 : 0);
      const open = price;
      price = price * (1 + drift + noise);
      const high = Math.max(open, price) * (1 + Math.random() * (isSpikeDay ? 0.03 : 0.012));
      const low = Math.min(open, price) * (1 - Math.random() * (isSpikeDay ? 0.02 : 0.01));
      const vol = Math.round(baseVol * (isSpikeDay ? 2.5 + Math.random() * 2 : 0.7 + Math.random() * 0.6));
      rows.push({
        Ticker: sym,
        Date: d.toISOString().slice(0, 10),
        Open: open.toFixed(2),
        High: high.toFixed(2),
        Low: low.toFixed(2),
        Close: price.toFixed(2),
        Volume: vol,
        Chatter: chatter,
      });
    }
  });
  return rows;
}

// ---------- metric computation (unchanged scoring logic) ----------
function computeMetrics(rows) {
  const sorted = [...rows].sort((a, b) => new Date(a.Date) - new Date(b.Date));
  const n = sorted.length;
  const closes = sorted.map(r => r.Close);
  const highs = sorted.map(r => r.High ?? r.Close);
  const lows = sorted.map(r => r.Low ?? r.Close);
  const vols = sorted.map(r => r.Volume);

  const last = n - 1;
  const close = closes[last];
  const prevClose = n >= 2 ? closes[last - 1] : close;
  const pctChange = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;

  const volWindowStart = Math.max(0, last - 20);
  const volWindow = vols.slice(volWindowStart, last); // excludes today
  const avgVol20 = volWindow.length ? volWindow.reduce((a, b) => a + b, 0) / volWindow.length : vols[last] || 1;
  const rvol = avgVol20 > 0 ? vols[last] / avgVol20 : 1;

  const highWindowStart = Math.max(0, last - 20);
  const highWindow = highs.slice(highWindowStart, last); // excludes today
  const high20prev = highWindow.length ? Math.max(...highWindow) : close;
  const breakoutPct = high20prev ? ((close - high20prev) / high20prev) * 100 : 0;

  const rocIdx = Math.max(0, last - 5);
  const closeThen = closes[rocIdx];
  const roc5 = closeThen ? ((close - closeThen) / closeThen) * 100 : 0;

  const ranges = sorted.map((r, i) => highs[i] - lows[i]);
  const r5start = Math.max(0, last - 4);
  const range5 = ranges.slice(r5start, last + 1);
  const avgRange5 = range5.length ? range5.reduce((a, b) => a + b, 0) / range5.length : 0;
  const r20start = Math.max(0, last - 19);
  const range20 = ranges.slice(r20start, last + 1);
  const avgRange20 = range20.length ? range20.reduce((a, b) => a + b, 0) / range20.length : avgRange5 || 1;
  const squeezeRatio = avgRange20 > 0 ? avgRange5 / avgRange20 : 1;

  return {
    close, pctChange, rvol, breakoutPct, roc5, squeezeRatio,
    dates: sorted.map(r => r.Date), closes, vols, highs, high20prev,
    rows: sorted,
  };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function subScores(m) {
  const rvolScore = clamp(((m.rvol - 1) / 2) * 100, 0, 100);
  const breakoutScore = clamp((((m.close) / (m.high20prev || m.close) - 0.95) / 0.10) * 100, 0, 100);
  const momentumScore = clamp(((m.roc5 + 5) / 15) * 100, 0, 100);
  const squeezeScore = clamp((1 - m.squeezeRatio) * 150, 0, 100);
  return { rvolScore, breakoutScore, momentumScore, squeezeScore };
}

function signalLabel(score) {
  if (score >= 75) return { label: 'HOT', color: COLORS.hot };
  if (score >= 50) return { label: 'WARMING', color: COLORS.amber };
  return { label: 'QUIET', color: COLORS.textMuted };
}

// ---------- UI atoms ----------
function FuseBar({ score, height = 8 }) {
  const hot = score >= 75;
  return (
    <div style={{
      position: 'relative', width: '100%', height,
      background: COLORS.surfaceAlt, borderRadius: height / 2, overflow: 'hidden',
      border: `1px solid ${COLORS.border}`,
    }}>
      <div style={{
        width: `${score}%`, height: '100%',
        background: `linear-gradient(90deg, ${COLORS.amber}, ${COLORS.hot})`,
        boxShadow: hot ? `0 0 10px 1px ${COLORS.hot}` : 'none',
        transition: 'width 0.4s ease',
      }} />
    </div>
  );
}

function Slider({ label, value, onChange }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{
        display: 'flex', justifyContent: 'space-between', marginBottom: 4,
        fontFamily: MONO, fontSize: 11, color: COLORS.textDim, letterSpacing: 0.5,
      }}>
        <span>{label}</span>
        <span style={{ color: COLORS.amber }}>{value}%</span>
      </div>
      <input
        type="range" min={0} max={100} value={value}
        onChange={e => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: COLORS.amber }}
      />
    </div>
  );
}

// Chatter badge - intentionally styled apart from score/signal colors
// (blue-gray family, not amber/hot/green/red) so it never blends into
// the quant ranking visually. It's a context flag, not an input.
function ChatterBadge({ level, compact = false }) {
  const meta = CHATTER_META[level] || CHATTER_META.normal;
  return (
    <span
      title="Chatter: message/watcher activity level, shown as context only - not part of the score"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        fontFamily: MONO, fontSize: compact ? 9.5 : 10.5, fontWeight: 600,
        letterSpacing: 0.6, color: meta.color,
        background: 'rgba(255,255,255,0.03)',
        border: `1px solid ${meta.color}55`,
        borderRadius: 20, padding: compact ? '2px 7px' : '3px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ fontSize: 8 }}>{meta.dot}</span>
      {meta.label}
    </span>
  );
}

// ---------- main ----------
export default function App() {
  const [tickerData, setTickerData] = useState(null); // { SYM: rows[] }
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [loadingRemote, setLoadingRemote] = useState(true);
  const [selected, setSelected] = useState(null);
  const [weights, setWeights] = useState({ rvol: 30, breakout: 30, momentum: 20, squeeze: 20 });
  const fileRef = useRef(null);

  function ingestRows(rawRows, sourceNotice) {
    const norm = raw => {
      const out = {};
      Object.keys(raw).forEach(k => { out[k.trim().toLowerCase()] = raw[k]; });
      const pick = (...keys) => {
        for (const k of keys) if (out[k] !== undefined && out[k] !== '') return out[k];
        return undefined;
      };
      const ticker = pick('ticker', 'symbol', 'sym');
      const date = pick('date');
      const close = parseFloat(pick('close', 'adj close', 'adjclose', 'price'));
      const open = parseFloat(pick('open')) || close;
      const high = parseFloat(pick('high')) || close;
      const low = parseFloat(pick('low')) || close;
      const volume = parseFloat(pick('volume', 'vol')) || 0;
      const chatterRaw = String(pick('chatter') || 'normal').toLowerCase().trim();
      const chatter = CHATTER_META[chatterRaw] ? chatterRaw : 'normal';
      if (!ticker || !date || Number.isNaN(close)) return null;
      return { Ticker: String(ticker).toUpperCase().trim(), Date: date, Open: open, High: high, Low: low, Close: close, Volume: volume, Chatter: chatter };
    };
    const cleaned = rawRows.map(norm).filter(Boolean);
    if (!cleaned.length) {
      setError('No usable rows found. Make sure your file has Ticker, Date, Close and Volume columns.');
      return;
    }
    const grouped = {};
    cleaned.forEach(r => {
      if (!grouped[r.Ticker]) grouped[r.Ticker] = [];
      grouped[r.Ticker].push(r);
    });
    setError(null);
    setNotice(sourceNotice || null);
    setTickerData(grouped);
    setSelected(null);
  }

  // Auto-load the latest scan on mount instead of requiring a manual
  // upload. Falls back to the upload/sample-data prompt if the file
  // isn't there yet (e.g. before the first scheduled run has ever
  // committed data/latest.csv).
  useEffect(() => {
    let cancelled = false;
    fetch(DATA_URL, { cache: 'no-store' })
      .then(res => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then(text => {
        if (cancelled) return;
        const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
        if (!parsed.data.length) throw new Error('empty file');
        ingestRows(parsed.data, `Loaded ${DATA_URL} automatically.`);
      })
      .catch(() => {
        if (!cancelled) setError(null); // stay on the intake screen quietly
      })
      .finally(() => { if (!cancelled) setLoadingRemote(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: res => ingestRows(res.data, `Loaded from uploaded file: ${file.name}`),
      error: err => setError('Could not parse that file: ' + err.message),
    });
  }

  function loadSample() {
    ingestRows(makeSampleCSV(), 'Showing generated sample data, not a real scan.');
  }

  const ranked = useMemo(() => {
    if (!tickerData) return [];
    const totalW = weights.rvol + weights.breakout + weights.momentum + weights.squeeze || 1;
    return Object.entries(tickerData).map(([sym, rows]) => {
      const m = computeMetrics(rows);
      const s = subScores(m);
      const composite = (
        s.rvolScore * weights.rvol +
        s.breakoutScore * weights.breakout +
        s.momentumScore * weights.momentum +
        s.squeezeScore * weights.squeeze
      ) / totalW;
      const chatter = rows[rows.length - 1]?.Chatter || 'normal';
      return { sym, m, s, composite, chatter };
    }).sort((a, b) => b.composite - a.composite);
  }, [tickerData, weights]);

  const top = ranked[0];
  const topFive = ranked.slice(0, 5);
  const activeSym = selected || (ranked[0] && ranked[0].sym);
  const active = ranked.find(r => r.sym === activeSym);

  const chartData = active ? active.m.dates.map((d, i) => ({
    date: d.slice(5),
    close: active.m.closes[i],
    volume: active.m.vols[i],
  })) : [];

  return (
    <div style={{
      background: COLORS.bg, color: COLORS.text, minHeight: '100%',
      fontFamily: SANS, padding: '28px 24px', boxSizing: 'border-box',
    }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 22, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 12, color: COLORS.amber, letterSpacing: 3 }}>SMALL/MID CAP BREAKOUT SCREENER</div>
          <h1 style={{ margin: '4px 0 0', fontSize: 30, fontWeight: 700, letterSpacing: -0.5 }}>Ignition</h1>
          <div style={{ color: COLORS.textDim, fontSize: 13, marginTop: 2 }}>Volume and momentum breakout scoring, refreshed by the daily scan.</div>
        </div>
        {top && (
          <div style={{
            background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 10,
            padding: '10px 18px', textAlign: 'right', minWidth: 160,
          }}>
            <div style={{ fontFamily: MONO, fontSize: 10, color: COLORS.textMuted, letterSpacing: 1 }}>HIGHEST SIGNAL</div>
            <div style={{ fontSize: 20, fontWeight: 700, fontFamily: MONO }}>{top.sym}</div>
            <div style={{ fontFamily: MONO, fontSize: 22, fontWeight: 700, color: signalLabel(top.composite).color }}>
              {top.composite.toFixed(0)}
            </div>
          </div>
        )}
      </div>

      {/* data intake */}
      {!tickerData && (
        <div style={{
          background: COLORS.surface, border: `1px dashed ${COLORS.border}`, borderRadius: 12,
          padding: 32, textAlign: 'center', marginBottom: 24,
        }}>
          {loadingRemote ? (
            <div style={{ color: COLORS.textDim, fontSize: 13, fontFamily: MONO }}>Loading latest scan…</div>
          ) : (
            <>
              <div style={{ fontSize: 15, marginBottom: 6, fontWeight: 600 }}>No scan data loaded yet</div>
              <div style={{ color: COLORS.textDim, fontSize: 13, marginBottom: 18, lineHeight: 1.6 }}>
                Couldn't find <code style={{ fontFamily: MONO }}>{DATA_URL}</code> - either the daily scan hasn't run yet,
                or you're viewing this outside the deployed site.<br />
                CSV columns expected: Ticker, Date, Open, High, Low, Close, Volume, Chatter.
              </div>
              <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
                <button onClick={() => fileRef.current?.click()} style={btnPrimary}>Upload CSV</button>
                <button onClick={loadSample} style={btnGhost}>Try it with sample data</button>
              </div>
              <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
              {error && <div style={{ color: COLORS.red, fontSize: 12, marginTop: 14, fontFamily: MONO }}>{error}</div>}
            </>
          )}
        </div>
      )}

      {tickerData && (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => fileRef.current?.click()} style={btnGhost}>Upload different CSV</button>
            <button onClick={loadSample} style={btnGhost}>Load sample data</button>
            <input ref={fileRef} type="file" accept=".csv" onChange={handleFile} style={{ display: 'none' }} />
            <span style={{ color: COLORS.textMuted, fontSize: 12, fontFamily: MONO }}>
              {Object.keys(tickerData).length} tickers loaded
            </span>
            {notice && (
              <span style={{ color: COLORS.textMuted, fontSize: 11.5, fontFamily: MONO, fontStyle: 'italic' }}>
                {notice}
              </span>
            )}
          </div>
          {error && <div style={{ color: COLORS.red, fontSize: 12, marginBottom: 14, fontFamily: MONO }}>{error}</div>}

          {/* top 5 hero section */}
          {topFive.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textMuted, letterSpacing: 1.5, marginBottom: 10 }}>
                TOP {topFive.length} CANDIDATES
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: `repeat(${topFive.length}, 1fr)`, gap: 12 }}>
                {topFive.map((r, i) => {
                  const sig = signalLabel(r.composite);
                  const isActive = r.sym === activeSym;
                  return (
                    <div
                      key={r.sym}
                      onClick={() => setSelected(r.sym)}
                      style={{
                        cursor: 'pointer', background: isActive ? COLORS.surfaceAlt : COLORS.surface,
                        border: `1px solid ${isActive ? sig.color : COLORS.border}`, borderRadius: 12,
                        padding: '14px 16px', position: 'relative', transition: 'border-color 0.2s ease',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div>
                          <div style={{ fontFamily: MONO, fontSize: 10, color: COLORS.textMuted }}>#{i + 1}</div>
                          <div style={{ fontFamily: MONO, fontSize: 18, fontWeight: 700 }}>{r.sym}</div>
                        </div>
                        <div style={{ fontFamily: MONO, fontSize: 20, fontWeight: 700, color: sig.color }}>
                          {r.composite.toFixed(0)}
                        </div>
                      </div>
                      <div style={{ fontFamily: MONO, fontSize: 12, color: COLORS.textDim, margin: '6px 0 8px' }}>
                        ${r.m.close.toFixed(2)}
                        <span style={{ color: r.m.pctChange >= 0 ? COLORS.green : COLORS.red, marginLeft: 6 }}>
                          {r.m.pctChange >= 0 ? '+' : ''}{r.m.pctChange.toFixed(1)}%
                        </span>
                      </div>
                      <FuseBar score={r.composite} height={6} />
                      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ color: sig.color, fontFamily: MONO, fontSize: 10.5, fontWeight: 700 }}>{sig.label}</span>
                        <ChatterBadge level={r.chatter} compact />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 260px', gap: 20 }}>
            {/* left: table + detail */}
            <div>
              <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, overflow: 'hidden', marginBottom: 20 }}>
                <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 13, minWidth: 640 }}>
                  <thead>
                    <tr style={{ borderBottom: `1px solid ${COLORS.border}`, textAlign: 'left', color: COLORS.textMuted, fontSize: 11 }}>
                      <th style={th}>TICKER</th>
                      <th style={th}>PRICE</th>
                      <th style={th}>CHG</th>
                      <th style={th}>RVOL</th>
                      <th style={th}>SIGNAL</th>
                      <th style={{ ...th, width: '26%' }}>SCORE</th>
                      <th style={{ ...th, borderLeft: `1px solid ${COLORS.border}` }}>CHATTER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map(r => {
                      const sig = signalLabel(r.composite);
                      const isActive = r.sym === activeSym;
                      return (
                        <tr
                          key={r.sym}
                          onClick={() => setSelected(r.sym)}
                          style={{
                            cursor: 'pointer',
                            background: isActive ? COLORS.surfaceAlt : 'transparent',
                            borderBottom: `1px solid ${COLORS.border}`,
                          }}
                        >
                          <td style={{ ...td, fontWeight: 700 }}>{r.sym}</td>
                          <td style={td}>${r.m.close.toFixed(2)}</td>
                          <td style={{ ...td, color: r.m.pctChange >= 0 ? COLORS.green : COLORS.red }}>
                            {r.m.pctChange >= 0 ? '+' : ''}{r.m.pctChange.toFixed(1)}%
                          </td>
                          <td style={td}>{r.m.rvol.toFixed(1)}x</td>
                          <td style={{ ...td, color: sig.color, fontWeight: 700, fontSize: 11 }}>{sig.label}</td>
                          <td style={td}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <div style={{ flex: 1 }}><FuseBar score={r.composite} /></div>
                              <span style={{ width: 28, textAlign: 'right', color: sig.color, fontWeight: 700 }}>{r.composite.toFixed(0)}</span>
                            </div>
                          </td>
                          <td style={{ ...td, borderLeft: `1px solid ${COLORS.border}` }}>
                            <ChatterBadge level={r.chatter} compact />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                </div>
              </div>

              {/* detail panel */}
              {active && (
                <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12, flexWrap: 'wrap', gap: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{ fontFamily: MONO, fontWeight: 700, fontSize: 15 }}>{active.sym} <span style={{ color: COLORS.textMuted, fontWeight: 400 }}>· price and volume</span></div>
                      <ChatterBadge level={active.chatter} />
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 12, color: COLORS.textMuted }}>{active.m.dates[active.m.dates.length - 1]}</div>
                  </div>
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart data={chartData}>
                      <CartesianGrid stroke={COLORS.border} vertical={false} />
                      <XAxis dataKey="date" tick={{ fill: COLORS.textMuted, fontSize: 10, fontFamily: MONO }} axisLine={{ stroke: COLORS.border }} tickLine={false} minTickGap={30} />
                      <YAxis yAxisId="price" orientation="right" tick={{ fill: COLORS.textMuted, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} domain={['auto', 'auto']} />
                      <YAxis yAxisId="vol" orientation="left" tick={{ fill: COLORS.textMuted, fontSize: 10, fontFamily: MONO }} axisLine={false} tickLine={false} />
                      <Tooltip
                        contentStyle={{ background: COLORS.surfaceAlt, border: `1px solid ${COLORS.border}`, borderRadius: 8, fontFamily: MONO, fontSize: 12 }}
                        labelStyle={{ color: COLORS.textDim }}
                      />
                      <ReferenceLine yAxisId="price" y={active.m.high20prev} stroke={COLORS.amber} strokeDasharray="4 4" label={{ value: '20d high', fill: COLORS.amber, fontSize: 10, fontFamily: MONO, position: 'insideTopLeft' }} />
                      <Bar yAxisId="vol" dataKey="volume" fill={COLORS.surfaceAlt} stroke={COLORS.border} radius={[2, 2, 0, 0]} />
                      <Line yAxisId="price" type="monotone" dataKey="close" stroke={COLORS.amber} strokeWidth={2} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>

                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 16 }}>
                    <ScoreBreakdown label="Relative volume" score={active.s.rvolScore} detail={`${active.m.rvol.toFixed(1)}x avg`} />
                    <ScoreBreakdown label="Breakout" score={active.s.breakoutScore} detail={`${active.m.breakoutPct >= 0 ? '+' : ''}${active.m.breakoutPct.toFixed(1)}% vs 20d high`} />
                    <ScoreBreakdown label="Momentum" score={active.s.momentumScore} detail={`${active.m.roc5 >= 0 ? '+' : ''}${active.m.roc5.toFixed(1)}% / 5d`} />
                    <ScoreBreakdown label="Squeeze" score={active.s.squeezeScore} detail={`${active.m.squeezeRatio.toFixed(2)} range ratio`} />
                  </div>
                  <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid ${COLORS.border}`, color: COLORS.textMuted, fontSize: 11, fontFamily: MONO, lineHeight: 1.6 }}>
                    Chatter reflects StockTwits-style message/watcher activity as of the scan snapshot. It is shown for
                    context only and does not feed into the score above.
                  </div>
                </div>
              )}
            </div>

            {/* right: weight controls */}
            <div style={{ background: COLORS.surface, border: `1px solid ${COLORS.border}`, borderRadius: 12, padding: 18, height: 'fit-content' }}>
              <div style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textMuted, letterSpacing: 1, marginBottom: 14 }}>SCORE WEIGHTING</div>
              <Slider label="RELATIVE VOLUME" value={weights.rvol} onChange={v => setWeights(w => ({ ...w, rvol: v }))} />
              <Slider label="PRICE BREAKOUT" value={weights.breakout} onChange={v => setWeights(w => ({ ...w, breakout: v }))} />
              <Slider label="MOMENTUM" value={weights.momentum} onChange={v => setWeights(w => ({ ...w, momentum: v }))} />
              <Slider label="VOLATILITY SQUEEZE" value={weights.squeeze} onChange={v => setWeights(w => ({ ...w, squeeze: v }))} />
              <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 16, paddingTop: 14, color: COLORS.textMuted, fontSize: 11.5, lineHeight: 1.6 }}>
                Weights are normalized automatically, they do not need to add to 100. Adjust them to match what you think actually predicts a move for the names you follow, then watch the ranking shift.
              </div>
              <div style={{ borderTop: `1px solid ${COLORS.border}`, marginTop: 16, paddingTop: 14 }}>
                <div style={{ fontFamily: MONO, fontSize: 10, color: COLORS.textMuted, letterSpacing: 1, marginBottom: 8 }}>CHATTER KEY</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <ChatterBadge level="elevated" />
                  <ChatterBadge level="normal" />
                  <ChatterBadge level="low" />
                </div>
                <div style={{ color: COLORS.textMuted, fontSize: 11, lineHeight: 1.6, marginTop: 10 }}>
                  Context flag only, never part of the score - small caps are an easy target for manufactured hype.
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function ScoreBreakdown({ label, score, detail }) {
  return (
    <div>
      <div style={{ fontFamily: MONO, fontSize: 10, color: COLORS.textMuted, marginBottom: 4 }}>{label.toUpperCase()}</div>
      <FuseBar score={score} height={6} />
      <div style={{ fontFamily: MONO, fontSize: 11, color: COLORS.textDim, marginTop: 4 }}>{detail}</div>
    </div>
  );
}

const th = { padding: '10px 14px', fontWeight: 500 };
const td = { padding: '9px 14px' };
const btnPrimary = {
  background: COLORS.amber, color: '#1A1300', border: 'none', borderRadius: 8,
  padding: '10px 18px', fontFamily: SANS, fontWeight: 600, fontSize: 13, cursor: 'pointer',
};
const btnGhost = {
  background: 'transparent', color: COLORS.text, border: `1px solid ${COLORS.border}`, borderRadius: 8,
  padding: '10px 18px', fontFamily: SANS, fontWeight: 500, fontSize: 13, cursor: 'pointer',
};
