import React, { useState, useEffect, useMemo, useRef } from 'react';
import { collection, query, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { Order } from '../types';
import { useAuth } from '../components/AuthProvider';
import { logAction, cn, safeSearch, formatDate, hasPermission, isAdmin, getWarehouseDisplayName } from '../utils';
import { 
  Search, 
  Download, 
  Calendar, 
  Filter, 
  ChevronRight,
  ShoppingBag,
  CheckCircle2,
  XCircle,
  FileText,
  AlertCircle,
  CheckCircle,
  MapPin,
  Mail,
  Send,
  MoreVertical,
  Plus,
  Upload,
  LayoutGrid,
  Table as TableIcon,
  Clock,
  CreditCard,
  Store as StoreIcon,
  Loader2,
  ShoppingCart
} from 'lucide-react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import { useClickOutside } from '../hooks/useClickOutside';
import { useOrderService } from '../hooks/useOrderService';
import { useDebounce } from '../hooks/useDebounce';
import { API_BASE_URL, CN_API_ONLY } from '../constants';
import { useTask } from '../components/TaskProvider';
import SignatureCanvas from 'react-signature-canvas';

import { PageHeader } from '../components/PageHeader';

const ORDER_CACHE_DB = 'mvp_orders_cache_v1';
const ORDER_CACHE_STORE = 'order_lists';
const ORDER_CACHE_TTL_MS = 60 * 1000;

type OrderCacheRecord = {
  key: string;
  orders: Order[];
  lastSyncAt: string;
  updatedAt: string;
};

const openOrderCacheDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(ORDER_CACHE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ORDER_CACHE_STORE)) {
        db.createObjectStore(ORDER_CACHE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const getOrderCache = async (key: string): Promise<OrderCacheRecord | null> => {
  try {
    const db = await openOrderCacheDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(ORDER_CACHE_STORE, 'readonly');
      const store = tx.objectStore(ORDER_CACHE_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve((req.result as OrderCacheRecord) || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
};

const setOrderCache = async (record: OrderCacheRecord): Promise<void> => {
  try {
    const db = await openOrderCacheDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(ORDER_CACHE_STORE, 'readwrite');
      const store = tx.objectStore(ORDER_CACHE_STORE);
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Best-effort cache
  }
};

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

export const Orders = () => {
  const { profile, user, activeWarehouse, token } = useAuth();
  const { bulkUpdateStatus } = useOrderService(token, API_BASE_URL);
  const { taskProgress, setTaskProgress, isMinimized, setIsMinimized, isTaskRunning, setIsTaskRunning } = useTask();
  const location = useLocation();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const debouncedSearchTerm = useDebounce(searchTerm, 500);
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const normalizeStatusFilter = (value?: string) => {
    if (!value) return 'Active';
    if (value === 'All Orders') return 'All';
    if (value === 'Active Orders') return 'Active';
    const allowed = ['Active', 'All', 'Overdue', 'Created', 'Picked Up', 'Reviewed', 'Cancelled'];
    return allowed.includes(value) ? value : 'Active';
  };

  const [statusFilter, setStatusFilter] = useState(normalizeStatusFilter(location.state?.statusFilter));
  const [overdueThreshold, setOverdueThreshold] = useState(location.state?.overdueThreshold || 7);
  const [paymentMethodFilter, setPaymentMethodFilter] = useState('All');
  const [storeFilter, setStoreFilter] = useState('All');
  const [stores, setStores] = useState<{id: string, name: string}[]>([]);
  const [selectedOrderIds, setSelectedOrderIds] = useState<string[]>([]);
  const [bulkUpdating, setBulkUpdating] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [executeBulkAction, setExecuteBulkAction] = useState<() => void>(() => () => {});
  const [bulkActionType, setBulkActionType] = useState<'review' | 'email' | null>(null);
  const [notification, setNotification] = useState<{ message: string, type: 'success' | 'error' } | null>(null);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'table' | 'card'>('table');
  const [currentPage, setCurrentPage] = useState(1);
  const PAGE_SIZE = 50;
  const menuRef = React.useRef<HTMLDivElement>(null);
  const [isScrolled, setIsScrolled] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [showPickupModal, setShowPickupModal] = useState(false);
  const [pickupOrder, setPickupOrder] = useState<Order | null>(null);
  const [confirmingPickup, setConfirmingPickup] = useState(false);
  const [pickupStep, setPickupStep] = useState<'items' | 'signature'>('items');
  const [pickupSelections, setPickupSelections] = useState<boolean[]>([]);
  const [partialPickupReason, setPartialPickupReason] = useState('');
  const pickupSignatureRef = useRef<SignatureCanvas>(null);

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

  const navigate = useNavigate();
  const routePrefix = location.pathname.startsWith('/cn') ? '/cn' : '';
  const isCnApiMode = routePrefix === '/cn';
  const cnText = {
    orderManagement: isCnApiMode ? '订单管理' : 'Order Management',
    warehouse: isCnApiMode ? '仓库' : 'Warehouse',
    bulkImport: isCnApiMode ? '批量导入' : 'Bulk Import',
    newOrder: isCnApiMode ? '新建订单' : 'New Order',
    export: isCnApiMode ? '导出' : 'Export',
    searchPlaceholder: isCnApiMode ? '搜索 预订号/参考号/客户/证件号/SKU...' : 'Search by Booking #, Ref #, Customer, ID, or SKU...',
    reviewed: isCnApiMode ? '已审核' : 'Reviewed',
    sendEmails: isCnApiMode ? '发送邮件' : 'Send Emails',
    activeOrders: isCnApiMode ? '进行中订单' : 'Active Orders',
    allOrders: isCnApiMode ? '全部订单' : 'All Orders',
    overdueOrders: isCnApiMode ? '超期订单' : 'Overdue Orders',
    to: isCnApiMode ? '至' : 'to',
    allPayments: isCnApiMode ? '全部付款方式' : 'All Payments',
    allStores: isCnApiMode ? '全部门店' : 'All Stores',
    noOrders: isCnApiMode ? '未找到订单。' : 'No orders found.',
    refreshList: isCnApiMode ? '刷新列表' : 'Refresh List',
    bookingNo: isCnApiMode ? '预订号' : 'Booking #',
    customer: isCnApiMode ? '客户' : 'Customer',
    store: isCnApiMode ? '门店' : 'Store',
    pickupDate: isCnApiMode ? '提货日期' : 'Pickup Date',
    payment: isCnApiMode ? '付款' : 'Payment',
    total: isCnApiMode ? '总额' : 'Total',
    status: isCnApiMode ? '状态' : 'Status',
    warehouseStatus: isCnApiMode ? '仓库状态' : 'Warehouse Status',
    action: isCnApiMode ? '操作' : 'Action',
    confirmPickup: isCnApiMode ? '确认提货' : 'Confirm Pickup',
    sendPickupEmail: isCnApiMode ? '发送提货邮件' : 'Send Pickup Email',
    viewDetails: isCnApiMode ? '查看详情' : 'View Details'
  };
  const ordersBasePath = `${routePrefix}/orders`;
  const getOrderDetailPath = (orderId?: string) => `${ordersBasePath}/${orderId || ''}`;

  useEffect(() => {
    const requestedStatus = normalizeStatusFilter(location.state?.statusFilter);
    const requestedThreshold = location.state?.overdueThreshold || 7;

    setStatusFilter(requestedStatus);
    setOverdueThreshold(requestedThreshold);

    // Always reset list filters when entering Order List to avoid stale filter state.
    setSearchTerm('');
    setPaymentMethodFilter('All');
    setStoreFilter('All');
    setDateRange({ start: '', end: '' });
  }, [location.state]);

  useClickOutside(menuRef, () => setActiveMenuId(null));

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  useEffect(() => {
    if (isCnApiMode || activeWarehouse) {
      fetchOrders();
    }
    fetchStores();
  }, [activeWarehouse, token, isCnApiMode]);

  const fetchStores = async () => {
    try {
      if (isCnApiMode) {
        if (!token) return;
        const response = await fetch(`${API_BASE_URL}/api/stores/list`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          }
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Failed to fetch stores');
        const storesData = (data.stores || []).map((s: any) => ({
          id: s.id,
          name: s.name || s.storeId || s.id
        }));
        setStores(storesData.sort((a, b) => a.name.localeCompare(b.name)));
        return;
      }

      const q = query(collection(db, 'stores'));
      const snap = await getDocs(q);
      const storesData = snap.docs.map(doc => ({ 
        id: doc.id, 
        name: (doc.data() as any).name || doc.id 
      }));
      setStores(storesData.sort((a, b) => a.name.localeCompare(b.name)));
    } catch (err) {
      console.error('Error fetching stores:', err);
    }
  };

  const fetchOrders = async () => {
    if (!isCnApiMode && !activeWarehouse) return;
    if (!token) return;
    setLoading(true);
    try {
      const cacheScope = isCnApiMode ? 'cn' : 'nz';
      const warehouseScope = isCnApiMode ? 'all-warehouses' : activeWarehouse;
      const cacheKey = `orders:${cacheScope}:${user?.uid || 'anon'}:${warehouseScope}`;
      const cached = await getOrderCache(cacheKey);
      if (cached?.orders?.length) {
        setOrders(cached.orders);
        setLoading(false);
        const cacheAgeMs = cached.updatedAt ? Date.now() - new Date(cached.updatedAt).getTime() : Infinity;
        if (cacheAgeMs >= 0 && cacheAgeMs < ORDER_CACHE_TTL_MS) {
          return;
        }
      }

      const params = new URLSearchParams({
        limit: '1000'
      });
      if (cached?.lastSyncAt) {
        params.set('updatedAfter', cached.lastSyncAt);
      }
      const response = await fetch(`${API_BASE_URL}/api/orders/list?${params.toString()}`, {
        headers: {
          'x-v2-auth-token': `Bearer ${token}`,
          ...(isCnApiMode ? {} : { 'x-warehouse-id': activeWarehouse || '' })
        }
      });
      const raw = await response.text();
      let data: any = null;
      try {
        data = raw ? JSON.parse(raw) : null;
      } catch (_e) {
        throw new Error(`Invalid JSON from /api/orders/list (status ${response.status})`);
      }
      if (!response.ok) {
        throw new Error(data?.error || `Failed to fetch orders (status ${response.status})`);
      }
      if (!data.success) throw new Error(data.error || 'Failed to fetch orders');
      const incoming = (data.orders || []) as Order[];
      const nextOrders = cached?.orders?.length ? mergeOrdersById(cached.orders, incoming) : incoming;
      setOrders(nextOrders);
      const maxMs = Math.max(
        ...nextOrders.map((o: Order) => getOrderSortMs(o)),
        data?.maxOrderTime || 0,
        cached?.lastSyncAt ? new Date(cached.lastSyncAt).getTime() : 0
      );
      const lastSyncAt = maxMs > 0 ? new Date(maxMs).toISOString() : new Date().toISOString();
      await setOrderCache({
        key: cacheKey,
        orders: nextOrders,
        lastSyncAt,
        updatedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error('Error fetching orders:', err);
      setNotification({ message: err.message || 'Failed to fetch orders', type: 'error' });
    } finally {
      setLoading(false);
    }
  };
  const getWarehouseStatusLabel = (order: Order) => order.warehouseStatus || 'Not Requested';

  const getWarehouseStatusBadgeClass = (order: Order) => {
    const status = getWarehouseStatusLabel(order);
    if (status === 'Picked') return 'bg-emerald-100 text-emerald-700';
    if (status === 'Picking') return 'bg-sky-100 text-sky-700';
    if (status === 'Pending') return 'bg-amber-100 text-amber-700';
    return 'bg-slate-100 text-slate-600';
  };

  const isPriorityPickupOrder = (order: Order) =>
    !!order.pickupExceptionStatus ||
    getWarehouseStatusLabel(order) !== 'Not Requested' &&
    order.status !== 'Picked Up' &&
    order.status !== 'Reviewed';

  const getPickupExceptionBadge = (order: Order) => {
    if (order.pickupExceptionStatus === 'PartialPendingSales') {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-700 border border-red-200">PARTIAL</span>;
    }
    if (order.pickupExceptionStatus === 'PendingFinalize') {
      return <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-orange-100 text-orange-700 border border-orange-200">READY FINALIZE</span>;
    }
    return null;
  };

  const filteredOrders = useMemo(() => {
    const result = orders.filter(order => {
      const searchLower = debouncedSearchTerm.toLowerCase();
      const matchesSearch = 
        safeSearch(order.bookingNumber, searchLower) ||
        safeSearch(order.refNumber, searchLower) ||
        safeSearch(order.customerName, searchLower) ||
        safeSearch(order.customerId, searchLower) ||
        order.items.some(item => safeSearch(item.sku, searchLower));
      
      let matchesStatus = true;
      if (statusFilter === 'Active') {
        matchesStatus = order.status !== 'Cancelled' && order.status !== 'Reviewed';
      } else if (statusFilter === 'Overdue') {
        if (!order.pickupDateScheduled || order.status !== 'Created') {
          matchesStatus = false;
        } else {
          // Normalize dates to midnight for accurate day-based comparison
          const scheduledDate = new Date(order.pickupDateScheduled);
          scheduledDate.setHours(0, 0, 0, 0);
          
          const now = new Date();
          now.setHours(0, 0, 0, 0);
          
          const thresholdDate = new Date(now);
          thresholdDate.setDate(now.getDate() - overdueThreshold);
          
          // Overdue by at least X days means scheduledDate <= thresholdDate
          matchesStatus = scheduledDate <= thresholdDate;
        }
      } else if (statusFilter !== 'All') {
        matchesStatus = order.status === statusFilter;
      }

      const matchesPaymentMethod = paymentMethodFilter === 'All' || order.paymentMethod === paymentMethodFilter;
      const matchesStore = storeFilter === 'All' || order.storeId === storeFilter || order.storeName === storeFilter;
      
      let matchesDate = true;
      if (order.createdTime) {
        try {
          const orderDate = new Date(order.createdTime).toISOString().split('T')[0];
          matchesDate = (!dateRange.start || orderDate >= dateRange.start) && 
                        (!dateRange.end || orderDate <= dateRange.end);
        } catch (e) {
          console.warn('Invalid createdTime for order:', order.id, order.createdTime);
          matchesDate = !dateRange.start && !dateRange.end; // Only match if no date filter
        }
      } else {
        matchesDate = !dateRange.start && !dateRange.end;
      }
      
      return matchesSearch && matchesStatus && matchesDate && matchesPaymentMethod && matchesStore;
    });

    return result.sort((a, b) => {
      const aPriority = isPriorityPickupOrder(a) ? 0 : 1;
      const bPriority = isPriorityPickupOrder(b) ? 0 : 1;
      if (aPriority !== bPriority) return aPriority - bPriority;

      const timeA = a.createdTime ? new Date(a.createdTime).getTime() : 0;
      const timeB = b.createdTime ? new Date(b.createdTime).getTime() : 0;
      return timeB - timeA;
    });
  }, [orders, debouncedSearchTerm, statusFilter, dateRange, paymentMethodFilter, storeFilter, overdueThreshold]);

  useEffect(() => {
    setCurrentPage(1);
  }, [debouncedSearchTerm, statusFilter, dateRange.start, dateRange.end, paymentMethodFilter, storeFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredOrders.length / PAGE_SIZE));

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const paginatedOrders = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredOrders.slice(start, start + PAGE_SIZE);
  }, [filteredOrders, currentPage]);

  const eligibleOrders = useMemo(() => {
    return filteredOrders.filter(o => o.status !== 'Cancelled');
  }, [filteredOrders]);

  const toggleSelectAll = () => {
    if (selectedOrderIds.length === eligibleOrders.length && eligibleOrders.length > 0) {
      setSelectedOrderIds([]);
    } else {
      setSelectedOrderIds(eligibleOrders.map(o => o.id!));
    }
  };

  const toggleSelectOrder = (id: string, status: string) => {
    if (status === 'Cancelled') return;
    setSelectedOrderIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleBulkReviewClick = () => {
    const reviewableIds = selectedOrderIds.filter(id => {
      const order = orders.find(o => o.id === id);
      return order?.status === 'Picked Up';
    });

    if (reviewableIds.length === 0) {
      setNotification({ message: 'Only orders with "Picked Up" status can be marked as Reviewed.', type: 'error' });
      return;
    }

    setBulkActionType('review');
    setExecuteBulkAction(() => () => {
      setShowConfirmModal(false);
      handleBulkReview();
    });
    setShowConfirmModal(true);
  };

  const handleBulkReview = async () => {
    const reviewableIds = selectedOrderIds.filter(id => {
      const order = orders.find(o => o.id === id);
      return order?.status === 'Picked Up';
    });

    if (reviewableIds.length === 0 || !profile) {
      setNotification({ message: 'Only orders with "Picked Up" status can be marked as Reviewed.', type: 'error' });
      return;
    }

    setBulkUpdating(true);
    setIsTaskRunning(true);
    setTaskProgress({
      type: 'bulk-update',
      total: reviewableIds.length,
      current: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      isComplete: false
    });

    try {
      // 🚀 使用 V2 API 进行批量更新
      await bulkUpdateStatus(reviewableIds, 'Reviewed');
      
      setTaskProgress(prev => prev ? {
        ...prev,
        current: reviewableIds.length,
        success: reviewableIds.length,
        isComplete: true
      } : null);

      setSelectedOrderIds([]);
      fetchOrders();
      setNotification({ message: `Successfully updated ${reviewableIds.length} orders to Reviewed.`, type: 'success' });
    } catch (err: any) {
      console.error('Error bulk updating orders:', err);
      setTaskProgress(prev => prev ? {
        ...prev,
        failed: reviewableIds.length,
        errors: [{ id: 'bulk', booking: 'Bulk Update', error: err.message }],
        isComplete: true
      } : null);
      setNotification({ message: `Failed to update orders: ${err.message}`, type: 'error' });
    } finally {
      setBulkUpdating(false);
    }
  };

  const handleBulkEmail = async (overrideIds?: string[]) => {
    const targetIds = overrideIds || selectedOrderIds;
    const selectedOrders = orders.filter(o => targetIds.includes(o.id!));
    const now = new Date().getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    const queue = selectedOrders.filter(order => {
      // Only block if it was successfully sent within the last 24 hours
      if (order.emailStatus === 'sent' && order.lastEmailSentAt) {
        const lastSent = new Date(order.lastEmailSentAt).getTime();
        if ((now - lastSent) <= twentyFourHours) return false;
      }
      return true;
    });

    if (queue.length === 0) {
      setNotification({ 
        message: 'No eligible orders found. (Already sent in last 24h or no selection)', 
        type: 'error' 
      });
      return;
    }

    setIsTaskRunning(true);
    if (!overrideIds) setSelectedOrderIds([]);
    setTaskProgress({
      type: 'email',
      total: queue.length,
      current: 0,
      success: 0,
      failed: 0,
      skipped: 0,
      errors: [],
      isComplete: false
    });

    if (!token) {
      console.error("No token available for bulk email");
      return;
    }
    // 🔍 这里的打印至关重要，看控制台是不是真的有一长串 JWT
    console.log("🚀 [DEBUG] Preparing to POST. Token state:", token ? "Exists" : "MISSING");

    for (let i = 0; i < queue.length; i++) {
      const order = queue[i];
      setTaskProgress(prev => prev ? { ...prev, current: i + 1 } : null);

      try {
        // Client-side validation before sending
        if (!order.customerEmail) {
          throw new Error("Missing customer email address");
        }
        const response = await fetch(`${API_BASE_URL}/api/orders/send-notification`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // 方案 A：自定义头
            'x-v2-auth-token': `Bearer ${token}`,
            // 方案 B：标准头（双重保险）
            'Authorization': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          },
          body: JSON.stringify({
            orderId: order.id,
            type: 'pickup_notification'
          }),
          mode: 'cors'
        });

        const result = await response.json();
        if (result.success && result.emailStatus === 'sent') {
          setTaskProgress(prev => prev ? { ...prev, success: prev.success + 1 } : null);
          // Update local state immediately for better UI feedback
          setOrders(prev => prev.map(o => o.id === order.id ? { ...o, emailStatus: 'sent', lastEmailSentAt: new Date().toISOString(), lastEmailError: null } : o));
        } else if (result.success && result.emailStatus === 'skipped') {
          setTaskProgress(prev => prev ? { ...prev, skipped: prev.skipped + 1 } : null);
          // Optionally mark as skipped in local state if you want to show it
          setOrders(prev => prev.map(o => o.id === order.id ? { ...o, emailStatus: 'skipped', lastEmailError: result.message } : o));
        } else {
          throw new Error(result.error || 'Failed to send email');
        }
      } catch (err: any) {
        console.error(`Error sending email to ${order.bookingNumber}:`, err);
        setTaskProgress(prev => prev ? { 
          ...prev, 
          failed: prev.failed + 1,
          errors: [...prev.errors, { id: order.id!, booking: order.bookingNumber, error: err.message }]
        } : null);
        // Update local state for failure
        setOrders(prev => prev.map(o => o.id === order.id ? { ...o, emailStatus: 'failed', lastEmailError: err.message } : o));
      }

      // Random interval between 1.5s and 4s to avoid spam detection
      if (i < queue.length - 1) {
        const delay = Math.floor(Math.random() * (4000 - 1500 + 1)) + 1500;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    setTaskProgress(prev => prev ? { ...prev, isComplete: true } : null);
    fetchOrders();
  };

  const handleBulkEmailClick = () => {
    const selectedOrders = orders.filter(o => selectedOrderIds.includes(o.id!));
    const now = new Date().getTime();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    const eligibleCount = selectedOrders.filter(order => {
      if (!order.customerEmail) return false;
      if (order.emailStatus === 'sent' && order.lastEmailSentAt) {
        const lastSent = new Date(order.lastEmailSentAt).getTime();
        if ((now - lastSent) <= twentyFourHours) return false;
      }
      return true;
    }).length;

    if (eligibleCount === 0) {
      setNotification({ 
        message: 'No eligible orders found. (Already sent in last 24h or missing email)', 
        type: 'error' 
      });
      return;
    }

    setBulkActionType('email');
    setExecuteBulkAction(() => () => {
      setShowConfirmModal(false);
      handleBulkEmail();
    });
    setShowConfirmModal(true);
  };

  const handleSingleEmail = async (order: Order) => {
    setActiveMenuId(null);
    if (!order.id) return;
    
    // Unify logic: treat single as bulk with 1 item
    handleBulkEmail([order.id]);
  };

  const openConfirmPickup = (order: Order) => {
    setActiveMenuId(null);
    if (!hasPermission(profile, 'Confirm Pickup', profile?.username || profile?.email)) {
      setNotification({ message: 'You do not have permission to confirm pickup.', type: 'error' });
      return;
    }

    if (order.status !== 'Created') {
      setNotification({ message: 'Only orders with Created status can be confirmed for pickup.', type: 'error' });
      return;
    }

    if (order.paymentStatus !== 'Paid') {
      setNotification({ message: 'Order must be paid before it can be confirmed for pickup.', type: 'error' });
      return;
    }

    if (order.pickupExceptionStatus) {
      setNotification({ message: 'This order is in partial pickup exception flow. Please process it in order detail.', type: 'error' });
      return;
    }

    setPickupOrder(order);
    setPickupStep('items');
    setPickupSelections((order.items || []).map(() => true));
    setPartialPickupReason('');
    setShowPickupModal(true);
  };

  const proceedToPickupSignature = () => {
    if (!pickupOrder) return;
    const pickedCount = pickupSelections.filter(Boolean).length;
    if (pickedCount === 0) {
      setNotification({ message: 'Please select at least one picked item.', type: 'error' });
      return;
    }
    const isPartial = pickedCount < pickupSelections.length;
    if (isPartial && !partialPickupReason.trim()) {
      setNotification({ message: 'Please provide a reason for partial pickup.', type: 'error' });
      return;
    }
    setPickupStep('signature');
  };

  const handleQuickConfirmPickup = async () => {
    if (!pickupOrder?.id || !token) return;
    if (!hasPermission(profile, 'Confirm Pickup', profile?.username || profile?.email)) {
      setNotification({ message: 'You do not have permission to confirm pickup.', type: 'error' });
      return;
    }

    if (!pickupSignatureRef.current || pickupSignatureRef.current.isEmpty()) {
      setNotification({ message: 'Please provide a signature to confirm pickup.', type: 'error' });
      return;
    }

    if (pickupOrder.warehouseStatus !== 'Picked') {
      if (!window.confirm('Warehouse has not marked this order as "Ready". Are you sure you want to confirm pickup?')) {
        return;
      }
    }

    try {
      setConfirmingPickup(true);
      const selectedIndexes = pickupSelections
        .map((selected, index) => (selected ? index : -1))
        .filter(index => index >= 0);

      const response = await fetch('/api/orders/confirm-pickup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: pickupOrder.id,
          signatureData: pickupSignatureRef.current.toDataURL(),
          pickedItemIndexes: selectedIndexes,
          partialReason: partialPickupReason.trim() || null
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to confirm pickup');
      }

      const isPartialPickup = selectedIndexes.length < pickupSelections.length;
      setShowPickupModal(false);
      setPickupOrder(null);
      setPickupStep('items');
      setPickupSelections([]);
      setPartialPickupReason('');
      setNotification({
        message: isPartialPickup
          ? `Order ${pickupOrder.bookingNumber} marked as partial pickup for Sales follow-up.`
          : `Order ${pickupOrder.bookingNumber} confirmed as picked up.`,
        type: 'success'
      });
      fetchOrders();
    } catch (err: any) {
      setNotification({ message: err.message || 'Failed to confirm pickup.', type: 'error' });
    } finally {
      setConfirmingPickup(false);
    }
  };

  const exportToCSV = () => {
    const headers = ['Booking Number', 'Customer Name', 'Store ID', 'Status', 'Payment Status', 'Created Time', 'Scheduled Pickup', 'Picked Up By', 'Items'];
    const rows = filteredOrders.map(o => [
      o.bookingNumber,
      o.customerName,
      o.storeId || 'N/A',
      o.status,
      o.paymentStatus,
      formatDate(o.createdTime, 'yyyy-MM-dd HH:mm'),
      o.pickupDateScheduled || 'N/A',
      o.pickedUpBy || 'N/A',
      o.items.map(i => `${i.sku}(${i.qty || 0})`).join('; ')
    ]);

    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `orders_${formatDate(new Date(), 'yyyyMMdd')}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden font-sans">
      {/* Notification Toast */}
      {notification && (
        <div className={cn(
          "fixed bottom-4 right-4 z-50 px-6 py-3 rounded-xl shadow-lg text-white font-semibold transition-all transform translate-y-0",
          notification.type === 'success' ? "bg-emerald-600" : "bg-red-600"
        )}>
          {notification.message}
        </div>
      )}

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-8 max-w-md w-full shadow-2xl border border-slate-100">
            <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <AlertCircle className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 text-center mb-2">Confirm Action</h3>
            <p className="text-slate-500 text-center mb-8">
              Are you sure you want to {bulkActionType === 'review' ? 'mark these orders as reviewed' : 'send emails for these orders'}?
            </p>
            <div className="flex gap-4">
              <button
                onClick={() => setShowConfirmModal(false)}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-600 rounded-xl font-semibold hover:bg-slate-200 transition-all"
              >
                {isCnApiMode ? '取消' : 'Cancel'}
              </button>
              <button
                onClick={executeBulkAction}
                className="flex-1 px-6 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}

      {showPickupModal && pickupOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl p-6 max-w-xl w-full shadow-2xl border border-slate-100">
            <h3 className="text-xl font-bold text-slate-900 mb-2">Confirm Pickup</h3>
            {pickupStep === 'items' ? (
              <>
                <p className="text-sm text-slate-500 mb-4">
                  Booking <span className="font-semibold text-slate-700">{pickupOrder.bookingNumber}</span>: confirm which items were actually picked up.
                </p>
                <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {(pickupOrder.items || []).map((item, index) => (
                    <label key={`${item.sku}-${index}`} className="flex items-start gap-3 p-3 hover:bg-slate-50 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={pickupSelections[index] || false}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPickupSelections(prev => prev.map((value, i) => (i === index ? checked : value)));
                        }}
                        className="mt-0.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <div className="flex-1">
                        <p className="text-sm font-semibold text-slate-800">{item.sku}</p>
                        <p className="text-xs text-slate-500">{item.productName || 'N/A'} · Qty {item.qty || 0}</p>
                      </div>
                    </label>
                  ))}
                </div>
                {pickupSelections.some(v => !v) && (
                  <div className="mt-3">
                    <label className="block text-xs font-semibold text-slate-600 mb-1">Reason for Partial Pickup</label>
                    <textarea
                      value={partialPickupReason}
                      onChange={(e) => setPartialPickupReason(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder="e.g. Out of stock for one SKU"
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-slate-500 mb-4">
                  Continue with customer signature to finish confirmation.
                </p>
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <SignatureCanvas
                    ref={pickupSignatureRef}
                    penColor="black"
                    canvasProps={{ className: 'w-full h-44 bg-white rounded-lg border border-slate-200' }}
                  />
                </div>
                <div className="flex justify-between items-center mt-3 mb-6">
                  <button
                    type="button"
                    onClick={() => pickupSignatureRef.current?.clear()}
                    className="text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                  >
                    Clear Signature
                  </button>
                  <span className={cn('text-xs font-semibold', getWarehouseStatusBadgeClass(pickupOrder))}>
                    Warehouse: {getWarehouseStatusLabel(pickupOrder)}
                  </span>
                </div>
              </>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => {
                  setShowPickupModal(false);
                  setPickupOrder(null);
                  setPickupStep('items');
                  setPickupSelections([]);
                  setPartialPickupReason('');
                }}
                className="flex-1 px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all"
                disabled={confirmingPickup}
              >
                Cancel
              </button>
              {pickupStep === 'items' ? (
                <button
                  onClick={proceedToPickupSignature}
                  className="flex-1 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all"
                >
                  {isCnApiMode ? '继续签名' : 'Continue to Signature'}
                </button>
              ) : (
                <button
                  onClick={handleQuickConfirmPickup}
                  disabled={confirmingPickup}
                  className="flex-1 px-4 py-2.5 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-all disabled:opacity-50"
                >
                  {confirmingPickup ? (isCnApiMode ? '确认中...' : 'Confirming...') : cnText.confirmPickup}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <PageHeader
        title={cnText.orderManagement}
        subtitle={
          <>
            <MapPin className="w-4 h-4" />
            <span>{cnText.warehouse}: <span className="font-bold text-indigo-600">{isCnApiMode ? 'AKL + CHC' : getWarehouseDisplayName(activeWarehouse)}</span></span>
          </>
        }
        icon={ShoppingBag}
        isScrolled={isScrolled}
        actions={
          <>
            <div className={cn(
              "bg-white border border-slate-200 p-1 rounded-xl flex gap-1 shadow-sm transition-all",
              isScrolled ? "scale-90 group-hover:scale-100" : ""
            )}>
              <button
                onClick={() => setViewMode('table')}
                className={cn(
                  "p-2 rounded-lg transition-all",
                  viewMode === 'table' ? "bg-indigo-50 text-indigo-600" : "text-slate-400 hover:bg-slate-50"
                )}
                title={isCnApiMode ? "表格视图" : "Table View"}
              >
                <TableIcon className="w-5 h-5" />
              </button>
              <button
                onClick={() => setViewMode('card')}
                className={cn(
                  "p-2 rounded-lg transition-all",
                  viewMode === 'card' ? "bg-indigo-50 text-indigo-600" : "text-slate-400 hover:bg-slate-50"
                )}
                title={isCnApiMode ? "卡片视图" : "Card View"}
              >
                <LayoutGrid className="w-5 h-5" />
              </button>
            </div>
            {!isCnApiMode && hasPermission(profile, 'Create Order', profile?.username || profile?.email) && (
              <Link 
                to={`${ordersBasePath}/bulk-import`}
                className={cn(
                  "inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-all shadow-sm",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2.5 text-sm"
                )}
              >
                <Upload className={isScrolled ? "w-3 h-3 group-hover:w-4 group-hover:h-4" : "w-4 h-4"} />
                <span className={cn(
                  "transition-all",
                  isScrolled ? "hidden group-hover:inline" : "inline"
                )}>{cnText.bulkImport}</span>
              </Link>
            )}
            {!isCnApiMode && hasPermission(profile, 'Create Order', profile?.username || profile?.email) && (
              <Link 
                to={`${ordersBasePath}/create`}
                className={cn(
                  "inline-flex items-center gap-2 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2.5 text-sm"
                )}
              >
                <Plus className={isScrolled ? "w-3 h-3 group-hover:w-4 group-hover:h-4" : "w-4 h-4"} />
                {cnText.newOrder}
              </Link>
            )}
            <button 
              onClick={exportToCSV}
              className={cn(
                "inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-all shadow-sm",
                isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2.5 text-sm"
              )}
            >
              <Download className={isScrolled ? "w-3 h-3 group-hover:w-4 group-hover:h-4" : "w-4 h-4"} />
              <span className={cn(
                "transition-all",
                isScrolled ? "hidden group-hover:inline" : "inline"
              )}>{cnText.export}</span>
            </button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full pl-10 pr-12 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                placeholder={cnText.searchPlaceholder}
              />
              <button 
                onClick={fetchOrders}
                disabled={loading}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 hover:bg-slate-200 rounded-lg transition-colors text-slate-400 hover:text-indigo-600 disabled:opacity-50"
                title={isCnApiMode ? "刷新订单" : "Refresh orders"}
              >
                <Loader2 className={cn("w-5 h-5", loading && "animate-spin")} />
              </button>
            </div>
            {!isCnApiMode && selectedOrderIds.length > 0 && hasPermission(profile, 'Review Orders', profile?.username || profile?.email) && (
              <div className="flex gap-2">
                <button
                  onClick={handleBulkReviewClick}
                  disabled={bulkUpdating || isTaskRunning}
                  className={cn(
                    "inline-flex items-center gap-2 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200 disabled:opacity-50 px-4 py-2.5 text-sm"
                  )}
                >
                  {bulkUpdating ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <CheckCircle className="w-4 h-4" />
                  )}
                  {isCnApiMode ? `标记 ${selectedOrderIds.length} 条为已审核` : `Mark ${selectedOrderIds.length} Reviewed`}
                </button>
                <button
                  onClick={handleBulkEmailClick}
                  disabled={bulkUpdating || isTaskRunning}
                  className={cn(
                    "inline-flex items-center gap-2 bg-emerald-600 text-white rounded-xl font-semibold hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200 disabled:opacity-50 px-4 py-2.5 text-sm"
                  )}
                >
                  {isTaskRunning ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Mail className="w-4 h-4" />
                  )}
                  {isCnApiMode ? `发送 ${selectedOrderIds.length} 封邮件` : `Send ${selectedOrderIds.length} Emails`}
                </button>
              </div>
            )}
          </div>

          <div className={cn(
            "grid grid-cols-1 md:grid-cols-4 gap-4 transition-all duration-300 ease-in-out overflow-hidden",
            isScrolled 
              ? "h-0 opacity-0 mt-0 group-hover:h-auto group-hover:opacity-100 group-hover:mt-4" 
              : "h-auto opacity-100 mt-4"
          )}>
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <Filter className="w-5 h-5 text-slate-400" />
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="bg-transparent outline-none text-sm flex-1 font-medium"
              >
                <option value="Active">{cnText.activeOrders}</option>
                <option value="All">{cnText.allOrders}</option>
                <option value="Overdue">{cnText.overdueOrders}</option>
                <option value="Created">Created</option>
                <option value="Picked Up">Picked Up</option>
                <option value="Reviewed">Reviewed</option>
                <option value="Cancelled">Cancelled</option>
              </select>
            </div>
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <Calendar className="w-5 h-5 text-slate-400" />
              <input 
                type="date" 
                value={dateRange.start} 
                onChange={(e) => setDateRange({...dateRange, start: e.target.value})}
                className="bg-transparent outline-none text-xs flex-1"
              />
              <span className="text-slate-400">{cnText.to}</span>
              <input 
                type="date" 
                value={dateRange.end} 
                onChange={(e) => setDateRange({...dateRange, end: e.target.value})}
                className="bg-transparent outline-none text-xs flex-1"
              />
            </div>
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <CreditCard className="w-5 h-5 text-slate-400" />
              <select
                value={paymentMethodFilter}
                onChange={(e) => setPaymentMethodFilter(e.target.value)}
                className="bg-transparent outline-none text-sm flex-1 font-medium"
              >
                <option value="All">{cnText.allPayments}</option>
                <option value="Cash">Cash</option>
                <option value="EFTPOS">EFTPOS</option>
                <option value="Bank Transfer">Bank Transfer</option>
                <option value="Online Payment">Online Payment</option>
              </select>
            </div>
            <div className="flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
              <StoreIcon className="w-5 h-5 text-slate-400" />
              <select
                value={storeFilter}
                onChange={(e) => setStoreFilter(e.target.value)}
                className="bg-transparent outline-none text-sm flex-1 font-medium"
              >
                <option value="All">{cnText.allStores}</option>
                {stores.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        {loading ? (
          <div className="space-y-4">
            {[1,2,3,4,5].map(i => <div key={i} className="h-20 bg-slate-100 animate-pulse rounded-2xl"></div>)}
          </div>
        ) : filteredOrders.length === 0 ? (
          <div className="text-center py-20 bg-white rounded-2xl border border-slate-100 border-dashed">
            <AlertCircle className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500 font-medium mb-4">{cnText.noOrders}</p>
            <button 
              onClick={fetchOrders}
              className="px-4 py-2 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-colors text-sm font-medium"
            >
              {cnText.refreshList}
            </button>
          </div>
        ) : (
          viewMode === 'table' ? (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="px-6 py-4 w-10">
                        <input 
                          type="checkbox"
                          checked={eligibleOrders.length > 0 && selectedOrderIds.length === eligibleOrders.length}
                          onChange={toggleSelectAll}
                          className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                        />
                      </th>
                      <th className="px-6 py-4">{cnText.bookingNo}</th>
                      <th className="px-6 py-4">{cnText.customer}</th>
                      <th className="px-6 py-4">{cnText.store}</th>
                      <th className="px-6 py-4">{cnText.pickupDate}</th>
                      <th className="px-6 py-4">{cnText.payment}</th>
                      <th className="px-6 py-4 text-right">{cnText.total}</th>
                      <th className="px-6 py-4">{cnText.status}</th>
                      <th className="px-6 py-4">{cnText.warehouseStatus}</th>
                      <th className="px-6 py-4 text-right">{cnText.action}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {paginatedOrders.map((order) => (
                      <tr 
                        key={order.id} 
                        className={cn(
                          "hover:bg-slate-50 transition-colors cursor-pointer",
                          isPriorityPickupOrder(order) && "bg-amber-50",
                          selectedOrderIds.includes(order.id!) && "bg-indigo-50/50"
                        )}
                      >
                        <td className="px-6 py-4" onClick={(e) => e.stopPropagation()}>
                          <input 
                            type="checkbox"
                            checked={selectedOrderIds.includes(order.id!)}
                            onChange={() => toggleSelectOrder(order.id!, order.status)}
                            disabled={order.status === 'Cancelled'}
                            className={cn(
                              "rounded border-slate-300 text-indigo-600 focus:ring-indigo-500",
                              order.status !== 'Cancelled' ? "cursor-pointer" : "cursor-not-allowed opacity-30"
                            )}
                          />
                        </td>
                        <td className="px-6 py-4" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-slate-900">{order.bookingNumber}</span>
                            {getPickupExceptionBadge(order)}
                            {order.warehouseStatus === 'Picked' && (
                              <div className="flex items-center gap-1 text-emerald-600" title="Ready">
                                <ShoppingCart className="w-3.5 h-3.5" />
                              </div>
                            )}
                            {order.notes && <FileText className="w-4 h-4 text-indigo-500" />}
                            {order.emailStatus === 'sent' && (
                              <div className="flex items-center gap-1 bg-emerald-50 text-emerald-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-emerald-100">
                                <Mail className="w-3 h-3" />
                                SENT
                              </div>
                            )}
                            {order.emailStatus === 'failed' && (
                              <div 
                                className="flex items-center gap-1 bg-red-50 text-red-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-red-100"
                                title={order.lastEmailError || 'Unknown error'}
                              >
                                <AlertCircle className="w-3 h-3" />
                                FAILED
                              </div>
                            )}
                            {order.emailStatus === 'skipped' && (
                              <div 
                                className="flex items-center gap-1 bg-amber-50 text-amber-600 px-1.5 py-0.5 rounded text-[10px] font-bold border border-amber-100"
                                title={order.lastEmailError || 'Already sent or disabled'}
                              >
                                <AlertCircle className="w-3 h-3" />
                                SKIPPED
                              </div>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-4" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <p className="font-medium text-slate-700">{order.customerName}</p>
                          <p className="text-xs text-slate-500">{order.customerId}</p>
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-500" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          {stores.find(s => s.id === order.storeId)?.name || order.storeId || 'N/A'}
                        </td>
                        <td className="px-6 py-4 text-sm text-slate-500" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          {formatDate(order.pickupDateScheduled, 'yyyy-MM-dd')}
                        </td>
                        <td className="px-6 py-4" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <span className={cn(
                            "px-2 py-1 rounded text-[10px] font-bold",
                            order.paymentStatus === 'Paid' ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                          )}>
                            {order.paymentStatus}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <span className="font-bold text-slate-900">${(order.totalAmount || 0).toFixed(2)}</span>
                        </td>
                        <td className="px-6 py-4" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <span className={cn(
                            "px-3 py-1 rounded-full text-xs font-bold",
                            order.status === 'Created' ? "bg-amber-100 text-amber-700" :
                            order.status === 'Picked Up' ? "bg-emerald-100 text-emerald-700" :
                            order.status === 'Reviewed' ? "bg-indigo-100 text-indigo-700" :
                            "bg-red-100 text-red-700"
                          )}>
                            {order.status}
                          </span>
                        </td>
                        <td className="px-6 py-4" onClick={() => navigate(getOrderDetailPath(order.id))}>
                          <span className={cn(
                            "px-2.5 py-1 rounded-full text-xs font-bold",
                            getWarehouseStatusBadgeClass(order)
                          )}>
                            {getWarehouseStatusLabel(order)}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-2">
                            <div className="relative" ref={activeMenuId === order.id ? menuRef : null}>
                              <button
                                onClick={() => setActiveMenuId(activeMenuId === order.id ? null : order.id!)}
                                className="p-2 hover:bg-slate-200 rounded-lg transition-colors text-slate-400 hover:text-slate-600"
                              >
                                <MoreVertical className="w-5 h-5" />
                              </button>
                              
                              {activeMenuId === order.id && (
                                <div className="absolute right-0 mt-2 w-48 bg-white border border-slate-200 rounded-xl shadow-xl z-30 py-1 overflow-hidden">
                                  {!isCnApiMode && hasPermission(profile, 'Confirm Pickup', profile?.username || profile?.email) && order.status === 'Created' && !order.pickupExceptionStatus && (
                                    <button
                                      onClick={() => openConfirmPickup(order)}
                                      className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                    >
                                      <CheckCircle className="w-4 h-4 text-emerald-500" />
                                      {cnText.confirmPickup}
                                    </button>
                                  )}
                                  {!isCnApiMode && (
                                    <button
                                      onClick={() => handleSingleEmail(order)}
                                      className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                    >
                                      <Mail className="w-4 h-4 text-emerald-500" />
                                      {cnText.sendPickupEmail}
                                    </button>
                                  )}
                                  <button
                                    onClick={() => navigate(getOrderDetailPath(order.id))}
                                    className="w-full text-left px-4 py-2 text-sm text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                  >
                                    <FileText className="w-4 h-4 text-indigo-500" />
                                    {cnText.viewDetails}
                                  </button>
                                </div>
                              )}
                            </div>
                            <ChevronRight 
                              className="w-5 h-5 text-slate-300 cursor-pointer hover:text-indigo-500" 
                              onClick={() => navigate(getOrderDetailPath(order.id))}
                            />
                            {isPriorityPickupOrder(order) && (
                              <span
                                className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"
                                title="In-store pickup"
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {paginatedOrders.map((order) => (
                <div
                  key={order.id}
                  onClick={() => navigate(getOrderDetailPath(order.id))}
                  className={cn(
                    "bg-white p-6 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-all cursor-pointer space-y-4",
                    isPriorityPickupOrder(order) && "bg-amber-50 border-amber-200"
                  )}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className={cn(
                        "w-10 h-10 rounded-xl flex items-center justify-center",
                        order.status === 'Created' ? "bg-amber-100 text-amber-600" :
                        order.status === 'Picked Up' ? "bg-emerald-100 text-emerald-600" :
                        order.status === 'Reviewed' ? "bg-indigo-100 text-indigo-600" :
                        "bg-red-100 text-red-600"
                      )}>
                        {order.status === 'Created' ? <Clock className="w-5 h-5" /> : <CheckCircle2 className="w-5 h-5" />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-slate-900">{order.bookingNumber}</h3>
                          {getPickupExceptionBadge(order)}
                          {order.emailStatus === 'sent' && (
                            <Mail className="w-3 h-3 text-emerald-500" />
                          )}
                          {order.emailStatus === 'failed' && (
                            <span title={order.lastEmailError || 'Failed'}>
                              <AlertCircle className="w-3 h-3 text-red-500" />
                            </span>
                          )}
                          {order.emailStatus === 'skipped' && (
                            <span title={order.lastEmailError || 'Skipped'}>
                              <AlertCircle className="w-3 h-3 text-amber-500" />
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-slate-500">{formatDate(order.createdTime, 'MMM d, HH:mm')}</p>
                      </div>
                    </div>
                    <span className={cn(
                      "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider",
                      order.status === 'Created' ? "bg-amber-100 text-amber-700" :
                      order.status === 'Picked Up' ? "bg-emerald-100 text-emerald-700" :
                      order.status === 'Reviewed' ? "bg-indigo-100 text-indigo-700" :
                      "bg-red-100 text-red-700"
                    )}>
                      {order.status}
                    </span>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Customer</span>
                      <span className="font-bold text-slate-900">{order.customerName}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Scheduled Pickup</span>
                      <span className="font-bold text-slate-900">{formatDate(order.pickupDateScheduled, 'MMM d, yyyy')}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Total Amount</span>
                      <span className="font-bold text-indigo-600">${(order.totalAmount || 0).toFixed(2)}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Payment</span>
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-bold",
                        order.paymentStatus === 'Paid' ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                      )}>
                        {order.paymentStatus}
                      </span>
                    </div>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-slate-500">Warehouse Status</span>
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-bold",
                        getWarehouseStatusBadgeClass(order)
                      )}>
                        {getWarehouseStatusLabel(order)}
                      </span>
                    </div>
                  </div>

                  <div className="pt-4 border-t border-slate-50 flex items-center justify-between">
                    <div className="flex -space-x-2">
                      {order.items.slice(0, 3).map((item, i) => (
                        <div key={i} className="w-8 h-8 rounded-lg bg-slate-100 border-2 border-white flex items-center justify-center text-[10px] font-bold text-slate-600" title={item.sku}>
                          {item.sku.substring(0, 2)}
                        </div>
                      ))}
                      {order.items.length > 3 && (
                        <div className="w-8 h-8 rounded-lg bg-indigo-50 border-2 border-white flex items-center justify-center text-[10px] font-bold text-indigo-600">
                          +{order.items.length - 3}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {isPriorityPickupOrder(order) && (
                        <span
                          className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block"
                          title="In-store pickup"
                        />
                      )}
                      <ChevronRight className="w-5 h-5 text-slate-300" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
        )
      }
      {!loading && filteredOrders.length > 0 && (
        <div className="mt-4 flex items-center justify-between bg-white border border-slate-100 rounded-xl px-4 py-3">
          <p className="text-sm text-slate-500">
            {isCnApiMode
              ? `显示 ${(currentPage - 1) * PAGE_SIZE + 1}-${Math.min(currentPage * PAGE_SIZE, filteredOrders.length)} / 共 ${filteredOrders.length} 条`
              : `Showing ${(currentPage - 1) * PAGE_SIZE + 1}-${Math.min(currentPage * PAGE_SIZE, filteredOrders.length)} of ${filteredOrders.length}`}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              {isCnApiMode ? '上一页' : 'Prev'}
            </button>
            <span className="text-sm text-slate-600">
              {currentPage} / {totalPages}
            </span>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50"
            >
              {isCnApiMode ? '下一页' : 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  </div>
);
};


