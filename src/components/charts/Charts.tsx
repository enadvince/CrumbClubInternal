"use client";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ReactNode } from "react";

export const SERIES_1 = "#b0601a";
export const SERIES_2 = "#7652b5";
const GRID = "#ece3d6";
const INK_SOFT = "#5a4636";

/** One-hue caramel ramp for the heatmap (light → dark = less → more). */
export const HEAT_RAMP = ["#fbf1e4", "#f2d6b3", "#e3b47e", "#cc8a46", "#b0601a", "#7d420f"];

export function ChartCard({ title, subtitle, actions, children, table }: {
  title: string; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; table?: ReactNode;
}) {
  return (
    <figure className="card min-w-0 p-4">
      <figcaption className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-bold">{title}</h2>
          {subtitle && <p className="text-sm text-ink-soft">{subtitle}</p>}
        </div>
        {actions}
      </figcaption>
      {children}
      {table && (
        <details className="mt-2 text-sm">
          <summary className="cursor-pointer font-semibold text-caramel">Show as table</summary>
          <div className="mt-2 overflow-x-auto">{table}</div>
        </details>
      )}
    </figure>
  );
}

type Datum = { label: string; value: number };

function TooltipBox({ active, payload, format }: { active?: boolean; payload?: { payload: Datum }[]; format: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="rounded-lg border border-crust-dark bg-paper px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold">{d.label}</p>
      <p className="tabular-nums">{format(d.value)}</p>
    </div>
  );
}

/** Ranked horizontal bars, single series. */
export function RankedBars({ data, format, color = SERIES_1, axisFormat }: { data: Datum[]; format: (v: number) => string; color?: string; axisFormat?: (v: number) => string }) {
  const height = Math.max(120, data.length * 30 + 30);
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 0, right: 16, bottom: 0, left: 0 }} barCategoryGap={4}>
          <CartesianGrid horizontal={false} stroke={GRID} />
          <XAxis type="number" tickFormatter={axisFormat ?? format} tick={{ fill: INK_SOFT, fontSize: 12 }} axisLine={false} tickLine={false} />
          <YAxis type="category" dataKey="label" width={120} tick={{ fill: "#24160c", fontSize: 12 }} axisLine={false} tickLine={false} interval={0} />
          <Tooltip cursor={{ fill: "#f3e3cc", opacity: 0.5 }} content={<TooltipBox format={format} />} />
          <Bar dataKey="value" fill={color} radius={[0, 4, 4, 0]} maxBarSize={22} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Vertical bars over an ordered axis (hours, item counts). */
export function ColumnBars({ data, format, color = SERIES_1, axisFormat, height = 220 }: { data: Datum[]; format: (v: number) => string; color?: string; axisFormat?: (v: number) => string; height?: number }) {
  return (
    <div style={{ height }} aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={GRID} />
          <XAxis dataKey="label" tick={{ fill: INK_SOFT, fontSize: 12 }} axisLine={{ stroke: GRID }} tickLine={false} interval="preserveStartEnd" />
          <YAxis tickFormatter={axisFormat ?? format} tick={{ fill: INK_SOFT, fontSize: 12 }} axisLine={false} tickLine={false} width={56} />
          <Tooltip cursor={{ fill: "#f3e3cc", opacity: 0.5 }} content={<TooltipBox format={format} />} />
          <Bar dataKey="value" fill={color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function DataTable({ headers, rows, minWidth }: { headers: string[]; rows: (string | number)[][]; minWidth?: number }) {
  return (
    <table className="w-full text-sm tabular-nums" style={minWidth ? { minWidth } : undefined}>
      <thead className="text-left text-ink-soft">
        <tr>{headers.map((h, i) => <th key={h} className={`py-1 font-semibold ${i ? "text-right" : ""}`}>{h}</th>)}</tr>
      </thead>
      <tbody className="divide-y divide-crust-dark">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className={`py-1 ${j ? "text-right" : ""}`}>{c}</td>)}</tr>)}
      </tbody>
    </table>
  );
}

/** Day × hour heatmap in plain HTML. Each cell has a tooltip and an accessible label. */
export function Heatmap({ cells, format }: { cells: { day: string; hour: number; value: number }[]; format: (v: number) => string }) {
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const hours = cells.map((c) => c.hour);
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);
  const max = Math.max(...cells.map((c) => c.value), 1);
  const lookup = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c.value]));
  const hourList = Array.from({ length: maxH - minH + 1 }, (_, i) => minH + i);
  const step = (v: number) => (v <= 0 ? -1 : Math.min(HEAT_RAMP.length - 1, Math.floor((v / max) * HEAT_RAMP.length)));
  const fmtHour = (h: number) => `${((h + 11) % 12) + 1}${h < 12 ? "a" : "p"}`;
  const fmtDay = (d: string) => new Date(`${d}T12:00:00+08:00`).toLocaleDateString("en-PH", { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="overflow-x-auto">
      <table className="border-separate border-spacing-0.5 text-xs">
        <thead>
          <tr>
            <th />
            {hourList.map((h) => <th key={h} className="px-0.5 font-normal text-ink-soft">{fmtHour(h)}</th>)}
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d}>
              <th className="pr-2 text-left font-semibold whitespace-nowrap">{fmtDay(d)}</th>
              {hourList.map((h) => {
                const v = lookup.get(`${d}|${h}`) ?? 0;
                const s = step(v);
                const label = `${fmtDay(d)} ${fmtHour(h)}: ${format(v)}`;
                return (
                  <td key={h} title={label} aria-label={label}
                    className="h-8 w-9 min-w-9 rounded"
                    style={{ background: s < 0 ? "#faf6f0" : HEAT_RAMP[s] }} />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-1 text-xs text-ink-soft" aria-hidden>
        Less {HEAT_RAMP.map((c) => <span key={c} className="h-3 w-5 rounded-sm" style={{ background: c }} />)} More
      </div>
    </div>
  );
}
