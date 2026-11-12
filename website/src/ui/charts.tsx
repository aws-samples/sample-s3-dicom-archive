import React, { useMemo } from 'react';
import {
  ResponsiveContainer, LineChart as RLineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  PieChart as RPieChart, Pie, Cell,
} from 'recharts';

/** Categorical palette, readable in both themes. */
export const CHART_COLORS = ['#4f6bed', '#14b8a6', '#f59e0b', '#ec4899', '#8b5cf6', '#22c55e', '#ef4444', '#0ea5e9', '#a3a3a3', '#f97316'];

const axis = { stroke: 'var(--color-muted-foreground)', fontSize: 11, tickLine: false, axisLine: false };
const tooltipStyle = {
  contentStyle: { background: 'var(--color-popover)', border: '1px solid var(--color-border)', borderRadius: 8, fontSize: 12, color: 'var(--color-popover-foreground)', boxShadow: '0 8px 24px rgb(0 0 0 / .12)' },
  labelStyle: { color: 'var(--color-muted-foreground)', marginBottom: 4 },
};

export function LineChart({ series = [], height = 300, xDomain, xScaleType, yTitle, legendTitle, statusType, empty, noMatch, i18nStrings, hideLegend }: any) {
  const time = xScaleType === 'time';
  const data = useMemo(() => {
    const byX = new Map<number | string, any>();
    series.forEach((s: any, si: number) => (s.data || []).forEach((p: any) => {
      const x = p.x instanceof Date ? p.x.getTime() : p.x;
      const row = byX.get(x) || { x };
      row[`s${si}`] = p.y;
      byX.set(x, row);
    }));
    return [...byX.values()].sort((a, b) => (a.x > b.x ? 1 : -1));
  }, [series]);
  if (!series.length || !data.length) return <div className="flex items-center justify-center text-sm text-muted-foreground" style={{ height }}>{empty || 'No data'}</div>;
  const fmt = (v: any) => (time ? new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : String(v));
  const domain = xDomain && time ? [new Date(xDomain[0]).getTime(), new Date(xDomain[1]).getTime()] : ['dataMin', 'dataMax'];
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <RLineChart data={data} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
          <CartesianGrid stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="x" type={time ? 'number' : 'category'} scale={time ? 'time' : 'auto'} domain={domain as any} tickFormatter={fmt} {...axis} minTickGap={24} />
          <YAxis {...axis} width={56} label={yTitle ? { value: yTitle, angle: -90, position: 'insideLeft', fill: 'var(--color-muted-foreground)', fontSize: 11, dx: 4 } : undefined} />
          <Tooltip {...tooltipStyle} labelFormatter={(v: any) => (time ? new Date(v).toLocaleString() : v)} />
          {!hideLegend && <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />}
          {series.map((s: any, si: number) => (
            <Line key={si} type="monotone" dataKey={`s${si}`} name={s.title} stroke={s.color || CHART_COLORS[si % CHART_COLORS.length]}
              strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          ))}
        </RLineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function PieChart({ data = [], detailPopoverContent, segmentDescription, size = 'medium', hideLegend, variant, innerMetricDescription, innerMetricValue, empty }: any) {
  const sum = data.reduce((a: number, d: any) => a + (d.value || 0), 0);
  const h = size === 'large' ? 340 : size === 'small' ? 200 : 280;
  if (!data.length) return <div className="py-10 text-center text-sm text-muted-foreground">{empty || 'No data'}</div>;
  const Tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    const rows = detailPopoverContent ? detailPopoverContent(d, sum) : [{ key: 'Value', value: d.value }];
    return (
      <div className="rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-lg">
        <div className="mb-1 font-semibold">{d.title}</div>
        {rows.map((r: any) => <div key={r.key} className="flex justify-between gap-4"><span className="text-muted-foreground">{r.key}</span><span className="tabular-nums">{r.value}</span></div>)}
      </div>
    );
  };
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-center">
      <div className="relative shrink-0" style={{ width: h, height: h }}>
        <ResponsiveContainer width="100%" height="100%">
          <RPieChart>
            <Pie data={data} dataKey="value" nameKey="title" innerRadius={variant === 'donut' ? '62%' : 0} outerRadius="92%" paddingAngle={data.length > 1 ? 1.5 : 0} stroke="var(--color-card)" strokeWidth={2} isAnimationActive={false}>
              {data.map((d: any, i: number) => <Cell key={i} fill={d.color || CHART_COLORS[i % CHART_COLORS.length]} />)}
            </Pie>
            <Tooltip content={<Tip />} />
          </RPieChart>
        </ResponsiveContainer>
        {variant === 'donut' && innerMetricValue && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <div className="text-2xl font-semibold tabular-nums tracking-tight">{innerMetricValue}</div>
            {innerMetricDescription && <div className="text-xs text-muted-foreground">{innerMetricDescription}</div>}
          </div>
        )}
      </div>
      {!hideLegend && (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-sm" aria-label="Legend">
          {data.map((d: any, i: number) => (
            <li key={i} className="flex items-center gap-2" title={segmentDescription ? segmentDescription(d, sum) : undefined}>
              <span className="size-2.5 shrink-0 rounded-sm" style={{ background: d.color || CHART_COLORS[i % CHART_COLORS.length] }} />
              <span className="min-w-0 flex-1 truncate">{d.title}</span>
              <span className="tabular-nums text-muted-foreground">{sum ? `${((d.value / sum) * 100).toFixed(1)}%` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
