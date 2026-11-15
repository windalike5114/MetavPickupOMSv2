import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Boxes, ChevronLeft, ChevronRight, ClipboardList, PackageCheck, RefreshCw, RotateCcw, ShoppingBag } from 'lucide-react';
import { DateTime } from 'luxon';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useAuth } from '../components/AuthProvider';
import { API_BASE_URL } from '../constants';
import { hasPermission } from '../utils';

type WarehouseStats = {
  warehouseId: string;
  onlineOrders: number;
  onlineItems: number;
  localRequests: number;
  localItems: number;
  grossLocalRequests: number;
  grossLocalItems: number;
  returnRequests: number;
  returnOnlyRequests: number;
  returnItems: number;
  totalTransactions: number;
  totalItems: number;
};

type DailyStats = {
  date: string;
  warehouses: WarehouseStats[];
  totals: Omit<WarehouseStats, 'warehouseId'>;
};

const zone = 'Pacific/Auckland';
const number = new Intl.NumberFormat('zh-CN');
const metrics = [
  { label: '净出库单量', key: 'totalTransactions', icon: ClipboardList },
  { label: '净出库件数', key: 'totalItems', icon: Boxes },
  { label: '线上取货', key: 'onlineOrders', icon: ShoppingBag },
  { label: '线下净出库', key: 'localRequests', icon: PackageCheck },
  { label: '含回库单量', key: 'returnRequests', icon: RotateCcw },
  { label: '回库件数', key: 'returnItems', icon: RotateCcw },
] as const;

const trendWarehouses = [
  { key: 'AKL', label: '奥克兰', color: '#1d4ed8', dashed: false },
  { key: 'CHC', label: '基督城', color: '#b45309', dashed: true },
] as const;

const loadTrend = async (date: string, token: string, signal: AbortSignal): Promise<DailyStats & { days: DailyStats[] }> => {
  const response = await fetch(`${API_BASE_URL}/api/cn/dashboard/stats?date=${date}&days=7`, {
    headers: { 'x-v2-auth-token': `Bearer ${token}` },
    signal,
  });
  const data = await response.json();
  if (!response.ok || !data.success || data.date !== date || data.days?.length !== 7) throw new Error('Statistics unavailable');
  return data;
};

type TrendMetric = 'totalTransactions' | 'totalItems';

function TrendChart({ days, selectedDate, metric, setMetric }: {
  days: DailyStats[];
  selectedDate: string;
  metric: TrendMetric;
  setMetric: (metric: TrendMetric) => void;
}) {
  const { profile } = useAuth();
  const [detailDate, setDetailDate] = useState(selectedDate);
  const [detailWarehouse, setDetailWarehouse] = useState('AKL');
  const canSeeOrders = hasPermission(profile, 'View Orders', profile?.email);
  const canSeeOutbound = ['Reception', 'Admin'].includes(profile?.roleTemplate || '') || hasPermission(profile, 'Manage Picking', profile?.email);
  const rows = days.map(day => ({
    date: day.date,
    AKL: day.warehouses.find(row => row.warehouseId === 'AKL')?.[metric] ?? null,
    CHC: day.warehouses.find(row => row.warehouseId === 'CHC')?.[metric] ?? null,
  }));
  return (
    <section className="min-w-0 cn-surface p-4 sm:p-6" aria-label="7 日趋势">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-bold text-slate-950">7 日趋势</h2>
        <div className="flex gap-1 rounded-lg bg-slate-100 p-1" role="group" aria-label="趋势指标">
          {([{ value: 'totalTransactions', label: '单量' }, { value: 'totalItems', label: '件数' }] as const).map(item => (
            <button key={item.value} type="button" aria-pressed={metric === item.value} onClick={() => setMetric(item.value)}
              className={`rounded-md px-3 py-1.5 text-xs font-semibold ${metric === item.value ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600 hover:text-slate-950'}`}>
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-3 mt-4 flex gap-4 text-xs font-semibold text-slate-700">
        {trendWarehouses.map(warehouse => (
          <span key={warehouse.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="w-5 border-t-[3px]" style={{ borderColor: warehouse.color, borderStyle: warehouse.dashed ? 'dashed' : 'solid' }} />
            {warehouse.label}
          </span>
        ))}
      </div>
      <div className="h-60 sm:h-72">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} debounce={50}>
          <LineChart data={rows} margin={{ top: 10, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
            <CartesianGrid vertical={false} stroke="#cbd7e7" />
            <XAxis dataKey="date" interval={0} tickFormatter={value => value.slice(5).replace('-', '/')} tick={{ fontSize: 11, fill: '#475569' }} tickLine={false} axisLine={false} tickMargin={10} />
            <YAxis allowDecimals={false} domain={[0, dataMax => Math.max(1, dataMax)]} width={38} tick={{ fontSize: 11, fill: '#475569' }} tickLine={false} axisLine={false} />
            <Tooltip filterNull formatter={(value, name) => [`${number.format(Number(value))} ${metric === 'totalTransactions' ? '单' : '件'}`, name]} />
            {trendWarehouses.map(warehouse => {
              const point = ({ cx, cy, payload }: { cx?: number; cy?: number; payload?: { date?: string } }, radius: number) => (
                <circle cx={cx} cy={cy} r={radius} fill={warehouse.color} stroke="white" strokeWidth={1.5} className="cursor-pointer" onClick={() => {
                  if (payload?.date) setDetailDate(payload.date);
                  setDetailWarehouse(warehouse.key);
                }} />
              );
              return <Line key={warehouse.key} dataKey={warehouse.key} name={warehouse.label} stroke={warehouse.color}
                strokeDasharray={warehouse.dashed ? '8 5' : undefined} strokeWidth={3} dot={props => point(props, 4)}
                activeDot={props => point(props, 6)} isAnimationActive={false} />;
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {(canSeeOrders || canSeeOutbound) && (
        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
          <select aria-label="明细日期" value={detailDate} onChange={event => setDetailDate(event.target.value)} className="rounded border px-2 py-1.5 text-sm">
            {rows.map(row => <option key={row.date} value={row.date}>{row.date}</option>)}
          </select>
          <select aria-label="明细仓库" value={detailWarehouse} onChange={event => setDetailWarehouse(event.target.value)} className="rounded border px-2 py-1.5 text-sm">
            {trendWarehouses.map(warehouse => <option key={warehouse.key} value={warehouse.key}>{warehouse.label}</option>)}
          </select>
          {canSeeOrders && <Link className="rounded border px-3 py-1.5 text-sm font-semibold text-blue-800" to={`/cn/orders?pickedDate=${detailDate}&warehouse=${detailWarehouse}`}>线上取货明细</Link>}
          {canSeeOutbound && <Link className="rounded border px-3 py-1.5 text-sm font-semibold text-blue-800" to={`/cn/counter-pickups?outboundDate=${detailDate}&warehouse=${detailWarehouse}`}>线下出库明细</Link>}
        </div>
      )}
      <table className="sr-only">
        <caption>{selectedDate} 截止 · {metric === 'totalTransactions' ? '单量' : '件数'}</caption>
        <thead><tr><th>日期</th><th>奥克兰</th><th>基督城</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{row.AKL ?? '—'}</td><td>{row.CHC ?? '—'}</td></tr>)}</tbody>
      </table>
    </section>
  );
}

type ChartProps = {
  title: string;
  unit: string;
  warehouses: WarehouseStats[];
  online: 'onlineOrders' | 'onlineItems';
  local: 'localRequests' | 'localItems';
};

function WarehouseChart({ title, unit, warehouses, online, local }: ChartProps) {
  const largest = Math.max(0, ...warehouses.map(row => row[online] + row[local]));
  const tick = Math.max(1, Math.ceil(largest / 4));
  const scale = tick * 4;
  return (
    <section className="min-w-0 cn-surface p-5 sm:p-6" aria-label={title}>
      <h2 className="text-base font-bold text-slate-950">{title}</h2>
      <div className="mt-7 space-y-5">
        {warehouses.map(row => {
          const values = [row[online], row[local]];
          return (
            <div key={row.warehouseId}>
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-semibold text-slate-800">{row.warehouseId === 'AKL' ? '奥克兰' : '基督城'}</span>
                <span className="font-semibold tabular-nums text-slate-700">{number.format(values[0] + values[1])} {unit}</span>
              </div>
              <div
                role="img"
                aria-label={`线上取货 ${values[0]} ${unit}，线下出库 ${values[1]} ${unit}`}
                className="flex h-5 overflow-hidden rounded-md bg-slate-100"
              >
                {values.map((value, index) => value > 0 && (
                  <span
                    key={index}
                    title={`${index === 0 ? '线上取货' : '线下出库'} ${value} ${unit}`}
                    style={{ width: `${value / scale * 100}%` }}
                    className={index === 0 ? 'cn-chart-online' : 'cn-chart-offline'}
                  />
                ))}
              </div>
              <div aria-hidden="true" className="mt-1.5 flex flex-wrap gap-x-4 text-xs font-semibold tabular-nums">
                <span className="cn-online-text">{number.format(values[0])}</span>
                <span className="cn-offline-text">{number.format(values[1])}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div aria-hidden="true" className="mt-5 flex justify-between border-t border-slate-100 pt-2 text-[11px] tabular-nums text-slate-500">
        {[0, 1, 2, 3, 4].map(value => <span key={value}>{number.format(value * tick)}</span>)}
      </div>
    </section>
  );
}

export const CnPortalHome = () => {
  const { token } = useAuth();
  const [params, setParams] = useSearchParams();
  const [revision, refresh] = useState(0);
  const [stats, setStats] = useState<DailyStats | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [trend, setTrend] = useState<{ date: string; days: DailyStats[] } | null>(null);
  const [trendMetric, setTrendMetric] = useState<TrendMetric>('totalTransactions');
  const today = DateTime.now().setZone(zone).startOf('day');
  const todayIso = today.toISODate()!;
  const requested = params.get('date') ?? '';
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(requested) ? DateTime.fromISO(requested, { zone }) : null;
  const day = parsed?.isValid && parsed <= today ? parsed : today;
  const date = day.toISODate()!;

  useEffect(() => {
    if (!token) return;
    const controller = new AbortController();
    setStatus('loading');
    setTrend(null);
    void loadTrend(date, token, controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setStats(data);
      setTrend({ date, days: data.days });
      setStatus('ready');
    }).catch(() => {
      if (!controller.signal.aborted) setStatus('error');
    });
    return () => controller.abort();
  }, [date, token, revision]);

  const selectDate = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value > todayIso || value === date) return;
    if (!DateTime.fromISO(value, { zone }).isValid) return;
    setParams(previous => {
      const next = new URLSearchParams(previous);
      next.set('date', value);
      return next;
    });
  };

  const current = stats?.date === date && status === 'ready' ? stats : null;
  const total = current?.totals;
  const retry = () => refresh(value => value + 1);
  const dayButton = 'grid size-10 shrink-0 place-items-center rounded-lg text-slate-700 hover:bg-slate-100 disabled:text-slate-300 disabled:hover:bg-transparent focus-visible:outline-2 focus-visible:outline-indigo-600';

  return (
    <div className="cn-home min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1320px] space-y-5 px-4 py-6 sm:px-7 lg:py-9">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">业务总览</h1>
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="统计日期 · 新西兰时间">
            <div className="cn-date-control flex items-center gap-1 rounded-xl border bg-white p-0.5">
              <button type="button" className={dayButton} aria-label="前一天" onClick={() => selectDate(day.minus({ days: 1 }).toISODate()!)}>
                <ChevronLeft size={18} />
              </button>
              <input type="date" value={date} max={todayIso} aria-label="统计日期" onChange={event => selectDate(event.target.value)}
                className="h-10 w-[8.75rem] rounded-md px-1.5 text-sm font-semibold tabular-nums text-slate-900 focus-visible:outline-2 focus-visible:outline-indigo-600" />
              <button type="button" className={dayButton} disabled={date === todayIso} aria-label="后一天" onClick={() => selectDate(day.plus({ days: 1 }).toISODate()!)}>
                <ChevronRight size={18} />
              </button>
            </div>
            <button type="button" disabled={date === todayIso} onClick={() => selectDate(todayIso)}
              className="cn-date-control h-[46px] rounded-xl border bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-100 disabled:text-slate-500">今天</button>
            <button type="button" aria-label="刷新统计" onClick={retry} disabled={status === 'loading'}
              className="cn-date-control grid size-[46px] place-items-center rounded-xl border bg-white text-slate-700 hover:bg-slate-100 disabled:text-slate-500">
              <RefreshCw size={16} className={status === 'loading' ? 'motion-safe:animate-spin' : ''} />
            </button>
          </div>
        </header>

        {status === 'error' && (
          <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">
            <span>统计加载失败</span>
            <button type="button" className="font-bold underline" onClick={retry}>重试</button>
          </div>
        )}

        <div className="cn-metric-strip grid grid-cols-2 overflow-hidden lg:grid-cols-6" aria-busy={status === 'loading'}>
          {metrics.map(({ label, key, icon: Icon }) => (
            <article key={key} className="cn-metric p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2">
                <span className="cn-metric-label text-xs font-semibold text-slate-700">{label}</span>
                <span className="cn-metric-icon grid size-6 shrink-0 place-items-center">
                  <Icon size={16} aria-hidden="true" />
                </span>
              </div>
              <p className="mt-3 text-[clamp(1.6rem,4vw,2.5rem)] leading-none font-bold tabular-nums">
                {total ? number.format(total[key]) : '—'}
              </p>
            </article>
          ))}
        </div>

        {current && (
          <section aria-label="仓库统计" className="space-y-3">
            <section className="cn-surface overflow-hidden" aria-labelledby="offline-reconciliation">
              <h2 id="offline-reconciliation" className="px-4 py-3 text-sm font-bold text-slate-950">线下出库核对</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[540px] text-sm tabular-nums">
                  <thead><tr className="text-right">
                    <th scope="col" className="px-4 py-2 text-left">仓库</th>
                    <th scope="col" className="px-4 py-2">处理单 / 件</th>
                    <th scope="col" className="px-4 py-2">扣除仅回库单 / 回库件</th>
                    <th scope="col" className="px-4 py-2">净出库单 / 件</th>
                  </tr></thead>
                  <tbody>{[...current.warehouses.map(row => ({ ...row, label: row.warehouseId === 'AKL' ? '奥克兰' : '基督城' })), { ...current.totals, label: '合计' }].map(row => (
                    <tr key={row.label} className="text-right">
                      <th scope="row" className="border-b border-slate-200 px-4 py-2.5 text-left font-semibold">{row.label}</th>
                      <td className="px-4 py-2.5">{number.format(row.grossLocalRequests)} / {number.format(row.grossLocalItems)}</td>
                      <td className="px-4 py-2.5 text-amber-800">{number.format(row.returnOnlyRequests)} / {number.format(row.returnItems)}</td>
                      <td className="px-4 py-2.5 font-bold">{number.format(row.localRequests)} / {number.format(row.localItems)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            </section>
            {trend?.date === date && <TrendChart key={date} days={trend.days} selectedDate={date} metric={trendMetric} setMetric={setTrendMetric} />}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-xs font-semibold text-slate-700">
              <span className="flex items-center gap-2"><span className="cn-chart-online size-2.5 rounded-sm" />线上取货</span>
              <span className="flex items-center gap-2"><span className="cn-chart-offline size-2.5 rounded-sm" />线下出库</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
              <WarehouseChart title="各仓业务量" unit="单" warehouses={current.warehouses} online="onlineOrders" local="localRequests" />
              <WarehouseChart title="各仓商品件数" unit="件" warehouses={current.warehouses} online="onlineItems" local="localItems" />
            </div>
          </section>
        )}
        {!current && status === 'loading' && (
          <div aria-hidden="true" className="grid gap-3 lg:grid-cols-2">
            {[0, 1].map(index => (
              <div key={index} className="space-y-5 cn-surface p-5 sm:p-6">
                <div className="h-4 w-28 rounded bg-slate-100" />
                <div className="mt-9 h-5 rounded bg-slate-100" />
                <div className="mb-10 h-5 rounded bg-slate-100" />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
