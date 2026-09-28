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
      desc: '查看 AKL 与 CHC 的线上订单，跟进提货、付款与订单状态。',
      to: '/cn/orders',
      icon: ClipboardList,
      visible: hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '超期处理',
      desc: '查看并处理超期未提货订单，完成审核与结案。',
      to: '/cn/overdue',
      icon: Clock,
      visible: hasPermission(profile, 'Audit Overdue Orders', profile?.email) || hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '邮件通知',
      desc: '在订单列表中发送提货通知邮件并跟进发送状态。',
      to: '/cn/orders',
      icon: Mail,
      visible: hasPermission(profile, 'View Orders', profile?.email)
    },
    {
      title: '账号管理',
      desc: '创建并管理销售和管理员账号及权限设置。',
      to: '/cn/users',
      icon: Users,
      visible: isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Users', profile?.email)
    },
    {
      title: '申请提货',
      desc: '查看 AKL 与 CHC 的本地线下出库、已送达和回库记录。',
      to: '/cn/counter-pickups',
      icon: PackageCheck,
      visible: profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin' || hasPermission(profile, 'Manage Picking', profile?.email)
    }
  ];

  const warehouseRows = [
    stats?.warehouses.find((item) => item.warehouseId === 'AKL') || emptyWarehouseStats('AKL', 'Auckland'),
    stats?.warehouses.find((item) => item.warehouseId === 'CHC') || emptyWarehouseStats('CHC', 'Christchurch')
  ];

  return (
    <div className="flex-1 overflow-y-auto bg-[radial-gradient(circle_at_top_left,#eef2ff_0,transparent_32%),linear-gradient(180deg,#f8fafc_0%,#f1f5f9_100%)] p-4 md:p-8">
      <div className="mx-auto max-w-7xl space-y-7">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full border border-indigo-100 bg-white/80 px-3 py-1 text-xs font-bold text-indigo-700 shadow-sm">
              <Building2 className="h-3.5 w-3.5" />
              AKL + CHC 跨仓总览
            </div>
            <h1 className="text-3xl font-black tracking-tight text-slate-950">中国轻量门户</h1>
            <p className="mt-1 text-sm text-slate-500">无需选择仓库，统一查看奥克兰与基督城业务数据。</p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-2xl border border-white/80 bg-white/80 px-4 py-2 text-right shadow-sm backdrop-blur">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-400">奥克兰业务日期</p>
              <p className="text-sm font-black text-slate-800">{stats?.date || getAucklandDate()}</p>
            </div>
            <button
              type="button"
              onClick={loadStats}
              disabled={statsLoading}
              className="flex h-11 w-11 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:border-indigo-200 hover:text-indigo-600 disabled:opacity-50"
              title="刷新今日统计"
            >
              <RefreshCw className={`h-4 w-4 ${statsLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {statsError && (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
            <span>{statsError}</span>
            <button type="button" onClick={loadStats} className="font-black underline underline-offset-2">重试</button>
          </div>
        )}

        <section className="grid gap-4 lg:grid-cols-2">
          {warehouseRows.map((warehouse, index) => (
            <article
              key={warehouse.warehouseId}
              className={`relative overflow-hidden rounded-[28px] border p-5 shadow-sm ${
                index === 0
                  ? 'border-sky-200 bg-gradient-to-br from-white via-sky-50 to-cyan-100/70'
                  : 'border-amber-200 bg-gradient-to-br from-white via-amber-50 to-orange-100/70'
              }`}
            >
              <div className="absolute -right-10 -top-10 h-36 w-36 rounded-full bg-white/50" />
              <div className="relative">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.2em] text-slate-400">{warehouse.warehouseId}</p>
                    <h2 className="mt-1 text-2xl font-black text-slate-950">{warehouse.warehouseName}</h2>
                  </div>
                  <div className="rounded-2xl bg-slate-950 px-4 py-2 text-right text-white shadow-lg shadow-slate-300/50">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">今日总出库</p>
                    <p className="text-2xl font-black">{warehouse.totalItems}</p>
                  </div>
                </div>

                <div className="mt-5 grid grid-cols-2 gap-3">
                  <div className="rounded-2xl border border-white/90 bg-white/85 p-4 shadow-sm backdrop-blur">
                    <div className="flex items-center gap-2 text-sky-700">
                      <ShoppingBag className="h-4 w-4" />
                      <p className="text-xs font-black">线上订单取货</p>
                    </div>
                    <p className="mt-3 text-3xl font-black text-slate-950">{warehouse.onlineOrders}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">订单列表 · {warehouse.onlineItems} 件产品</p>
                  </div>
                  <div className="rounded-2xl border border-white/90 bg-white/85 p-4 shadow-sm backdrop-blur">
                    <div className="flex items-center gap-2 text-orange-700">
                      <PackageCheck className="h-4 w-4" />
                      <p className="text-xs font-black">本地线下出库</p>
                    </div>
                    <p className="mt-3 text-3xl font-black text-slate-950">{warehouse.localRequests}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">申请提货 · {warehouse.localItems} 件产品</p>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </section>

        <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
          {[
            { label: '线上取货订单', value: stats?.totals.onlineOrders || 0, sub: `${stats?.totals.onlineItems || 0} 件产品`, icon: ShoppingBag },
            { label: '线下出库请求', value: stats?.totals.localRequests || 0, sub: `${stats?.totals.localItems || 0} 件产品`, icon: PackageCheck },
            { label: '总业务单数', value: stats?.totals.totalTransactions || 0, sub: 'AKL + CHC', icon: ClipboardList },
            { label: '总出库数量', value: stats?.totals.totalItems || 0, sub: '今日产品数量', icon: Boxes }
          ].map((item) => (
            <div key={item.label} className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-500">{item.label}</p>
                <item.icon className="h-4 w-4 text-slate-400" />
              </div>
              <p className="mt-2 text-2xl font-black text-slate-950">{statsLoading ? '—' : item.value}</p>
              <p className="mt-1 text-xs text-slate-400">{item.sub}</p>
            </div>
          ))}
        </section>

        <section>
          <div className="mb-3">
            <h2 className="text-lg font-black text-slate-900">日常操作</h2>
            <p className="text-sm text-slate-500">跨仓查看不会改变新西兰端的仓库隔离逻辑。</p>
          </div>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {cards.filter((card) => card.visible).map((card) => (
              <Link
                key={card.title}
                to={card.to}
                className="group rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="space-y-2">
                    <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                      <card.icon className="h-5 w-5" />
                    </div>
                    <h3 className="text-lg font-bold text-slate-900">{card.title}</h3>
                    <p className="text-sm leading-relaxed text-slate-500">{card.desc}</p>
                  </div>
                  <ArrowRight className="mt-2 h-5 w-5 text-slate-300 transition-transform group-hover:translate-x-1 group-hover:text-indigo-500" />
                </div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
