import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import { 
  collection, 
  doc, 
  runTransaction, 
  serverTimestamp, 
  query, 
  where, 
  getDocs,
  writeBatch
} from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { 
  Upload, 
  FileText, 
  CheckCircle2, 
  AlertCircle, 
  Loader2, 
  ArrowLeft, 
  Trash2, 
  Save, 
  Play, 
  Info,
  ChevronRight,
  Database,
  History,
  AlertTriangle,
  Download
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { Order, OrderItem, OrderStatus, PaymentStatus, PaymentMethod, SKU } from '../types';
import { cn, hasPermission } from '../utils';
import { API_BASE_URL } from '../constants';

// 1. Zod Schema for Validation
const orderRowSchema = z.object({
  'booking_number': z.string().min(1, "Booking number is required"),
  'customer_name': z.string().min(1, "Customer name is required"),
  'customer_ref': z.string().min(1, "Customer ref is required"),
  'customer_id': z.string().optional(),
  'customer_email': z.string().email("Invalid email format"),
  'scheduled_pickup_date': z.string().optional().transform(val => {
    if (!val || val.trim() === '' || val.toLowerCase() === 'n/a') {
      return new Date().toISOString().split('T')[0];
    }
    const d = new Date(val);
    if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
    return d.toISOString().split('T')[0];
  }),
  'store_id': z.string().min(1, "Store ID is required"),
  'payment_state': z.string().refine(val => ['paid', 'unpaid'].includes(val.toLowerCase()), {
    message: "Payment state must be Paid or Unpaid"
  }),
  'payment_method': z.string().optional(),
  'sku': z.string().min(1, "SKU is required"),
  'quantity': z.string().transform(val => parseInt(val, 10)).refine(val => !isNaN(val) && val > 0, {
    message: "Quantity must be a positive number"
  }),
  'unit_price': z.string().transform(val => parseFloat(val)).refine(val => !isNaN(val) && val >= 0, {
    message: "Unit price must be a non-negative number"
  }),
  'warehouse_id': z.string().optional().transform(val => val?.trim().toUpperCase() || '').refine(val => !val || ['AKL', 'CHC'].includes(val), {
    message: "Warehouse must be blank, AKL, or CHC"
  }),
  'order_note': z.string().optional()
}).refine(data => {
  const isPaid = data['payment_state'].toLowerCase() === 'paid';
  const validMethods = ['Cash', 'EFTPOS', 'Bank Transfer', 'Online Payment'];
  
  if (isPaid) {
    // If Paid, payment_method MUST be one of the valid methods
    return data.payment_method && validMethods.some(m => data.payment_method?.toLowerCase() === m.toLowerCase());
  }
  
  // If Unpaid, payment_method can be empty or one of the valid methods
  if (!data.payment_method || data.payment_method.trim() === '') return true;
  return validMethods.some(m => data.payment_method?.toLowerCase() === m.toLowerCase());
}, {
  message: "Invalid payment method. For Paid orders, it must be one of: Cash, EFTPOS, Bank Transfer, Online Payment. For Unpaid, it can be empty.",
  path: ['payment_method']
});

type OrderRow = z.infer<typeof orderRowSchema>;

interface LogEntry {
  timestamp: string;
  message: string;
  type: 'info' | 'success' | 'error' | 'warning';
}

interface ProcessedRow {
  id: string;
  data: any;
  errors: string[];
  isDuplicate: boolean;
  status: 'pending' | 'checking' | 'ready' | 'importing' | 'success' | 'failed';
  rowNumber: number;
}

import { PageHeader } from '../components/PageHeader';

export const BulkOrderUpload = () => {
  const { profile, token } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const isCnRoute = location.pathname.startsWith('/cn');
  const canCreate = hasPermission(profile, 'Create Order', profile?.username || profile?.email);
  const ordersBasePath = location.pathname.startsWith('/cn') ? '/cn/orders' : '/orders';
  const [rows, setRows] = useState<ProcessedRow[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [progress, setProgress] = useState(0);
  const [activeTab, setActiveTab] = useState<'all' | 'valid' | 'invalid' | 'duplicate'>('all');
  const [availableStoreIds, setAvailableStoreIds] = useState<string[]>([]);
  const text = isCnRoute ? {
    title: '批量导入订单',
    downloadTemplate: '下载模板',
    clear: '清空',
    startImport: '开始导入',
    ordersUnit: '个订单',
    dataHealth: '数据概览',
    totalRows: '总行数',
    groupedOrders: '合并订单数',
    readyOrders: '可导入订单',
    duplicates: '重复数据',
    invalidRows: '无效数据',
    successImported: '成功导入',
    dragDrop: '拖拽 Excel 或 CSV 文件到此处',
    browse: '或点击选择文件',
    importRules: '导入规则',
    fixedFields: '固定字段：',
    storeRule: 'store_id：必须与系统内店铺 ID 一致',
    paymentStateRule: 'payment_state：仅支持 Paid 或 Unpaid',
    paymentMethodRule: 'payment_method：',
    paymentPaidRule: '若为 Paid：Cash、EFTPOS、Bank Transfer、Online Payment',
    paymentUnpaidRule: '若为 Unpaid：可留空，系统默认 Pending',
    warehouseRule: 'warehouse_id 可留空（未分配），或填写 AKL、CHC',
    note: '说明：CSV 导入时大小写不敏感，系统会自动标准化。',
    dataPreview: '数据预览',
    checkingDuplicates: '正在检查重复数据...',
    noData: '尚未加载数据，请先上传 Excel 或 CSV 文件。',
    booking: '预订号',
    customer: '客户',
    ref: '参考号',
    email: '邮箱',
    status: '状态',
    success: '成功',
    duplicate: '重复',
    error: '错误',
    ready: '就绪',
    processLogs: '处理日志',
    waitingActivity: '等待操作中...',
    adminOnlyLogs: '仅管理员可查看实时处理日志。',
    templateGuide: '模板说明',
    orderInfoArea: '订单信息区（蓝色）',
    productArea: '商品信息区（黄色）',
    bookingRule: 'booking_number 每一行都必须填写，其他订单字段只需在首行填写。',
    productRule: 'sku、quantity、unit_price 每一行都必须填写。',
    loadedStores: '已加载',
    loadedStoresSuffix: '个店铺配置用于校验',
    failedStores: '加载店铺配置失败',
    templateDownloaded: 'CSV 模板已下载',
    noValidRows: '没有可导入的有效数据行',
    fileSelected: '已选择文件',
    parsedRows: 'CSV 解析完成，共',
    parsedRowsSuffix: '行',
    fetchingSkus: '正在拉取 SKU 定义，共',
    fetchingSkusSuffix: '个唯一 SKU...',
    fetchedSkus: 'SKU 自动带出完成，共匹配',
    fetchedSkusSuffix: '个 SKU'
  } : {
    title: 'Bulk Order Upload',
    downloadTemplate: 'Download Template',
    clear: 'Clear',
    startImport: 'Start Import',
    ordersUnit: 'Orders',
    dataHealth: 'Data Health',
    totalRows: 'Total Rows',
    groupedOrders: 'Grouped Orders',
    readyOrders: 'Ready Orders',
    duplicates: 'Duplicates',
    invalidRows: 'Invalid Rows',
    successImported: 'Successfully Imported',
    dragDrop: 'Drag & drop CSV here',
    browse: 'or click to browse files',
    importRules: 'Import Rules',
    fixedFields: 'Fixed Fields:',
    storeRule: 'store_id: Must match Store ID in system',
    paymentStateRule: 'payment_state: Paid, Unpaid',
    paymentMethodRule: 'payment_method:',
    paymentPaidRule: 'If Paid: Cash, EFTPOS, Bank Transfer, Online Payment',
    paymentUnpaidRule: 'If Unpaid: Can be empty (defaults to "Pending")',
    warehouseRule: 'warehouse_id: optional (blank, AKL, or CHC)',
    note: 'Note: Values are case-insensitive during CSV import but will be normalized.',
    dataPreview: 'Data Preview',
    checkingDuplicates: 'Checking duplicates...',
    noData: 'No data loaded. Upload a CSV to begin.',
    booking: 'Booking #',
    customer: 'Customer',
    ref: 'Ref #',
    email: 'Email',
    status: 'Status',
    success: 'Success',
    duplicate: 'Duplicate',
    error: 'Error',
    ready: 'Ready',
    processLogs: 'Process Logs',
    waitingActivity: 'Waiting for activity...',
    adminOnlyLogs: 'Only administrators can view real-time process logs.',
    templateGuide: 'Template Guide',
    orderInfoArea: 'Order Info Area (Blue)',
    productArea: 'Product Details Area (Amber)',
    bookingRule: 'booking_number must be on EVERY row. Other fields only on the 1st row.',
    productRule: 'sku, quantity, unit_price MUST be filled on every row.',
    loadedStores: 'Loaded',
    loadedStoresSuffix: 'store configurations for validation',
    failedStores: 'Failed to load store configurations',
    templateDownloaded: 'CSV template downloaded',
    noValidRows: 'No valid rows to import',
    fileSelected: 'File selected',
    parsedRows: 'Parsed',
    parsedRowsSuffix: 'rows from CSV',
    fetchingSkus: 'Fetching definitions for',
    fetchingSkusSuffix: 'unique SKUs...',
    fetchedSkus: 'Auto-fill data retrieved for',
    fetchedSkusSuffix: 'SKUs'
  };

  // Scroll state for collapsible header
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

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [{
      timestamp: new Date().toLocaleTimeString(),
      message,
      type
    }, ...prev].slice(0, 100));
  }, []);

  useEffect(() => {
    const fetchStores = async () => {
      try {
        let ids: string[];
        if (isCnRoute) {
          if (!token || !canCreate) return;
          const response = await fetch('/api/stores/list', { headers: { 'x-v2-auth-token': token } });
          const result = await response.json();
          if (!response.ok || !result.success) throw new Error(text.failedStores);
          ids = result.stores.flatMap((store: { id: string; storeId: string }) => [store.id, store.storeId]);
        } else {
          const snapshot = await getDocs(collection(db, 'stores'));
          ids = snapshot.docs.map(doc => doc.id);
        }
        setAvailableStoreIds(ids);
        addLog(isCnRoute ? `${text.loadedStores} ${ids.length} ${text.loadedStoresSuffix}` : `${text.loadedStores} ${ids.length} ${text.loadedStoresSuffix}`, 'info');
      } catch (err) {
        console.error("Error fetching stores:", err);
        addLog(text.failedStores, 'warning');
      }
    };

    fetchStores();
  }, [addLog, isCnRoute, token, canCreate]);

  const downloadTemplate = () => {
    const headers = [
      'booking_number',
      'customer_name',
      'customer_email',
      'customer_ref',
      'customer_id',
      'scheduled_pickup_date',
      'store_id',
      'payment_state',
      'payment_method',
      'order_note',
      'warehouse_id',
      'sku',
      'quantity',
      'unit_price'
    ];
    
    const instructions = [
      '# === IMPORT TEMPLATE RULES ===',
      '# [BLUE AREA] Order Info: booking_number, customer_name, customer_email, customer_ref, customer_id, scheduled_pickup_date, store_id, payment_state, payment_method, order_note, warehouse_id',
      '# -> RULE: booking_number MUST be filled on EVERY row. Other order info only needs to be on the FIRST row of an order.',
      '# -> store_id: Must match existing Store ID in system (e.g., WMS-MAIN).',
      '# -> payment_state: Must be "Paid" or "Unpaid".',
      '# -> payment_method: If Paid, must be one of: Cash, EFTPOS, Bank Transfer, Online Payment. If Unpaid, can be empty.',
      '# -> warehouse_id: Optional. Leave blank for Unassigned or enter "AKL" or "CHC".',
      '# [AMBER AREA] Product Info: sku, quantity, unit_price',
      '# -> RULE: These MUST be filled on EVERY row for product details.',
      '# ============================='
    ];
    
    const sampleData = [
      ['BK-2026-001', 'John Doe', 'john@example.com', 'REF-9988', 'CUST-102', '2026-03-25', 'WMS-MAIN', 'Paid', 'EFTPOS', 'Handle with care', '', 'WPKIT-TA005', '2', '45.50'],
      ['BK-2026-001', '', '', '', '', '', '', '', '', '', '', 'SKU-B', '1', '50.00'],
      ['BK-2026-002', 'Jane Smith', 'jane@example.com', 'REF-1001', 'CUST-103', '2026-03-26', 'WMS-MAIN', 'Unpaid', 'Bank Transfer', '', 'AKL', 'SKU-C', '1', '299.99']
    ];

    const csvContent = [...instructions, headers.join(','), ...sampleData.map(row => row.join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'order_import_template.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addLog(text.templateDownloaded, 'info');
  };

  const checkImport = async (payload: { skus?: string[]; bookingNumbers?: string[]; refs?: string[] }) => {
    const response = await fetch('/api/orders/import-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-v2-auth-token': token || '' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(result.error || '导入校验失败。');
    return result;
  };

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (!file || (isCnRoute && (!canCreate || !token))) return;

    addLog(isCnRoute ? `${text.fileSelected}：${file.name}` : `${text.fileSelected}: ${file.name}`, 'info');
    
    let input: string;
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', dateNF: 'yyyy-mm-dd' });
        input = XLSX.utils.sheet_to_csv(workbook.Sheets[workbook.SheetNames[0]]);
      } else {
        input = await file.text();
      }
    } catch {
      addLog(isCnRoute ? '无法读取导入文件。' : 'Could not read the import file.', 'error');
      return;
    }

    Papa.parse<Record<string, string>>(input, {
      header: true,
      skipEmptyLines: true,
      comments: "#",
      complete: async (results) => {
        addLog(isCnRoute ? `${text.parsedRows} ${results.data.length} ${text.parsedRowsSuffix}` : `${text.parsedRows} ${results.data.length} ${text.parsedRowsSuffix}`, 'success');
        
        // 1. Extract unique SKUs from CSV to fetch on-demand (Quota optimization)
        const uniqueSkusInCsv = Array.from(new Set(
          results.data
            .map((row: any) => row['sku']?.trim()?.toUpperCase())
            .filter((sku: string) => !!sku)
        )) as string[];

        addLog(isCnRoute ? `${text.fetchingSkus} ${uniqueSkusInCsv.length} ${text.fetchingSkusSuffix}` : `${text.fetchingSkus} ${uniqueSkusInCsv.length} ${text.fetchingSkusSuffix}`, 'info');
        
        const fetchedSkusMap = new Map<string, SKU>();
        
        // Firestore 'in' query limit is 30
        const SKU_CHUNK_SIZE = 30;
        for (let i = 0; i < uniqueSkusInCsv.length; i += SKU_CHUNK_SIZE) {
          const chunk = uniqueSkusInCsv.slice(i, i + SKU_CHUNK_SIZE);
          try {
            if (isCnRoute) {
              const result = await checkImport({ skus: chunk });
              (result.skus as SKU[]).forEach(sku => fetchedSkusMap.set(sku.sku.toUpperCase(), sku));
              continue;
            }
            const q = query(collection(db, 'skus'), where('sku', 'in', chunk));
            const snap = await getDocs(q);
            snap.docs.forEach(doc => {
              const data = doc.data() as SKU;
              fetchedSkusMap.set(data.sku.toUpperCase(), data);
            });
          } catch (err) {
            console.error("Error fetching SKU chunk:", err);
            if (isCnRoute) { setRows([]); addLog("SKU 校验失败，请重新导入。", "error"); return; }
          }
        }
        
        addLog(isCnRoute ? `${text.fetchedSkus} ${fetchedSkusMap.size} ${text.fetchedSkusSuffix}` : `${text.fetchedSkus} ${fetchedSkusMap.size} ${text.fetchedSkusSuffix}`, 'success');

        // 2. Track order metadata for inheritance
        const orderMetadataMap = new Map<string, any>();
        
        // First pass: Collect metadata from rows that have it
        results.data.forEach((row: any) => {
          const bookingNumber = row['booking_number']?.trim();
          if (bookingNumber && row['customer_name']?.trim() && row['customer_ref']?.trim()) {
            if (!orderMetadataMap.has(bookingNumber)) {
              orderMetadataMap.set(bookingNumber, {
                customer_name: row['customer_name'],
                customer_email: row['customer_email'],
                customer_ref: row['customer_ref'],
                customer_id: row['customer_id'],
                scheduled_pickup_date: row['scheduled_pickup_date'],
                store_id: row['store_id'],
                payment_state: row['payment_state'],
                payment_method: row['payment_method'],
                order_note: row['order_note'],
                warehouse_id: row['warehouse_id']
              });
            }
          }
        });

        const processed: ProcessedRow[] = results.data.map((row: any, index: number) => {
          const bookingNumber = row['booking_number']?.trim();
          let enrichedRow = { ...row };

          // If this row is missing metadata but we have it for this booking number, inherit it
          if (bookingNumber && (!row['customer_name']?.trim() || !row['customer_ref']?.trim())) {
            const inherited = orderMetadataMap.get(bookingNumber);
            if (inherited) {
              enrichedRow = { ...enrichedRow, ...inherited };
            }
          }

          const validation = orderRowSchema.safeParse(enrichedRow);
          const errors = validation.success ? [] : validation.error.issues.map(e => `Row ${index + 2}: ${e.message}`);
          
          // Additional store validation
          const storeId = enrichedRow['store_id']?.toUpperCase().replace(/\s+/g, '_');
          if (storeId && availableStoreIds.length > 0 && !availableStoreIds.includes(storeId)) {
            errors.push(`Row ${index + 2}: Store ID "${storeId}" not found in system`);
          }

          // Auto-fill Location and Product Name from the fetched map
          const skuCode = enrichedRow['sku']?.toUpperCase();
          const matchedSku = fetchedSkusMap.get(skuCode);
          if (matchedSku) {
            enrichedRow.productName = matchedSku.productName;
            const warehouse = enrichedRow.warehouse_id?.trim().toUpperCase();
            enrichedRow.location = warehouse ? (matchedSku.locations?.[warehouse] || matchedSku.location) : '';
          }

          return {
            id: Math.random().toString(36).substr(2, 9),
            data: enrichedRow,
            errors,
            isDuplicate: false,
            status: (validation.success && errors.length === 0) ? 'pending' : 'failed',
            rowNumber: index + 2
          };
        });

        setRows(processed);
        void checkDuplicates(processed).catch(error => {
          setRows([]); setIsChecking(false); setProgress(0);
          addLog(error.message || "导入校验失败。", "error");
        });
      },
      error: (err) => {
        addLog(`CSV Parsing Error: ${err.message}`, 'error');
      }
    });
  }, [addLog, availableStoreIds, isCnRoute, token, canCreate]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: isCnRoute ? { 'text/csv': ['.csv'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } : { 'text/csv': ['.csv'] },
    multiple: false
  });

  const checkDuplicates = async (dataRows: ProcessedRow[]) => {
    setIsChecking(true);
    addLog('Starting database duplicate pre-check...', 'info');
    
    const validRows = dataRows.filter(r => r.errors.length === 0);
    const bookingNumbers = validRows.map(r => r.data['booking_number']);
    const customerRefs = validRows.map(r => r.data['customer_ref']);

    const duplicates = new Set<string>();

    // Batch queries in chunks of 30
    const CHUNK_SIZE = 30;
    for (let i = 0; i < bookingNumbers.length; i += CHUNK_SIZE) {
      const bnChunk = bookingNumbers.slice(i, i + CHUNK_SIZE);
      const refChunk = customerRefs.slice(i, i + CHUNK_SIZE);

      if (isCnRoute) {
        const result = await checkImport({
          bookingNumbers: bnChunk.map(value => value.trim().toUpperCase()),
          refs: refChunk.map(value => value.trim().toUpperCase())
        });
        result.bookingNumbers.forEach((value: string) => duplicates.add('bn_' + value));
        result.refs.forEach((value: string) => duplicates.add('ref_' + value));
        continue;
      }
      const bnQuery = query(collection(db, 'orders'), where('bookingNumber', 'in', bnChunk));
      const refQuery = query(collection(db, 'orders'), where('refNumber', 'in', refChunk));

      const [bnSnap, refSnap] = await Promise.all([getDocs(bnQuery), getDocs(refQuery)]);
      
      bnSnap.docs.forEach(doc => duplicates.add(`bn_${doc.data().bookingNumber}`));
      refSnap.docs.forEach(doc => duplicates.add(`ref_${doc.data().refNumber}`));
      
      setProgress(Math.round(((i + CHUNK_SIZE) / bookingNumbers.length) * 50));
    }

    setRows(prev => prev.map(row => {
      const isBnDup = duplicates.has(`bn_${row.data['booking_number'].trim().toUpperCase()}`);
      const isRefDup = duplicates.has(`ref_${row.data['customer_ref'].trim().toUpperCase()}`);
      const isDuplicate = isBnDup || isRefDup;
      
      return {
        ...row,
        isDuplicate,
        status: row.errors.length > 0 ? 'failed' : (isDuplicate ? 'failed' : 'ready')
      };
    }));

    setIsChecking(false);
    setProgress(0);
    addLog('Duplicate check complete', 'success');
  };

  const handleImport = async () => {
    const readyRows = rows.filter(r => r.status === 'ready');
    if (readyRows.length === 0) {
      addLog(text.noValidRows, 'warning');
      return;
    }

    setIsImporting(true);
    addLog(`Starting import of ${readyRows.length} rows...`, 'info');
    setProgress(0);

    try {
      if (!token || !canCreate) throw new Error('Create Order permission required.');
      
      // Group rows by booking_number to handle multi-line orders
      const groupedOrdersMap = new Map<string, any>();
      
      readyRows.forEach(row => {
        const data = row.data;
        const bn = (data['booking_number'] || '').toString().trim().toUpperCase();
        
        if (!bn) return; // Skip if somehow empty

        if (!groupedOrdersMap.has(bn)) {
          groupedOrdersMap.set(bn, {
            booking_number: bn,
            customer_ref: (data['customer_ref'] || '').toString().trim().toUpperCase(),
            customer_name: data['customer_name'] || '',
            customer_id: data['customer_id'] || '',
            customer_email: data['customer_email'] || '',
            store_id: (data['store_id'] || '').toString().toUpperCase().replace(/\s+/g, '_'),
            scheduled_pickup_date: data['scheduled_pickup_date'] || '',
            warehouse_id: (data['warehouse_id'] || '').toString().trim().toUpperCase(),
            payment_state: (data['payment_state'] || '').toString().toLowerCase() === 'paid' ? 'Paid' : 'Unpaid',
            payment_method: data.payment_method || (data['payment_state']?.toLowerCase() === 'unpaid' ? 'Pending' : null),
            order_note: data.order_note || '',
            items: [],
            sendPickupEmail: false,
            rowIds: [] // Track which rows are part of this order
          });
        }
        
        const order = groupedOrdersMap.get(bn);
        order.items.push({
          sku: (data['sku'] || '').toString().toUpperCase(),
          qty: parseInt(data['quantity'] || '0', 10),
          unit_price: parseFloat(data['unit_price'] || '0'),
          productName: data.productName || '',
          location: data.location || ''
        });
        order.rowIds.push(row.id);
      });

      const ordersToCreate = Array.from(groupedOrdersMap.values());
      const BATCH_SIZE = 50;
      let totalSuccess = 0;
      let totalFailed = 0;

      for (let i = 0; i < ordersToCreate.length; i += BATCH_SIZE) {
        const chunkOrders = ordersToCreate.slice(i, i + BATCH_SIZE);
        const payload = chunkOrders.map(({ rowIds, ...order }) => order);

        try {
          const response = await fetch(`${API_BASE_URL}/api/orders/bulk-create`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-v2-auth-token': `Bearer ${token}`
            },
            body: JSON.stringify({ orders: payload })
          });

          const result = await response.json();

          if (response.ok && result.failed === 0) {
            totalSuccess += result.success;
            addLog(`Batch ${Math.floor(i / BATCH_SIZE) + 1} imported successfully (${result.success} orders)`, 'success');
            
            // Mark these rows as success
            const successRowIds = new Set(chunkOrders.flatMap(o => o.rowIds));
            setRows(prev => prev.map(r => {
              if (successRowIds.has(r.id)) {
                return { ...r, status: 'success' };
              }
              return r;
            }));
          } else {
            totalFailed += chunkOrders.length;
            const errorMsg = result.errors?.[0] || result.error || 'Unknown error';
            addLog(`Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${errorMsg}`, 'error');
            
            // Mark these rows as failed
            const failedRowIds = new Set(chunkOrders.flatMap(o => o.rowIds));
            setRows(prev => prev.map(r => {
              if (failedRowIds.has(r.id)) {
                return { ...r, status: 'failed', errors: [...r.errors, errorMsg] };
              }
              return r;
            }));
          }
        } catch (err: any) {
          totalFailed += chunkOrders.length;
          addLog(`Network error in batch ${Math.floor(i / BATCH_SIZE) + 1}: ${err.message}`, 'error');
          const errorRowIds = new Set(chunkOrders.flatMap(o => o.rowIds));
          setRows(prev => prev.map(r => {
            if (errorRowIds.has(r.id)) {
              return { ...r, status: 'failed', errors: [...r.errors, err.message] };
            }
            return r;
          }));
        }
        
        setProgress(Math.round(((i + chunkOrders.length) / ordersToCreate.length) * 100));
      }

      addLog(`Import process finished. Total Orders: ${ordersToCreate.length}, Success: ${totalSuccess}, Failed: ${totalFailed}`, totalSuccess > 0 ? 'success' : 'error');
    } catch (err: any) {
      addLog(`Import process encountered a critical error: ${err.message}`, 'error');
    } finally {
      setIsImporting(false);
    }
  };

  const updateRow = (id: string, field: string, value: string) => {
    setRows(prev => {
      // 1. Update the target row's raw data
      const updatedRows = prev.map(row => {
        if (row.id !== id) return row;
        return { ...row, data: { ...row.data, [field]: value } };
      });

      // 2. Re-collect metadata map from all rows
      const orderMetadataMap = new Map<string, any>();
      updatedRows.forEach(row => {
        const bn = row.data['booking_number']?.trim();
        if (bn && row.data['customer_name']?.trim() && row.data['customer_ref']?.trim()) {
          if (!orderMetadataMap.has(bn)) {
            orderMetadataMap.set(bn, {
              customer_name: row.data['customer_name'],
              customer_email: row.data['customer_email'],
              customer_ref: row.data['customer_ref'],
              customer_id: row.data['customer_id'],
              scheduled_pickup_date: row.data['scheduled_pickup_date'],
              store_id: row.data['store_id'],
              payment_state: row.data['payment_state'],
              payment_method: row.data['payment_method'],
              order_note: row.data['order_note'],
              warehouse_id: row.data['warehouse_id']
            });
          }
        }
      });

      // 3. Re-enrich and re-validate all rows to ensure consistency
      return updatedRows.map(row => {
        const bn = row.data['booking_number']?.trim();
        let enrichedData = { ...row.data };
        
        // If this row is missing metadata but we have it for this booking number, inherit it
        if (bn && (!row.data['customer_name']?.trim() || !row.data['customer_ref']?.trim())) {
          const inherited = orderMetadataMap.get(bn);
          if (inherited) {
            enrichedData = { ...enrichedData, ...inherited };
          }
        }

        const validation = orderRowSchema.safeParse(enrichedData);
        const errors = validation.success ? [] : validation.error.issues.map(e => e.message);
        
        // Additional store validation
        const storeId = enrichedData['store_id']?.toUpperCase().replace(/\s+/g, '_');
        if (storeId && availableStoreIds.length > 0 && !availableStoreIds.includes(storeId)) {
          errors.push(`Store ID "${storeId}" not found in system`);
        }

        return {
          ...row,
          data: enrichedData,
          errors,
          status: (validation.success && errors.length === 0 ? 'pending' : 'failed') as ProcessedRow['status']
        };
      });
    });
  };

  const stats = useMemo(() => {
    const total = rows.length;
    const valid = rows.filter(r => r.errors.length === 0 && !r.isDuplicate).length;
    const invalid = rows.filter(r => r.errors.length > 0).length;
    const duplicates = rows.filter(r => r.isDuplicate).length;
    const success = rows.filter(r => r.status === 'success').length;
    
    // Grouped order count
    const uniqueBookings = new Set(rows.map(r => r.data['booking_number']?.trim().toUpperCase()).filter(Boolean));
    const totalOrders = uniqueBookings.size;
    
    const validBookings = new Set(
      rows.filter(r => r.errors.length === 0 && !r.isDuplicate)
          .map(r => r.data['booking_number']?.trim().toUpperCase())
          .filter(Boolean)
    );
    const readyOrders = validBookings.size;

    return { total, valid, invalid, duplicates, success, totalOrders, readyOrders };
  }, [rows]);

  const filteredRows = useMemo(() => {
    switch (activeTab) {
      case 'valid': return rows.filter(r => r.errors.length === 0 && !r.isDuplicate);
      case 'invalid': return rows.filter(r => r.errors.length > 0);
      case 'duplicate': return rows.filter(r => r.isDuplicate);
      default: return rows;
    }
  }, [rows, activeTab]);

  if (isCnRoute && !canCreate) return <p role="alert" className="p-6">此账号没有创建订单权限。</p>;

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        compact={isCnRoute}
        title={text.title}
        subtitle={isCnRoute ? undefined : 'Import orders using CSV with atomic transaction safety'}
        icon={Upload}
        isScrolled={isScrolled}
        backButton={
          <Link to={ordersBasePath} className="p-2 hover:bg-slate-100 rounded-full transition-colors block">
            <ArrowLeft className="w-6 h-6 text-slate-500" />
          </Link>
        }
        actions={
          <>
            <button
              onClick={downloadTemplate}
              className="px-3 py-1.5 text-indigo-600 hover:bg-indigo-50 rounded-xl transition-all flex items-center gap-2 text-sm font-bold"
            >
              <Download className="w-4 h-4" />
              {text.downloadTemplate}
            </button>
            <button
              onClick={() => setRows([])}
              className="px-3 py-1.5 text-slate-600 hover:bg-slate-50 rounded-xl transition-all flex items-center gap-2 text-sm"
            >
              <Trash2 className="w-4 h-4" />
              {text.clear}
            </button>
            <button
              onClick={handleImport}
              disabled={isImporting || isChecking || stats.readyOrders === 0}
              className="px-5 py-1.5 bg-indigo-600 text-white rounded-xl font-semibold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2 shadow-lg shadow-indigo-200 text-sm"
            >
              {isImporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
              {text.startImport} ({stats.readyOrders} {text.ordersUnit})
            </button>
          </>
        }
      />

      {/* Content Area (Scrolling) */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-[1600px] mx-auto space-y-6">

        {/* Main Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          
          {/* Left Pane: Health Summary */}
          <div className="lg:col-span-3 space-y-6">
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-6">
              <h2 className="font-bold text-slate-900 flex items-center gap-2">
                <Database className="w-5 h-5 text-indigo-600" />
                {text.dataHealth}
              </h2>

              <div className="space-y-3">
                <button 
                  onClick={() => setActiveTab('all')}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-xl transition-all border",
                    activeTab === 'all' ? "bg-indigo-50 border-indigo-200 text-indigo-700" : "bg-slate-50 border-transparent text-slate-600 hover:bg-white hover:border-slate-200"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    {text.totalRows}
                  </span>
                  <span className="font-bold">{stats.total}</span>
                </button>

                <div className="px-3 py-1 flex items-center justify-between text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                  <span>{text.groupedOrders}</span>
                  <span>{stats.totalOrders}</span>
                </div>

                <button 
                  onClick={() => setActiveTab('valid')}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-xl transition-all border",
                    activeTab === 'valid' ? "bg-emerald-50 border-emerald-200 text-emerald-700" : "bg-slate-50 border-transparent text-slate-600 hover:bg-white hover:border-slate-200"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    {text.readyOrders}
                  </span>
                  <span className="font-bold">{stats.readyOrders}</span>
                </button>

                <button 
                  onClick={() => setActiveTab('duplicate')}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-xl transition-all border",
                    activeTab === 'duplicate' ? "bg-amber-50 border-amber-200 text-amber-700" : "bg-slate-50 border-transparent text-slate-600 hover:bg-white hover:border-slate-200"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    {text.duplicates}
                  </span>
                  <span className="font-bold">{stats.duplicates}</span>
                </button>

                <button 
                  onClick={() => setActiveTab('invalid')}
                  className={cn(
                    "w-full flex items-center justify-between p-3 rounded-xl transition-all border",
                    activeTab === 'invalid' ? "bg-red-50 border-red-200 text-red-700" : "bg-slate-50 border-transparent text-slate-600 hover:bg-white hover:border-slate-200"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    {text.invalidRows}
                  </span>
                  <span className="font-bold">{stats.invalid}</span>
                </button>
              </div>

              {stats.success > 0 && (
                <div className="pt-4 border-t border-slate-100">
                  <div className="flex items-center justify-between text-emerald-600 font-bold">
                    <span>{text.successImported}</span>
                    <span>{stats.success}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Dropzone */}
            <div 
              {...getRootProps()} 
              className={cn(
                "border-2 border-dashed rounded-2xl p-8 text-center transition-all cursor-pointer",
                isDragActive ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white hover:border-indigo-400"
              )}
            >
              <input {...getInputProps()} />
              <Upload className="w-10 h-10 text-slate-400 mx-auto mb-4" />
              <p className="text-slate-600 font-medium">{text.dragDrop}</p>
              <p className="text-slate-400 text-sm mt-1">{text.browse}</p>
            </div>

            {/* Import Rules Info */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center gap-2 text-sm">
                <Info className="w-4 h-4 text-indigo-600" />
                {text.importRules}
              </h3>
              <div className="space-y-3 text-xs text-slate-600">
                <div className="p-3 bg-slate-50 rounded-xl space-y-2">
                  <p className="font-bold text-slate-900">{text.fixedFields}</p>
                  <ul className="list-disc list-inside space-y-1">
                    <li>{text.storeRule}</li>
                    <li>{text.paymentStateRule}</li>
                    <li><span className="font-semibold">{text.paymentMethodRule}</span>
                      <ul className="pl-4 mt-1 list-circle space-y-1">
                        <li>{text.paymentPaidRule}</li>
                        <li>{text.paymentUnpaidRule}</li>
                      </ul>
                    </li>
                    <li>{text.warehouseRule}</li>
                  </ul>
                </div>
                <p className="italic text-[10px]">{text.note}</p>
              </div>
            </div>
          </div>

          {/* Middle Pane: Interactive Table */}
          <div className="lg:col-span-6 space-y-6">
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden flex flex-col min-h-[600px]">
              <div className="px-6 py-4 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
                <h3 className="font-bold text-slate-900">{text.dataPreview}</h3>
                {isChecking && (
                  <div className="flex items-center gap-2 text-indigo-600 text-sm font-medium animate-pulse">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {text.checkingDuplicates}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-auto">
                {rows.length === 0 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-400 p-12">
                    <FileText className="w-16 h-16 mb-4 opacity-20" />
                    <p>{text.noData}</p>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse">
                    <thead className="sticky top-0 bg-white shadow-sm z-10">
                      <tr className="text-xs font-bold text-slate-500 uppercase tracking-wider border-b border-slate-100">
                        <th className="px-4 py-3 w-12">#</th>
                        <th className="px-4 py-3">{text.booking}</th>
                        <th className="px-4 py-3">{text.customer}</th>
                        <th className="px-4 py-3">{text.ref}</th>
                        <th className="px-4 py-3">{text.email}</th>
                        <th className="px-4 py-3">{text.status}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {filteredRows.map((row) => (
                        <tr 
                          key={row.id} 
                          className={cn(
                            "group hover:bg-slate-50 transition-colors",
                            row.isDuplicate ? "bg-amber-50/30" : row.errors.length > 0 ? "bg-red-50/30" : ""
                          )}
                        >
                          <td className="px-4 py-3 text-xs text-slate-400">{row.rowNumber}</td>
                          <td className="px-4 py-3">
                            <input 
                              type="text"
                              value={row.data['booking_number']}
                              onChange={(e) => updateRow(row.id, 'booking_number', e.target.value)}
                              className={cn(
                                "w-full bg-transparent border-none p-0 focus:ring-0 text-sm font-medium",
                                row.isDuplicate ? "text-amber-700" : "text-slate-900"
                              )}
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input 
                              type="text"
                              value={row.data['customer_name']}
                              onChange={(e) => updateRow(row.id, 'customer_name', e.target.value)}
                              className="w-full bg-transparent border-none p-0 focus:ring-0 text-sm text-slate-600"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input 
                              type="text"
                              value={row.data['customer_ref']}
                              onChange={(e) => updateRow(row.id, 'customer_ref', e.target.value)}
                              className="w-full bg-transparent border-none p-0 focus:ring-0 text-sm text-slate-600"
                            />
                          </td>
                          <td className="px-4 py-3">
                            <input 
                              type="text"
                              value={row.data['customer_email']}
                              onChange={(e) => updateRow(row.id, 'customer_email', e.target.value)}
                              className={cn(
                                "w-full bg-transparent border-none p-0 focus:ring-0 text-sm",
                                row.errors.some(e => e.includes('Email')) ? "text-red-600" : "text-slate-600"
                              )}
                            />
                          </td>
                          <td className="px-4 py-3">
                            {row.status === 'success' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-100 text-emerald-700 text-[10px] font-bold uppercase">
                                <CheckCircle2 className="w-3 h-3" />
                                {text.success}
                              </span>
                            ) : row.isDuplicate ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-amber-100 text-amber-700 text-[10px] font-bold uppercase">
                                <AlertTriangle className="w-3 h-3" />
                                {text.duplicate}
                              </span>
                            ) : row.errors.length > 0 ? (
                              <div className="group relative">
                                <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-red-100 text-red-700 text-[10px] font-bold uppercase cursor-help">
                                  <AlertCircle className="w-3 h-3" />
                                  {text.error}
                                </span>
                                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 p-2 bg-slate-900 text-white text-[10px] rounded shadow-xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20">
                                  {row.errors.join(', ')}
                                </div>
                              </div>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-indigo-100 text-indigo-700 text-[10px] font-bold uppercase">
                                {text.ready}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              {/* Progress Bar */}
              {(isImporting || isChecking) && (
                <div className="h-1 bg-slate-100 w-full">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${progress}%` }}
                    className="h-full bg-indigo-600"
                  />
                </div>
              )}
            </div>
          </div>

          {/* Right Pane: Log Window */}
          <div className="lg:col-span-3 space-y-6">
            {(profile?.roleTemplate === 'Admin') ? (
              <div className="bg-slate-900 rounded-2xl border border-slate-800 shadow-xl overflow-hidden flex flex-col h-[600px]">
                <div className="px-6 py-4 border-b border-slate-800 bg-slate-800/50 flex items-center justify-between">
                  <h3 className="font-bold text-white flex items-center gap-2">
                    <History className="w-5 h-5 text-indigo-400" />
                    {text.processLogs}
                  </h3>
                  <button 
                    onClick={() => setLogs([])}
                    className="text-slate-400 hover:text-white text-xs"
                  >
                    {text.clear}
                  </button>
                </div>

                <div className="flex-1 overflow-auto p-4 font-mono text-xs space-y-2">
                  {logs.length === 0 ? (
                    <div className="text-slate-600 italic">{text.waitingActivity}</div>
                  ) : (
                    <AnimatePresence initial={false}>
                      {logs.map((log, i) => (
                        <motion.div 
                          key={i}
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className={cn(
                            "flex gap-3",
                            log.type === 'error' ? "text-red-400" : 
                            log.type === 'success' ? "text-emerald-400" : 
                            log.type === 'warning' ? "text-amber-400" : "text-slate-300"
                          )}
                        >
                          <span className="text-slate-600 shrink-0">[{log.timestamp}]</span>
                          <span>{log.message}</span>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  )}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center h-[600px] flex flex-col items-center justify-center">
                <History className="w-12 h-12 text-slate-200 mb-4" />
                <h3 className="font-bold text-slate-900 mb-2">{text.processLogs}</h3>
                <p className="text-slate-500 text-sm">{text.adminOnlyLogs}</p>
              </div>
            )}

            {/* Template Guide Card */}
            <div className="bg-white rounded-2xl p-6 border border-slate-200 shadow-sm">
              <div className="flex items-center gap-3 mb-6">
                <div className="p-2 bg-indigo-50 rounded-lg">
                  <Info className="w-5 h-5 text-indigo-600" />
                </div>
                <h3 className="font-bold text-slate-900">{text.templateGuide}</h3>
              </div>
              
              <div className="space-y-6">
                <div className="flex gap-4">
                  <div className="w-1.5 h-auto bg-blue-500 rounded-full shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-blue-700 uppercase tracking-wider mb-1.5">{text.orderInfoArea}</p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {['booking_number', 'customer_name', 'email', 'ref', 'store_id'].map(f => (
                        <span key={f} className="text-[10px] font-mono bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 text-blue-600">{f}</span>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      {text.bookingRule}
                    </p>
                  </div>
                </div>
                
                <div className="flex gap-4">
                  <div className="w-1.5 h-auto bg-amber-500 rounded-full shrink-0" />
                  <div>
                    <p className="text-xs font-bold text-amber-700 uppercase tracking-wider mb-1.5">{text.productArea}</p>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {['sku', 'quantity', 'unit_price'].map(f => (
                        <span key={f} className="text-[10px] font-mono bg-amber-50 px-1.5 py-0.5 rounded border border-amber-100 text-amber-600">{f}</span>
                      ))}
                    </div>
                    <p className="text-[11px] text-slate-500 leading-relaxed">
                      {text.productRule}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    </div>
  );
};
