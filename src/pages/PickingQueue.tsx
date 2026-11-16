import type { QuerySnapshot, DocumentData } from 'firebase/firestore';
import { startWorkPolling, subscribeDuringWorkHours } from '../lib/workHours';
import React, { useEffect, useState, useMemo } from 'react';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, getDocs,
  doc, 
  updateDoc, 
  serverTimestamp,
  orderBy
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { CounterPickup, Order, OrderItem, WarehouseStatus, PickingLog } from '../types';
import { 
  ShoppingCart, 
  Package, 
  MapPin, 
  CheckCircle2, 
  Clock, 
  AlertTriangle,
  Play,
  Search,
  Filter,
  ArrowUpDown,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  History as HistoryIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn, formatDate, logAction } from '../utils';

interface PickingTask {
  sku: string;
  productName: string;
  location: string;
  totalQty: number;
  orders: {
    id: string;
    bookingNumber: string;
    qty: number;
    status: string;
    warehouseStatus: string;
    pickerId?: string | null;
  }[];
}

import { PageHeader } from '../components/PageHeader';

export const PickingQueue: React.FC = () => {
  const { profile, activeWarehouse, token } = useAuth();
  const [orders, setOrders] = useState<Order[]>([]);
  const [counterPickups, setCounterPickups] = useState<CounterPickup[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('All');
  const [expandedTasks, setExpandedTasks] = useState<string[]>([]);
  const [updatingIds, setUpdatingIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<'location' | 'order'>(() => {
    return (localStorage.getItem('pickingQueueTab') as 'location' | 'order') || 'location';
  });

  const [isScrolled, setIsScrolled] = useState(false);
  const sentinelRef = React.useRef<HTMLDivElement>(null);

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
    localStorage.setItem('pickingQueueTab', activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!activeWarehouse) return;

    const q = query(
      collection(db, 'orders'),
      where('warehouseId', '==', activeWarehouse),
      where('warehouseStatus', 'in', ['Pending', 'Picking', 'Picked'])
    );

    const applySnapshot = (snapshot: QuerySnapshot<DocumentData>) => {
      const ordersData = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as Order[];

      const activeOrders = ordersData.filter(order => {
        const isFullyDone = order.status === 'Picked Up' && order.warehouseStatus === 'Picked';
        const isCancelled = order.status === 'Cancelled';
        const isReviewed = order.status === 'Reviewed';
        return !isFullyDone && !isCancelled && !isReviewed;
      });

      setOrders(activeOrders);
      setLoading(false);
    };
    const loadError = (error: unknown) => {
      console.error('Could not load picking orders:', error);
      setLoading(false);
    };
    return subscribeDuringWorkHours('nz', () => onSnapshot(q, applySnapshot, loadError), async () => {
      try { applySnapshot(await getDocs(q)); } catch (error) { loadError(error); }
    });
  }, [activeWarehouse]);

  useEffect(() => {
    if (!activeWarehouse || !token) return;

    let stopped = false;
    const loadCounterPickups = async () => {
      try {
        const response = await fetch('/api/counter-pickups/list?view=active&limit=200', {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse
          }
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to load counter pickups');
        }
        if (stopped) return;
        const activeQueueItems = ((data.requests || []) as CounterPickup[]).filter((item) =>
          item.status === 'PendingPick' || item.status === 'Picked'
        );
        setCounterPickups(activeQueueItems);
      } catch (err) {
        console.error('Error loading counter pickups for queue:', err);
      }
    };

    const stopPolling = startWorkPolling({ site: 'nz', interval: 15_000, load: loadCounterPickups, loadOnMount: true, whileHidden: false });
    return () => {
      stopped = true;
      stopPolling();
    };
  }, [activeWarehouse, token]);

  const locationTasks = useMemo(() => {
    const taskMap = new Map<string, PickingTask>();

    orders.forEach(order => {
      order.items.forEach(item => {
        const key = `${item.sku}-${item.location || 'No Location'}`;
        if (!taskMap.has(key)) {
          taskMap.set(key, {
            sku: item.sku,
            productName: item.productName || 'Unknown Product',
            location: item.location || 'No Location',
            totalQty: 0,
            orders: []
          });
        }

        const task = taskMap.get(key)!;
        task.totalQty += item.qty;
        task.orders.push({
          id: order.id!,
          bookingNumber: order.bookingNumber,
          qty: item.qty,
          status: order.status,
          warehouseStatus: item.status === 'Picked' ? 'Picked' : (order.warehouseStatus || 'Pending'),
          pickerId: order.pickingLog?.pickerId || null
        });
      });
    });

    return Array.from(taskMap.values()).sort((a, b) => {
      return a.location.localeCompare(b.location, undefined, { numeric: true, sensitivity: 'base' });
    });
  }, [orders]);

  const orderTasks = useMemo(() => {
    return orders.map(order => {
      const totalItems = order.items.length;
      const pickedItems = order.items.filter(i => i.status === 'Picked').length;
      return {
        id: order.id!,
        bookingNumber: order.bookingNumber,
        createdTime: order.createdTime,
        status: order.status,
        warehouseStatus: order.warehouseStatus || 'Pending',
        pickerId: order.pickingLog?.pickerId || null,
        pickerName: order.pickingLog?.pickerName || null,
        totalItems,
        pickedItems,
        items: order.items
      };
    }).sort((a, b) => new Date(b.createdTime).getTime() - new Date(a.createdTime).getTime());
  }, [orders]);

  const filteredLocationTasks = locationTasks.filter(task => {
    const matchesSearch = 
      task.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.productName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.location.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.orders.some(o => o.bookingNumber.toLowerCase().includes(searchTerm.toLowerCase()));

    if (statusFilter === 'All') return matchesSearch;
    if (statusFilter === 'Pending') return matchesSearch && task.orders.some(o => o.warehouseStatus === 'Pending');
    if (statusFilter === 'Picking') return matchesSearch && task.orders.some(o => o.warehouseStatus === 'Picking');
    if (statusFilter === 'Picked') return matchesSearch && task.orders.every(o => o.warehouseStatus === 'Picked');
    
    return matchesSearch;
  });

  const filteredOrderTasks = orderTasks.filter(task => {
    const matchesSearch = 
      task.bookingNumber.toLowerCase().includes(searchTerm.toLowerCase()) ||
      task.items.some(i => i.sku.toLowerCase().includes(searchTerm.toLowerCase()) || i.productName?.toLowerCase().includes(searchTerm.toLowerCase()));

    if (statusFilter === 'All') return matchesSearch;
    if (statusFilter === 'Pending') return matchesSearch && task.warehouseStatus === 'Pending';
    if (statusFilter === 'Picking') return matchesSearch && task.warehouseStatus === 'Picking';
    if (statusFilter === 'Picked') return matchesSearch && task.warehouseStatus === 'Picked';
    
    return matchesSearch;
  });

  const counterStats = useMemo(() => {
    const todayKey = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const createdToday = counterPickups.filter((item) => {
      const createdKey = item.createdAt
        ? new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Pacific/Auckland',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
          }).format(new Date(item.createdAt))
        : '';
      return createdKey === todayKey;
    }).length;

    return {
      createdToday,
      pending: counterPickups.filter((item) => item.status === 'PendingPick').length,
      ready: counterPickups.filter((item) => item.status === 'Picked').length,
      putback: counterPickups.filter((item) => item.status === 'PendingPutback').length,
      finalized: counterPickups.filter((item) => item.status === 'Finalized').length
    };
  }, [counterPickups]);

  const counterPickupRequests = useMemo(
    () => counterPickups.filter((item) => (item.requestType || 'counterPickup') === 'counterPickup'),
    [counterPickups]
  );

  const scheduledDeliveryRequests = useMemo(
    () => counterPickups.filter((item) => item.requestType === 'scheduledDelivery'),
    [counterPickups]
  );

  const getQueueDisplayItems = (item: CounterPickup) => {
    const putbackItems = Array.isArray((item as any).putbackItems) ? (item as any).putbackItems : [];
    if (item.status === 'PendingPutback' && putbackItems.length > 0) {
      return putbackItems;
    }

    const sourceItems = item.items?.length
      ? item.items
      : [{ sku: item.sku, productName: item.productName, location: item.location, qty: item.qty, destination: item.destination }];

    if (item.status === 'PendingPutback') {
      return sourceItems.filter((entry: any) => (entry.destination || item.destination) === 'Returned');
    }

    return sourceItems;
  };

  const getQueueDisplayQty = (item: CounterPickup) => {
    const displayItems = getQueueDisplayItems(item);
    const displayQty = displayItems.reduce((sum, entry: any) => sum + (Number(entry.qty) || 0), 0);
    if (displayQty > 0) return displayQty;
    return item.status === 'PendingPutback' ? Number((item as any).putbackQty || item.qty || 0) : (displayQty || item.qty);
  };

  const handleUpdateItemStatus = async (orderId: string, sku: string, status: 'Pending' | 'Picked') => {
    if (!profile) return;
    const updateKey = `${orderId}-${sku}`;
    setUpdatingIds(prev => [...prev, updateKey]);

    try {
      const response = await fetch('/api/orders/item-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ orderId, sku, status })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to update item status');
      }
      
      logAction(profile, 'Update Item Status', `Set ${sku} to ${status} for order ${orderId}`, orderId, 'Picking');
    } catch (err: any) {
      console.error('Error updating item status:', err);
      alert(`Error: ${err.message}`);
    } finally {
      setUpdatingIds(prev => prev.filter(id => id !== updateKey));
    }
  };

  const handleStartPicking = async (orderIds: string[]) => {
    if (!profile) return;
    setUpdatingIds(prev => [...prev, ...orderIds]);

    try {
      const promises = orderIds.map(async (id) => {
        const order = orders.find(o => o.id === id);
        if (order?.warehouseStatus !== 'Pending') return;

        const response = await fetch('/api/orders/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-v2-auth-token': `Bearer ${token}`
          },
          body: JSON.stringify({
            orderId: id,
            updateData: {
              warehouseStatus: 'Picking',
              'pickingLog.startedAt': new Date().toISOString(),
              'pickingLog.pickerId': profile.uid,
              'pickingLog.pickerName': profile.name
            }
          })
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to update order');
        }
      });

      await Promise.all(promises);
      logAction(profile, 'Start Picking', `Started picking for orders: ${orderIds.join(', ')}`, null, 'Picking');
    } catch (err: any) {
      console.error('Error starting picking:', err);
      alert(`Error: ${err.message}`);
    } finally {
      setUpdatingIds(prev => prev.filter(id => !orderIds.includes(id)));
    }
  };

  const handleMarkAsPicked = async (orderIds: string[]) => {
    if (!profile) return;
    setUpdatingIds(prev => [...prev, ...orderIds]);

    try {
      const promises = orderIds.map(async (id) => {
        const response = await fetch('/api/orders/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-v2-auth-token': `Bearer ${token}`
          },
          body: JSON.stringify({
            orderId: id,
            updateData: {
              warehouseStatus: 'Picked',
              'pickingLog.finishedAt': new Date().toISOString()
            }
          })
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Failed to update order');
        }
      });

      await Promise.all(promises);
      logAction(profile, 'Mark as Picked', `Marked orders as picked: ${orderIds.join(', ')}`, null, 'Picking');
    } catch (err: any) {
      console.error('Error marking as picked:', err);
      alert(`Error: ${err.message}`);
    } finally {
      setUpdatingIds(prev => prev.filter(id => !orderIds.includes(id)));
    }
  };

  const handleReportIssue = async (orderId: string, bookingNumber: string) => {
    if (!profile) return;
    const issue = window.prompt(`Report inventory issue for Order ${bookingNumber}:`);
    if (!issue) return;

    try {
      await updateDoc(doc(db, 'orders', orderId), {
        'pickingLog.inventoryIssue': issue,
        'pickingLog.issueReportedAt': new Date().toISOString()
      });
      logAction(profile, 'Report Inventory Issue', `Reported issue for ${bookingNumber}: ${issue}`, orderId, 'Picking');
    } catch (err) {
      console.error('Error reporting issue:', err);
    }
  };

  const toggleExpand = (key: string) => {
    setExpandedTasks(prev => 
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  const handleCounterStartPicking = async (requestId: string) => {
    if (!token) return;
    setUpdatingIds(prev => [...prev, requestId]);
    try {
      const response = await fetch(`/api/counter-pickups/${requestId}/start-picking`, {
        method: 'POST',
        headers: {
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        }
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to start picking');
      }
      setCounterPickups(prev => prev.map((item) => item.id === requestId ? { ...item, queueStatus: 'Picking' } : item));
    } catch (err: any) {
      alert(err.message || 'Failed to start picking');
    } finally {
      setUpdatingIds(prev => prev.filter(id => id !== requestId));
    }
  };

  const handleCounterMarkPicked = async (requestId: string) => {
    if (!token) return;
    setUpdatingIds(prev => [...prev, requestId]);
    try {
      const response = await fetch(`/api/counter-pickups/${requestId}/mark-picked`, {
        method: 'POST',
        headers: {
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        }
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Failed to mark picked');
      }
      setCounterPickups(prev => prev.map((item) =>
        item.id === requestId ? { ...item, status: 'Picked', queueStatus: 'Picked' } : item
      ));
    } catch (err: any) {
      alert(err.message || 'Failed to mark picked');
    } finally {
      setUpdatingIds(prev => prev.filter(id => id !== requestId));
    }
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-hidden">
      <PageHeader
        title="Picking Queue"
        subtitle={`Active tasks for ${activeWarehouse || 'Selected Warehouse'}`}
        icon={ShoppingCart}
        isScrolled={isScrolled}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
              <button
                onClick={() => setActiveTab('location')}
                className={cn(
                  "text-[10px] font-black px-3 py-1.5 rounded-lg transition-all uppercase tracking-wider",
                  activeTab === 'location' 
                    ? "bg-white text-indigo-600 shadow-sm" 
                    : "text-slate-500 hover:bg-slate-200/50"
                )}
              >
                By Loc
              </button>
              <button
                onClick={() => setActiveTab('order')}
                className={cn(
                  "text-[10px] font-black px-3 py-1.5 rounded-lg transition-all uppercase tracking-wider",
                  activeTab === 'order' 
                    ? "bg-white text-purple-600 shadow-sm" 
                    : "text-slate-500 hover:bg-slate-200/50"
                )}
              >
                By Order
              </button>
            </div>
            <button 
              onClick={() => window.location.href = '/logs?category=Picking'}
              className="p-2 bg-slate-100 text-slate-500 rounded-xl hover:bg-slate-200 transition-all"
              title="Picking History"
            >
              <HistoryIcon className="w-4 h-4" />
            </button>
          </div>
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-5xl mx-auto space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Today New', value: counterStats.createdToday, tone: 'bg-indigo-50 text-indigo-700 border-indigo-100' },
              { label: 'Pending', value: counterStats.pending, tone: 'bg-slate-50 text-slate-700 border-slate-200' },
              { label: 'Ready', value: counterStats.ready, tone: 'bg-emerald-50 text-emerald-700 border-emerald-100' },
              { label: 'Putback', value: counterStats.putback, tone: 'bg-amber-50 text-amber-700 border-amber-100' },
              { label: 'Finalized', value: counterStats.finalized, tone: 'bg-rose-50 text-rose-700 border-rose-100' }
            ].map((stat) => (
              <div key={stat.label} className={cn('rounded-2xl border p-4 shadow-sm', stat.tone)}>
                <div className="text-[10px] uppercase tracking-wider font-bold opacity-80">{stat.label}</div>
                <div className="text-2xl font-black mt-1">{stat.value}</div>
              </div>
            ))}
          </div>

          <div className="bg-white p-4 rounded-2xl border border-slate-100 shadow-sm flex flex-col md:flex-row items-center gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                placeholder={activeTab === 'location' ? "SKU, Loc..." : "Order #, SKU..."}
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full md:w-48 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm font-bold"
            >
              <option value="All">All Status</option>
              <option value="Pending">Pending</option>
              <option value="Picking">Picking</option>
              <option value="Picked">Ready</option>
            </select>
          </div>

          {(counterPickupRequests.length > 0 || scheduledDeliveryRequests.length > 0) && (
            <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <AlertTriangle className="w-5 h-5 text-amber-600" />
                <h3 className="text-sm font-black text-amber-900 uppercase tracking-wider">Counter Pickup Priority</h3>
              </div>
              <div className="space-y-5">
                {counterPickupRequests.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full bg-amber-300 text-amber-950 text-[10px] font-black uppercase tracking-wider shadow-sm">
                        Counter Pickup
                      </span>
                      <span className="text-[11px] text-amber-800 font-semibold">Reception urgent requests</span>
                    </div>
                    {counterPickupRequests.map((item) => (
                  (() => {
                    const displayItems = getQueueDisplayItems(item);
                    if (item.status === 'PendingPutback' && displayItems.length === 0) return null;
                    const isPutbackTask = item.status === 'PendingPutback';
                    return (
                  <div
                    key={item.id}
                    className={cn(
                      "rounded-2xl p-4 flex flex-col md:flex-row md:items-center gap-4 border shadow-sm transition-all",
                      item.queueStatus === 'Picked' || isPutbackTask
                        ? "bg-emerald-50 border-emerald-300 ring-1 ring-emerald-200"
                        : "bg-white border-amber-100"
                    )}
                  >
                    <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                        <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-900 text-[10px] font-black uppercase tracking-wider">Counter Pickup</span>
                        <span className={cn(
                          "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider",
                          item.queueStatus === 'Pending'
                            ? "bg-slate-100 text-slate-700"
                            : item.queueStatus === 'Picking'
                              ? "bg-indigo-100 text-indigo-700"
                              : "bg-emerald-600 text-white shadow-sm"
                        )}>
                          {item.queueStatus === 'Picked' ? 'Ready' : item.queueStatus}
                        </span>
                        {item.status === 'PendingPutback' && (
                          <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold uppercase">
                            Putback Pending
                          </span>
                        )}
                        <span className="text-[10px] text-slate-400">{formatDate(item.createdAt, 'HH:mm')}</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400">Request</p>
                          <p className="text-sm font-bold text-slate-900">{item.id}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400">SKU</p>
                          <p className="text-sm font-black text-slate-900 break-words">{item.sku}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400">LOC</p>
                          <p className="text-sm font-black text-slate-900">{item.location}</p>
                        </div>
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-slate-400">QTY</p>
                          <p className="text-sm font-black text-slate-900">{getQueueDisplayQty(item)}</p>
                        </div>
                      </div>
                      <div className="mt-3 space-y-2">
                        {displayItems.map((entry, idx) => (
                          <div key={`${item.id}-${entry.sku}-${idx}`} className="rounded-2xl border border-amber-200 bg-gradient-to-r from-amber-50 to-white px-4 py-3 shadow-sm">
                            <div className="flex flex-col gap-2">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-amber-300 text-amber-950 text-[10px] font-black uppercase tracking-wider">
                                  Item {idx + 1}
                                </span>
                                <span className="text-base md:text-lg font-black text-slate-950 break-words tracking-tight">
                                  {entry.sku}
                                </span>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                <span className="inline-flex items-center px-3 py-1 rounded-xl bg-blue-100 text-blue-800 text-sm font-black tracking-wide border border-blue-200">
                                  Loc: {entry.location}
                                </span>
                                <span className="inline-flex items-center px-3 py-1 rounded-xl bg-slate-900 text-white text-sm font-black tracking-wide">
                                  Qty: {entry.qty}
                                </span>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                      {(item.pickupNote || item.comment) && (
                        <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                          <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Pickup Note</p>
                          <p className="text-sm text-slate-700 break-words">{item.pickupNote || item.comment}</p>
                        </div>
                      )}
                    </div>
                    <div className="flex gap-2">
                      {item.queueStatus === 'Pending' && (
                        <button
                          onClick={() => handleCounterStartPicking(item.id)}
                          disabled={updatingIds.includes(item.id)}
                          className="flex items-center justify-center bg-amber-600 text-white w-12 h-12 rounded-2xl font-bold hover:bg-amber-700 transition-all shadow-md disabled:opacity-50"
                          title="Start Picking"
                        >
                          {updatingIds.includes(item.id) ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <Play className="w-6 h-6 fill-current" />
                          )}
                        </button>
                      )}
                      {item.queueStatus === 'Picking' && (
                        <button
                          onClick={() => handleCounterMarkPicked(item.id)}
                          disabled={updatingIds.includes(item.id)}
                          className="flex items-center justify-center bg-amber-700 text-white w-12 h-12 rounded-2xl font-bold hover:bg-amber-800 transition-all shadow-md disabled:opacity-50"
                          title="Complete Picking"
                        >
                          {updatingIds.includes(item.id) ? (
                            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-6 h-6" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                    );
                  })()
                    ))}
                  </div>
                )}

                {scheduledDeliveryRequests.length > 0 && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2">
                      <span className="px-2.5 py-1 rounded-full bg-slate-200 text-slate-900 text-[10px] font-black uppercase tracking-wider shadow-sm">
                        Scheduled Delivery
                      </span>
                      <span className="text-[11px] text-slate-500 font-semibold">Warehouse delivery requests</span>
                    </div>
                    {scheduledDeliveryRequests.map((item) => (
                      (() => {
                        const displayItems = getQueueDisplayItems(item);
                        if (item.status === 'PendingPutback' && displayItems.length === 0) return null;
                        const isPutbackTask = item.status === 'PendingPutback';
                        return (
                      <div
                        key={item.id}
                        className={cn(
                          "rounded-2xl p-4 flex flex-col md:flex-row md:items-center gap-4 border shadow-sm transition-all",
                          item.queueStatus === 'Picked' || isPutbackTask
                            ? "bg-emerald-50 border-emerald-300 ring-1 ring-emerald-200"
                            : "bg-slate-50 border-slate-200"
                        )}
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2 mb-2">
                            <span className="px-2 py-0.5 rounded bg-slate-100 text-slate-800 text-[10px] font-black uppercase tracking-wider">Scheduled Delivery</span>
                            <span className={cn(
                              "px-2 py-0.5 rounded text-[10px] font-black uppercase tracking-wider",
                              item.queueStatus === 'Pending'
                                ? "bg-slate-200 text-slate-800"
                                : item.queueStatus === 'Picking'
                                  ? "bg-slate-500 text-white"
                                  : "bg-emerald-600 text-white shadow-sm"
                            )}>
                              {item.queueStatus === 'Picked' ? 'Ready' : item.queueStatus}
                            </span>
                            {item.status === 'PendingPutback' && (
                              <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-bold uppercase">
                                Putback Pending
                              </span>
                            )}
                            <span className="text-[10px] text-slate-400">{formatDate(item.createdAt, 'HH:mm')}</span>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-slate-400">Request</p>
                              <p className="text-sm font-bold text-slate-900">{item.id}</p>
                            </div>
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-slate-400">SKU</p>
                              <p className="text-sm font-black text-slate-900 break-words">{item.sku}</p>
                            </div>
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-slate-400">LOC</p>
                              <p className="text-sm font-black text-slate-900">{item.location}</p>
                            </div>
                            <div>
                              <p className="text-[10px] uppercase tracking-wider text-slate-400">QTY</p>
                              <p className="text-sm font-black text-slate-900">{getQueueDisplayQty(item)}</p>
                            </div>
                          </div>
                          <div className="mt-3 space-y-2">
                            {displayItems.map((entry, idx) => (
                              <div key={`${item.id}-${entry.sku}-${idx}`} className="rounded-2xl border border-slate-200 bg-gradient-to-r from-slate-50 to-white px-4 py-3 shadow-sm">
                                <div className="flex flex-col gap-2">
                                  <div className="flex items-center gap-2">
                                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-slate-200 text-slate-900 text-[10px] font-black uppercase tracking-wider">
                                      Item {idx + 1}
                                    </span>
                                    <span className="text-base md:text-lg font-black text-slate-950 break-words tracking-tight">
                                      {entry.sku}
                                    </span>
                                  </div>
                                  <div className="flex flex-wrap gap-2">
                                    <span className="inline-flex items-center px-3 py-1 rounded-xl bg-slate-200 text-slate-900 text-sm font-black tracking-wide border border-slate-300">
                                      Loc: {entry.location}
                                    </span>
                                    <span className="inline-flex items-center px-3 py-1 rounded-xl bg-slate-700 text-white text-sm font-black tracking-wide">
                                      Qty: {entry.qty}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            ))}
                          </div>
                          {(item.pickupNote || item.comment) && (
                            <div className="mt-3 rounded-xl bg-slate-50 border border-slate-200 px-3 py-2">
                              <p className="text-[10px] uppercase tracking-wider text-slate-400 mb-1">Pickup Note</p>
                              <p className="text-sm text-slate-700 break-words">{item.pickupNote || item.comment}</p>
                            </div>
                          )}
                        </div>
                        <div className="flex gap-2">
                          {item.queueStatus === 'Pending' && (
                            <button
                              onClick={() => handleCounterStartPicking(item.id)}
                              disabled={updatingIds.includes(item.id)}
                              className="flex items-center justify-center bg-slate-700 text-white w-12 h-12 rounded-2xl font-bold hover:bg-slate-800 transition-all shadow-md disabled:opacity-50"
                              title="Start Picking"
                            >
                              {updatingIds.includes(item.id) ? (
                                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <Play className="w-6 h-6 fill-current" />
                              )}
                            </button>
                          )}
                          {item.queueStatus === 'Picking' && (
                            <button
                              onClick={() => handleCounterMarkPicked(item.id)}
                              disabled={updatingIds.includes(item.id)}
                              className="flex items-center justify-center bg-slate-900 text-white w-12 h-12 rounded-2xl font-bold hover:bg-black transition-all shadow-md disabled:opacity-50"
                              title="Complete Picking"
                            >
                              {updatingIds.includes(item.id) ? (
                                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                              ) : (
                                <CheckCircle2 className="w-6 h-6" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                        );
                      })()
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'location' ? (
            filteredLocationTasks.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
                <Package className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-slate-900">No picking tasks found</h3>
                <p className="text-slate-500">All items are currently handled or no items match your search.</p>
              </div>
            ) : (
              filteredLocationTasks.map((task) => {
                const key = `${task.sku}-${task.location}`;
                const isExpanded = expandedTasks.includes(key);
                const allPicked = task.orders.every(o => o.warehouseStatus === 'Picked');
                
                return (
                  <motion.div
                    layout
                    key={key}
                    className={cn(
                      "bg-white rounded-2xl border transition-all overflow-hidden shadow-sm",
                      allPicked ? "border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200" : "border-slate-200 hover:border-indigo-200"
                    )}
                  >
                    <div className="p-4 flex items-center gap-4">
                      {/* Location Badge */}
                      <div className="flex-shrink-0 w-20 h-20 bg-blue-50 rounded-xl flex flex-col items-center justify-center border border-blue-100">
                        <MapPin className="w-4 h-4 text-blue-600 mb-1" />
                        <span className="text-lg font-black text-blue-700 tracking-tighter">{task.location}</span>
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded uppercase tracking-wider">
                            {task.sku}
                          </span>
                          {allPicked && (
                            <span className="flex items-center gap-1 text-[10px] font-black text-white bg-emerald-600 px-2 py-0.5 rounded uppercase shadow-sm">
                              <CheckCircle2 className="w-3 h-3" />
                              Ready
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 mt-1">
                          <div className="flex items-center gap-1 text-sm">
                            <Package className="w-4 h-4 text-slate-400" />
                            <span className="font-bold text-slate-900 text-lg">Qty: {task.totalQty}</span>
                          </div>
                          <div className="text-xs text-slate-400 font-medium">
                            {task.orders.length} Orders
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col items-end gap-2">
                        {!allPicked && (
                          <>
                            {task.orders.some(o => o.warehouseStatus === 'Pending') ? (
                              <button
                                onClick={() => {
                                  const pendingOrders = task.orders.filter(o => o.warehouseStatus === 'Pending');
                                  handleStartPicking(pendingOrders.map(o => o.id));
                                }}
                                disabled={task.orders.some(o => updatingIds.includes(o.id))}
                                className="flex items-center justify-center bg-indigo-600 text-white w-12 h-12 rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-md active:scale-95 disabled:opacity-50"
                              >
                                {task.orders.some(o => updatingIds.includes(o.id)) ? (
                                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <Play className="w-6 h-6 fill-current" />
                                )}
                              </button>
                            ) : (
                              <button
                                onClick={() => {
                                  const pickingOrders = task.orders.filter(o => o.warehouseStatus === 'Picking');
                                  pickingOrders.forEach(o => handleUpdateItemStatus(o.id, task.sku, 'Picked'));
                                }}
                                disabled={task.orders.some(o => updatingIds.includes(`${o.id}-${task.sku}`))}
                                className="flex items-center justify-center bg-emerald-600 text-white w-12 h-12 rounded-2xl font-bold hover:bg-emerald-700 transition-all shadow-md active:scale-95 disabled:opacity-50"
                              >
                                {task.orders.some(o => updatingIds.includes(`${o.id}-${task.sku}`)) ? (
                                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                ) : (
                                  <CheckCircle2 className="w-6 h-6" />
                                )}
                              </button>
                            )}
                          </>
                        )}
                        <button
                          onClick={() => toggleExpand(key)}
                          className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
                        >
                          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    {/* Expanded Order Details */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="border-t border-slate-100 bg-slate-50/50"
                        >
                          <div className="p-4 space-y-2">
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Associated Orders</h4>
                            {task.orders.map((order) => (
                              <div
                                key={order.id}
                                className={cn(
                                  "flex items-center justify-between p-3 rounded-xl border shadow-sm",
                                  order.warehouseStatus === 'Picked'
                                    ? "border-emerald-300 bg-emerald-50"
                                    : "border-slate-100 bg-white"
                                )}
                              >
                                <div className="flex items-center gap-4">
                                  <div className="flex flex-col">
                                    <span className="text-sm font-bold text-slate-900">{order.bookingNumber}</span>
                                    <span className="text-xs text-slate-500">Qty: {order.qty}</span>
                                  </div>
                                  <span className={cn(
                                    "text-[10px] font-bold px-2 py-0.5 rounded uppercase",
                                    order.warehouseStatus === 'Pending' ? "bg-slate-100 text-slate-600" :
                                    order.warehouseStatus === 'Picking' ? "bg-amber-100 text-amber-600" :
                                    "bg-emerald-600 text-white shadow-sm"
                                  )}>
                                    {order.warehouseStatus === 'Picked' ? 'Ready' : order.warehouseStatus}
                                  </span>
                                </div>
                                {order.warehouseStatus !== 'Picked' && (
                                  <>
                                    {order.warehouseStatus === 'Pending' ? (
                                      <button
                                        onClick={() => handleStartPicking([order.id])}
                                        disabled={updatingIds.includes(order.id)}
                                        className="flex items-center justify-center bg-indigo-50 text-indigo-600 w-10 h-10 rounded-xl border border-indigo-100 active:bg-indigo-100 transition-all disabled:opacity-50"
                                        title="Start Picking"
                                      >
                                        {updatingIds.includes(order.id) ? (
                                          <div className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                        ) : (
                                          <Play className="w-5 h-5 fill-current" />
                                        )}
                                      </button>
                                    ) : (
                                      <button
                                        onClick={() => handleUpdateItemStatus(order.id, task.sku, 'Picked')}
                                        disabled={updatingIds.includes(`${order.id}-${task.sku}`) || ((order as any).pickerId && (order as any).pickerId !== profile?.uid)}
                                        className="flex items-center justify-center bg-emerald-50 text-emerald-600 w-10 h-10 rounded-xl border border-emerald-100 active:bg-emerald-100 transition-all disabled:opacity-50"
                                        title="Complete Picking"
                                      >
                                        {updatingIds.includes(`${order.id}-${task.sku}`) ? (
                                          <div className="w-3 h-3 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                                        ) : (
                                          <CheckCircle2 className="w-5 h-5" />
                                        )}
                                      </button>
                                    )}
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })
            )
          ) : (
            filteredOrderTasks.length === 0 ? (
              <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
                <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-slate-900">No orders found</h3>
                <p className="text-slate-500">All orders are handled or no orders match your search.</p>
              </div>
            ) : (
              filteredOrderTasks.map((task) => {
                const isExpanded = expandedTasks.includes(task.id);
                const progress = (task.pickedItems / task.totalItems) * 100;
                
                return (
                  <motion.div
                    layout
                    key={task.id}
                    className={cn(
                      "bg-white rounded-2xl border transition-all overflow-hidden shadow-sm",
                      task.warehouseStatus === 'Picked' ? "border-emerald-300 bg-emerald-50 ring-1 ring-emerald-200" : "border-slate-200 hover:border-purple-200"
                    )}
                  >
                    <div className="p-4 flex items-center gap-4">
                      {/* Order ID Badge */}
                      <div className="flex-shrink-0 w-20 h-20 bg-purple-50 rounded-xl flex flex-col items-center justify-center border border-purple-100">
                        <ClipboardList className="w-4 h-4 text-purple-600 mb-1" />
                        <span className="text-lg font-black text-purple-700 tracking-tighter">{task.bookingNumber}</span>
                      </div>

                      {/* Order Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-2">
                          <span className={cn(
                            "text-[10px] font-bold px-2 py-0.5 rounded uppercase tracking-wider",
                            task.warehouseStatus === 'Pending' ? "bg-slate-100 text-slate-600" :
                            task.warehouseStatus === 'Picking' ? "bg-amber-100 text-amber-600" :
                            "bg-emerald-600 text-white shadow-sm"
                          )}>
                            {task.warehouseStatus === 'Picked' ? 'Ready' : task.warehouseStatus}
                          </span>
                          <span className="text-[10px] text-slate-400">{formatDate(task.createdTime, 'HH:mm')}</span>
                        </div>
                        
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-xs">
                            <span className="text-slate-900 font-bold">{task.pickedItems} / {task.totalItems} items</span>
                          </div>
                          <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${progress}%` }}
                              className={cn(
                                "h-full transition-all duration-500",
                                progress === 100 ? "bg-emerald-500" : "bg-purple-500"
                              )}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-col items-end gap-2">
                        {task.warehouseStatus === 'Pending' && (
                          <button
                            onClick={() => handleStartPicking([task.id])}
                            disabled={updatingIds.includes(task.id)}
                            className="flex items-center justify-center bg-indigo-600 text-white w-12 h-12 rounded-2xl font-bold hover:bg-indigo-700 transition-all shadow-md active:scale-95 disabled:opacity-50"
                          >
                            {updatingIds.includes(task.id) ? (
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <Play className="w-6 h-6 fill-current" />
                            )}
                          </button>
                        )}
                        {task.warehouseStatus === 'Picking' && (
                          <button
                            onClick={() => {
                              if (task.pickedItems === task.totalItems) handleMarkAsPicked([task.id]);
                            }}
                            disabled={updatingIds.includes(task.id) || task.pickedItems !== task.totalItems || (task as any).pickerId !== profile?.uid}
                            className="flex items-center justify-center bg-emerald-600 text-white w-12 h-12 rounded-2xl font-bold hover:bg-emerald-700 transition-all shadow-md active:scale-95 disabled:opacity-50"
                          >
                            {updatingIds.includes(task.id) ? (
                              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                            ) : (
                              <CheckCircle2 className="w-6 h-6" />
                            )}
                          </button>
                        )}
                        <button
                          onClick={() => toggleExpand(task.id)}
                          className="p-2 hover:bg-slate-100 rounded-xl transition-colors text-slate-400"
                        >
                          {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
                        </button>
                      </div>
                    </div>

                    {/* Expanded Item Details */}
                    <AnimatePresence>
                      {isExpanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="border-t border-slate-100 bg-slate-50/50"
                        >
                          <div className="p-4 space-y-2">
                            <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Order Items</h4>
                            {task.items.map((item) => (
                              <div
                                key={item.sku}
                                className={cn(
                                  "flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-xl border shadow-sm",
                                  item.status === 'Picked'
                                    ? "border-emerald-300 bg-emerald-50 ring-1 ring-emerald-100"
                                    : "border-slate-100 bg-white"
                                )}
                              >
                                <div className="flex items-center gap-4 min-w-0">
                                  <div className="w-10 h-10 bg-slate-50 rounded-lg flex items-center justify-center border border-slate-100">
                                    <MapPin className="w-4 h-4 text-slate-400" />
                                  </div>
                                  <div className="flex flex-col">
                                    <span className="text-sm font-black text-slate-900">{item.sku}</span>
                                    <div className="flex items-center gap-2 mt-0.5">
                                      <span className="text-[10px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">Loc: {item.location}</span>
                                      <span className="text-[10px] font-bold text-slate-600 bg-slate-100 px-1.5 py-0.5 rounded">Qty: {item.qty}</span>
                                    </div>
                                  </div>
                                </div>
                                <div className="flex items-center gap-2 sm:justify-end w-full sm:w-auto">
                                  {item.status === 'Picked' ? (
                                    <span className="flex items-center gap-1 text-[10px] font-black text-white bg-emerald-600 px-2 py-0.5 rounded uppercase shadow-sm">
                                      <CheckCircle2 className="w-3 h-3" />
                                      Picked
                                    </span>
                                  ) : (
                                    <>
                                      {task.warehouseStatus === 'Pending' ? (
                                        <button
                                          onClick={() => handleStartPicking([task.id])}
                                          disabled={updatingIds.includes(task.id)}
                                          className="inline-flex items-center justify-center gap-2 bg-indigo-600 text-white w-full sm:w-auto px-4 h-10 rounded-xl border border-indigo-700 active:bg-indigo-700 transition-all disabled:opacity-50 font-bold text-xs"
                                          title={`Start picking ${item.sku}`}
                                        >
                                          {updatingIds.includes(task.id) ? (
                                            <div className="w-3 h-3 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
                                          ) : (
                                            <>
                                              <Play className="w-4 h-4 fill-current" />
                                              <span className="whitespace-nowrap">Start</span>
                                            </>
                                          )}
                                        </button>
                                      ) : (
                                        <>
                                          <button
                                            onClick={() => handleReportIssue(task.id, task.bookingNumber)}
                                            className="text-[10px] font-bold text-slate-400 hover:text-red-600 transition-colors px-2 whitespace-nowrap"
                                          >
                                            Issue?
                                          </button>
                                          <button
                                            onClick={() => handleUpdateItemStatus(task.id, item.sku, 'Picked')}
                                            disabled={updatingIds.includes(`${task.id}-${item.sku}`)}
                                            className="inline-flex items-center justify-center gap-2 bg-emerald-600 text-white w-full sm:w-auto px-4 h-10 rounded-xl border border-emerald-700 active:bg-emerald-700 transition-all disabled:opacity-50 font-bold text-xs"
                                            title={`Mark ${item.sku} as picked`}
                                          >
                                            {updatingIds.includes(`${task.id}-${item.sku}`) ? (
                                              <div className="w-3 h-3 border-2 border-emerald-600 border-t-transparent rounded-full animate-spin" />
                                            ) : (
                                              <>
                                                <CheckCircle2 className="w-4 h-4" />
                                                <span className="whitespace-nowrap">Picked</span>
                                              </>
                                            )}
                                          </button>
                                        </>
                                      )}
                                    </>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </motion.div>
                );
              })
            )
          )}
        </div>
      </div>

      {/* Footer Info */}
      <div className="bg-white border-t border-slate-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-slate-200"></div>
            <span className="text-xs font-medium text-slate-500">Pending</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-amber-400"></div>
            <span className="text-xs font-medium text-slate-500">Picking</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-emerald-400"></div>
            <span className="text-xs font-medium text-slate-500">Ready</span>
          </div>
        </div>
        <div className="text-xs text-slate-400 font-medium">
          Showing {activeTab === 'location' ? filteredLocationTasks.length : filteredOrderTasks.length} {activeTab === 'location' ? 'tasks' : 'orders'} across {orders.length} orders
        </div>
      </div>
    </div>
  );
};
