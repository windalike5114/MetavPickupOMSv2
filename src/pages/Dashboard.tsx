import React, { useEffect, useState, useRef } from 'react';
import { collection, query, where, getDocs, limit, orderBy, doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { Order } from '../types';
import { useAuth } from '../components/AuthProvider';
import { logAction, isAdmin, isSystemAdmin, cn, formatDate, hasPermission } from '../utils';
import { 
  ShoppingBag, 
  CheckCircle2, 
  Clock, 
  XCircle,
  AlertCircle,
  Plus,
  ArrowRight,
  Database,
  RefreshCw,
  Megaphone,
  TrendingUp,
  Edit3,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Info,
  Warehouse
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useLocation } from 'react-router-dom';
import { subDays, startOfDay, isAfter } from 'date-fns';
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer,
  AreaChart,
  Area
} from 'recharts';
import { PageHeader } from '../components/PageHeader';
import { AnnouncementModal } from '../components/AnnouncementModal';
import { API_BASE_URL } from '../constants';

const DASHBOARD_CACHE_PREFIX = 'dashboard_orders_cache_v1';
const DASHBOARD_CACHE_TTL_MS = 2 * 60 * 1000;

const getOrderSortMs = (order: any): number => {
  const updated = order?.updatedAt;
  if (updated && typeof updated === 'object' && typeof updated._seconds === 'number') {
    return updated._seconds * 1000;
  }
  if (typeof updated === 'string') {
    const t = new Date(updated).getTime();
    if (Number.isFinite(t) && t > 0) return t;
  }
  const created = order?.createdTime ? new Date(order.createdTime).getTime() : 0;
  return Number.isFinite(created) ? created : 0;
};

const mergeOrdersById = (base: Order[], incoming: Order[]): Order[] => {
  const map = new Map<string, Order>();
  [...base, ...incoming].forEach((o: Order) => {
    if (o?.id) map.set(o.id, o);
  });
  return Array.from(map.values()).sort((a: Order, b: Order) => getOrderSortMs(b) - getOrderSortMs(a));
};

type DashboardOrder = Pick<Order, 'id' | 'bookingNumber' | 'customerName' | 'warehouseId' | 'status' | 'createdTime' | 'actualPickupTime' | 'pickupDateScheduled'>;

type DashboardCacheRecord = {
  orders: DashboardOrder[];
  updatedAt: string;
};

const getDashboardCache = (key: string): DashboardCacheRecord | null => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};

const setDashboardCache = (key: string, record: DashboardCacheRecord) => {
  try {
    localStorage.setItem(key, JSON.stringify(record));
  } catch {
    // Best-effort cache; ignore storage quota/private mode failures.
  }
};

export const Dashboard = () => {
  const { profile, user, activeWarehouse, token } = useAuth();
  const location = useLocation();
  const isCnRoute = location.pathname.startsWith('/cn');
  
  const navigate = useNavigate();
  const [stats, setStats] = useState({
    total: 0,
    pickedUp: 0,
    created: 0,
    cancelled: 0
  });
  const [recentOrders, setRecentOrders] = useState<DashboardOrder[]>([]);
  const [warningOrders, setWarningOrders] = useState<DashboardOrder[]>([]);
  const [trendData, setTrendData] = useState<any[]>([]);
  const [announcement, setAnnouncement] = useState<any>(null);
  const [showAnnouncementModal, setShowAnnouncementModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentTipIndex, setCurrentTipIndex] = useState(0);
  const [isScrolled, setIsScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const dashboardRequest = useRef(0);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsScrolled(!entry.isIntersecting);
      },
      { threshold: 0 }
    );

    if (sentinelRef.current) {
      observer.observe(sentinelRef.current);
    }

    return () => {
      if (sentinelRef.current) {
        observer.unobserve(sentinelRef.current);
      }
    };
  }, []);
  
  // Tips Data
  interface Tip {
    id: string;
    title: string;
    content: string;
    link: string | null;
    linkText: string | null;
    icon: any;
    color: string;
    isAnnouncement?: boolean;
    updatedAt?: string;
  }

  const baseTips: Tip[] = [
    {
      id: 'personalize',
      title: 'Personalize Your App',
      content: 'Visit the Settings page to toggle real-time notifications and switch between light and dark themes.',
      link: '/settings',
      linkText: 'Go to Settings',
      icon: Sparkles,
      color: 'from-indigo-600 to-indigo-700'
    },
    {
      id: 'sku-db',
      title: 'Quick SKU Search',
      content: 'Use the SKU Database to quickly find item locations and manage your inventory efficiently.',
      link: '/skus',
      linkText: 'View SKUs',
      icon: Database,
      color: 'from-indigo-600 to-indigo-700'
    },
    {
      id: 'history',
      title: 'Order Tracking',
      content: 'Check the Order List to see past pickups and review customer signatures.',
      link: '/orders',
      linkText: 'View Orders',
      icon: ShoppingBag,
      color: 'from-indigo-600 to-indigo-700'
    }
  ];

  const [allTips, setAllTips] = useState<any[]>(baseTips);

  const fetchAnnouncement = async (isCurrent: () => boolean) => {
    try {
      const snap = await getDoc(doc(db, 'announcements', 'current'));
      if (!isCurrent()) return;
      const data = snap.exists() ? snap.data() : null;
      setAnnouncement(data);
      setAllTips(data?.isActive ? [{
        id: 'announcement', title: 'System Announcement', content: data.content,
        link: data.link || null, linkText: data.link ? 'Learn More' : null, icon: Megaphone,
        color: 'from-indigo-600 to-indigo-700', isAnnouncement: true, updatedAt: data.updatedAt
      }, ...baseTips] : baseTips);
    } catch (error) {
      if (isCurrent()) console.error('Error fetching dashboard announcement:', error);
    }
  };

  const fetchData = async (force = false) => {
    const request = ++dashboardRequest.current;
    const isCurrent = () => dashboardRequest.current === request;
    const warehouse = activeWarehouse || localStorage.getItem('activeWarehouse') || 'AKL';
    setLoading(true);
    void fetchAnnouncement(isCurrent);

    try {
      const applyDashboardOrders = (orders: DashboardOrder[]) => {
        // Filter by warehouse: match warehouse OR missing warehouseId (assumed AKL)
        const filteredByWarehouse = orders.filter(order => {
          const orderWarehouse = order.warehouseId || 'AKL';
          return orderWarehouse === warehouse;
        });

        // 1. Calculate Stats
        const statsData = {
          total: filteredByWarehouse.length,
          created: filteredByWarehouse.filter(o => o.status === 'Created').length,
          pickedUp: filteredByWarehouse.filter(o => o.status === 'Picked Up' || o.status === 'Reviewed').length,
          cancelled: filteredByWarehouse.filter(o => o.status === 'Cancelled').length
        };
        setStats(statsData);

        // 2. Warnings (72h Overdue)
        const threshold = subDays(new Date(), 3).toISOString();
        const warningOrders = filteredByWarehouse
          .filter(o => o.status === 'Created' && o.pickupDateScheduled < threshold)
          .sort((a, b) => a.pickupDateScheduled.localeCompare(b.pickupDateScheduled))
          .slice(0, 5);
        setWarningOrders(warningOrders);

        // 3. Recent Orders
        setRecentOrders(filteredByWarehouse.slice(0, 5));

        // 4. Trend Data (Last 14 days)
        const trendThreshold = subDays(new Date(), 14).toISOString();
        const trendOrders = filteredByWarehouse.filter(o => 
          (o.status === 'Picked Up' || o.status === 'Reviewed') && 
          o.actualPickupTime && o.actualPickupTime >= trendThreshold
        );

        const trendMap = new Map();
        for (let i = 0; i < 14; i++) {
          const dateStr = formatDate(subDays(new Date(), i), 'MM/dd');
          trendMap.set(dateStr, 0);
        }

        trendOrders.forEach(order => {
          if (order.actualPickupTime) {
            const pickupDate = formatDate(order.actualPickupTime, 'MM/dd');
            if (trendMap.has(pickupDate)) {
              trendMap.set(pickupDate, trendMap.get(pickupDate) + 1);
            }
          }
        });

        const formattedTrend = Array.from(trendMap.entries())
          .map(([date, count]) => ({ date, count }))
          .reverse();
        setTrendData(formattedTrend);
      };

      const cacheKey = `${DASHBOARD_CACHE_PREFIX}:${user?.uid || 'anon'}:${warehouse}`;
      const cached = getDashboardCache(cacheKey);
      if (cached) {
        applyDashboardOrders(cached.orders);
        setLoading(false);
        const cacheAgeMs = cached.updatedAt ? Date.now() - new Date(cached.updatedAt).getTime() : Infinity;
        if (!force && cacheAgeMs >= 0 && cacheAgeMs < DASHBOARD_CACHE_TTL_MS) {
          return;
        }
      }

      const ordersRef = collection(db, 'orders');
      
      // 核心优化：确保查询条件与安全规则匹配 (Query Matching)
      let q;
      const isSuper = isSystemAdmin(profile?.username || profile?.email);
      
      if (isSuper || (profile?.allowedWarehouses || []).includes('*')) {
        // 超级管理员或拥有全库权限的用户可以扫描
        if (warehouse === 'AKL') {
          q = query(ordersRef, orderBy('createdTime', 'desc'), limit(1000));
        } else {
          q = query(
            ordersRef, 
            where('warehouseId', '==', warehouse),
            orderBy('createdTime', 'desc'),
            limit(1000)
          );
        }
      } else {
        // 普通用户必须严格遵守仓库隔离，显式过滤以通过规则校验
        q = query(
          ordersRef, 
          where('warehouseId', '==', warehouse),
          orderBy('createdTime', 'desc'),
          limit(1000)
        );
      }
      
      let snap;
      try {
        snap = await getDocs(q);
      } catch (err: any) {
        if (err.message?.includes('index')) {
          console.warn('Firestore index missing. Falling back to memory filtering.');
          const fallbackQ = query(ordersRef, orderBy('createdTime', 'desc'), limit(1000));
          snap = await getDocs(fallbackQ);
        } else {
          throw err;
        }
      }

      if (!isCurrent()) return;
      const allFetched = snap.docs.map(doc => {
        const { bookingNumber, customerName, warehouseId, status, createdTime, actualPickupTime, pickupDateScheduled } = doc.data();
        return { id: doc.id, bookingNumber, customerName, warehouseId, status, createdTime, actualPickupTime, pickupDateScheduled } as DashboardOrder;
      });
      applyDashboardOrders(allFetched);
      setDashboardCache(cacheKey, {
        orders: allFetched,
        updatedAt: new Date().toISOString()
      });

    } catch (error) {
      if (isCurrent()) console.error('Error fetching dashboard data:', error);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  };

  useEffect(() => {
    void fetchData();
    return () => { dashboardRequest.current += 1; };
  }, [activeWarehouse, user?.uid]);

  const nextTip = () => {
    setCurrentTipIndex((prev) => (prev + 1) % allTips.length);
  };

  const prevTip = () => {
    setCurrentTipIndex((prev) => (prev - 1 + allTips.length) % allTips.length);
  };

  if (loading) {
    return <div className="animate-pulse space-y-8">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        {[1,2,3,4].map(i => <div key={i} className="h-32 bg-slate-200 rounded-lg"></div>)}
      </div>
      <div className="h-64 bg-slate-200 rounded-lg"></div>
    </div>;
  }


  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden font-sans">
      <PageHeader
        title={isCnRoute ? "仪表盘总览" : "Dashboard Overview"}
        subtitle={isCnRoute ? "欢迎回来，仓库管理系统已就绪。" : "Welcome back to the Warehouse Management System."}
        icon={Warehouse}
        isScrolled={isScrolled}
        actions={
          <>
            <button 
              onClick={() => void fetchData(true)}
              className={cn(
                "p-3 bg-white border border-slate-200 text-slate-600 rounded-xl hover:bg-slate-50 transition-all",
                isScrolled ? "p-2 group-hover:p-3" : "p-3"
              )}
              title={isCnRoute ? "刷新数据" : "Refresh Data"}
            >
              <RefreshCw className={cn(
                loading ? 'animate-spin' : '',
                isScrolled ? "w-4 h-4 group-hover:w-5 h-5" : "w-5 h-5"
              )} />
            </button>
            {isSystemAdmin(profile?.username || profile?.email) && !announcement?.isActive && (
              <button 
                onClick={() => setShowAnnouncementModal(true)}
                className={cn(
                  "inline-flex items-center gap-2 bg-white border border-slate-200 text-slate-600 rounded-xl font-semibold hover:bg-slate-50 transition-all",
                  isScrolled ? "px-3 py-1.5 text-sm group-hover:px-6 group-hover:py-3 group-hover:text-base" : "px-6 py-3"
                )}
              >
                <Megaphone className={isScrolled ? "w-4 h-4 group-hover:w-5 group-hover:h-5" : "w-5 h-5"} />
                <span className={cn(
                  "transition-all",
                  isScrolled ? "hidden group-hover:inline" : "inline"
                )}>{isCnRoute ? '发布公告' : 'Post Announcement'}</span>
              </button>
            )}
            {hasPermission(profile, 'Create Order', profile?.username || profile?.email) && (
              <Link 
                to="/orders/create"
                className={cn(
                  "inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold transition-all shadow-lg shadow-indigo-200",
                  isScrolled ? "px-4 py-2 text-sm group-hover:px-6 group-hover:py-3 group-hover:text-base" : "px-6 py-3"
                )}
              >
                <Plus className={isScrolled ? "w-4 h-4 group-hover:w-5 group-hover:h-5" : "w-5 h-5"} />
                {isCnRoute ? '创建新订单' : 'Create New Order'}
              </Link>
            )}
          </>
        }
      />

      {/* 🚀 Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard 
          title={isCnRoute ? "订单总数" : "Total Orders"} 
          value={stats.total} 
          icon={ShoppingBag} 
          color="bg-blue-500" 
        />
        <StatCard 
          title={isCnRoute ? "已创建" : "Created"} 
          value={stats.created} 
          icon={Clock} 
          color="bg-amber-500" 
        />
        <StatCard 
          title={isCnRoute ? "已提货" : "Picked Up"} 
          value={stats.pickedUp} 
          icon={CheckCircle2} 
          color="bg-emerald-500" 
        />
        <StatCard 
          title={isCnRoute ? "已取消" : "Cancelled"} 
          value={stats.cancelled} 
          icon={XCircle} 
          color="bg-red-500" 
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-lg flex items-center justify-center">
                <TrendingUp className="w-5 h-5" />
              </div>
              <h2 className="text-lg font-bold text-slate-900">Pickup Trend (14 Days)</h2>
            </div>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trendData}>
                <defs>
                  <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="var(--color-emerald-500)" stopOpacity={0.1}/>
                    <stop offset="95%" stopColor="var(--color-emerald-500)" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                <XAxis 
                  dataKey="date" 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{fill: '#94a3b8', fontSize: 12}}
                  dy={10}
                />
                <YAxis 
                  axisLine={false} 
                  tickLine={false} 
                  tick={{fill: '#94a3b8', fontSize: 12}}
                />
                <Tooltip 
                  contentStyle={{borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)', backgroundColor: '#fff'}}
                />
                <Area 
                  type="monotone" 
                  dataKey="count" 
                  stroke="#10b981" 
                  strokeWidth={3}
                  fillOpacity={1} 
                  fill="url(#colorCount)" 
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 bg-red-100 text-red-600 rounded-lg flex items-center justify-center">
              <AlertCircle className="w-5 h-5" />
            </div>
            <h2 className="text-lg font-bold text-slate-900">72h Overdue Warning</h2>
          </div>
          <div className="space-y-4">
            {warningOrders.length === 0 ? (
              <div className="text-center py-8">
                <CheckCircle2 className="w-12 h-12 text-emerald-200 mx-auto mb-2" />
                <p className="text-slate-400 text-sm">No overdue orders</p>
              </div>
            ) : (
              warningOrders.map(order => (
                <div 
                  key={order.id}
                  onClick={() => navigate(`/orders/${order.id}`)}
                  className="p-4 bg-red-50/50 border border-red-100 rounded-lg hover:bg-red-50 transition-all cursor-pointer group"
                >
                  <div className="flex justify-between items-start mb-1">
                    <span className="font-bold text-slate-900">{order.bookingNumber}</span>
                    <span className="text-[10px] font-bold text-red-600 bg-red-100 px-1.5 py-0.5 rounded uppercase">OVERDUE</span>
                  </div>
                  <p className="text-sm text-slate-600 mb-2">{order.customerName}</p>
                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-medium">
                    <span>Scheduled: {formatDate(order.pickupDateScheduled, 'MMM d, HH:mm')}</span>
                    <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform" />
                  </div>
                </div>
              ))
            )}
            {warningOrders.length > 0 && (
              <Link 
                to="/orders" 
                state={{ statusFilter: 'Overdue' }}
                className="block text-center text-sm font-semibold text-red-600 hover:text-red-700 pt-2"
              >
                View all overdue orders
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
          <div className="p-6 border-b border-slate-100 flex items-center justify-between">
            <h2 className="text-lg font-bold text-slate-900">Recent Orders</h2>
            <Link to="/orders" className="text-sm font-medium text-indigo-600 hover:text-indigo-700 flex items-center gap-1">
              View All <ArrowRight className="w-4 h-4" />
            </Link>
          </div>
          <div className="overflow-x-auto">
            {recentOrders.length === 0 ? (
              <div className="p-12 text-center">
                <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
                  <ShoppingBag className="w-8 h-8 text-slate-200" />
                </div>
                <p className="text-slate-500 font-medium">No orders found</p>
                <p className="text-slate-400 text-sm mt-1">Try changing the warehouse or check your database connection.</p>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wider">
                    <th className="px-6 py-4 font-semibold">Order #</th>
                    <th className="px-6 py-4 font-semibold">Customer</th>
                    <th className="px-6 py-4 font-semibold">Status</th>
                    <th className="px-6 py-4 font-semibold">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {recentOrders.map((order) => (
                    <tr 
                      key={order.id} 
                      className="hover:bg-slate-50 transition-colors cursor-pointer" 
                      onClick={() => navigate(`/orders/${order.id}`)}
                    >
                      <td className="px-6 py-4 font-medium text-slate-900">{order.bookingNumber}</td>
                      <td className="px-6 py-4 text-slate-600">{order.customerName}</td>
                      <td className="px-6 py-4">
                        <span className={cn(
                          "px-3 py-1 rounded-full text-xs font-semibold",
                          order.status === 'Created' ? "bg-amber-100 text-amber-700" :
                          order.status === 'Picked Up' ? "bg-emerald-100 text-emerald-700" :
                          order.status === 'Reviewed' ? "bg-indigo-100 text-indigo-700" :
                          "bg-red-100 text-red-700"
                        )}>
                          {order.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-slate-500 text-sm">
                        {formatDate(order.createdTime, 'MMM d, HH:mm')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="relative bg-white rounded-xl overflow-hidden shadow-md border border-slate-100 h-[240px]">
            <div
              key={allTips[currentTipIndex].id}
              className={`absolute inset-0 bg-indigo-600 p-6 text-white flex flex-col`}
            >
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-white/20 rounded-lg flex items-center justify-center">
                    {React.createElement(allTips[currentTipIndex].icon, { className: "w-5 h-5" })}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">{allTips[currentTipIndex].title}</h3>
                    {allTips[currentTipIndex].isAnnouncement && (
                      <p className="text-[10px] text-white/60 font-medium">
                        Updated {formatDate(allTips[currentTipIndex].updatedAt, 'MMM d, HH:mm')}
                      </p>
                    )}
                  </div>
                </div>
                {allTips[currentTipIndex].isAnnouncement && isSystemAdmin(profile?.username || profile?.email) && (
                  <button 
                    onClick={() => setShowAnnouncementModal(true)}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                  >
                    <Edit3 className="w-4 h-4" />
                  </button>
                )}
              </div>
              
              <p className="text-white/90 text-sm leading-relaxed flex-1 overflow-y-auto pr-2">
                {allTips[currentTipIndex].content}
              </p>

              <div className="mt-4 pt-4 border-t border-white/10 flex items-center justify-between">
                {allTips[currentTipIndex].link ? (
                  allTips[currentTipIndex].id === 'announcement' ? (
                    <a 
                      href={allTips[currentTipIndex].link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm font-bold flex items-center gap-2"
                    >
                      {allTips[currentTipIndex].linkText} <ExternalLink className="w-3 h-3" />
                    </a>
                  ) : (
                    <Link 
                      to={allTips[currentTipIndex].link}
                      className="text-sm font-bold flex items-center gap-2"
                    >
                      {allTips[currentTipIndex].linkText} <ArrowRight className="w-4 h-4" />
                    </Link>
                  )
                ) : (
                  <div className="text-sm font-bold opacity-50 flex items-center gap-2">
                    <Info className="w-4 h-4" /> Tip
                  </div>
                )}

                <div className="flex gap-2">
                  <button 
                    onClick={prevTip}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={nextTip}
                    className="p-2 bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-6 border border-slate-100 shadow-sm">
            <h3 className="text-lg font-bold text-slate-900 mb-4">System Status</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Database Connection</span>
                <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Authentication Service</span>
                <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Storage Service</span>
                <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AnnouncementModal 
        isOpen={showAnnouncementModal}
        onClose={() => setShowAnnouncementModal(false)}
        currentAnnouncement={announcement}
        onUpdate={fetchData}
      />
      </div>
    </div>
  );
};

const StatCard = ({ title, value, icon: Icon, color }: any) => (
  <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-5">
    <div className={cn("w-12 h-12 rounded-xl flex items-center justify-center text-white", color)}>
      <Icon className="w-6 h-6" />
    </div>
    <div>
      <p className="text-sm font-medium text-slate-500">{title}</p>
      <p className="text-2xl font-bold text-slate-900">{value}</p>
    </div>
  </div>
);
