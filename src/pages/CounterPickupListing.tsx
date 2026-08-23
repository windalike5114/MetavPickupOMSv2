import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  AlertTriangle,
  Archive,
  Calendar,
  ClipboardList,
  Clock,
  Loader2,
  Package,
  Plus,
  RotateCcw,
  Search,
  Send,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../components/AuthProvider';
import { useClickOutside } from '../hooks/useClickOutside';
import { CounterPickup, CounterPickupOutcome, CounterPickupQueueStatus, CounterPickupRequestType, CounterPickupSourceType, CounterPickupStatus, SKU } from '../types';
import { cn, formatDate, getAucklandDateKey, getAucklandBusinessDayWindow, hasPermission, getSkuWarehouseLocation } from '../utils';
import * as XLSX from 'xlsx';

type ListingView = 'active' | 'history';
type CounterListTab = 'All' | 'My Pending' | 'My Created';
type StatusFilter = 'All' | CounterPickupStatus;
type QueueFilter = 'All' | CounterPickupQueueStatus;
type FinalizeFormState = {
  outcome: '' | CounterPickupOutcome;
  orderNumber: string;
  comment: string;
};

type FinalizeMetaState = {
  requestType: CounterPickupRequestType;
  sourceType: CounterPickupSourceType;
};

type FinalizeItemAction = {
  outcome: '' | CounterPickupOutcome;
  orderNumber: string;
  comment: string;
};

type CounterPickupItem = {
  sku: string;
  qty: number;
  productName: string;
  location: string;
  outcome?: string | null;
  destination?: string | null;
  orderNumber?: string | null;
  referenceNo?: string | null;
  comment?: string | null;
  finalizedAt?: string | null;
};

type CounterPickupItemDraft = {
  skuQuery: string;
  sku: string;
  qty: number;
  productName: string;
  location: string;
  skuResults: SKU[];
  showSkuResults: boolean;
  skuMetaLoading: boolean;
  skuMeta: { productName: string; location: string } | null;
  skuLookupMiss: boolean;
  manualProductName: string;
  manualLocation: string;
};

const PAGE_SIZE = 50;

const emptyFinalizeForm: FinalizeFormState = {
  outcome: '',
  orderNumber: '',
  comment: '',
};

type HistorySourceFilter = Record<CounterPickupSourceType, boolean>;
type HistoryRequestTypeFilter = Record<CounterPickupRequestType, boolean>;
type CounterPickupRow = {
  request: CounterPickup;
  item: {
    sku: string;
    qty: number;
    productName: string;
    location: string;
    outcome?: string | null;
    destination?: string | null;
    orderNumber?: string | null;
    referenceNo?: string | null;
    comment?: string | null;
    finalizedAt?: string | null;
  };
  itemIndex: number;
};

const getOrderNumberPrefix = (sourceType: CounterPickupSourceType | '' | undefined) => {
  if (sourceType === 'metav') return 'MVNZ';
  if (sourceType === 'blackfern') return 'BFINV-';
  return 'INV-';
};

const applyOrderNumberPrefix = (sourceType: CounterPickupSourceType | '' | undefined, value: string) => {
  const raw = value.replace(/\D/g, '').trim();
  if (!raw) return '';
  const prefix = getOrderNumberPrefix(sourceType);
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
};

const createDefaultItemAction = (): FinalizeItemAction => ({
  outcome: '',
  orderNumber: '',
  comment: '',
});

const createEmptyDraft = (): CounterPickupItemDraft => ({
  skuQuery: '',
  sku: '',
  qty: 1,
  productName: '',
  location: 'NOT_ASSIGNED',
  skuResults: [],
  showSkuResults: false,
  skuMetaLoading: false,
  skuMeta: null,
  skuLookupMiss: false,
  manualProductName: '',
  manualLocation: 'NOT_ASSIGNED'
});

const isAucklandDateOnOrAfter = (value: string, compare: string) => {
  if (!value) return true;
  return value >= compare;
};

const CN_TEXT = {
  pageTitle: '申请提货列表',
  pageSubtitle: '前台临时提货、仓库送达与后续结案处理。',
  active: '待处理',
  history: '历史记录',
  all: '全部',
  myPending: '我的待处理',
  myCreated: '我的创建',
  createRequest: '新建申请',
  createHint: '像创建订单一样搜索 SKU，自动带出产品和库位。特殊 SKU 也可以手动填写。',
  showCreate: '展开申请表单',
  hideCreate: '收起申请表单',
  requestType: '请求类型',
  sourceType: '订单来源',
  skuLabel: 'SKU / 产品搜索',
  skuPlaceholder: '搜索 SKU 或产品名称...',
  skuHelp: '系统会自动带出产品名称和主库位。若为特殊 SKU，可手动补充产品信息。',
  qty: '数量',
  submit: '提交申请',
  productName: '产品名称',
  productNamePlaceholder: '请输入特殊 SKU 的产品名称',
  location: '库位',
  locationPlaceholder: '请输入库位，或保留 NOT_ASSIGNED',
  manualSku: '使用自定义 SKU',
  searchPlaceholder: '搜索申请号、SKU、产品名、库位、创建人...',
  statusFilter: '状态筛选',
  queueFilter: '队列筛选',
  dateFilter: '日期筛选',
  loading: '正在加载申请提货数据...',
  empty: '当前视图下没有符合条件的申请提货记录。',
  counterPickup: '申请提货',
  requestNo: '申请单号',
  warehouse: '仓库',
  createdBy: '创建人',
  createdAt: '创建时间',
  finalizedAt: '完成时间',
  destination: '去向',
  referenceNo: '关联单号',
  orderNumber: '订单号',
  startPicking: '开始拣货',
  markPicked: '确认送达',
  finalize: '完成结案',
  completePutback: '确认回库',
  finalizeTitle: '完成结案',
  selectOne: '请选择',
  counterPickupType: '前台取货',
  scheduledDeliveryType: '安排发货',
  metavSource: 'Metav 订单',
  offlineSource: 'Offline 订单',
  blackfernSource: 'BlackFern 订单',
  otherSource: '其他',
  sold: '售出',
  sent: '已寄出',
  returned: 'Returned to warehouse',
  warrantySwapParts: '售后 / Warranty / Swap / Parts',
  other: '其他',
  cancel: '取消',
  productNameRequired: '特殊 SKU 或未匹配 SKU 必须填写产品名称。',
  loadError: '加载申请提货失败',
  searchSkuError: 'SKU 查询失败',
  createError: '创建申请提货失败',
  startPickingError: '开始拣货失败',
  markPickedError: '确认送达失败',
  finalizeError: '结案失败',
  completePutbackError: '确认回库失败',
  noWarehouse: '未分配',
  allStatuses: '全部状态',
  allQueues: '全部队列',
  pendingPick: '待拣货',
  picked: '已送达前台',
  pendingPutback: '等待回库',
  finalized: '已结案',
  queuePending: '待领取',
  queuePicking: '拣货中',
  queuePicked: '已完成拣货',
  pickedAlert: '已送达前台，等待补充去向',
  putbackAlert: '等待仓库回库确认',
  noResults: '没有匹配结果，可直接使用自定义 SKU。',
  showing: '显示',
  of: '/',
  prev: '上一页',
  next: '下一页',
} as const;

const EN_TEXT = {
  pageTitle: 'Counter Pickup Listing',
  pageSubtitle: 'Reception urgent pickup requests, warehouse delivery, and closure workflow.',
  active: 'Active',
  history: 'History',
  all: 'All',
  myPending: 'My Pending',
  myCreated: 'My Created',
  createRequest: 'Create Request',
  createHint: 'Search SKU like Order Create, auto-fill product and location, or enter a special SKU manually.',
  showCreate: 'Show Request Form',
  hideCreate: 'Hide Request Form',
  requestType: 'Request Type',
  sourceType: 'Order Source',
  skuLabel: 'SKU / Product Search',
  skuPlaceholder: 'Search SKU or product name...',
  skuHelp: 'The system will auto-fill product name and primary location. If this is a special SKU, you can enter product details manually.',
  qty: 'Qty',
  submit: 'Submit',
  productName: 'Product Name',
  productNamePlaceholder: 'Enter product name for special SKU',
  location: 'Location',
  locationPlaceholder: 'Enter location or keep NOT_ASSIGNED',
  manualSku: 'Use Custom SKU',
  searchPlaceholder: 'Search request no., SKU, product, location, creator...',
  statusFilter: 'Status Filter',
  queueFilter: 'Queue Filter',
  dateFilter: 'Date Filter',
  loading: 'Loading counter pickup requests...',
  empty: 'No counter pickup requests match the current view.',
  counterPickup: 'Counter Pickup',
  requestNo: 'Request No.',
  warehouse: 'Warehouse',
  createdBy: 'Created By',
  createdAt: 'Created At',
  finalizedAt: 'Finalize At',
  destination: 'Destination',
  referenceNo: 'Reference No.',
  orderNumber: 'Order Number',
  startPicking: 'Start Picking',
  markPicked: 'Mark Picked',
  finalize: 'Finalize',
  completePutback: 'Complete Putback',
  finalizeTitle: 'Finalize',
  selectOne: 'Select one',
  counterPickupType: 'Counter Pickup',
  scheduledDeliveryType: 'Scheduled Delivery',
  metavSource: 'Metav Order',
  offlineSource: 'Offline Order',
  blackfernSource: 'BlackFern Order',
  otherSource: 'Other',
  sold: 'Sold',
  sent: 'Sent',
  returned: 'Returned to warehouse',
  warrantySwapParts: 'Warranty / Swap / Parts',
  other: 'Other',
  cancel: 'Cancel',
  productNameRequired: 'Product name is required for unmatched or special SKU.',
  loadError: 'Failed to load counter pickup requests',
  searchSkuError: 'Failed to search SKU',
  createError: 'Failed to create counter pickup',
  startPickingError: 'Failed to start picking',
  markPickedError: 'Failed to mark picked',
  finalizeError: 'Failed to finalize counter pickup',
  completePutbackError: 'Failed to complete putback',
  noWarehouse: 'Unassigned',
  allStatuses: 'All Statuses',
  allQueues: 'All Queues',
  pendingPick: 'Pending Pick',
  picked: 'Picked',
  pendingPutback: 'Pending Putback',
  finalized: 'Finalized',
  queuePending: 'Pending',
  queuePicking: 'Picking',
  queuePicked: 'Picked',
  pickedAlert: 'Picked to reception, waiting for closure',
  putbackAlert: 'Waiting for warehouse putback confirmation',
  noResults: 'No matching results. You can use a custom SKU.',
  showing: 'Showing',
  of: 'of',
  prev: 'Prev',
  next: 'Next',
} as const;

const getStatusBadgeClass = (status: CounterPickupStatus) => {
  if (status === 'PendingPick') return 'bg-amber-100 text-amber-700';
  if (status === 'Picked') return 'bg-red-100 text-red-700';
  if (status === 'PendingPutback') return 'bg-orange-100 text-orange-700';
  return 'bg-emerald-100 text-emerald-700';
};

const getQueueBadgeClass = (status: CounterPickupQueueStatus) => {
  if (status === 'Pending') return 'bg-slate-100 text-slate-700';
  if (status === 'Picking') return 'bg-sky-100 text-sky-700';
  return 'bg-emerald-100 text-emerald-700';
};

export const CounterPickupListing: React.FC = () => {
  const { token, activeWarehouse, profile } = useAuth();
  const location = useLocation();
  const isCnRoute = location.pathname.startsWith('/cn');
  const text = isCnRoute ? CN_TEXT : EN_TEXT;

  const [view, setView] = useState<ListingView>('active');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requests, setRequests] = useState<CounterPickup[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('All');
  const [counterTab, setCounterTab] = useState<CounterListTab>('All');
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [historySourceFilters, setHistorySourceFilters] = useState<HistorySourceFilter>({
    metav: false,
    offline: false,
    blackfern: false,
    other: false,
  });
  const [historyRequestTypeFilters, setHistoryRequestTypeFilters] = useState<HistoryRequestTypeFilter>({
    counterPickup: false,
    scheduledDelivery: false,
  });
  const [historyTodayOnly, setHistoryTodayOnly] = useState(false);
  const [dailyExportDate, setDailyExportDate] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [showCreateForm, setShowCreateForm] = useState(true);
  const [expandedHistoryIds, setExpandedHistoryIds] = useState<string[]>([]);
  const [draft, setDraft] = useState<CounterPickupItemDraft>(createEmptyDraft);
  const [itemsDraft, setItemsDraft] = useState<CounterPickupItem[]>([]);
  const [pickupNote, setPickupNote] = useState('');
  const [requestType, setRequestType] = useState<CounterPickupRequestType | ''>('');
  const [sourceType, setSourceType] = useState<CounterPickupSourceType | ''>('');
  const suppressSkuSearchRef = useRef(false);

  const [finalizeTarget, setFinalizeTarget] = useState<CounterPickup | null>(null);
  const [finalizeForm, setFinalizeForm] = useState<FinalizeFormState>(emptyFinalizeForm);
  const [finalizeMeta, setFinalizeMeta] = useState<FinalizeMetaState>({ requestType: 'counterPickup', sourceType: 'metav' });
  const [editingFinalizeMeta, setEditingFinalizeMeta] = useState(false);
  const [itemFinalizeActions, setItemFinalizeActions] = useState<FinalizeItemAction[]>([]);
  const [splitPerItem, setSplitPerItem] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);

  const sentinelRef = useRef<HTMLDivElement>(null);
  const skuRef = useRef<HTMLDivElement>(null);
  useClickOutside(skuRef, () => setDraft((prev) => ({ ...prev, showSkuResults: false })));

  const canCreate = !isCnRoute && (profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin');
  const canManageWarehouse =
    !isCnRoute && (
      profile?.roleTemplate === 'Warehouse' ||
      profile?.roleTemplate === 'Admin' ||
      hasPermission(profile, 'Manage Picking', profile?.username || profile?.email)
    );
  const canViewPage = isCnRoute || canCreate || canManageWarehouse;

  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setIsScrolled(!entry.isIntersecting), { threshold: 0 });
    if (sentinelRef.current) observer.observe(sentinelRef.current);
    return () => {
      if (sentinelRef.current) observer.unobserve(sentinelRef.current);
    };
  }, []);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchTerm, statusFilter, queueFilter, dateRange.start, dateRange.end, view, counterTab, historySourceFilters, historyRequestTypeFilters, historyTodayOnly]);

  const resetCreateForm = () => {
    setDraft(createEmptyDraft());
    setItemsDraft([]);
    setPickupNote('');
    setRequestType('');
    setSourceType('');
  };
  const loadRequests = async (nextView = view) => {
    if (!token) return;
    setLoading(true);
    try {
      const response = await fetch(`/api/counter-pickups/list?view=${nextView}&limit=500`, {
        headers: {
          'x-v2-auth-token': `Bearer ${token}`,
          ...(isCnRoute ? {} : { 'x-warehouse-id': activeWarehouse || '' })
        }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || text.loadError);
      setRequests((data.requests || []) as CounterPickup[]);
    } catch (err: any) {
      alert(err.message || text.loadError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadRequests(view);
  }, [token, activeWarehouse, view]);

  useEffect(() => {
    if (suppressSkuSearchRef.current) {
      suppressSkuSearchRef.current = false;
      return;
    }
    if (!token || draft.skuQuery.trim().length < 2) {
      setDraft((prev) => ({ ...prev, skuResults: [], showSkuResults: false }));
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setDraft((prev) => ({ ...prev, skuMetaLoading: true }));
      try {
        const params = new URLSearchParams({ q: draft.skuQuery.trim().toUpperCase(), limit: '20' });
        const response = await fetch(`/api/skus/search?${params.toString()}`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          }
        });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || text.searchSkuError);
        if (!cancelled) {
          setDraft((prev) => ({
            ...prev,
            skuResults: (data.skus || []) as SKU[],
            showSkuResults: true,
            skuLookupMiss: (data.skus || []).length === 0,
            skuMetaLoading: false
          }));
        }
      } catch {
        if (!cancelled) {
          setDraft((prev) => ({
            ...prev,
            skuResults: [],
            showSkuResults: true,
            skuLookupMiss: true,
            skuMetaLoading: false
          }));
        }
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft.skuQuery, token, activeWarehouse, text.searchSkuError]);

  const applySelectedSku = (selected: SKU) => {
    const selectedLocation = getSkuWarehouseLocation(selected, activeWarehouse);
    suppressSkuSearchRef.current = true;
    setDraft((prev) => ({
      ...prev,
      sku: selected.sku,
      skuQuery: selected.sku,
      skuMeta: {
        productName: selected.productName || selected.sku,
        location: selectedLocation || 'NOT_ASSIGNED'
      },
      manualProductName: selected.productName || '',
      manualLocation: selectedLocation || 'NOT_ASSIGNED',
      skuLookupMiss: false,
      showSkuResults: false
    }));
  };

  const useCustomSku = () => {
    const normalized = draft.skuQuery.trim().toUpperCase();
    suppressSkuSearchRef.current = true;
    setDraft((prev) => ({
      ...prev,
      sku: normalized,
      skuQuery: normalized,
      skuMeta: null,
      skuLookupMiss: true,
      manualLocation: prev.manualLocation || 'NOT_ASSIGNED',
      showSkuResults: false
    }));
  };

  const currentItem = (): CounterPickupItem => {
    const finalSku = (draft.sku || draft.skuQuery).trim().toUpperCase();
    const resolvedProductName = (draft.skuMeta?.productName || draft.manualProductName).trim();
    const resolvedLocation = (draft.skuMeta?.location || draft.manualLocation || 'NOT_ASSIGNED').trim().toUpperCase();
    return {
      sku: finalSku,
      qty: draft.qty,
      productName: resolvedProductName,
      location: resolvedLocation || 'NOT_ASSIGNED'
    };
  };

  const canAddDraftItem = () => {
    const item = currentItem();
    return !!item.sku && !!item.productName && Number.isInteger(item.qty) && item.qty > 0;
  };

  const addDraftItem = () => {
    const item = currentItem();
    if (!item.sku) return;
    if (!item.productName) {
      alert(text.productNameRequired);
      return;
    }
    if (!Number.isInteger(item.qty) || item.qty <= 0) return;
    setItemsDraft((prev) => {
      const idx = prev.findIndex(
        (draftItem) =>
          draftItem.sku === item.sku &&
          draftItem.productName === item.productName &&
          draftItem.location === item.location
      );
      if (idx >= 0) {
        return prev.map((draftItem, i) => i === idx ? { ...draftItem, qty: draftItem.qty + item.qty } : draftItem);
      }
      return [...prev, item];
    });
    setDraft(createEmptyDraft());
  };

  const handleCreate = async () => {
    if (!token) return;
    const combinedItems = [...itemsDraft];
    const pending = currentItem();
    if (pending.sku) combinedItems.push(pending);
    if (combinedItems.length === 0) return;
    if (!requestType || !sourceType) {
      alert('Please select both Request Type and Order Source before submitting.');
      return;
    }
    if (combinedItems.some((item) => !item.productName)) {
      alert(text.productNameRequired);
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch('/api/counter-pickups/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
      body: JSON.stringify({
        items: combinedItems,
        pickupNote,
        requestType,
        sourceType
      })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || text.createError);
      setView('active');
      resetCreateForm();
      await loadRequests('active');
    } catch (err: any) {
      alert(err.message || text.createError);
    } finally {
      setSubmitting(false);
    }
  };

  const handleFinalize = async () => {
    if (!token || !finalizeTarget) return;
    const targetItems = finalizeTarget.items?.length ? finalizeTarget.items : [{
      sku: finalizeTarget.sku,
      productName: finalizeTarget.productName,
      location: finalizeTarget.location,
      qty: finalizeTarget.qty
    }];

    const normalizedActions = targetItems.map((_, index) => {
      const itemAction = itemFinalizeActions[index] || createDefaultItemAction();
      return {
        outcome: itemAction.outcome || finalizeForm.outcome,
        orderNumber: itemAction.orderNumber || finalizeForm.orderNumber,
        comment: itemAction.comment || finalizeForm.comment
      };
    });

    setSubmitting(true);
    try {
      const response = await fetch(`/api/counter-pickups/${finalizeTarget.id}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          sourceType: finalizeMeta.sourceType,
          requestType: finalizeMeta.requestType,
          outcome: finalizeForm.outcome,
          orderNumber: applyOrderNumberPrefix(finalizeMeta.sourceType, finalizeForm.orderNumber),
          comment: finalizeForm.comment,
          itemActions: normalizedActions
        })
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || text.finalizeError);
      setFinalizeTarget(null);
      setFinalizeForm(emptyFinalizeForm);
      setFinalizeMeta({ requestType: 'counterPickup', sourceType: 'metav' });
      setEditingFinalizeMeta(false);
      setItemFinalizeActions([]);
      await loadRequests(view);
    } catch (err: any) {
      alert(err.message || text.finalizeError);
    } finally {
      setSubmitting(false);
    }
  };

  const isFinalizeItemActionValid = (itemAction: FinalizeItemAction) => {
    if (!itemAction.outcome) return false;
    if (itemAction.outcome === 'sold') return itemAction.orderNumber.trim().length > 0;
    if (itemAction.outcome === 'returnedToWarehouse') return true;
    if (itemAction.outcome === 'warrantySwapParts') return itemAction.orderNumber.trim().length > 0 && itemAction.comment.trim().length >= 5;
    if (itemAction.outcome === 'other') return itemAction.comment.trim().length >= 5;
    return true;
  };

  const canSubmitFinalize = useMemo(() => {
    if (!finalizeTarget) return false;

    if (splitPerItem) {
      const targetItems = finalizeTarget.items?.length ? finalizeTarget.items : [{
        sku: finalizeTarget.sku,
        productName: finalizeTarget.productName,
        location: finalizeTarget.location,
        qty: finalizeTarget.qty
      }];
      return targetItems.every((_, index) => {
        const action = itemFinalizeActions[index] || createDefaultItemAction();
        const outcome = action.outcome || finalizeForm.outcome;
        const effectiveAction = {
          ...action,
          outcome,
          orderNumber: applyOrderNumberPrefix(finalizeTarget.sourceType || 'other', action.orderNumber || finalizeForm.orderNumber),
          comment: action.comment || finalizeForm.comment
        };
        if (!effectiveAction.outcome) return false;
        return isFinalizeItemActionValid(effectiveAction);
      });
    }

    if (!finalizeForm.outcome) return false;
    if (finalizeForm.outcome === 'sold') return finalizeForm.orderNumber.trim().length > 0;
    if (finalizeForm.outcome === 'warrantySwapParts') return finalizeForm.orderNumber.trim().length > 0 && finalizeForm.comment.trim().length >= 5;
    if (finalizeForm.outcome === 'other') return finalizeForm.comment.trim().length >= 5;
    return true;
  }, [finalizeTarget, splitPerItem, finalizeForm.outcome, finalizeForm.orderNumber, finalizeForm.comment, itemFinalizeActions]);

  const handleCompletePutback = async (requestId: string) => {
    if (!token) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/counter-pickups/${requestId}/complete-putback`, {
        method: 'POST',
        headers: {
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        }
      });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || text.completePutbackError);
      await loadRequests(view);
    } catch (err: any) {
      alert(err.message || text.completePutbackError);
    } finally {
      setSubmitting(false);
    }
  };

  const filteredRequests = useMemo(() => {
    const hasSourceFilter = Object.values(historySourceFilters).some(Boolean);
    const hasRequestTypeFilter = Object.values(historyRequestTypeFilters).some(Boolean);
    const todayKey = getAucklandDateKey(new Date());
    return requests.filter((item) => {
      const itemSearchText = (item.items || [])
        .map((entry) => `${entry.sku || ''} ${entry.productName || ''} ${entry.location || ''} ${entry.qty || ''} ${entry.orderNumber || ''} ${entry.comment || ''} ${entry.outcome || ''}`)
        .join(' ');
      const haystack = `${item.id} ${item.sku} ${item.productName} ${item.location} ${item.createdBy} ${item.orderNumber || ''} ${item.referenceNo || ''} ${item.comment || ''} ${itemSearchText}`.toLowerCase();
      const matchesSearch = haystack.includes(searchTerm.toLowerCase());
      const matchesStatus = statusFilter === 'All' || item.status === statusFilter;
      const matchesQueue = queueFilter === 'All' || item.queueStatus === queueFilter;
      const itemDate = item.createdAt ? getAucklandDateKey(item.createdAt) : '';
      const matchesDate =
        (!dateRange.start || itemDate >= dateRange.start) &&
        (!dateRange.end || itemDate <= dateRange.end);
      const matchesMyPending = counterTab !== 'My Pending' || item.status !== 'Finalized';
      const matchesMyCreated = counterTab !== 'My Created' || item.createdByUid === profile?.uid;
      const matchesToday = !historyTodayOnly || itemDate === todayKey;
      const matchesSource = !hasSourceFilter || !!item.sourceType && historySourceFilters[(item.sourceType as CounterPickupSourceType) || 'other'];
      const matchesRequestType = !hasRequestTypeFilter || !!item.requestType && historyRequestTypeFilters[(item.requestType as CounterPickupRequestType) || 'counterPickup'];
      return matchesSearch && matchesStatus && matchesQueue && matchesDate && matchesMyPending && matchesMyCreated && matchesToday && matchesSource && matchesRequestType;
    });
  }, [requests, searchTerm, statusFilter, queueFilter, dateRange.start, dateRange.end, counterTab, profile?.uid, historySourceFilters, historyRequestTypeFilters, historyTodayOnly]);

  const totalPages = Math.max(1, Math.ceil(filteredRequests.length / PAGE_SIZE));
  const paginatedRequests = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredRequests.slice(start, start + PAGE_SIZE);
  }, [filteredRequests, currentPage]);
  const historyRows = useMemo<CounterPickupRow[]>(() => {
    return filteredRequests.flatMap((request) => {
      const requestItems = request.items?.length
        ? request.items
        : [{ sku: request.sku, productName: request.productName, location: request.location, qty: request.qty }];
      return requestItems.map((item, itemIndex) => ({
        request,
        item: {
          sku: item.sku,
          qty: item.qty,
          productName: item.productName,
          location: item.location,
          outcome: item.outcome,
          destination: item.destination,
          finalizedAt: item.finalizedAt,
          orderNumber: item.orderNumber,
          referenceNo: item.referenceNo,
          comment: item.comment,
          otherNotes: item.otherNotes,
        },
        itemIndex,
      }));
    });
  }, [filteredRequests]);
  const paginatedHistoryRows = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return historyRows.slice(start, start + PAGE_SIZE);
  }, [historyRows, currentPage]);
  const displayTotalPages = view === 'history' ? Math.max(1, Math.ceil(historyRows.length / PAGE_SIZE)) : totalPages;

  useEffect(() => {
    if (currentPage > displayTotalPages) setCurrentPage(displayTotalPages);
  }, [currentPage, displayTotalPages]);

  const statusLabel = (status?: CounterPickupStatus | null) => {
    if (!status) return '-';
    if (status === 'PendingPick') return text.pendingPick;
    if (status === 'Picked') return text.picked;
    if (status === 'PendingPutback') return text.pendingPutback;
    if (status === 'Finalized') return text.finalized;
    return status;
  };

  const queueLabel = (status?: CounterPickupQueueStatus | null) => {
    if (!status) return '-';
    if (status === 'Pending') return text.queuePending;
    if (status === 'Picking') return text.queuePicking;
    if (status === 'Picked') return text.queuePicked;
    return status;
  };

  const destinationLabel = (destination?: string | null) => {
    if (!destination) return '-';
    if (destination === 'Returned') return text.returned;
    if (destination === 'Sold') return text.sold;
    if (destination === 'Other') return text.other;
    if (destination === 'Mixed') return 'Mixed';
    return destination;
  };
  const outcomeLabel = (outcome?: string | null) => {
    if (!outcome) return '-';
    if (outcome === 'sold') return text.sold;
    if (outcome === 'returnedToWarehouse') return text.returned;
    if (outcome === 'warrantySwapParts') return text.warrantySwapParts;
    if (outcome === 'other') return text.other;
    return outcome;
  };
  const outcomeOptions = (target: CounterPickup | null) => {
    const isScheduledDelivery = target?.requestType === 'scheduledDelivery';
    return [
      { value: 'sold', label: isScheduledDelivery ? text.sent : text.sold },
      { value: 'returnedToWarehouse', label: text.returned },
      { value: 'warrantySwapParts', label: text.warrantySwapParts },
      { value: 'other', label: text.other },
    ] as const;
  };
  const outcomeLabelForTarget = (outcome?: string | null, target?: CounterPickup | null) => {
    if (!outcome) return '-';
    const isScheduledDelivery = target?.requestType === 'scheduledDelivery';
    if (outcome === 'sold') return isScheduledDelivery ? text.sent : text.sold;
    if (outcome === 'returnedToWarehouse') return text.returned;
    if (outcome === 'warrantySwapParts') return text.warrantySwapParts;
    if (outcome === 'other') return text.other;
    return outcome;
  };
  const referenceLabelForHistory = (item: CounterPickupItem, request: CounterPickup) => {
    return item.orderNumber || item.referenceNo || request.orderNumber || request.referenceNo || '-';
  };
  const destinationLabelForHistory = (item: CounterPickupItem, request: CounterPickup) => {
    const raw = item.outcome || request.outcome;
    if (!raw) return '-';
    if (raw === 'sold') return request.requestType === 'scheduledDelivery' ? text.sent : text.sold;
    if (raw === 'returnedToWarehouse') return text.returned;
    if (raw === 'warrantySwapParts') return text.warrantySwapParts;
    if (raw === 'other') return text.other;
    return raw;
  };
  const historyCommentLabel = (item: CounterPickupItem, request: CounterPickup) => item.comment || request.comment || '-';
  const historyStatusLabel = (request: CounterPickup) => statusLabel(request.status);
  const historyQueueLabel = (request: CounterPickup) => queueLabel(request.queueStatus);
  const historyTableTextClass = 'block min-h-[1.25rem] leading-5 whitespace-pre-wrap break-words';
  const shouldShowCommentForOutcome = (outcome?: string | null) => outcome === 'warrantySwapParts' || outcome === 'other';
  const historyNoteLabel = (item: CounterPickup) => item.comment || '-';
  const isExpandedHistory = (id: string) => expandedHistoryIds.includes(id);
  const sourceBadgeClass = (source?: string | null) => {
    if (source === 'metav') return 'bg-red-100 text-red-700 border border-red-200';
    if (source === 'offline') return 'bg-blue-100 text-blue-700 border border-blue-200';
    if (source === 'blackfern') return 'bg-slate-900 text-white border border-slate-900';
    return 'bg-slate-100 text-slate-600 border border-slate-200';
  };
  const requestTypeBadgeClass = (requestType?: string | null) => {
    if (requestType === 'scheduledDelivery') return 'bg-violet-100 text-violet-700 border border-violet-200';
    return 'bg-amber-100 text-amber-700 border border-amber-200';
  };
  const exportCsv = (rows: string[][], filename: string) => {
    const csv = ['\uFEFF' + rows.map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n')].join('');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const autoFitWorksheetColumns = (worksheet: XLSX.WorkSheet, rows: string[][]) => {
    worksheet['!cols'] = rows[0]?.map((_, colIndex) => {
      const maxLength = rows.reduce((max, row) => {
        const cell = String(row[colIndex] ?? '');
        return Math.max(max, cell.length);
      }, 0);
      return { wch: Math.min(Math.max(maxLength + 2, 10), 42) };
    }) || [];
    worksheet['!autofilter'] = {
      ref: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: Math.max(rows.length - 1, 0), c: Math.max((rows[0]?.length || 1) - 1, 0) }
      })
    };
  };
  const handleExportFilteredList = () => {
    const detailRows: string[][] = [
      ['SKU', 'Qty', 'Requested By', 'Order Source', 'Request No.', 'Order Number', 'Destination', 'Comment', 'Request Type', 'Created At']
    ];
    const summaryMap = new Map<string, number>();

    historyRows.forEach(({ request, item }) => {
      const outcome = String(item.outcome || request.outcome || '').trim();
      if (outcome === 'returnedToWarehouse') return;

      const sku = item.sku || '';
      const qty = Number(item.qty || 0);
      const orderNumber = item.orderNumber || item.referenceNo || request.orderNumber || request.referenceNo || '';

      detailRows.push([
        sku,
        String(item.qty || ''),
        request.createdBy || '',
        request.sourceType === 'offline' ? 'Offline Order' : request.sourceType === 'blackfern' ? 'BlackFern Order' : request.sourceType === 'other' ? 'Other' : 'Metav Order',
        request.id,
        orderNumber,
        destinationLabelForHistory(item as any, request),
        historyCommentLabel(item as any, request),
        request.requestType === 'scheduledDelivery' ? 'Scheduled Delivery' : 'Counter Pickup',
        request.createdAt ? formatDate(request.createdAt, 'yyyy-MM-dd HH:mm') : ''
      ]);

      summaryMap.set(sku, (summaryMap.get(sku) || 0) + qty);
    });

    const summaryRows: string[][] = [
      ['SKU', 'Total Qty'],
      ...Array.from(summaryMap.entries()).map(([sku, totalQty]) => [sku, String(totalQty)])
    ];

    const workbook = XLSX.utils.book_new();
    const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    autoFitWorksheetColumns(detailSheet, detailRows);
    autoFitWorksheetColumns(summarySheet, summaryRows);
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Detail');
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'Summary');

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `counter-pickup-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  const handleExportDailyPickupHistory = () => {
    const detailRows: string[][] = [
      ['SKU', 'Qty', 'Requested By', 'Order Source', 'Request No.', 'Order Number', 'Destination', 'Comment', 'Request Type', 'Finalized At']
    ];
    const summaryMap = new Map<string, number>();
    const allowedSourceTypes = new Set(['metav', 'offline', 'blackfern', 'other']);
    const targetDate = dailyExportDate ? `${dailyExportDate}T12:00:00` : new Date();
    const { start, end } = getAucklandBusinessDayWindow(targetDate, 15);

    historyRows.forEach(({ request, item }) => {
      const finalizedAt = request.finalizedAt || request.updatedAt || request.createdAt;
      const finalizedDate = finalizedAt ? new Date(finalizedAt) : null;
      if (!finalizedDate || finalizedDate < start || finalizedDate >= end) return;
      if (!allowedSourceTypes.has(String(request.sourceType || '').toLowerCase())) return;
      const requestType = String(request.requestType || '').trim();
      if (requestType !== 'counterPickup' && requestType !== 'scheduledDelivery') return;
      const destination = String(item.destination || request.destination || item.outcome || request.outcome || '').trim();
      if (destination === 'Returned' || destination === 'returnedToWarehouse') return;

      const sku = item.sku || '';
      const qty = Number(item.qty || 0);
      const orderNumber = item.orderNumber || item.referenceNo || request.orderNumber || request.referenceNo || '';
      const sourceLabel = request.sourceType === 'offline'
        ? 'Offline Order'
        : request.sourceType === 'blackfern'
          ? 'BlackFern Order'
          : request.sourceType === 'other'
            ? 'Other'
            : 'Metav Order';

      detailRows.push([
        sku,
        String(item.qty || ''),
        request.createdBy || '',
        sourceLabel,
        request.id,
        orderNumber,
        destinationLabelForHistory(item as any, request),
        historyCommentLabel(item as any, request),
        requestType === 'scheduledDelivery' ? 'Scheduled Delivery' : 'Counter Pickup',
        formatDate(finalizedDate, 'yyyy-MM-dd HH:mm')
      ]);

      summaryMap.set(sku, (summaryMap.get(sku) || 0) + qty);
    });

    const summaryRows: string[][] = [
      ['SKU', 'Total Qty'],
      ...Array.from(summaryMap.entries()).map(([sku, totalQty]) => [sku, String(totalQty)])
    ];

    const workbook = XLSX.utils.book_new();
    const detailSheet = XLSX.utils.aoa_to_sheet(detailRows);
    const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
    autoFitWorksheetColumns(detailSheet, detailRows);
    autoFitWorksheetColumns(summarySheet, summaryRows);
    XLSX.utils.book_append_sheet(workbook, detailSheet, 'Daily Pickup Detail');
    XLSX.utils.book_append_sheet(workbook, summarySheet, 'SKU Summary');

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `daily-pickup-history-${dailyExportDate || new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  return (
    <div className="flex-1 flex flex-col min-w-0 bg-slate-50 overflow-hidden">
      <PageHeader
        title={text.pageTitle}
        subtitle={text.pageSubtitle}
        icon={ClipboardList}
        isScrolled={isScrolled}
        actions={
          canCreate ? (
            <button
              onClick={() => setShowCreateForm((prev) => !prev)}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all"
            >
              <Plus className="w-4 h-4" />
              {showCreateForm ? text.hideCreate : text.showCreate}
            </button>
          ) : undefined
        }
      />

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="w-full mx-auto space-y-6">
          {!canViewPage ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
              <ClipboardList className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500">You do not have access to Counter Pickup.</p>
            </div>
          ) : canCreate && showCreateForm && (
            <section className="bg-white p-4 md:p-6 rounded-2xl border border-slate-100 shadow-sm space-y-5">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{text.createRequest}</h2>
                <p className="text-sm text-slate-500 mt-1">{text.createHint}</p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-3">
                  <label className="block text-sm font-bold text-slate-900 mb-2">
                    {text.requestType} <span className="ml-1 inline-flex px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] uppercase tracking-wide">Required</span>
                  </label>
                  <select
                    value={requestType}
                    onChange={(e) => setRequestType(e.target.value as CounterPickupRequestType | '')}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value="" disabled>Select Request Type</option>
                    <option value="counterPickup">{text.counterPickupType}</option>
                    <option value="scheduledDelivery">{text.scheduledDeliveryType}</option>
                  </select>
                </div>

                <div className="lg:col-span-3">
                  <label className="block text-sm font-bold text-slate-900 mb-2">
                    {text.sourceType} <span className="ml-1 inline-flex px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] uppercase tracking-wide">Required</span>
                  </label>
                  <select
                    value={sourceType}
                    onChange={(e) => setSourceType(e.target.value as CounterPickupSourceType | '')}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  >
                    <option value="" disabled>Select Order Source</option>
                    <option value="metav">{text.metavSource}</option>
                    <option value="offline">{text.offlineSource}</option>
                    <option value="blackfern">{text.blackfernSource}</option>
                    <option value="other">{text.otherSource}</option>
                  </select>
                </div>

                <div className="lg:col-span-6" ref={skuRef}>
                  <label className="block text-sm font-bold text-slate-900 mb-2">
                    {text.skuLabel} <span className="ml-1 inline-flex px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] uppercase tracking-wide">Required</span>
                  </label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                    <input
                      value={draft.skuQuery}
                      onChange={(e) => {
                        const next = e.target.value.toUpperCase();
                        setDraft((prev) => ({ ...prev, skuQuery: next, sku: next, skuMeta: null, skuLookupMiss: false }));
                      }}
                      className="w-full pl-10 pr-10 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                      placeholder={text.skuPlaceholder}
                    />
                    {draft.skuMetaLoading && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 animate-spin text-slate-400" />}
                  </div>

                  {draft.showSkuResults && (
                    <div className="mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-72 overflow-auto">
                      {draft.skuResults.map((result) => (
                        <button
                          key={result.id || result.sku}
                          type="button"
                          onClick={() => applySelectedSku(result)}
                          className="w-full px-4 py-3 text-left hover:bg-slate-50 border-b border-slate-100 last:border-b-0"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-bold text-slate-900">{result.sku}</p>
                              <p className="text-sm text-slate-500">{result.productName}</p>
                            </div>
                            <span className="px-2 py-1 rounded-lg bg-indigo-50 text-indigo-600 text-xs font-bold">
                              {result.location || 'NOT_ASSIGNED'}
                            </span>
                          </div>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={useCustomSku}
                        className="w-full px-4 py-3 text-left hover:bg-indigo-50 text-indigo-600 font-semibold"
                      >
                        {text.manualSku}: {draft.skuQuery || 'SKU'}
                      </button>
                      {draft.skuResults.length === 0 && (
                        <div className="px-4 py-3 text-sm text-slate-500 border-t border-slate-100">{text.noResults}</div>
                      )}
                    </div>
                  )}

                  <p className="mt-2 text-xs text-slate-500">{text.skuHelp}</p>
                </div>

                <div className="lg:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-2">{text.qty}</label>
                  <input
                    type="number"
                    min={1}
                    value={draft.qty}
                    onChange={(e) => setDraft((prev) => ({ ...prev, qty: Math.max(1, Number(e.target.value) || 1) }))}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>

                <div className="lg:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-2">{text.productName}</label>
                  <input
                    value={draft.skuMeta?.productName || draft.manualProductName}
                    onChange={(e) => setDraft((prev) => ({ ...prev, skuMeta: null, skuLookupMiss: true, manualProductName: e.target.value }))}
                    placeholder={text.productNamePlaceholder}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>

                <div className="lg:col-span-2">
                  <label className="block text-sm font-medium text-slate-700 mb-2">{text.location}</label>
                  <input
                    value={draft.skuMeta?.location || draft.manualLocation}
                    onChange={(e) => setDraft((prev) => ({ ...prev, skuMeta: null, skuLookupMiss: true, manualLocation: e.target.value.toUpperCase() }))}
                    placeholder={text.locationPlaceholder}
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Pickup Note</label>
                  <input
                    value={pickupNote}
                    onChange={(e) => setPickupNote(e.target.value)}
                    placeholder="Internal note for warehouse picking"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                </div>
                <div className="flex items-end justify-end gap-2">
                  <button
                    onClick={addDraftItem}
                    disabled={!canAddDraftItem()}
                    className="inline-flex items-center gap-2 px-5 py-3 bg-slate-900 text-white rounded-xl font-semibold hover:bg-slate-800 transition-all disabled:opacity-50"
                  >
                    <Plus className="w-4 h-4" />
                    Add Product
                  </button>
                  <button
                    onClick={handleCreate}
                    disabled={submitting || (itemsDraft.length === 0 && !canAddDraftItem()) || !requestType || !sourceType}
                    className="inline-flex items-center gap-2 px-5 py-3 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all disabled:opacity-50"
                  >
                    <Send className="w-4 h-4" />
                    {text.submit}
                  </button>
                </div>
              </div>

              {itemsDraft.length > 0 && (
                <div className="space-y-2">
                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Added Products</div>
                  {itemsDraft.map((item, index) => (
                    <div key={`${item.sku}-${index}`} className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 break-words">{item.sku}</div>
                        <div className="text-sm text-slate-500 truncate">{item.productName}</div>
                      </div>
                      <div className="text-sm text-slate-700 font-semibold whitespace-nowrap">{item.qty} x {item.location}</div>
                      <button
                        type="button"
                        onClick={() => setItemsDraft((prev) => prev.filter((_, idx) => idx !== index))}
                        className="text-xs font-semibold text-red-600 hover:text-red-700"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {canViewPage && (
          <section className="bg-white p-3 md:p-4 rounded-2xl border border-slate-100 shadow-sm space-y-4">
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
              <div className="xl:col-span-4 relative min-w-0">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder={text.searchPlaceholder}
                  className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                />
                {view === 'history' && (
                  <div className="mt-3 w-full space-y-3 rounded-xl border border-slate-200 bg-slate-50/80 p-3 min-w-0">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400">{text.sourceType} / {text.requestType}</div>
                      <button
                        type="button"
                        onClick={() => {
                          setHistorySourceFilters({
                            metav: false,
                            offline: false,
                            blackfern: false,
                            other: false,
                          });
                          setHistoryRequestTypeFilters({
                            counterPickup: false,
                            scheduledDelivery: false,
                          });
                          setHistoryTodayOnly(false);
                        }}
                        className="text-[11px] font-semibold text-slate-500 hover:text-slate-700"
                      >
                        Clear filters
                      </button>
                    </div>

                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{text.sourceType}</div>
                      <div className="flex flex-wrap gap-2">
                        {([
                          ['metav', text.metavSource],
                          ['offline', text.offlineSource],
                          ['blackfern', text.blackfernSource],
                          ['other', text.otherSource],
                        ] as const).map(([value, label]) => (
                          <label key={value} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={historySourceFilters[value]}
                              onChange={(e) => setHistorySourceFilters((prev) => ({ ...prev, [value]: e.target.checked }))}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">{text.requestType}</div>
                      <div className="flex flex-wrap gap-2">
                        {([
                          ['counterPickup', text.counterPickupType],
                          ['scheduledDelivery', text.scheduledDeliveryType],
                        ] as const).map(([value, label]) => (
                          <label key={value} className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={historyRequestTypeFilters[value]}
                              onChange={(e) => setHistoryRequestTypeFilters((prev) => ({ ...prev, [value]: e.target.checked }))}
                              className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <label className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={historyTodayOnly}
                        onChange={(e) => setHistoryTodayOnly(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>Today</span>
                    </label>
                  </div>
                )}
              </div>

              <div className="xl:col-span-2">
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  <option value="All">{text.statusFilter}: {text.allStatuses}</option>
                  <option value="PendingPick">{text.pendingPick}</option>
                  <option value="Picked">{text.picked}</option>
                  <option value="PendingPutback">{text.pendingPutback}</option>
                  <option value="Finalized">{text.finalized}</option>
                </select>
              </div>

              <div className="xl:col-span-2">
                <select
                  value={queueFilter}
                  onChange={(e) => setQueueFilter(e.target.value as QueueFilter)}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  <option value="All">{text.queueFilter}: {text.allQueues}</option>
                  <option value="Pending">{text.queuePending}</option>
                  <option value="Picking">{text.queuePicking}</option>
                  <option value="Picked">{text.queuePicked}</option>
                </select>
              </div>

              <div className="xl:col-span-2 flex items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 min-w-0">
                <Calendar className="w-5 h-5 text-slate-400" />
                <input
                  type="date"
                  value={dateRange.start}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, start: e.target.value }))}
                  className="bg-transparent outline-none text-xs flex-1 min-w-0"
                />
                <span className="text-slate-400">-</span>
                <input
                  type="date"
                  value={dateRange.end}
                  onChange={(e) => setDateRange((prev) => ({ ...prev, end: e.target.value }))}
                  className="bg-transparent outline-none text-xs flex-1 min-w-0"
                />
              </div>

              <div className="xl:col-span-3 flex items-center justify-start xl:justify-end gap-3 flex-wrap">
                <div className="inline-flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                  <button
                    onClick={() => setView('active')}
                    className={cn('px-3 py-1.5 rounded-lg text-xs font-bold transition-all', view === 'active' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}
                  >
                    {text.active}
                  </button>
                  <button
                    onClick={() => setView('history')}
                    className={cn('px-3 py-1.5 rounded-lg text-xs font-bold transition-all', view === 'history' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500')}
                  >
                    {text.history}
                  </button>
                </div>
                <button
                  type="button"
                  onClick={handleExportFilteredList}
                  className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 text-white rounded-xl text-xs font-bold hover:bg-slate-800 transition-all"
                >
                  <Archive className="w-4 h-4" />
                  Export Excel
                </button>
              <button
                type="button"
                onClick={handleExportDailyPickupHistory}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl text-xs font-bold hover:bg-indigo-700 transition-all ml-2"
              >
                <Clock className="w-4 h-4" />
                Export Daily Pickup History
              </button>
              <input
                type="date"
                value={dailyExportDate}
                onChange={(e) => setDailyExportDate(e.target.value)}
                className="ml-2 px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-xs font-semibold text-slate-700"
              />
            </div>
              <div className="xl:col-span-9 flex items-center justify-end">
                <div className="inline-flex items-center gap-1 bg-slate-100 p-1 rounded-xl">
                  {(['All', 'My Pending', 'My Created'] as CounterListTab[]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => setCounterTab(tab)}
                      className={cn(
                        'px-3 py-1.5 rounded-lg text-xs font-bold transition-all',
                        counterTab === tab ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-500'
                      )}
                    >
                      {tab === 'All' ? text.all : tab === 'My Pending' ? text.myPending : text.myCreated}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
          )}

          {canViewPage && (loading ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
              <Clock className="w-10 h-10 text-slate-300 mx-auto mb-4 animate-pulse" />
              <p className="text-slate-500">{text.loading}</p>
            </div>
          ) : filteredRequests.length === 0 ? (
            <div className="bg-white rounded-2xl border border-dashed border-slate-300 p-12 text-center">
              <Package className="w-12 h-12 text-slate-300 mx-auto mb-4" />
              <p className="text-slate-500">{text.empty}</p>
            </div>
          ) : (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full table-fixed text-left">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase">
                    <tr>
                      <th className="px-3 py-3 w-[18%] md:w-[10%]">{text.requestNo}</th>
                      <th className="px-3 py-3 w-[20%] md:w-[12%]">{text.requestType} / {text.sourceType}</th>
                      <th className="px-3 py-3 w-[16%] md:w-[10%]">SKU</th>
                      <th className="hidden md:table-cell px-3 py-3 w-[18%]">{text.productName}</th>
                      <th className="px-3 py-3 w-[14%] md:w-[8%]">{text.location}</th>
                      <th className="px-3 py-3 w-[8%] md:w-[5%] text-right">{text.qty}</th>
                      <th className="hidden md:table-cell px-3 py-3 w-[10%]">{text.warehouse} / {text.createdBy}</th>
                      <th className="hidden md:table-cell px-3 py-3 w-[9%]">{text.finalizedAt}</th>
                      {view === 'history' && (
                        <>
                          <th className="hidden md:table-cell px-3 py-3 w-[7%]">{text.referenceNo}</th>
                          <th className="hidden md:table-cell px-3 py-3 w-[7%]">{text.destination}</th>
                        </>
                      )}
                      {view === 'history' && (
                        <>
                          <th className="hidden md:table-cell px-3 py-3 w-[10%]">Comment</th>
                        </>
                      )}
                      <th className="px-3 py-3 w-[12%] text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {view === 'history'
                      ? paginatedHistoryRows.map(({ request: item, item: entry, itemIndex }) => (
                        <>
                          <tr
                            key={`${item.id}-${entry.sku}-${itemIndex}`}
                            className={cn(
                              'transition-colors',
                              item.status === 'Picked' && 'bg-red-50/40',
                              item.status === 'PendingPutback' && 'bg-amber-50/40',
                              itemIndex === 0 ? 'hover:bg-slate-50' : 'bg-slate-50/35 hover:bg-slate-100/60',
                              itemIndex > 0 && 'border-t border-slate-100'
                            )}
                          >
                          <td className="px-3 py-3 font-bold text-slate-900 align-top">
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="block text-sm break-words" title={item.id}>{item.id}</span>
                              </div>
                              <span className="inline-flex px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 text-[10px] font-bold uppercase">{text.counterPickup}</span>
                              <button
                                type="button"
                                onClick={() => setExpandedHistoryIds((prev) => (
                                  prev.includes(item.id)
                                    ? prev.filter((id) => id !== item.id)
                                    : [...prev, item.id]
                                ))}
                                className="inline-flex items-center gap-1 text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
                              >
                                {isExpandedHistory(item.id) ? 'Hide details' : 'View details'}
                              </button>
                            </div>
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="space-y-2">
                              <span className={cn('inline-flex px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide', requestTypeBadgeClass(item.requestType))}>
                                {item.requestType === 'scheduledDelivery' ? text.scheduledDeliveryType : text.counterPickupType}
                              </span>
                              <div className="flex flex-wrap gap-1">
                                <span className={cn('inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide', sourceBadgeClass(item.sourceType))}>
                                  {item.sourceType === 'offline' ? text.offlineSource : item.sourceType === 'blackfern' ? text.blackfernSource : item.sourceType === 'other' ? text.otherSource : text.metavSource}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td className={cn('px-3 py-3 font-semibold text-slate-700 align-top break-words text-sm', itemIndex > 0 && 'pl-5')}>
                            <div className="flex items-center gap-2">
                              {itemIndex > 0 && <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />}
                              <span title={entry.sku}>{entry.sku}</span>
                            </div>
                          </td>
                          <td className="px-3 py-3 text-slate-700 align-top">
                            <div className="space-y-1">
                              <p className={cn('font-medium text-sm truncate hidden md:block', itemIndex > 0 && 'pl-4')} title={entry.productName}>{entry.productName}</p>
                              <p className="md:hidden text-[10px] text-slate-500 truncate" title={entry.productName}>{entry.productName}</p>
                              {itemIndex === 0 && item.status === 'Picked' && (
                                <div className="flex items-center gap-1 text-[11px] text-red-600 font-semibold">
                                  <AlertTriangle className="w-3 h-3" />
                                  {text.pickedAlert}
                                </div>
                              )}
                              {itemIndex === 0 && item.status === 'PendingPutback' && (
                                <div className="flex items-center gap-1 text-[11px] text-amber-700 font-semibold">
                                  <RotateCcw className="w-3 h-3" />
                                  {text.putbackAlert}
                                </div>
                              )}
                            </div>
                          </td>
                          <td className={cn('px-3 py-3 text-slate-500 align-top text-sm break-all', itemIndex > 0 && 'pl-5')}>{entry.location}</td>
                          <td className="px-3 py-3 text-right font-semibold text-slate-900 align-top text-sm">{entry.qty}</td>
                          <td className="hidden md:table-cell px-3 py-3 text-slate-500 align-top">
                            <div className="space-y-1 min-w-0">
                              <p className="text-sm font-semibold text-slate-700 truncate" title={item.warehouseId || text.noWarehouse}>
                                {item.warehouseId || text.noWarehouse}
                              </p>
                              <p className="text-[11px] truncate" title={item.createdBy}>
                                {item.createdBy}
                              </p>
                            </div>
                          </td>
                          <td className="hidden md:table-cell px-3 py-3 text-slate-500 align-top text-sm">
                            <div className="leading-tight">
                              <div className="whitespace-nowrap">{formatDate(item.finalizedAt || item.updatedAt || item.createdAt, 'yyyy-MM-dd')}</div>
                              <div className="whitespace-nowrap text-[11px] text-slate-400">{formatDate(item.finalizedAt || item.updatedAt || item.createdAt, 'HH:mm')}</div>
                            </div>
                          </td>
                          <td className="hidden md:table-cell px-3 py-3 text-slate-500 align-top font-medium text-sm break-all">
                            {referenceLabelForHistory(entry, item)}
                          </td>
                          <td className="hidden md:table-cell px-3 py-3 text-slate-500 align-top text-sm">
                            {destinationLabelForHistory(entry, item)}
                          </td>
                          <td className="hidden md:table-cell px-3 py-3 text-slate-600 align-top text-sm break-words">
                            {historyCommentLabel(entry, item)}
                          </td>
                          <td className="px-3 py-3 align-top">
                            <div className="flex justify-end gap-1.5 flex-wrap">
                              {canCreate && item.status === 'Picked' && itemIndex === 0 && (
                                  <button
                                  onClick={() => {
                                    setFinalizeTarget(item);
                                    setFinalizeForm(emptyFinalizeForm);
                                    setFinalizeMeta({ requestType: item.requestType || 'counterPickup', sourceType: item.sourceType || 'metav' });
                                    setEditingFinalizeMeta(false);
                                    setItemFinalizeActions(item.items?.length ? item.items.map(() => createDefaultItemAction()) : [createDefaultItemAction()]);
                                  }}
                                  disabled={submitting}
                                  className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-600 text-white rounded-lg text-[11px] font-semibold hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                                >
                                  <Send className="w-3 h-3" />
                                  {text.finalize}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {itemIndex === 0 && isExpandedHistory(item.id) && (
                          <tr key={`${item.id}-details`} className="bg-slate-50/60">
                            <td colSpan={14} className="px-3 pb-4 pt-0">
                              <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3 shadow-sm">
                                <div className="flex items-center justify-between">
                                  <div className="text-xs font-bold uppercase tracking-wider text-slate-400">Items</div>
                                  <button
                                    onClick={() => setExpandedHistoryIds((prev) => prev.filter((id) => id !== item.id))}
                                    className="text-xs font-semibold text-slate-500 hover:text-slate-700"
                                  >
                                    Hide details
                                  </button>
                                </div>
                                <div className="text-xs text-slate-500">
                                  {item.items?.length || 1} item(s) · {item.status}
                                </div>
                                <div className="flex flex-wrap gap-2 text-[11px]">
                                  <span className="inline-flex items-center px-2 py-1 rounded-full bg-violet-50 text-violet-700 font-semibold">
                                    {text.requestType}: {item.requestType === 'scheduledDelivery' ? text.scheduledDeliveryType : text.counterPickupType}
                                  </span>
                                  <span className="inline-flex items-center px-2 py-1 rounded-full bg-slate-100 text-slate-700 font-semibold">
                                    {text.sourceType}: {item.sourceType === 'offline' ? text.offlineSource : item.sourceType === 'blackfern' ? text.blackfernSource : item.sourceType === 'other' ? text.otherSource : text.metavSource}
                                  </span>
                                </div>
                                {(item.pickupNote || item.comment) && (
                                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                                    <div className="text-[11px] font-bold uppercase tracking-wider text-slate-400 mb-2">Pickup Note</div>
                                    <div className="text-sm text-slate-700 break-words whitespace-pre-wrap">
                                      {item.pickupNote || item.comment}
                                    </div>
                                  </div>
                                )}
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-h-72 overflow-y-auto pr-1">
                                  {(item.items || [{ sku: item.sku, productName: item.productName, location: item.location, qty: item.qty }]).map((detailEntry, idx) => (
                                    <div key={`${detailEntry.sku}-${idx}`} className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2">
                                      <div className="min-w-0">
                                        <div className="text-sm font-semibold text-slate-900 break-words">{detailEntry.sku}</div>
                                        <div className="text-xs text-slate-500 truncate">{detailEntry.productName}</div>
                                      </div>
                                      <div className="text-xs text-slate-700 font-semibold whitespace-nowrap">{detailEntry.qty} x {detailEntry.location}</div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                      ))
                      : paginatedRequests.map((item) => (
                        (() => {
                          const requestItems = item.items?.length
                            ? item.items
                            : [{ sku: item.sku, productName: item.productName, location: item.location, qty: item.qty }];
                          return requestItems.map((entry, index) => (
                            <tr
                              key={`${item.id}-${entry.sku}-${index}`}
                              className={cn(
                                'transition-colors',
                                item.status === 'Picked' && 'bg-red-50/40',
                                item.status === 'PendingPutback' && 'bg-amber-50/40',
                                index === 0 ? 'hover:bg-slate-50' : 'bg-slate-50/35 hover:bg-slate-100/60',
                                index > 0 && 'border-t border-slate-100'
                              )}
                            >
                              {index === 0 && (
                                <td rowSpan={requestItems.length} className="px-3 py-3 font-bold text-slate-900 align-top">
                                  <div className="space-y-1">
                                    <div className="flex items-center gap-2">
                                      <span className="block text-sm break-words" title={item.id}>{item.id}</span>
                                    </div>
                                    <span className="inline-flex px-2 py-0.5 rounded bg-yellow-100 text-yellow-800 text-[10px] font-bold uppercase">{text.counterPickup}</span>
                                  </div>
                                </td>
                              )}
                              {index === 0 && (
                                <td rowSpan={requestItems.length} className="px-3 py-3 align-top">
                                  <div className="space-y-2">
                                    <span className={cn('inline-flex px-2 py-1 rounded-full text-[10px] font-bold uppercase tracking-wide', requestTypeBadgeClass(item.requestType))}>
                                      {item.requestType === 'scheduledDelivery' ? text.scheduledDeliveryType : text.counterPickupType}
                                    </span>
                                    <div className="flex flex-wrap gap-1">
                                      <span className={cn('inline-flex px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide', sourceBadgeClass(item.sourceType))}>
                                        {item.sourceType === 'offline' ? text.offlineSource : item.sourceType === 'blackfern' ? text.blackfernSource : item.sourceType === 'other' ? text.otherSource : text.metavSource}
                                      </span>
                                    </div>
                                  </div>
                                </td>
                              )}
                              <td className={cn('px-3 py-3 font-semibold text-slate-700 align-top break-words text-sm', index > 0 && 'pl-5')}>
                                <div className="flex items-center gap-2">
                                  {index > 0 && <span className="w-1.5 h-1.5 rounded-full bg-slate-300 shrink-0" />}
                                  <span title={entry.sku}>{entry.sku}</span>
                                </div>
                              </td>
                              <td className="px-3 py-3 text-slate-700 align-top">
                                <div className="space-y-1">
                                  <p className={cn('font-medium text-sm truncate hidden md:block', index > 0 && 'pl-4')} title={entry.productName}>{entry.productName}</p>
                                  <p className="md:hidden text-[10px] text-slate-500 truncate" title={entry.productName}>{entry.productName}</p>
                                  {index === 0 && item.status === 'Picked' && (
                                    <div className="flex items-center gap-1 text-[11px] text-red-600 font-semibold">
                                      <AlertTriangle className="w-3 h-3" />
                                      {text.pickedAlert}
                                    </div>
                                  )}
                                  {index === 0 && item.status === 'PendingPutback' && (
                                    <div className="flex items-center gap-1 text-[11px] text-amber-700 font-semibold">
                                      <RotateCcw className="w-3 h-3" />
                                      {text.putbackAlert}
                                    </div>
                                  )}
                                </div>
                              </td>
                              <td className={cn('px-3 py-3 text-slate-500 align-top text-sm break-all', index > 0 && 'pl-5')}>{entry.location}</td>
                              <td className="px-3 py-3 text-right font-semibold text-slate-900 align-top text-sm">{entry.qty}</td>
                              {index === 0 && (
                                <>
                                  <td rowSpan={requestItems.length} className="hidden md:table-cell px-3 py-3 text-slate-500 align-top">
                                    <div className="space-y-1 min-w-0">
                                      <p className="text-sm font-semibold text-slate-700 truncate" title={item.warehouseId || text.noWarehouse}>
                                        {item.warehouseId || text.noWarehouse}
                                      </p>
                                      <p className="text-[11px] truncate" title={item.createdBy}>
                                        {item.createdBy}
                                      </p>
                                    </div>
                                  </td>
                                  <td rowSpan={requestItems.length} className="hidden md:table-cell px-3 py-3 text-slate-500 align-top text-sm">
                                    <div className="leading-tight">
                                      <div className="whitespace-nowrap">{formatDate(item.createdAt, 'yyyy-MM-dd')}</div>
                                      <div className="whitespace-nowrap text-[11px] text-slate-400">{formatDate(item.createdAt, 'HH:mm')}</div>
                                    </div>
                                  </td>
                                  <td rowSpan={requestItems.length} className="px-3 py-3 align-top">
                                    <div className="flex justify-end gap-1.5 flex-wrap">
                                      {canCreate && item.status === 'Picked' && (
                                        <button
                                          onClick={() => {
                                            setFinalizeTarget(item);
                                            setFinalizeForm(emptyFinalizeForm);
                                            setFinalizeMeta({ requestType: item.requestType || 'counterPickup', sourceType: item.sourceType || 'metav' });
                                            setEditingFinalizeMeta(false);
                                            setItemFinalizeActions((requestItems).map(() => createDefaultItemAction()));
                                          }}
                                          disabled={submitting}
                                          className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-red-600 text-white rounded-lg text-[11px] font-semibold hover:bg-red-700 disabled:opacity-50 whitespace-nowrap"
                                        >
                                          <Send className="w-3 h-3" />
                                          {text.finalize}
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                </>
                              )}
                            </tr>
                          ));
                        })()
                      ))}
                    
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {canViewPage && !loading && filteredRequests.length > 0 && (
            <div className="flex items-center justify-between bg-white border border-slate-100 rounded-xl px-4 py-3">
              <p className="text-sm text-slate-500">
                {text.showing} {(currentPage - 1) * PAGE_SIZE + 1}-{Math.min(currentPage * PAGE_SIZE, filteredRequests.length)} {text.of} {filteredRequests.length}
              </p>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                  disabled={currentPage === 1}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50"
                >
                  {text.prev}
                </button>
                <span className="text-sm text-slate-600">{currentPage} / {displayTotalPages}</span>
                <button
                  onClick={() => setCurrentPage((prev) => Math.min(displayTotalPages, prev + 1))}
                  disabled={currentPage === displayTotalPages}
                  className="px-3 py-1.5 text-sm rounded-lg border border-slate-200 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-slate-50"
                >
                  {text.next}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {finalizeTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-6 space-y-5 max-h-[90vh] overflow-hidden flex flex-col">
            <div>
              <h2 className="text-xl font-bold text-slate-900">{text.finalizeTitle}</h2>
              <p className="text-sm text-slate-500 mt-1">{finalizeTarget.id} | {finalizeTarget.sku}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Items</span>
                <span>{(finalizeTarget.items?.length || 1)} product(s)</span>
              </div>
              <div className="mt-3 space-y-2">
                {(finalizeTarget.items?.length ? finalizeTarget.items : [{
                  sku: finalizeTarget.sku,
                  productName: finalizeTarget.productName,
                  location: finalizeTarget.location,
                  qty: finalizeTarget.qty
                }]).map((item, index) => (
                  <div key={`${item.sku}-${index}`} className="flex items-start justify-between gap-3 rounded-lg bg-white border border-slate-200 px-3 py-2">
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-900 break-words">
                        {item.sku} - {item.qty}PCS
                      </div>
                      <div className="text-xs text-slate-500 truncate" title={item.productName}>
                        {item.productName}
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 whitespace-nowrap">
                      {item.location || 'NOT_ASSIGNED'}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex items-start justify-between gap-3 mt-2">
                <span className="font-semibold">Comment</span>
                <span className="text-right max-w-[70%] break-words">{finalizeTarget.comment || '-'}</span>
              </div>
              <div className="flex items-center justify-between gap-3 mt-2">
                <span className="font-semibold">Request Type / Order Source</span>
                <div className="flex items-center gap-2">
                  <span className="px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-700 text-[11px] font-semibold">
                    {finalizeMeta.requestType === 'scheduledDelivery' ? text.scheduledDeliveryType : text.counterPickupType}
                  </span>
                  <span className="px-2 py-0.5 rounded-full bg-white border border-slate-200 text-slate-700 text-[11px] font-semibold">
                    {finalizeMeta.sourceType === 'offline' ? text.offlineSource : finalizeMeta.sourceType === 'blackfern' ? text.blackfernSource : finalizeMeta.sourceType === 'other' ? text.otherSource : text.metavSource}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEditingFinalizeMeta((prev) => !prev)}
                    className="ml-1 inline-flex items-center px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-[11px] font-semibold border border-indigo-100 hover:bg-indigo-100"
                  >
                    Edit
                  </button>
                </div>
              </div>
            </div>

            <div className="space-y-4 flex-1 overflow-y-auto pr-1">
              {!splitPerItem && (
                <>
                  {editingFinalizeMeta && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <div>
                        <label className="text-sm font-medium text-slate-700">{text.requestType}</label>
                        <select
                          value={finalizeMeta.requestType}
                          onChange={(e) => setFinalizeMeta((prev) => ({ ...prev, requestType: e.target.value as CounterPickupRequestType }))}
                          className="mt-2 w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                        >
                          <option value="counterPickup">{text.counterPickupType}</option>
                          <option value="scheduledDelivery">{text.scheduledDeliveryType}</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-sm font-medium text-slate-700">{text.sourceType}</label>
                        <select
                          value={finalizeMeta.sourceType}
                          onChange={(e) => setFinalizeMeta((prev) => ({ ...prev, sourceType: e.target.value as CounterPickupSourceType }))}
                          className="mt-2 w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                        >
                          <option value="metav">{text.metavSource}</option>
                          <option value="offline">{text.offlineSource}</option>
                          <option value="blackfern">{text.blackfernSource}</option>
                          <option value="other">{text.otherSource}</option>
                        </select>
                      </div>
                    </div>
                  )}
                  <div>
                    <label className="text-sm font-medium text-slate-700">{text.destination}</label>
                    <select
                      value={finalizeForm.outcome}
                      onChange={(e) => setFinalizeForm((prev) => ({ ...prev, outcome: e.target.value as FinalizeFormState['outcome'] }))}
                      className="mt-2 w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                    >
                      <option value="">{text.selectOne}</option>
                      <option value="sold">{finalizeMeta.requestType === 'scheduledDelivery' ? text.sent : text.sold}</option>
                      <option value="returnedToWarehouse">{text.returned}</option>
                      <option value="warrantySwapParts">{text.warrantySwapParts}</option>
                      <option value="other">{text.other}</option>
                    </select>
                  </div>

                  {(finalizeForm.outcome === 'sold' || finalizeForm.outcome === 'warrantySwapParts') && (
                    <div>
                      <label className="text-sm font-medium text-slate-700">{text.orderNumber}</label>
                      <input
                        value={finalizeForm.orderNumber}
                        onChange={(e) => setFinalizeForm((prev) => ({ ...prev, orderNumber: applyOrderNumberPrefix(finalizeMeta.sourceType, e.target.value) }))}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        placeholder="Digits only"
                        className="mt-2 w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                      />
                    </div>
                  )}
                </>
              )}

                {shouldShowCommentForOutcome(finalizeForm.outcome) && (
                <div>
                  <label className="text-sm font-medium text-slate-700">Comment</label>
                  <input
                    value={finalizeForm.comment}
                    onChange={(e) => setFinalizeForm((prev) => ({ ...prev, comment: e.target.value }))}
                    placeholder={finalizeForm.outcome === 'other' || finalizeForm.outcome === 'warrantySwapParts' ? 'Required final closure comment' : 'Optional final closure comment'}
                    className="mt-2 w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  />
                  {(finalizeForm.outcome === 'other' || finalizeForm.outcome === 'warrantySwapParts') && (
                    <p className="mt-1 text-xs text-slate-500">Required for this closure type.</p>
                  )}
                </div>
                )}

              <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
                <div>
                  <div className="text-sm font-semibold text-slate-900">Split per item</div>
                  <div className="text-xs text-slate-500">Turn on only when different items in the same request need different outcomes.</div>
                </div>
                <label className="inline-flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={splitPerItem}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setSplitPerItem(checked);
                      if (!checked) {
                        setItemFinalizeActions((finalizeTarget.items?.length ? finalizeTarget.items : [{
                          sku: finalizeTarget.sku,
                          productName: finalizeTarget.productName,
                          location: finalizeTarget.location,
                          qty: finalizeTarget.qty
                        }]).map(() => createDefaultItemAction()));
                      }
                    }}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  <span className="text-sm font-medium text-slate-700">Enabled</span>
                </label>
              </div>

              {splitPerItem && (
                <div className="rounded-xl border border-slate-200 bg-white">
                  <div className="px-4 py-3 border-b border-slate-200">
                    <div className="text-sm font-semibold text-slate-900">Item-level handling</div>
                    <div className="text-xs text-slate-500 mt-1">Leave as default to apply the same handling to all items.</div>
                  </div>
                  <div className="divide-y divide-slate-100 max-h-[38vh] overflow-y-auto">
                    {(finalizeTarget.items?.length ? finalizeTarget.items : [{
                      sku: finalizeTarget.sku,
                      productName: finalizeTarget.productName,
                      location: finalizeTarget.location,
                      qty: finalizeTarget.qty
                    }]).map((item, index) => {
                      const itemAction = itemFinalizeActions[index] || createDefaultItemAction();
                      return (
                        <div key={`${item.sku}-${index}`} className="p-4 space-y-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="text-sm font-semibold text-slate-900 break-words">{item.sku}</div>
                              <div className="text-xs text-slate-500 break-words">{item.productName}</div>
                            </div>
                            <div className="text-xs font-semibold text-slate-500 whitespace-nowrap">{item.qty} x {item.location}</div>
                          </div>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                            <div>
                              <label className="text-xs font-medium text-slate-600">Outcome</label>
                              <select
                                value={itemAction.outcome || finalizeForm.outcome}
                                onChange={(e) => {
                                  const next = e.target.value as FinalizeFormState['outcome'];
                                  setItemFinalizeActions((prev) => {
                                    const copy = [...prev];
                                    copy[index] = { ...(copy[index] || createDefaultItemAction()), outcome: next };
                                    if (next !== 'sold' && next !== 'warrantySwapParts') {
                                      copy[index].orderNumber = '';
                                    }
                                    if (next !== 'warrantySwapParts' && next !== 'other') {
                                      copy[index].comment = '';
                                    }
                                    return copy;
                                  });
                                }}
                                className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                              >
                                <option value="">{text.selectOne}</option>
                                <option value="sold">{finalizeMeta.requestType === 'scheduledDelivery' ? text.sent : text.sold}</option>
                                <option value="returnedToWarehouse">{text.returned}</option>
                                <option value="warrantySwapParts">{text.warrantySwapParts}</option>
                                <option value="other">{text.other}</option>
                              </select>
                            </div>
                            {(itemAction.outcome || finalizeForm.outcome) === 'sold' || (itemAction.outcome || finalizeForm.outcome) === 'warrantySwapParts' ? (
                              <div>
                                <label className="text-xs font-medium text-slate-600">{text.orderNumber}</label>
                                  <input
                                    value={itemAction.orderNumber}
                                    onChange={(e) => {
                                    const value = applyOrderNumberPrefix(finalizeMeta.sourceType, e.target.value);
                                      setItemFinalizeActions((prev) => {
                                        const copy = [...prev];
                                        copy[index] = { ...(copy[index] || createDefaultItemAction()), orderNumber: value };
                                        return copy;
                                      });
                                  }}
                                  inputMode="numeric"
                                  pattern="[0-9]*"
                                  placeholder="Digits only"
                                  className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                                />
                              </div>
                            ) : null}
                            {(itemAction.outcome || finalizeForm.outcome) === 'warrantySwapParts' || (itemAction.outcome || finalizeForm.outcome) === 'other' ? (
                              <div className="md:col-span-1">
                                <label className="text-xs font-medium text-slate-600">Comment</label>
                                <input
                                  value={itemAction.comment}
                                  onChange={(e) => {
                                    const value = e.target.value;
                                    setItemFinalizeActions((prev) => {
                                      const copy = [...prev];
                                      copy[index] = { ...(copy[index] || createDefaultItemAction()), comment: value };
                                      return copy;
                                    });
                                  }}
                                  className="mt-1 w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none"
                                />
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setFinalizeTarget(null);
                  setFinalizeForm(emptyFinalizeForm);
                  setFinalizeMeta({ requestType: 'counterPickup', sourceType: 'metav' });
                  setEditingFinalizeMeta(false);
                }}
                className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold"
              >
                {text.cancel}
              </button>
              <button
                onClick={handleFinalize}
                disabled={submitting || !canSubmitFinalize}
                className="px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 transition-all disabled:opacity-50"
              >
                {text.submit}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
