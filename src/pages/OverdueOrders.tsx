import React, { useState, useEffect, useMemo } from 'react';
import { collection, query, getDocs, where, doc, updateDoc, serverTimestamp, limit, arrayUnion } from 'firebase/firestore';
import { db } from '../firebase';
import { Order, AuditLog, FollowUpLog } from '../types';
import { useAuth } from '../components/AuthProvider';
import { cn, formatDate, handleFirestoreError, OperationType, logAction, isSystemAdmin } from '../utils';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Clock, 
  Search, 
  AlertCircle, 
  CheckCircle2, 
  X, 
  Calendar,
  MapPin,
  Loader2,
  User,
  Filter,
  TrendingUp,
  AlertTriangle,
  History as HistoryIcon,
  Send,
  ChevronRight,
  MessageSquare
} from 'lucide-react';

import { PageHeader } from '../components/PageHeader';
import { useRef } from 'react';
import { API_BASE_URL, CN_API_ONLY } from '../constants';
import { useLocation } from 'react-router-dom';

const CN_OVERDUE_CACHE_PREFIX = 'cn_overdue_orders_cache_v1';

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

export const OverdueOrders = () => {
  const { profile, user, activeWarehouse, token } = useAuth();
  const location = useLocation();
  const isCnApiMode = location.pathname.startsWith('/cn');
  const isCnRoute = isCnApiMode;
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState(activeWarehouse || 'All');
  
  // Advanced Filters
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [overdueThreshold, setOverdueThreshold] = useState<'all' | '14' | '30'>('all');
  
  // Side Panel state
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [followUpContent, setFollowUpContent] = useState('');
  const [savingFollowUp, setSavingFollowUp] = useState(false);

  // Audit Modal state
  const [selectedOrderForAudit, setSelectedOrderForAudit] = useState<Order | null>(null);
  const [reason, setReason] = useState<AuditLog['reason'] | ''>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [isScrolled, setIsScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    fetchOverdueOrders();
  }, []);

  const fetchOverdueOrders = async () => {
    setLoading(true);
    try {
      if (isCnApiMode) {
        if (!token) return;
        const warehouse = activeWarehouse || '';
        const cacheKey = `${CN_OVERDUE_CACHE_PREFIX}:${user?.uid || 'anon'}:${warehouse}`;
        const cachedRaw = localStorage.getItem(cacheKey);
        let cachedOrders: Order[] = [];
        let lastSyncAt = '';
        if (cachedRaw) {
          try {
            const parsed = JSON.parse(cachedRaw);
            cachedOrders = parsed?.orders || [];
            lastSyncAt = parsed?.lastSyncAt || '';
            if (cachedOrders.length) {
              setOrders(cachedOrders);
              setLoading(false);
            }
          } catch {
            // ignore broken cache
          }
        }

        const params = new URLSearchParams({ limit: '1000' });
        if (lastSyncAt) params.set('updatedAfter', lastSyncAt);
        const response = await fetch(`${API_BASE_URL}/api/orders/list?${params.toString()}`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': warehouse
          }
        });
        const raw = await response.text();
        const data = raw ? JSON.parse(raw) : null;
        if (!response.ok || !data?.success) {
          throw new Error(data?.error || `Failed to fetch overdue orders (status ${response.status})`);
        }
        const incoming = ((data.orders || []) as Order[]).filter((o) => o.paymentStatus === 'Paid' && o.status === 'Created');
        const merged = mergeOrdersById(cachedOrders, incoming);
        setOrders(merged);
        const maxMs = Math.max(
          ...merged.map((o: Order) => getOrderSortMs(o)),
          lastSyncAt ? new Date(lastSyncAt).getTime() : 0
        );
        localStorage.setItem(cacheKey, JSON.stringify({
          orders: merged,
          lastSyncAt: maxMs > 0 ? new Date(maxMs).toISOString() : new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }));
        setLoading(false);
        return;
      }

      const ordersRef = collection(db, 'orders');
      // Base filter: Paid but not Picked Up
      // Note: We also exclude Reviewed and Cancelled as they are terminal
      
      let q;
      const isSuper = isSystemAdmin(profile?.username || profile?.email);
      
      if (isSuper || (profile?.allowedWarehouses || []).includes('*')) {
        // 超级管理员或拥有全库权限的用户可以扫描
        q = query(
          ordersRef, 
          where('paymentStatus', '==', 'Paid'),
          where('status', '==', 'Created'),
          limit(1000)
        );
      } else {
        // 普通用户必须按仓库过滤以通过安全规则校验
        // 如果有 activeWarehouse 则用它，否则用第一个授权仓库
        const targetWarehouse = activeWarehouse || (profile?.allowedWarehouses && profile.allowedWarehouses[0]);
        
        if (targetWarehouse) {
          q = query(
            ordersRef, 
            where('warehouseId', '==', targetWarehouse),
            where('paymentStatus', '==', 'Paid'),
            where('status', '==', 'Created'),
            limit(1000)
          );
        } else {
          // 无权限仓库，返回空查询
          setOrders([]);
          setLoading(false);
          return;
        }
      }
      
      const snap = await getDocs(q);
      const fetchedOrders = snap.docs.map(doc => ({ id: doc.id, ...(doc.data() as object) } as Order));
      
      setOrders(fetchedOrders);
    } catch (err) {
      console.error('Error fetching overdue orders:', err);
      handleFirestoreError(err, OperationType.GET, 'orders');
    } finally {
      setLoading(false);
    }
  };

  const processedOrders = useMemo(() => {
    const now = new Date();
    
    return orders
      .map(order => {
        // Calculation: CurrentDate - PaymentDate
        const paymentDate = order.paymentTime ? new Date(order.paymentTime) : new Date(order.createdTime);
        const diffTime = now.getTime() - paymentDate.getTime();
        const diffDays = Math.max(0, Math.floor(diffTime / (1000 * 60 * 60 * 24)));
        return { ...order, unclaimedDays: diffDays };
      })
      .filter(order => {
        // Search Filter
        const searchLower = searchTerm.toLowerCase();
        const matchesSearch = 
          order.bookingNumber.toLowerCase().includes(searchLower) ||
          order.customerName.toLowerCase().includes(searchLower) ||
          order.items.some(item => item.sku.toLowerCase().includes(searchLower));
        
        // Warehouse Filter
        const matchesWarehouse = warehouseFilter === 'All' || order.warehouseId === warehouseFilter;
        
        // Date Range Filter (Created Range)
        let matchesDateRange = true;
        if (startDate || endDate) {
          const createdDate = new Date(order.createdTime);
          if (startDate && createdDate < new Date(startDate)) matchesDateRange = false;
          if (endDate) {
            const end = new Date(endDate);
            end.setHours(23, 59, 59, 999);
            if (createdDate > end) matchesDateRange = false;
          }
        }

        // Overdue Threshold Filter
        let matchesThreshold = true;
        if (overdueThreshold === '14') matchesThreshold = order.unclaimedDays >= 14;
        if (overdueThreshold === '30') matchesThreshold = order.unclaimedDays >= 30;
        
        return matchesSearch && matchesWarehouse && matchesDateRange && matchesThreshold;
      })
      .sort((a, b) => b.unclaimedDays - a.unclaimedDays);
  }, [orders, searchTerm, warehouseFilter, startDate, endDate, overdueThreshold]);

  const stats = useMemo(() => {
    const total = processedOrders.length;
    const critical = processedOrders.filter(o => o.unclaimedDays >= 30).length;
    const potential = processedOrders.filter(o => o.unclaimedDays >= 14 && o.unclaimedDays < 30).length;
    return { total, critical, potential };
  }, [processedOrders]);

  const handleAddFollowUp = async () => {
    if (!activeOrder || !followUpContent.trim() || !profile) return;
    
    setSavingFollowUp(true);
    try {
      const orderRef = doc(db, 'orders', activeOrder.id!);
      const newLog: FollowUpLog = {
        timestamp: new Date().toISOString(),
        staffName: profile.name || user?.email || 'Unknown',
        content: followUpContent.trim()
      };

      await updateDoc(orderRef, {
        followUpLogs: arrayUnion(newLog)
      });

      await logAction(profile, 'Audit Follow-up', `Added follow-up for order ${activeOrder.bookingNumber || activeOrder.id}: ${newLog.content}`, activeOrder.id, 'Audit');

      // Update local state
      setOrders(prev => prev.map(o => o.id === activeOrder.id 
        ? { ...o, followUpLogs: [...(o.followUpLogs || []), newLog] } 
        : o
      ));
      
      // Update active order to show new log
      setActiveOrder(prev => prev ? { ...prev, followUpLogs: [...(prev.followUpLogs || []), newLog] } : null);
      setFollowUpContent('');
    } catch (err) {
      console.error('Error adding follow-up:', err);
      alert('Failed to save follow-up record.');
    } finally {
      setSavingFollowUp(false);
    }
  };

  const handleAuditClose = async () => {
    if (!selectedOrderForAudit || !reason) {
      alert('Please select a reason for closure.');
      return;
    }

    if (!profile || !user) {
      alert('Authentication error. Please refresh and try again.');
      return;
    }
    
    setSubmitting(true);
    try {
      const auditLog: AuditLog = {
        closed_by: profile.name || user.username,
        closed_at: new Date().toISOString(),
        reason: reason as AuditLog['reason']
      };

      const trimmedNote = note.trim();
      if (trimmedNote) {
        auditLog.note = trimmedNote;
      }

      // Call Backend API instead of direct Firestore update
      const response = await fetch('/api/v2/orders/audit', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': localStorage.getItem('x-v2-auth-token') || ''
        },
        body: JSON.stringify({
          orderId: selectedOrderForAudit.id,
          auditLog
        })
      });

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'Failed to audit order');
      }

      // Remove from local state
      setOrders(prev => prev.filter(o => o.id !== selectedOrderForAudit.id));
      
      setSelectedOrderForAudit(null);
      setReason('');
      setNote('');
      if (activeOrder?.id === selectedOrderForAudit.id) setActiveOrder(null);
      
      alert(isCnRoute ? '订单已完成审核并关闭。' : 'Order successfully audited and closed.');
    } catch (err: any) {
      console.error('Error closing order:', err);
      const errorMessage = err.message || (isCnRoute ? '未知错误' : 'Unknown error');
      alert(isCnRoute ? `关闭订单失败：${errorMessage}` : `Failed to close order: ${errorMessage}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex-1 flex flex-row min-w-0 bg-slate-50 overflow-hidden relative">
      <div className="flex-1 flex flex-col min-w-0">
        <PageHeader
          compact={isCnRoute}
          title={isCnRoute ? "超期订单审核" : "Overdue Audit"}
          subtitle={isCnRoute ? undefined : "Aging Order Management"}
          icon={Clock}
          isScrolled={isScrolled}
          actions={
            <>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input
                  type="text"
                  placeholder={isCnRoute ? "搜索..." : "Search..."}
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="pl-10 pr-4 py-2 bg-slate-100 border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500 rounded-xl text-sm w-48 transition-all outline-none"
                />
              </div>
              <select
                value={warehouseFilter}
                onChange={(e) => setWarehouseFilter(e.target.value)}
                className="bg-slate-100 border-transparent focus:bg-white focus:ring-2 focus:ring-indigo-500 rounded-xl text-sm px-4 py-2 outline-none transition-all font-bold text-slate-600"
              >
                <option value="All">{isCnRoute ? '全部仓库' : 'All Warehouses'}</option>
                <option value="AKL">AKL</option>
                <option value="CHC">CHC</option>
              </select>
              <button 
                onClick={fetchOverdueOrders}
                className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
                title={isCnRoute ? "刷新" : "Refresh"}
              >
                <Loader2 className={cn("w-5 h-5", loading && "animate-spin")} />
              </button>
              <button 
                onClick={() => window.location.href = '/logs?category=Audit'}
                className="flex items-center gap-2 px-4 py-2 bg-amber-50 text-amber-600 border border-amber-100 rounded-xl hover:bg-amber-100 transition-all text-sm font-bold shadow-sm active:scale-95"
                title={isCnRoute ? "查看审核历史" : "View Audit History"}
              >
                <HistoryIcon className="w-4 h-4" />
                {isCnRoute ? '审核历史' : 'Audit History'}
              </button>
            </>
          }
        />

        <div className="flex-1 overflow-y-auto p-4 md:p-8">
          <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
          <div className="max-w-[1600px] mx-auto space-y-8">
            {/* Advanced Filters */}
            <div className="flex flex-wrap items-center gap-4 border-b border-slate-100 pb-4">
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{isCnRoute ? '创建日期范围：' : 'Created Range:'}</span>
              <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="bg-transparent border-none text-xs font-bold text-slate-600 focus:ring-0 px-2 py-1"
                />
                <span className="text-slate-300">-</span>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="bg-transparent border-none text-xs font-bold text-slate-600 focus:ring-0 px-2 py-1"
                />
                {(startDate || endDate) && (
                  <button onClick={() => { setStartDate(''); setEndDate(''); }} className="p-1 hover:bg-slate-200 rounded-full">
                    <X className="w-3 h-3 text-slate-400" />
                  </button>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">{isCnRoute ? '超期层级：' : 'Aging Depth:'}</span>
              <div className="flex bg-slate-100 p-1 rounded-xl gap-1">
                <button
                  onClick={() => setOverdueThreshold('all')}
                  className={cn(
                    "px-3 py-1 rounded-lg text-xs font-bold transition-all",
                    overdueThreshold === 'all' ? "bg-white text-slate-900 shadow-sm" : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  {isCnRoute ? '全部' : 'All'}
                </button>
                <button
                  onClick={() => setOverdueThreshold('14')}
                  className={cn(
                    "px-3 py-1 rounded-lg text-xs font-bold transition-all",
                    overdueThreshold === '14' ? "bg-amber-500 text-white shadow-sm" : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  {isCnRoute ? '> 14天' : '> 14 Days'}
                </button>
                <button
                  onClick={() => setOverdueThreshold('30')}
                  className={cn(
                    "px-3 py-1 rounded-lg text-xs font-bold transition-all",
                    overdueThreshold === '30' ? "bg-red-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-600"
                  )}
                >
                  {isCnRoute ? '> 30天' : '> 30 Days'}
                </button>
              </div>
            </div>
          </div>

        {/* Summary Bar */}
        <div className="bg-slate-900 text-white px-6 py-3 flex items-center gap-8 flex-shrink-0">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-indigo-400" />
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{isCnRoute ? '超期总数：' : 'Total Overdue:'}</span>
            <span className="text-lg font-black">{stats.total}</span>
          </div>
          <div className="flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-red-500" />
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{isCnRoute ? '严重(30+)：' : 'Critical (30+):'}</span>
            <span className="text-lg font-black text-red-500">{stats.critical}</span>
          </div>
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-500" />
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{isCnRoute ? '预警(14+)：' : 'Potential (14+):'}</span>
            <span className="text-lg font-black text-amber-500">{stats.potential}</span>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-64">
              <Loader2 className="w-8 h-8 text-indigo-600 animate-spin mb-4" />
              <p className="text-slate-500">{isCnRoute ? '正在处理超期数据...' : 'Processing aging data...'}</p>
            </div>
          ) : processedOrders.length === 0 ? (
            <div className="bg-white rounded-3xl border border-slate-200 border-dashed p-16 text-center">
              <div className="w-20 h-20 bg-emerald-50 text-emerald-500 rounded-full flex items-center justify-center mx-auto mb-6">
                <CheckCircle2 className="w-10 h-10" />
              </div>
              <h3 className="text-xl font-black text-slate-900">{isCnRoute ? '当前无超期订单' : 'Queue Cleared'}</h3>
              {!isCnRoute && <p className="mt-2 text-slate-500">No orders match the current overdue criteria.</p>}
            </div>
          ) : (
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
              {processedOrders.map((order) => (
                <motion.div 
                  layout
                  key={order.id}
                  onClick={() => setActiveOrder(order)}
                  className={cn(
                    "bg-white rounded-3xl border-2 transition-all shadow-sm hover:shadow-xl p-6 flex flex-col gap-5 cursor-pointer group relative overflow-hidden",
                    order.unclaimedDays >= 30 ? "border-red-100 hover:border-red-500" : 
                    order.unclaimedDays >= 14 ? "border-amber-100 hover:border-amber-500" : 
                    "border-slate-100 hover:border-indigo-500",
                    activeOrder?.id === order.id && "ring-2 ring-indigo-500 ring-offset-2"
                  )}
                >
                  {/* Background Accent */}
                  <div className={cn(
                    "absolute top-0 right-0 w-32 h-32 -mr-16 -mt-16 rounded-full opacity-5 transition-all group-hover:scale-150",
                    order.unclaimedDays >= 30 ? "bg-red-600" : 
                    order.unclaimedDays >= 14 ? "bg-amber-500" : 
                    "bg-indigo-600"
                  )} />

                  <div className="flex items-start justify-between relative z-10">
                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <span className="text-xl font-black text-slate-900 tracking-tighter">{order.bookingNumber}</span>
                        <span className={cn(
                          "text-[10px] font-black px-2.5 py-1 rounded-lg uppercase tracking-wider shadow-sm",
                          order.unclaimedDays >= 30 ? "bg-red-600 text-white" :
                          order.unclaimedDays >= 14 ? "bg-amber-500 text-white" :
                          "bg-slate-100 text-slate-600"
                        )}>
                          Unclaimed for {order.unclaimedDays} Days
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs font-bold text-slate-400 uppercase tracking-widest">
                        <span className="text-slate-900">{order.customerName}</span>
                        <span>•</span>
                        <span className="flex items-center gap-1">
                          <MapPin className="w-3 h-3" />
                          {order.warehouseId}
                        </span>
                      </div>
                    </div>
                    
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedOrderForAudit(order);
                      }}
                      className="bg-slate-900 text-white px-5 py-2.5 rounded-2xl text-xs font-black hover:bg-slate-800 transition-all shadow-lg shadow-slate-200 active:scale-95 flex items-center gap-2"
                    >
                      Close Order
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4 relative z-10">
                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Order Items</p>
                      <div className="space-y-1.5">
                        {order.items.slice(0, 2).map((item, idx) => (
                          <div key={idx} className="flex items-center justify-between text-xs">
                            <span className="font-mono font-bold text-slate-600 truncate max-w-[100px]">{item.sku}</span>
                            <span className="font-black text-slate-900">x{item.qty}</span>
                          </div>
                        ))}
                        {order.items.length > 2 && (
                          <p className="text-[10px] text-slate-400 font-bold italic">+{order.items.length - 2} more items</p>
                        )}
                      </div>
                    </div>

                    <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100 flex flex-col justify-between">
                      <div>
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">Payment Info</p>
                        <p className="text-xs font-bold text-slate-900">{formatDate(order.paymentTime || order.createdTime, 'MMM d, yyyy')}</p>
                        <p className="text-[10px] text-slate-500">{order.paymentMethod || 'Paid'}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <MessageSquare className="w-3.5 h-3.5 text-indigo-500" />
                        <span className="text-[10px] font-black text-indigo-600 uppercase">
                          {order.followUpLogs?.length || 0} Logs
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-[10px] text-slate-400 font-black uppercase tracking-widest pt-2 border-t border-slate-50 relative z-10">
                    <div className="flex items-center gap-1.5">
                      <Calendar className="w-3.5 h-3.5" />
                      Created: {formatDate(order.createdTime, 'yyyy-MM-dd')}
                    </div>
                    <div className="flex items-center gap-1.5">
                      Ref: {order.refNumber}
                    </div>
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>

      {/* Side Panel: Follow-up Logs */}
      <AnimatePresence>
        {activeOrder && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setActiveOrder(null)}
              className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-40"
            />
            <motion.div
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed top-0 right-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col"
            >
              <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
                <div>
                  <h3 className="text-xl font-black text-slate-900">{activeOrder.bookingNumber}</h3>
                  <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Follow-up History</p>
                </div>
                <button onClick={() => setActiveOrder(null)} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-6 space-y-6">
                {/* Order Summary in Panel */}
                <div className="bg-indigo-50 rounded-2xl p-4 border border-indigo-100">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-white rounded-xl flex items-center justify-center shadow-sm">
                      <User className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div>
                      <p className="text-sm font-black text-slate-900">{activeOrder.customerName}</p>
                      <p className="text-[10px] font-bold text-indigo-600 uppercase">{activeOrder.customerId}</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                    <div>
                      <p className="mb-1">Phone/Email</p>
                      <p className="text-slate-900 lowercase">{activeOrder.customerEmail || 'No Email'}</p>
                    </div>
                    <div>
                      <p className="mb-1">Total Amount</p>
                      <p className="text-slate-900">${(activeOrder.totalAmount || 0).toFixed(2)}</p>
                    </div>
                  </div>
                </div>

                {/* Logs List */}
                <div className="space-y-4">
                  <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2">
                    <HistoryIcon className="w-4 h-4" />
                    Timeline
                  </h4>
                  {(!activeOrder.followUpLogs || activeOrder.followUpLogs.length === 0) ? (
                    <div className="text-center py-12 bg-slate-50 rounded-3xl border border-slate-100 border-dashed">
                      <MessageSquare className="w-8 h-8 text-slate-200 mx-auto mb-2" />
                      <p className="text-xs font-bold text-slate-400 uppercase">No records yet</p>
                    </div>
                  ) : (
                    <div className="space-y-4 relative before:absolute before:left-4 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-100">
                      {activeOrder.followUpLogs.map((log, idx) => (
                        <div key={idx} className="relative pl-10">
                          <div className="absolute left-3 top-1.5 w-2.5 h-2.5 rounded-full bg-indigo-500 ring-4 ring-white" />
                          <div className="bg-slate-50 rounded-2xl p-4 border border-slate-100">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-[10px] font-black text-slate-900 uppercase">{log.staffName}</span>
                              <span className="text-[10px] font-bold text-slate-400">{formatDate(log.timestamp, 'MMM d, HH:mm')}</span>
                            </div>
                            <p className="text-sm text-slate-600 leading-relaxed">{log.content}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* Add Log Input */}
              <div className="p-6 border-t border-slate-100 bg-slate-50">
                <div className="relative">
                  <textarea
                    value={followUpContent}
                    onChange={(e) => setFollowUpContent(e.target.value)}
                    placeholder="Type follow-up notes here..."
                    className="w-full bg-white border border-slate-200 rounded-2xl px-4 py-3 pr-12 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all min-h-[100px] resize-none shadow-sm"
                  />
                  <button
                    onClick={handleAddFollowUp}
                    disabled={!followUpContent.trim() || savingFollowUp}
                    className="absolute bottom-3 right-3 p-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all disabled:opacity-50 shadow-lg shadow-indigo-200"
                  >
                    {savingFollowUp ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>

      {/* Audit Modal */}
      {selectedOrderForAudit && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-[2.5rem] w-full max-w-md shadow-2xl overflow-hidden animate-in fade-in zoom-in duration-200">
            <div className="px-8 py-6 border-b border-slate-100 flex items-center justify-between bg-slate-50">
              <div>
                <h3 className="text-xl font-black text-slate-900">Final Audit Closure</h3>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-1">Order: {selectedOrderForAudit.bookingNumber}</p>
              </div>
              <button onClick={() => setSelectedOrderForAudit(null)} className="p-2 hover:bg-slate-200 rounded-full transition-colors">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            
            <div className="p-8 space-y-6">
              <div className="bg-red-50 border border-red-100 rounded-2xl p-5 flex gap-4">
                <AlertTriangle className="w-6 h-6 text-red-600 flex-shrink-0" />
                <div className="text-xs text-red-800 leading-relaxed">
                  <p className="font-black mb-1 uppercase tracking-wider">Irreversible Action</p>
                  <p>Closing this order will mark it as <span className="font-black">Reviewed</span> and remove it from all active queues. This requires mandatory attribution.</p>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
                  Closure Reason <span className="text-red-500">*</span>
                </label>
                <select
                  value={reason}
                  onChange={(e) => setReason(e.target.value as any)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-4 text-sm font-bold text-slate-700 focus:ring-2 focus:ring-indigo-500 outline-none transition-all appearance-none cursor-pointer"
                  required
                >
                  <option value="">Select a reason...</option>
                  <option value="Staff Missed Click">Staff Missed Click (Already collected)</option>
                  <option value="Stock Missing">Stock Missing (Lost/Damaged)</option>
                  <option value="Abandoned by Customer">Abandoned by Customer (Unclaimed)</option>
                  <option value="Other">Other (Specify in notes)</option>
                </select>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black text-slate-400 uppercase tracking-widest ml-1">
                  Internal Notes
                </label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Provide context for this audit decision..."
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-5 py-4 text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none transition-all min-h-[120px] resize-none"
                />
              </div>
            </div>

            <div className="px-8 py-6 bg-slate-50 border-t border-slate-100 flex gap-4">
              <button
                onClick={() => setSelectedOrderForAudit(null)}
                className="flex-1 px-6 py-4 bg-white border border-slate-200 text-slate-600 rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-100 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleAuditClose}
                disabled={!reason || submitting}
                className="flex-1 px-6 py-4 bg-slate-900 text-white rounded-2xl font-black text-xs uppercase tracking-widest hover:bg-slate-800 transition-all shadow-xl shadow-slate-200 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Confirm Audit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  </div>
);
};
