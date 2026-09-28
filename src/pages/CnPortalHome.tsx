import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  Building2,
  ClipboardList,
  Clock,
  Mail,
  PackageCheck,
  RefreshCw,
  ShoppingBag,
  Users
} from 'lucide-react';
import { useAuth } from '../components/AuthProvider';
import { API_BASE_URL } from '../constants';
import { hasPermission, isAdmin } from '../utils';

type WarehouseDailyStats = {
  warehouseId: 'AKL' | 'CHC';
  warehouseName: string;
  onlineOrders: number;
  onlineItems: number;
  localRequests: number;
  localItems: number;
  totalTransactions: number;
  totalItems: number;
};

type DailyStatsResponse = {
  date: string;
  generatedAt: string;
  warehouses: WarehouseDailyStats[];
  totals: Omit<WarehouseDailyStats, 'warehouseId' | 'warehouseName'>;
};

const getAucklandDate = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());

const emptyWarehouseStats = (warehouseId: 'AKL' | 'CHC', warehouseName: string): WarehouseDailyStats => ({
  warehouseId,
  warehouseName,
  onlineOrders: 0,
  onlineItems: 0,
  localRequests: 0,
  localItems: 0,
  totalTransactions: 0,
  totalItems: 0
});

export const CnPortalHome: React.FC = () => {
  const { profile, token } = useAuth();
  const [stats, setStats] = useState<DailyStatsResponse | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  const loadStats = useCallback(async () => {
    if (!token) return;
    setStatsLoading(true);
    setStatsError('');
    try {
      const params = new URLSearchParams({ date: getAucklandDate() });
      const response = await fetch(`${API_BASE_URL}/api/cn/dashboard/stats?${params.toString()}`, {
        headers: { 'x-v2-auth-token': `Bearer ${token}` }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '无法加载今日统计');
      setStats(data as DailyStatsResponse);
    } catch (error: any) {
      setStatsError(error.message || '无法加载今日统计');
    } finally {
      setStatsLoading(false);
    }
  }, [token]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const cards = [
    {
      title: '订单管理',
      desc: '统一查看两地线上订单、付款和提货状态。',
      to: '/cn/orders',
      icon: ClipboardList,
      visible: hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '申请提货',
      desc: '查看本地线下出库、送达及回库记录。',
      to: '/cn/counter-pickups',
      icon: PackageCheck,
      visible: profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin' || hasPermission(profile, 'Manage Picking', profile?.email)
    },
    {
      title: '超期处理',
      desc: '集中处理超期未提货订单和审核事项。',
      to: '/cn/overdue',
      icon: Clock,
      visible: hasPermission(profile, 'Audit Overdue Orders', profile?.email) || hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '邮件通知',
      desc: '从订单列表发送提货通知并跟进状态。',
      to: '/cn/orders',
      icon: Mail,
      visible: hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '账号管理',
      desc: '维护销售、接待与管理员账号权限。',
      to: '/cn/users',
      icon: Users,
      visible: isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Users', profile?.email)
    }
  ];

  const warehouseRows = [
    stats?.warehouses.find((item) => item.warehouseId === 'AKL') || emptyWarehouseStats('AKL', 'Auckland'),
    stats?.warehouses.find((item) => item.warehouseId === 'CHC') || emptyWarehouseStats('CHC', 'Christchurch')
  ];

  const summaryCards = [
    {
      label: '线上取货订单',
      value: stats?.totals.onlineOrders || 0,
      sub: `${stats?.totals.onlineItems || 0} 件产品`,
      icon: ShoppingBag,
      tone: 'text-sky-700 bg-sky-50 border-sky-100'
    },
    {
      label: '线下出库请求',
      value: stats?.totals.localRequests || 0,
      sub: `${stats?.totals.localItems || 0} 件产品`,
      icon: PackageCheck,
      tone: 'text-amber-700 bg-amber-50 border-amber-100'
    },
    {
      label: '今日业务单数',
      value: stats?.totals.totalTransactions || 0,
      sub: 'AKL + CHC',
      icon: ClipboardList,
      tone: 'text-emerald-700 bg-emerald-50 border-emerald-100'
    },
    {
      label: '今日出库数量',
      value: stats?.totals.totalItems || 0,
      sub: '全部产品数量',
      icon: Boxes,
      tone: 'text-slate-700 bg-slate-100 border-slate-200'
    }
  ];

  return (
    <div className="cn-home flex-1 overflow-y-auto bg-slate-50">
      <div className="mx-auto w-full max-w-[1500px] space-y-6 px-4 py-5 sm:px-6 md:py-7 xl:px-8">
        <section className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white px-5 py-5 shadow-sm sm:px-6">
          <div className="absolute inset-y-0 left-0 w-1 bg-emerald-500" />
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-md bg-slate-950 px-2 py-1 text-[10px] font-black uppercase tracking-[0.12em] text-white">
                  <Building2 className="h-3 w-3" />
                  跨仓运营总览
                </span>
                <span className="text-xs font-semibold text-slate-400">Pacific/Auckland</span>
              </div>
              <h1 className="text-2xl font-black tracking-tight text-slate-950 sm:text-3xl">今日业务一目了然</h1>
              <p className="mt-1 text-sm text-slate-500">无需切换仓库，统一查看奥克兰与基督城的订单和线下出库。</p>
            </div>
            <div className="flex items-center gap-2 self-start sm:self-auto">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2 text-right">
                <p className="text-[9px] font-black uppercase tracking-[0.12em] text-slate-400">业务日期</p>
                <p className="mt-0.5 text-sm font-black text-slate-800">{stats?.date || getAucklandDate()}</p>
              </div>
              <button
                type="button"
                onClick={loadStats}
                disabled={statsLoading}
                className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:border-slate-400 hover:text-slate-950 disabled:opacity-50"
                title="刷新今日统计"
              >
                <RefreshCw className={`h-4 w-4 ${statsLoading ? 'animate-spin' : ''}`} />
              </button>
            </div>
          </div>
        </section>

        {statsError && (
          <div className="flex items-center justify-between gap-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            <span>{statsError}</span>
            <button type="button" onClick={loadStats} className="font-black underline underline-offset-2">重新加载</button>
          </div>
        )}

        <section aria-labelledby="today-summary-title">
          <div className="mb-3 flex items-end justify-between">
            <div>
              <h2 id="today-summary-title" className="text-sm font-black text-slate-900">今日关键指标</h2>
              <p className="mt-0.5 text-xs text-slate-400">订单按业务单计数，产品按商品数量合计。</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
            {summaryCards.map((item) => (
              <article key={item.label} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-bold text-slate-500">{item.label}</p>
                  <span className={`flex h-8 w-8 items-center justify-center rounded-lg border ${item.tone}`}>
                    <item.icon className="h-4 w-4" />
                  </span>
                </div>
                <div className="mt-3 flex items-end gap-2">
                  <p className="text-2xl font-black leading-none text-slate-950 sm:text-3xl">{statsLoading ? '—' : item.value}</p>
                  <p className="pb-0.5 text-[11px] font-semibold text-slate-400">{item.sub}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="warehouse-comparison-title">
          <div className="mb-3">
            <h2 id="warehouse-comparison-title" className="text-sm font-black text-slate-900">仓库业务对比</h2>
            <p className="mt-0.5 text-xs text-slate-400">蓝色代表线上订单，橙色代表本地线下出库。</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {warehouseRows.map((warehouse) => (
              <article key={warehouse.warehouseId} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
                <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3.5 sm:px-5">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-950 text-xs font-black text-white">{warehouse.warehouseId}</span>
                    <div>
                      <h3 className="text-base font-black text-slate-950">{warehouse.warehouseName}</h3>
                      <p className="text-[11px] text-slate-400">今日跨仓业务口径</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[9px] font-black uppercase tracking-[0.1em] text-slate-400">总出库</p>
                    <p className="text-xl font-black text-slate-950">{statsLoading ? '—' : warehouse.totalItems}</p>
                  </div>
                </header>

                <div className="divide-y divide-slate-100">
                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3.5 sm:px-5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-sky-500" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">线上订单取货</p>
                        <p className="text-[11px] text-slate-400">来自订单列表</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-slate-950">{warehouse.onlineOrders}</p>
                      <p className="text-[9px] font-bold text-slate-400">订单</p>
                    </div>
                    <div className="min-w-16 rounded-lg bg-sky-50 px-2.5 py-1.5 text-right">
                      <p className="text-sm font-black text-sky-700">{warehouse.onlineItems}</p>
                      <p className="text-[9px] font-bold text-sky-600/70">件产品</p>
                    </div>
                  </div>

                  <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3.5 sm:px-5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="h-2.5 w-2.5 flex-shrink-0 rounded-full bg-amber-500" />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-bold text-slate-800">本地线下出库</p>
                        <p className="text-[11px] text-slate-400">来自申请提货</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-black text-slate-950">{warehouse.localRequests}</p>
                      <p className="text-[9px] font-bold text-slate-400">请求</p>
                    </div>
                    <div className="min-w-16 rounded-lg bg-amber-50 px-2.5 py-1.5 text-right">
                      <p className="text-sm font-black text-amber-700">{warehouse.localItems}</p>
                      <p className="text-[9px] font-bold text-amber-600/70">件产品</p>
                    </div>
                  </div>
                </div>

                <footer className="flex items-center justify-between border-t border-slate-100 bg-slate-50 px-4 py-2.5 text-xs sm:px-5">
                  <span className="font-semibold text-slate-500">共 {warehouse.totalTransactions} 笔业务</span>
                  <span className="font-black text-slate-800">{warehouse.totalItems} 件产品</span>
                </footer>
              </article>
            ))}
          </div>
        </section>

        <section aria-labelledby="daily-actions-title">
          <div className="mb-3">
            <h2 id="daily-actions-title" className="text-sm font-black text-slate-900">日常操作</h2>
            <p className="mt-0.5 text-xs text-slate-400">中国门户仅用于跨仓跟单，不改变新西兰端仓库隔离逻辑。</p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.filter((card) => card.visible).map((card) => (
              <Link
                key={card.title}
                to={card.to}
                className="group flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-400 hover:shadow-md"
              >
                <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 transition group-hover:bg-slate-950 group-hover:text-white">
                  <card.icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-black text-slate-900">{card.title}</span>
                  <span className="mt-0.5 block text-xs leading-5 text-slate-500">{card.desc}</span>
                </span>
                <ArrowRight className="h-4 w-4 flex-shrink-0 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-slate-700" />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};