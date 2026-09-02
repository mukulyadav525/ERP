// ============================================================================
// Chart primitives. Recharts needs concrete colour values for SVG fills, so the
// theme's CSS custom properties are read at runtime and re-read when the theme
// changes — that is what keeps charts legible in both light and dark mode instead
// of hard-coding one palette and hoping.
// ============================================================================
import React, { useEffect, useState } from 'react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart,
  Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { inrCompact } from '../lib/api';

const SERIES_KEYS = ['--series-1', '--series-2', '--series-3', '--series-4',
                     '--series-5', '--series-6', '--series-7', '--series-8'];

/** Resolves the palette from CSS, and re-resolves when the OS theme flips. */
export function useSeriesColors(): string[] {
  const [colors, setColors] = useState<string[]>([
    '#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#007a33', '#4a3aa7', '#e34948',
  ]);
  useEffect(() => {
    const read = () => {
      const styles = getComputedStyle(document.documentElement);
      const next = SERIES_KEYS.map((k) => styles.getPropertyValue(k).trim()).filter(Boolean);
      if (next.length === SERIES_KEYS.length) setColors(next);
    };
    read();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { mq.removeEventListener('change', read); observer.disconnect(); };
  }, []);
  return colors;
}

/**
 * Postgres numerics arrive as strings over JSON. Recharts silently computes NaN
 * geometry from a string, which renders as an empty chart, so every series value
 * is coerced before it reaches a chart.
 */
function numeric(data: any[], keys: string[]): any[] {
  if (!Array.isArray(data)) return [];
  return data.map((row) => {
    const out: any = { ...row };
    for (const k of keys) if (out[k] !== null && out[k] !== undefined) out[k] = Number(out[k]);
    return out;
  });
}

function ChartTooltip({ active, payload, label, formatter }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="t-label">{label}</div>
      {payload.map((p: any) => (
        <div className="t-row" key={p.dataKey}>
          <span className="legend-dot" style={{ background: p.color }} />
          <span>{p.name}</span>
          <span className="v">{formatter ? formatter(p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

export function TrendChart({ data, xKey, series, height = 260, money = true }: {
  data: any[]; xKey: string;
  series: { key: string; label: string }[];
  height?: number; money?: boolean;
}) {
  const colors = useSeriesColors();
  const fmt = money ? (v: number) => inrCompact(v) : (v: number) => String(v);
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={numeric(data, series.map((s) => s.key))} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {series.map((s, i) => (
              <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={colors[i % colors.length]} stopOpacity={0.28} />
                <stop offset="100%" stopColor={colors[i % colors.length]} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={28} />
          <YAxis tickFormatter={fmt} tickLine={false} axisLine={false} width={58} />
          <Tooltip content={<ChartTooltip formatter={fmt} />} />
          {series.map((s, i) => (
            <Area key={s.key} type="monotone" dataKey={s.key} name={s.label}
                  stroke={colors[i % colors.length]} strokeWidth={2}
                  fill={`url(#grad-${s.key})`} dot={false} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function BarsChart({ data, xKey, series, height = 260, money = true, horizontal }: {
  data: any[]; xKey: string; series: { key: string; label: string }[];
  height?: number; money?: boolean; horizontal?: boolean;
}) {
  const colors = useSeriesColors();
  const fmt = money ? (v: number) => inrCompact(v) : (v: number) => String(v);
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={numeric(data, series.map((s) => s.key))} layout={horizontal ? 'vertical' : 'horizontal'}
                  margin={{ top: 8, right: 12, left: horizontal ? 8 : 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={!horizontal} horizontal={horizontal} />
          {horizontal ? (
            <>
              <XAxis type="number" tickFormatter={fmt} tickLine={false} axisLine={false} />
              <YAxis type="category" dataKey={xKey} width={140} tickLine={false} axisLine={false} />
            </>
          ) : (
            <>
              <XAxis dataKey={xKey} tickLine={false} axisLine={false} minTickGap={20} />
              <YAxis tickFormatter={fmt} tickLine={false} axisLine={false} width={58} />
            </>
          )}
          <Tooltip content={<ChartTooltip formatter={fmt} />} cursor={{ fill: 'var(--surface-2)' }} />
          {series.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label}
                 fill={colors[i % colors.length]} radius={horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DonutChart({ data, nameKey, valueKey, height = 240, money = true }: {
  data: any[]; nameKey: string; valueKey: string; height?: number; money?: boolean;
}) {
  const colors = useSeriesColors();
  const fmt = money ? (v: number) => inrCompact(v) : (v: number) => String(v);
  // The API returns numerics as strings (pg numeric -> string). Recharts needs real
  // numbers or every arc computes to NaN and the donut renders empty.
  const rows = numeric(data, [valueKey]);
  const total = rows.reduce((s, d) => s + Number(d[valueKey] ?? 0), 0);
  return (
    <div className="chart-wrap" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={rows} dataKey={valueKey} nameKey={nameKey}
               innerRadius="58%" outerRadius="82%" paddingAngle={1.5} strokeWidth={0}>
            {rows.map((_, i) => <Cell key={i} fill={colors[i % colors.length]} />)}
          </Pie>
          <Tooltip content={<ChartTooltip formatter={(v: number) =>
            `${fmt(v)}${total ? ` (${((v / total) * 100).toFixed(1)}%)` : ''}`} />} />
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ChartLegend({ items }: { items: string[] }) {
  const colors = useSeriesColors();
  return (
    <div className="legend-row">
      {items.map((label, i) => (
        <span className="legend-item" key={label}>
          <span className="legend-dot" style={{ background: colors[i % colors.length] }} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** A tiny inline bar for use inside table cells (stock level, budget usage). */
export function MiniBar({ value, max, tone = 'accent' }: {
  value: number; max: number; tone?: 'accent' | 'good' | 'warning' | 'critical';
}) {
  const pct = max > 0 ? Math.min(Math.max((value / max) * 100, 0), 100) : 0;
  const color = tone === 'accent' ? 'var(--accent)'
    : tone === 'good' ? 'var(--status-good)'
    : tone === 'warning' ? 'var(--status-warning)' : 'var(--status-critical)';
  return (
    <span style={{ display: 'inline-block', width: 64, height: 6, borderRadius: 3,
                   background: 'var(--surface-3)', overflow: 'hidden', verticalAlign: 'middle' }}>
      <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: color }} />
    </span>
  );
}
