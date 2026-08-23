import React, { useState, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { 
  doc, 
  getDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  orderBy,
  limit
} from 'firebase/firestore';
import { db } from '../firebase';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { 
  Order, 
  OrderItem, 
  SKU, 
  Store, 
  OperationLog, 
  PaymentStatus, 
  PaymentMethod,
  OrderStatus,
  WarehouseStatus
} from '../types';
import { 
  ArrowLeft, 
  Edit, 
  Trash2, 
  Printer, 
  CheckCircle, 
  XCircle, 
  Clock, 
  CreditCard, 
  User, 
  Calendar, 
  FileText, 
  Plus, 
  Search,
  Save,
  X,
  AlertCircle,
  PenTool,
  Monitor,
  Smartphone,
  ShoppingCart,
  AlertTriangle,
  Info,
  Mail,
  Send,
  MessageSquare
} from 'lucide-react';
import { formatDate, hasPermission, cn, getSkuWarehouseLocation } from '../utils';
import { motion, AnimatePresence } from 'motion/react';
import SignatureCanvas from 'react-signature-canvas';
import html2canvas from 'html2canvas-pro';
import { io, Socket } from 'socket.io-client';
import { API_BASE_URL, CN_API_ONLY } from '../constants';

import { PageHeader } from '../components/PageHeader';

export const OrderDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { profile, user, activeWarehouse, token } = useAuth();
  const ordersBasePath = location.pathname.startsWith('/cn') ? '/cn/orders' : '/orders';
  const isCnApiMode = location.pathname.startsWith('/cn');
  const cnText = {
    backToOrders: isCnApiMode ? '返回订单列表' : 'Back to Orders',
    edit: isCnApiMode ? '编辑' : 'Edit',
    print: isCnApiMode ? '打印' : 'Print',
    requestPicking: isCnApiMode ? '请求拣货' : 'Request Picking',
    confirmPickup: isCnApiMode ? '确认提货' : 'Confirm Pickup',
    submitForFinalization: isCnApiMode ? '提交终审' : 'Submit For Finalization',
    finalizePartialPickup: isCnApiMode ? '完成部分提货' : 'Finalize Partial Pickup',
    markReviewed: isCnApiMode ? '标记已审核' : 'Mark Reviewed',
    cancel: isCnApiMode ? '取消订单' : 'Cancel',
    ref: isCnApiMode ? '参考号' : 'Ref'
  };
  
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [isPaymentEditing, setIsPaymentEditing] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [logs, setLogs] = useState<OperationLog[]>([]);
  const [paymentForm, setPaymentForm] = useState<{ paymentStatus: PaymentStatus; paymentMethod: PaymentMethod | '' }>({
    paymentStatus: 'Unpaid',
    paymentMethod: ''
  });
  
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
    type: 'danger' | 'info';
  } | null>(null);
  
  // Signature State
  const [showSignatureModal, setShowSignatureModal] = useState(false);
  const signatureRef = React.useRef<SignatureCanvas>(null);
  const [signatureLoading, setSignatureLoading] = useState(false);
  const [showPickupItemsModal, setShowPickupItemsModal] = useState(false);
  const [pickupSelections, setPickupSelections] = useState<boolean[]>([]);
  const [partialPickupReason, setPartialPickupReason] = useState('');
  const [partialFlowLoading, setPartialFlowLoading] = useState(false);
  
  // Socket State
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isGuestOnline, setIsGuestOnline] = useState(false);
  const [isProjecting, setIsProjecting] = useState(false);
  const [receivedRemoteSignature, setReceivedRemoteSignature] = useState<string | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);
  
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
  
  // Edit Form State
  const [editForm, setEditForm] = useState<Partial<Order>>({});
  const [skuSearch, setSkuSearch] = useState('');
  const [skuResults, setSkuResults] = useState<SKU[]>([]);
  const [showSkuResults, setShowSkuResults] = useState(false);

  useEffect(() => {
    if (isCnApiMode && !token) return;
    fetchOrder();
    fetchStores();
    if (id) fetchLogs(id);
  }, [id, token, isCnApiMode]);

  // Socket setup for signature projection
  useEffect(() => {
    if (!order) return;

    const newSocket = io(API_BASE_URL);
    setSocket(newSocket);

    const pairingPassword = localStorage.getItem('pairing_password');
    const roomId = pairingPassword ? `pair_${pairingPassword}` : `store_${order.storeId}`;

    newSocket.on('connect', () => {
      newSocket.emit('join-room', roomId);
      // Check if guest is already online
      newSocket.emit('check-guest-presence', roomId);
    });

    newSocket.on('guest-online', () => {
      setIsGuestOnline(true);
    });

    newSocket.on('signature-received', (data: { signatureData: string }) => {
      if (data.signatureData) {
        setReceivedRemoteSignature(data.signatureData);
        setIsProjecting(false);
      }
    });

    newSocket.on('reset-guest-display', () => {
      setIsProjecting(false);
    });

    return () => {
      newSocket.disconnect();
    };
  }, [order?.id]);

  const getSelectedPickupIndexes = () => {
    if (!order?.items?.length) return [];
    if (pickupSelections.length !== order.items.length) {
      return order.items.map((_, index) => index);
    }
    return pickupSelections
      .map((selected, index) => (selected ? index : -1))
      .filter(index => index >= 0);
  };

  const startPickupConfirmationFlow = () => {
    if (!order) return;

    if (order.status !== 'Created') {
      alert('Only orders with Created status can be confirmed for pickup.');
      return;
    }

    if (order.paymentStatus !== 'Paid') {
      alert('Order must be paid before it can be confirmed for pickup.');
      return;
    }

    if (order.pickupExceptionStatus) {
      alert('This order is already in partial pickup exception flow.');
      return;
    }

    setPickupSelections((order.items || []).map(() => true));
    setPartialPickupReason('');
    setShowPickupItemsModal(true);
  };

  const continueToSignatureStep = () => {
    if (!order) return;
    const selectedIndexes = getSelectedPickupIndexes();
    if (!selectedIndexes.length) {
      alert('Please select at least one picked item.');
      return;
    }

    const isPartial = selectedIndexes.length < (order.items || []).length;
    if (isPartial && !partialPickupReason.trim()) {
      alert('Please provide a reason for partial pickup.');
      return;
    }

    setShowPickupItemsModal(false);
    setShowSignatureModal(true);
  };

  const handleSaveRemoteSignature = async () => {
    if (!id || !profile || !order || !receivedRemoteSignature || !token) return;
    
    try {
      setSignatureLoading(true);
      
      const selectedIndexes = getSelectedPickupIndexes();
      const response = await fetch('/api/orders/confirm-pickup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          signatureData: receivedRemoteSignature,
          pickedItemIndexes: selectedIndexes,
          partialReason: partialPickupReason.trim() || null
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to save remote signature');
      }
      
      setShowSignatureModal(false);
      setPickupSelections([]);
      setPartialPickupReason('');
      setReceivedRemoteSignature(null);
      fetchOrder();
      fetchLogs(id);
    } catch (err: any) {
      console.error('Error saving remote signature:', err);
      alert(err.message || 'Failed to save remote signature');
    } finally {
      setSignatureLoading(false);
    }
  };

  const handleClearRemoteSignature = () => {
    setReceivedRemoteSignature(null);
    // Optionally re-project immediately
    handleProjectSignature();
  };

  const handleProjectSignature = () => {
    if (!socket || !order) return;
    
    const pairingPassword = localStorage.getItem('pairing_password');
    const roomId = pairingPassword ? `pair_${pairingPassword}` : `store_${order.storeId}`;

    setIsProjecting(true);
    socket.emit('request-signature', {
      orderId: order.id,
      bookingNumber: order.bookingNumber,
      customerName: order.customerName,
      storeId: roomId
    });
  };

  const handleCancelProjection = () => {
    if (!socket || !order) return;
    const pairingPassword = localStorage.getItem('pairing_password');
    const roomId = pairingPassword ? `pair_${pairingPassword}` : `store_${order.storeId}`;
    socket.emit('cancel-signature', roomId);
    setIsProjecting(false);
  };

  const fetchOrder = async () => {
    if (!id) return;
    try {
      setLoading(true);
      if (isCnApiMode) {
        if (!token) return;
        const response = await fetch(`${API_BASE_URL}/api/orders/detail/${id}`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          }
        });
        const data = await response.json();
        if (!data.success) {
          throw new Error(data.error || 'Failed to load order details');
        }
        const orderData = data.order as Order;
        setOrder(orderData);
        setEditForm(orderData);
        return;
      }
      const docRef = doc(db, 'orders', id);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        const orderData = { id: docSnap.id, ...docSnap.data() } as Order;
        
        // Enrich items with SKU data if missing (for legacy or bulk imported orders)
        const enrichedItems = [...(orderData.items || [])];
        let needsEnrichment = false;
        
        for (let i = 0; i < enrichedItems.length; i++) {
          const item = enrichedItems[i];
          if (!item.productName || !item.location || item.location === 'N/A') {
            needsEnrichment = true;
            try {
              const skuRef = doc(db, 'skus', item.sku.replace(/\//g, '_'));
              const skuSnap = await getDoc(skuRef);
              if (skuSnap.exists()) {
                const skuData = skuSnap.data();
                enrichedItems[i] = {
                  ...item,
                  productName: item.productName || skuData.productName || '',
                  location: (item.location && item.location !== 'N/A') ? item.location : getSkuWarehouseLocation(skuData, activeWarehouse)
                };
              }
            } catch (err) {
              console.error(`Error enriching SKU ${item.sku}:`, err);
            }
          }
        }

        const finalOrderData = needsEnrichment ? { ...orderData, items: enrichedItems } : orderData;

        // Warehouse Isolation Check (unified pool): check against user allowed warehouses,
        // not the currently selected warehouse tab.
        const isSuper = profile?.allowedWarehouses?.includes('*');
        const orderWarehouse = finalOrderData.warehouseId || null;
        const allowedWarehouses = profile?.allowedWarehouses || [];
        if (!isSuper && orderWarehouse && allowedWarehouses.length > 0 && !allowedWarehouses.includes(orderWarehouse)) {
          setError('Access Denied: You do not have permission for this warehouse');
          setLoading(false);
          return;
        }

        setOrder(finalOrderData);
        setEditForm(finalOrderData);
      } else {
        setError('Order not found');
      }
    } catch (err) {
      console.error('Error fetching order:', err);
      // NZ keeps Firestore as primary path; fallback to API when Firestore access is blocked.
      if (!isCnApiMode && token) {
        try {
          const response = await fetch(`${API_BASE_URL}/api/orders/detail/${id}`, {
            headers: {
              'x-v2-auth-token': `Bearer ${token}`,
              'x-warehouse-id': activeWarehouse || ''
            }
          });
          const data = await response.json();
          if (data.success && data.order) {
            const orderData = data.order as Order;
            setOrder(orderData);
            setEditForm(orderData);
            setError(null);
            return;
          }
        } catch (fallbackErr) {
          console.error('Order detail API fallback failed:', fallbackErr);
        }
      }
      setError('Failed to load order details');
    } finally {
      setLoading(false);
    }
  };

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
        setStores((data.stores || []) as Store[]);
        return;
      }
      const querySnapshot = await getDocs(collection(db, 'stores'));
      const storesData = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store));
      setStores(storesData);
    } catch (err) {
      console.error('Error fetching stores:', err);
    }
  };

  const fetchLogs = async (orderId: string) => {
    try {
      // Use API-first for logs to avoid Firestore log-read permission mismatches
      // (e.g. Reception role without global View Logs claim).
      if (token) {
        const response = await fetch(`${API_BASE_URL}/api/logs/order/${orderId}?limit=300`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          }
        });
        const data = await response.json();
        if (data.success) {
          setLogs((data.logs || []) as OperationLog[]);
          return;
        }
      }
      if (isCnApiMode) return;
      const q = query(
        collection(db, 'logs'),
        where('orderId', '==', orderId)
      );
      const querySnapshot = await getDocs(q);
      const logsData = querySnapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as OperationLog))
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      setLogs(logsData);
    } catch (err) {
      console.error('Error fetching logs:', err);
      // NZ keeps Firestore as primary path; fallback to API when Firestore access is blocked.
      if (!isCnApiMode && token) {
        try {
          const response = await fetch(`${API_BASE_URL}/api/logs/order/${orderId}?limit=300`, {
            headers: {
              'x-v2-auth-token': `Bearer ${token}`,
              'x-warehouse-id': activeWarehouse || ''
            }
          });
          const data = await response.json();
          if (data.success) {
            setLogs((data.logs || []) as OperationLog[]);
            return;
          }
        } catch (fallbackErr) {
          console.error('Order logs API fallback failed:', fallbackErr);
        }
      }
    }
  };

  const handleUpdateOrder = async () => {
    if (!id || !profile || !order || !token) return;
    if (order.status === 'Picked Up' || order.status === 'Reviewed') {
      alert('Picked Up / Reviewed orders cannot be modified.');
      setIsEditing(false);
      return;
    }
    
    try {
      // Handle payment metadata
      const updatedData = { ...editForm };
      
      // Recalculate totalAmount
      if (updatedData.items) {
        updatedData.totalAmount = updatedData.items.reduce((sum, item) => sum + (item.qty * (item.unit_price || 0)), 0);
      }

      if (editForm.paymentStatus === 'Paid' && order.paymentStatus === 'Unpaid') {
        updatedData.paymentTime = new Date().toISOString();
        updatedData.paymentBy = profile.name;
      } else if (editForm.paymentStatus === 'Unpaid' && order.paymentStatus === 'Paid') {
        updatedData.paymentTime = null;
        updatedData.paymentBy = null;
        updatedData.paymentMethod = null;
      }

      const response = await fetch('/api/orders/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          updateData: updatedData
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to update order');
      }
      
      setIsEditing(false);
      fetchOrder();
      fetchLogs(id);
    } catch (err: any) {
      console.error('Error updating order:', err);
      alert(err.message || 'Failed to update order');
    }
  };

  const openPaymentEditor = () => {
    if (!order) return;
    if (order.status === 'Picked Up' || order.status === 'Reviewed') {
      alert('Picked Up / Reviewed orders cannot update payment.');
      return;
    }
    setPaymentForm({
      paymentStatus: order.paymentStatus || 'Unpaid',
      paymentMethod: (order.paymentMethod as PaymentMethod) || ''
    });
    setIsPaymentEditing(true);
  };

  const handleUpdatePayment = async () => {
    if (!id || !profile || !order || !token) return;
    if (order.status === 'Picked Up' || order.status === 'Reviewed') {
      alert('Picked Up / Reviewed orders cannot update payment.');
      setIsPaymentEditing(false);
      return;
    }

    const updateData: any = {
      paymentStatus: paymentForm.paymentStatus,
      paymentMethod: paymentForm.paymentStatus === 'Paid' ? (paymentForm.paymentMethod || null) : null
    };

    if (paymentForm.paymentStatus === 'Paid' && order.paymentStatus === 'Unpaid') {
      updateData.paymentTime = new Date().toISOString();
      updateData.paymentBy = profile.name;
    } else if (paymentForm.paymentStatus === 'Unpaid' && order.paymentStatus === 'Paid') {
      updateData.paymentTime = null;
      updateData.paymentBy = null;
    } else if (paymentForm.paymentStatus === 'Paid' && order.paymentStatus === 'Paid') {
      updateData.paymentTime = order.paymentTime || new Date().toISOString();
      updateData.paymentBy = order.paymentBy || profile.name;
    }

    try {
      const response = await fetch('/api/orders/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          updateData
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to update payment');
      }

      setIsPaymentEditing(false);
      fetchOrder();
      fetchLogs(id);
    } catch (err: any) {
      console.error('Error updating payment:', err);
      alert(err.message || 'Failed to update payment');
    }
  };

  const handleStatusChange = async (newStatus: OrderStatus) => {
    if (!id || !profile || !order) {
      console.warn('Cannot update status: missing context', { id, hasProfile: !!profile, hasOrder: !!order });
      return;
    }
    
    // Rule: Order must be paid before pickup
    if (newStatus === 'Picked Up' && order.paymentStatus !== 'Paid') {
      alert('Order must be paid before it can be confirmed for pickup.');
      return;
    }

    // Rule: Only picked up orders can be reviewed
    if (newStatus === 'Reviewed' && order.status !== 'Picked Up') {
      alert('Only orders that have been picked up can be marked as reviewed.');
      return;
    }

    // Rule: Only unpaid orders can be cancelled
    if (newStatus === 'Cancelled') {
      if (order.paymentStatus === 'Paid') {
      alert('Only unpaid orders can be cancelled. Please use Update Payment to set status to Unpaid first.');
      return;
      }
      
      setConfirmAction({
        title: 'Cancel Order',
        message: 'Are you sure you want to cancel this order? This action cannot be undone.',
        type: 'danger',
        onConfirm: () => executeStatusUpdate(newStatus)
      });
      setShowConfirmModal(true);
      return;
    }

    executeStatusUpdate(newStatus);
  };

  const executeStatusUpdate = async (newStatus: OrderStatus) => {
    if (!id || !profile || !order) return;
    
    // Rule: Confirm pickup requires signature
    if (newStatus === 'Picked Up') {
      setShowSignatureModal(true);
      return;
    }
    
    try {
      const response = await fetch('/api/orders/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          updateData: { status: newStatus }
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to update status');
      }

      fetchOrder();
      fetchLogs(id);
    } catch (err: any) {
      console.error('Error updating status:', err);
      alert(err.message || 'Failed to update status');
    }
  };

  const handleRequestPicking = async () => {
    if (!id || !profile || !order || !token) return;

    try {
      const response = await fetch('/api/orders/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          updateData: { 
            warehouseStatus: 'Pending',
            'pickingLog.requestedAt': new Date().toISOString()
          }
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to request picking');
      }

      fetchOrder();
      fetchLogs(id);
    } catch (err: any) {
      console.error('Error requesting picking:', err);
      alert(err.message || 'Failed to request picking');
    }
  };

  const handleSendEmail = async () => {
    if (!id || !order || !token || !profile) return;
    
    setSendingEmail(true);
    try {
      if (!order.customerEmail) {
        throw new Error("Missing customer email address");
      }
      const response = await fetch(`${API_BASE_URL}/api/orders/send-notification`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'Authorization': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          type: 'pickup_notification'
        }),
        mode: 'cors'
      });

      const result = await response.json();
      if (result.success && result.emailStatus === 'sent') {
        alert('Pickup email sent successfully!');
        fetchOrder();
        fetchLogs(id);
      } else if (result.success && result.emailStatus === 'skipped') {
        alert(`Email skipped: ${result.message}`);
      } else {
        throw new Error(result.error || 'Failed to send email');
      }
    } catch (err: any) {
      console.error('Error sending email:', err);
      alert(err.message || 'Failed to send email');
    } finally {
      setSendingEmail(false);
    }
  };

  const handleMarkPartialReady = async () => {
    if (!id || !token || !order) return;
    if (order.pickupExceptionStatus !== 'PartialPendingSales') return;

    try {
      setPartialFlowLoading(true);
      const response = await fetch('/api/orders/partial-pickup/mark-ready', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({ orderId: id })
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to mark partial pickup ready for finalization');
      }
      fetchOrder();
      fetchLogs(id);
      alert('Order is now Pending Finalize. Authorized users can finalize it into Picked Up.');
    } catch (err: any) {
      console.error('Error marking partial pickup ready:', err);
      alert(err.message || 'Failed to mark partial pickup ready');
    } finally {
      setPartialFlowLoading(false);
    }
  };

  const handleFinalizePartialPickup = async () => {
    if (!id || !token || !order) return;
    if (order.pickupExceptionStatus !== 'PendingFinalize') return;

    if (!window.confirm('Finalize this exception order into Picked Up?')) {
      return;
    }

    try {
      setPartialFlowLoading(true);
      const response = await fetch('/api/orders/partial-pickup/finalize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({ orderId: id })
      });
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to finalize partial pickup');
      }
      fetchOrder();
      fetchLogs(id);
      alert('Order finalized as Picked Up.');
    } catch (err: any) {
      console.error('Error finalizing partial pickup:', err);
      alert(err.message || 'Failed to finalize partial pickup');
    } finally {
      setPartialFlowLoading(false);
    }
  };

  const signatureAreaRef = React.useRef<HTMLDivElement>(null);

  const handleConfirmPickup = async () => {
    if (!id || !profile || !order || !signatureRef.current || !token) return;
    
    if (signatureRef.current.isEmpty()) {
      alert('Please provide a signature to confirm pickup.');
      return;
    }

    const selectedIndexes = getSelectedPickupIndexes();
    if (!selectedIndexes.length) {
      alert('Please select at least one picked item.');
      return;
    }
    const isPartialPickup = selectedIndexes.length < (order.items || []).length;

    // Warning if warehouse hasn't picked yet
    if (order.warehouseStatus !== 'Picked') {
      if (!window.confirm('Warehouse has not marked this order as "Ready". Are you sure you want to confirm pickup?')) {
        return;
      }
    }

    try {
      setSignatureLoading(true);
      
      let signatureData = '';
      if (signatureAreaRef.current) {
        const canvas = await html2canvas(signatureAreaRef.current, {
          backgroundColor: '#ffffff',
          scale: 2,
          logging: false
        });
        signatureData = canvas.toDataURL('image/png');
      } else {
        signatureData = signatureRef.current.toDataURL();
      }
      
      const response = await fetch('/api/orders/confirm-pickup', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          signatureData: signatureData,
          pickedItemIndexes: selectedIndexes,
          partialReason: partialPickupReason.trim() || null
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to confirm pickup');
      }

      setShowSignatureModal(false);
      setPickupSelections([]);
      setPartialPickupReason('');
      fetchOrder();
      fetchLogs(id);
      if (isPartialPickup) {
        alert('Partial pickup recorded. Sales can now resolve and submit for finalization.');
      }
    } catch (err: any) {
      console.error('Error confirming pickup:', err);
      alert(err.message || 'Failed to confirm pickup');
    } finally {
      setSignatureLoading(false);
    }
  };

  const handlePrint = async () => {
    if (!id || !profile || !order || !token) return;
    
    try {
      const response = await fetch('/api/orders/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          orderId: id,
          updateData: {
            printedTime: new Date().toISOString(),
            printedBy: profile.name
          }
        })
      });

      const data = await response.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to update print status');
      }
      
      fetchOrder();
      fetchLogs(id);
      
      window.print();
    } catch (err) {
      console.error('Error updating print status:', err);
    }
  };

  const searchSKU = async (term: string) => {
    setSkuSearch(term);
    if (term.length < 2) {
      setSkuResults([]);
      setShowSkuResults(false);
      return;
    }

    try {
      if (isCnApiMode) {
        if (!token) return;
        const params = new URLSearchParams({ q: term, limit: '50' });
        const response = await fetch(`${API_BASE_URL}/api/skus/search?${params.toString()}`, {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse || ''
          }
        });
        const data = await response.json();
        if (!data.success) throw new Error(data.error || 'Failed to search SKU');
        setSkuResults((data.skus || []) as SKU[]);
        setShowSkuResults(true);
        return;
      }
      const q = query(
        collection(db, 'skus'),
        where('sku', '>=', term.toUpperCase()),
        where('sku', '<=', term.toUpperCase() + '\uf8ff')
      );
      const querySnapshot = await getDocs(q);
      const results = querySnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SKU));
      setSkuResults(results);
      setShowSkuResults(true);
    } catch (err) {
      console.error('Error searching SKU:', err);
    }
  };

  const addItem = (sku: SKU) => {
    const newItem: OrderItem = {
      sku: sku.sku,
      productName: sku.productName,
      location: sku.location,
      qty: 1,
      unit_price: 0
    };
    
    setEditForm(prev => ({
      ...prev,
      items: [...(prev.items || []), newItem]
    }));
    setSkuSearch('');
    setShowSkuResults(false);
  };

  const addManualItem = () => {
    const newItem: OrderItem = {
      sku: skuSearch.toUpperCase() || 'CUSTOM-SKU',
      productName: 'Custom Product',
      location: 'N/A',
      qty: 1,
      unit_price: 0
    };
    
    setEditForm(prev => ({
      ...prev,
      items: [...(prev.items || []), newItem]
    }));
    setSkuSearch('');
    setShowSkuResults(false);
  };

  const removeItem = (index: number) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.filter((_, i) => i !== index)
    }));
  };

  const updateItemQty = (index: number, qty: number) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.map((item, i) => i === index ? { ...item, qty: Math.max(1, qty) } : item)
    }));
  };

  const updateItemSku = (index: number, sku: string) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.map((item, i) => i === index ? { ...item, sku: sku.toUpperCase() } : item)
    }));
  };

  const updateItemProductName = (index: number, productName: string) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.map((item, i) => i === index ? { ...item, productName } : item)
    }));
  };

  const updateItemLocation = (index: number, location: string) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.map((item, i) => i === index ? { ...item, location } : item)
    }));
  };

  const updateItemPrice = (index: number, unit_price: number) => {
    setEditForm(prev => ({
      ...prev,
      items: prev.items?.map((item, i) => i === index ? { ...item, unit_price: Math.max(0, unit_price) } : item)
    }));
  };

  const renderStatusBadge = (status: OrderStatus) => {
    const colors = {
      'Created': 'bg-indigo-50 text-indigo-700 border-indigo-100',
      'Picked Up': 'bg-emerald-50 text-emerald-700 border-emerald-100',
      'Reviewed': 'bg-purple-50 text-purple-700 border-purple-100',
      'Cancelled': 'bg-red-50 text-red-700 border-red-100'
    };
    return (
      <span className={cn('px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border', colors[status])}>
        {status}
      </span>
    );
  };

  const renderPaymentBadge = (status: PaymentStatus) => {
    const colors = {
      'Paid': 'bg-emerald-50 text-emerald-700 border-emerald-100',
      'Unpaid': 'bg-amber-50 text-amber-700 border-amber-100'
    };
    return (
      <span className={cn('px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider border', colors[status])}>
        {status}
      </span>
    );
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="p-6 text-center bg-slate-50 min-h-screen flex flex-col items-center justify-center">
        <div className="w-16 h-16 bg-red-50 text-red-500 rounded-2xl flex items-center justify-center mb-4">
          <AlertCircle className="w-8 h-8" />
        </div>
        <h2 className="text-xl font-bold text-slate-900 mb-2">{error || (isCnApiMode ? '未找到订单' : 'Order not found')}</h2>
        <button
          onClick={() => navigate(ordersBasePath)}
          className="text-indigo-600 hover:text-indigo-700 font-bold inline-flex items-center gap-2"
        >
          <ArrowLeft className="w-4 h-4" />
          {cnText.backToOrders}
        </button>
      </div>
    );
  }

  console.log("OrderDetail - Status:", order.status, "WarehouseStatus:", order.warehouseStatus, "HasPermission:", hasPermission(profile, 'Request Picking', profile?.username || profile?.email));

  const store = stores.find(s => s.storeId === order.storeId);
  const isOrderLocked = order.status === 'Picked Up' || order.status === 'Reviewed';

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        title={order.bookingNumber}
        subtitle={
          <div className="flex items-center gap-3">
            {renderStatusBadge(order.status)}
            <span className="text-slate-500 text-sm">{cnText.ref}: {order.refNumber}</span>
          </div>
        }
        isScrolled={isScrolled}
        maxWidth="max-w-5xl"
        className="print:hidden"
        backButton={
          <button
            onClick={() => navigate(ordersBasePath)}
            className="p-2 hover:bg-slate-100 rounded-full transition-colors"
          >
            <ArrowLeft className="w-6 h-6 text-slate-500" />
          </button>
        }
        actions={
          <>
            {!isCnApiMode && hasPermission(profile, 'Edit Order', profile?.username || profile?.email) && order.status !== 'Cancelled' && !isOrderLocked && (
              <button
                onClick={() => setIsEditing(true)}
                className="inline-flex items-center px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 transition-all"
              >
                <Edit className="w-3.5 h-3.5 mr-1.5" />
                {cnText.edit}
              </button>
            )}

            {!isCnApiMode && (hasPermission(profile, 'Add Payment', profile?.username || profile?.email) || hasPermission(profile, 'Edit Payment', profile?.username || profile?.email)) && order.status !== 'Cancelled' && !isOrderLocked && (
              <button
                onClick={openPaymentEditor}
                className="inline-flex items-center px-3 py-1.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-bold text-emerald-700 hover:bg-emerald-100 transition-all"
              >
                <CreditCard className="w-3.5 h-3.5 mr-1.5" />
                Update Payment
              </button>
            )}
            
            {hasPermission(profile, 'Print Pick List', profile?.username || profile?.email) && (
              <button
                onClick={handlePrint}
                className="inline-flex items-center px-3 py-1.5 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-700 hover:bg-slate-50 transition-all"
              >
                <Printer className="w-3.5 h-3.5 mr-1.5" />
                {cnText.print}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Request Picking', profile?.username || profile?.email) && !order.warehouseStatus && order.status === 'Created' && (
              <button
                onClick={handleRequestPicking}
                className="inline-flex items-center px-3 py-1.5 bg-indigo-600 rounded-xl text-xs font-bold text-white hover:bg-indigo-700 transition-all shadow-lg shadow-indigo-200"
              >
                <ShoppingCart className="w-3.5 h-3.5 mr-1.5" />
                {cnText.requestPicking}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Confirm Pickup', profile?.username || profile?.email) && order.status === 'Created' && !order.pickupExceptionStatus && (
              <button
                onClick={startPickupConfirmationFlow}
                className="inline-flex items-center px-3 py-1.5 bg-emerald-600 rounded-xl text-xs font-bold text-white hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-200"
              >
                <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                {cnText.confirmPickup}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Edit Order', profile?.username || profile?.email) && order.status === 'Created' && order.pickupExceptionStatus === 'PartialPendingSales' && (
              <button
                onClick={handleMarkPartialReady}
                disabled={partialFlowLoading}
                className="inline-flex items-center px-3 py-1.5 bg-orange-600 rounded-xl text-xs font-bold text-white hover:bg-orange-700 transition-all shadow-lg shadow-orange-200 disabled:opacity-50"
              >
                {cnText.submitForFinalization}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Finalize Partial Pickup', profile?.username || profile?.email) && order.status === 'Created' && order.pickupExceptionStatus === 'PendingFinalize' && (
              <button
                onClick={handleFinalizePartialPickup}
                disabled={partialFlowLoading}
                className="inline-flex items-center px-3 py-1.5 bg-violet-600 rounded-xl text-xs font-bold text-white hover:bg-violet-700 transition-all shadow-lg shadow-violet-200 disabled:opacity-50"
              >
                {cnText.finalizePartialPickup}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Review Orders', profile?.username || profile?.email) && order.status === 'Picked Up' && (
              <button
                onClick={() => handleStatusChange('Reviewed')}
                className="inline-flex items-center px-3 py-1.5 bg-purple-600 rounded-xl text-xs font-bold text-white hover:bg-purple-700 transition-all shadow-lg shadow-purple-200"
              >
                <CheckCircle className="w-3.5 h-3.5 mr-1.5" />
                {cnText.markReviewed}
              </button>
            )}

            {!isCnApiMode && hasPermission(profile, 'Cancel Orders', profile?.username || profile?.email) && order.status !== 'Cancelled' && (
              <button
                onClick={() => handleStatusChange('Cancelled')}
                className="inline-flex items-center px-3 py-1.5 bg-red-50 rounded-xl text-xs font-bold text-red-600 hover:bg-red-100 transition-all"
              >
                <XCircle className="w-3.5 h-3.5 mr-1.5" />
                {cnText.cancel}
              </button>
            )}
          </>
        }
      />

      {/* Content Area (Scrolling) */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8 print:hidden">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-5xl mx-auto space-y-6">
          
          {/* Exception Warning: Picked Up but not Ready by Warehouse */}
          {order.status === 'Picked Up' && order.warehouseStatus !== 'Picked' && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3 animate-pulse">
              <AlertTriangle className="w-5 h-5 text-red-600 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-red-900">Warehouse Confirmation Missing</h4>
                <p className="text-xs text-red-700 mt-1">
                  This order has been confirmed as "Picked Up" by Reception, but the Warehouse has not yet marked it as "Ready". 
                  Please coordinate with the warehouse staff to ensure the items were correctly retrieved.
                </p>
              </div>
            </div>
          )}

          {order.pickupExceptionStatus && (
            <div className={cn(
              "border rounded-xl p-4 flex items-start gap-3",
              order.pickupExceptionStatus === 'PartialPendingSales'
                ? "bg-red-50 border-red-200"
                : "bg-orange-50 border-orange-200"
            )}>
              <AlertTriangle className={cn(
                "w-5 h-5 mt-0.5",
                order.pickupExceptionStatus === 'PartialPendingSales' ? "text-red-600" : "text-orange-600"
              )} />
              <div>
                <h4 className={cn(
                  "text-sm font-bold",
                  order.pickupExceptionStatus === 'PartialPendingSales' ? "text-red-900" : "text-orange-900"
                )}>
                  {order.pickupExceptionStatus === 'PartialPendingSales'
                    ? 'Partial Pickup - Sales Action Needed'
                    : 'Partial Pickup - Pending Finalization'}
                </h4>
                <p className={cn(
                  "text-xs mt-1",
                  order.pickupExceptionStatus === 'PartialPendingSales' ? "text-red-700" : "text-orange-700"
                )}>
                  {order.pickupExceptionStatus === 'PartialPendingSales'
                    ? 'Reception has completed a partial pickup. Sales should update the order and submit it for finalization.'
                    : 'Order updates are complete. A user with Finalize Partial Pickup permission should finalize it to Picked Up.'}
                </p>
                {order.partialPickupInfo?.reason && (
                  <p className="text-xs mt-2 text-slate-700">
                    Reason: <span className="font-semibold">{order.partialPickupInfo.reason}</span>
                  </p>
                )}
                {(order.partialPickupInfo?.pickedItems?.length || order.partialPickupInfo?.unpickedItems?.length) && (
                  <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="text-xs font-bold text-emerald-800 mb-2">
                        Picked Items ({order.partialPickupInfo?.pickedItems?.length || 0})
                      </p>
                      {order.partialPickupInfo?.pickedItems?.length ? (
                        <div className="space-y-1">
                          {order.partialPickupInfo.pickedItems.map((item, index) => (
                            <p key={`picked-${item.sku}-${index}`} className="text-xs text-emerald-900">
                              [{item.sku}] {item.productName || 'N/A'} x {item.qty || 0}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-emerald-700">No items marked as picked.</p>
                      )}
                    </div>

                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                      <p className="text-xs font-bold text-amber-800 mb-2">
                        Not Picked Items ({order.partialPickupInfo?.unpickedItems?.length || 0})
                      </p>
                      {order.partialPickupInfo?.unpickedItems?.length ? (
                        <div className="space-y-1">
                          {order.partialPickupInfo.unpickedItems.map((item, index) => (
                            <p key={`unpicked-${item.sku}-${index}`} className="text-xs text-amber-900">
                              [{item.sku}] {item.productName || 'N/A'} x {item.qty || 0}
                            </p>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-amber-700">All items were picked.</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Inventory Issue Warning */}
          {order.pickingLog?.inventoryIssue && (
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5" />
              <div>
                <h4 className="text-sm font-bold text-amber-900">Inventory Issue Reported</h4>
                <p className="text-xs text-amber-700 mt-1">
                  Warehouse reported an issue: <span className="font-bold italic">"{order.pickingLog.inventoryIssue}"</span>
                </p>
                <p className="text-[10px] text-amber-600 mt-1 uppercase font-bold">
                  Reported at {formatDate(order.pickingLog.issueReportedAt, 'PPp')}
                </p>
              </div>
            </div>
          )}

          {/* Audit Log Section */}
          {order.auditLog && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-6 mb-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 bg-slate-200 text-slate-600 rounded-xl flex items-center justify-center">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900">Audit Log</h3>
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-bold">Manual Closure Details</p>
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Closed By</p>
                  <p className="text-sm font-bold text-slate-900">{order.auditLog.closed_by}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Closed At</p>
                  <p className="text-sm font-bold text-slate-900">{formatDate(order.auditLog.closed_at, 'yyyy-MM-dd HH:mm')}</p>
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Reason</p>
                  <p className="text-sm font-bold text-red-600">{order.auditLog.reason}</p>
                </div>
                {order.auditLog.note && (
                  <div className="space-y-1 md:col-span-2">
                    <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Additional Notes</p>
                    <p className="text-sm text-slate-600 bg-white p-3 rounded-xl border border-slate-100 italic">"{order.auditLog.note}"</p>
                  </div>
                )}
              </div>
            </div>
          )}

      {/* Main Content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Order Info */}
        <div className="lg:col-span-2 space-y-6">
          {/* Details Card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
              <h3 className="font-semibold text-gray-900">Order Information</h3>
            </div>
            <div className="p-6 grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <User className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Customer</p>
                    <p className="text-gray-900 font-medium">{order.customerName}</p>
                    <p className="text-sm text-gray-500">ID: {order.customerId}</p>
                    {order.customerEmail && <p className="text-sm text-gray-500">{order.customerEmail}</p>}
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <Calendar className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Pickup Date</p>
                    <p className="text-gray-900">{formatDate(order.pickupDateScheduled, 'PPP')}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <FileText className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Store</p>
                    <p className="text-gray-900">{store?.name || order.storeId}</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <ShoppingCart className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Warehouse Status</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={cn(
                        "px-2 py-0.5 rounded text-[10px] font-bold uppercase border",
                        !order.warehouseStatus ? "bg-slate-50 text-slate-400 border-slate-200" :
                        order.warehouseStatus === 'Pending' ? "bg-slate-100 text-slate-600 border-slate-200" :
                        order.warehouseStatus === 'Picking' ? "bg-amber-50 text-amber-600 border-amber-100" :
                        "bg-emerald-50 text-emerald-600 border-emerald-100"
                      )}>
                        {order.warehouseStatus === 'Picked' ? 'Ready' : (order.warehouseStatus || 'Not Requested')}
                      </span>
                    </div>
                    {order.pickingLog?.requestedAt && (
                      <p className="text-[10px] text-gray-400 mt-1">Requested: {formatDate(order.pickingLog.requestedAt, 'MMM d, HH:mm')}</p>
                    )}
                    {order.pickingLog?.pickerName && (
                      <p className="text-[10px] text-gray-400">Picker: {order.pickingLog.pickerName}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-start gap-3">
                  <CreditCard className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Amount</p>
                    <p className="text-lg font-bold text-slate-900">NZD ${(order.totalAmount || 0).toFixed(2)}</p>
                    <div className="flex items-center gap-2 mt-1">
                      {renderPaymentBadge(order.paymentStatus)}
                      {order.paymentMethod && (
                        <span className="text-sm text-gray-600">via {order.paymentMethod}</span>
                      )}
                    </div>
                    {order.paymentTime && (
                      <p className="text-xs text-gray-500 mt-1">
                        Paid on {formatDate(order.paymentTime, 'PPp')} by {order.paymentBy}
                      </p>
                    )}
                  </div>
                </div>
                {order.customerSignature && (
                  <div className="flex items-start gap-3">
                    <PenTool className="w-5 h-5 text-gray-400 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Customer Signature</p>
                      <img 
                        src={order.customerSignature} 
                        alt="Customer Signature" 
                        className="h-16 border border-gray-200 rounded mt-1 bg-white"
                        referrerPolicy="no-referrer"
                      />
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-3">
                  <Clock className="w-5 h-5 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Created</p>
                    <p className="text-gray-900">{formatDate(order.createdTime, 'PPp')}</p>
                    <p className="text-sm text-gray-500">by {order.createdBy}</p>
                  </div>
                </div>
                {order.actualPickupTime && (
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-green-500 mt-0.5" />
                    <div>
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Actual Pickup</p>
                      <p className="text-gray-900">{formatDate(order.actualPickupTime, 'PPp')}</p>
                      <p className="text-sm text-gray-500">by {order.pickedUpBy}</p>
                    </div>
                  </div>
                )}
              </div>
            </div>
            
            {order.notes && (
              <div className="px-6 py-4 bg-gray-50 border-t border-gray-100">
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1">Notes</p>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{order.notes}</p>
              </div>
            )}
          </div>

          {/* Items Card */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
              <h3 className="font-semibold text-gray-900">Order Items</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3">SKU</th>
                    <th className="px-6 py-3">Product Name</th>
                    <th className="px-6 py-3">Location</th>
                    <th className="px-6 py-3 text-right">Qty</th>
                    <th className="px-6 py-3 text-right">Price</th>
                    <th className="px-6 py-3 text-right">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {(order.items || []).map((item, idx) => (
                    <tr key={idx} className="hover:bg-gray-50 transition-colors">
                      <td className="px-6 py-4 text-sm font-mono font-medium text-gray-900">{item.sku}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">{item.productName || '-'}</td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        <span className="px-2 py-1 bg-gray-100 rounded text-xs font-medium">
                          {item.location || 'N/A'}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-900 text-right font-semibold">{item.qty}</td>
                      <td className="px-6 py-4 text-sm text-gray-600 text-right">${(item.unit_price || 0).toFixed(2)}</td>
                      <td className="px-6 py-4 text-sm text-gray-900 text-right font-bold">${((item.qty || 0) * (item.unit_price || 0)).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50/50">
                  <tr>
                    <td colSpan={5} className="px-6 py-4 text-right text-sm font-bold text-gray-500 uppercase tracking-wider">Total Amount</td>
                    <td className="px-6 py-4 text-right text-lg font-bold text-indigo-600">${(order.totalAmount || 0).toFixed(2)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column: Logs & Metadata */}
        <div className="space-y-6">
          {/* Follow-up Logs */}
          {order.followUpLogs && order.followUpLogs.length > 0 && (
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 bg-indigo-50/50 flex items-center justify-between">
                <h3 className="font-semibold text-gray-900">Follow-up Logs</h3>
                <MessageSquare className="w-4 h-4 text-indigo-500" />
              </div>
              <div className="p-4 max-h-[300px] overflow-y-auto space-y-4">
                {order.followUpLogs.map((log, idx) => (
                  <div key={idx} className="bg-slate-50 rounded-lg p-3 border border-slate-100">
                    <div className="flex justify-between items-center mb-1">
                      <span className="text-[10px] font-bold text-slate-900 uppercase">{log.staffName}</span>
                      <span className="text-[10px] text-slate-400">{formatDate(log.timestamp, 'MMM d, HH:mm')}</span>
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed">{log.content}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Operation Logs */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Operation Logs</h3>
              <Clock className="w-4 h-4 text-gray-400" />
            </div>
            <div className="p-4 max-h-[500px] overflow-y-auto">
              <div className="space-y-4">
                {logs.length === 0 ? (
                  <p className="text-sm text-gray-500 text-center py-4">No logs found</p>
                ) : (
                  logs.map((log) => (
                    <div key={log.id} className="flex gap-3 text-sm">
                      <div className="flex-shrink-0 w-1 bg-gray-200 rounded-full" />
                      <div>
                        <p className="font-medium text-gray-900">{log.action}</p>
                        <p className="text-gray-600 text-xs mt-0.5">{log.details}</p>
                        <div className="flex items-center gap-2 mt-1 text-[10px] text-gray-400 uppercase tracking-wider">
                          <span>{log.userName}</span>
                          <span>•</span>
                          <span>{formatDate(log.timestamp, 'MMM d, HH:mm')}</span>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Email Status */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
            <h3 className="font-semibold text-gray-900 mb-4">Email Status</h3>
            <div className="space-y-3">
              <div className="flex justify-between items-center text-sm">
                <span className="text-gray-500">Notification</span>
                <span className={cn(
                  'px-2 py-0.5 rounded text-xs font-medium',
                  order.emailStatus === 'sent' ? 'bg-green-100 text-green-800' : 
                  order.emailStatus === 'failed' ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-800'
                )}>
                  {order.emailStatus || 'Not Sent'}
                </span>
              </div>
              {order.lastEmailSentAt && (
                <div className="text-xs text-gray-400 text-right">
                  Last sent: {formatDate(order.lastEmailSentAt, 'PPp')}
                </div>
              )}
              
              {hasPermission(profile, 'Review Orders', profile?.username || profile?.email) && (
                <button
                  onClick={handleSendEmail}
                  disabled={sendingEmail}
                  className="w-full mt-4 inline-flex items-center justify-center px-4 py-2 bg-emerald-600 rounded-lg text-sm font-medium text-white hover:bg-emerald-700 transition-colors shadow-sm disabled:opacity-50"
                >
                  {sendingEmail ? (
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                  ) : (
                    <Send className="w-4 h-4 mr-2" />
                  )}
                  Send Pickup Email
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Pickup Item Selection Modal */}
      {showPickupItemsModal && order && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <h2 className="text-lg font-bold text-gray-900">Confirm Picked Items</h2>
              <button
                onClick={() => {
                  setShowPickupItemsModal(false);
                  setPickupSelections([]);
                  setPartialPickupReason('');
                }}
                className="p-2 hover:bg-gray-200 rounded-full"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                Select the items the customer actually picked up for order <span className="font-bold">{order.bookingNumber}</span>.
              </p>
              <div className="max-h-72 overflow-y-auto border border-gray-200 rounded-xl divide-y divide-gray-100">
                {(order.items || []).map((item, index) => (
                  <label key={`${item.sku}-${index}`} className="flex items-start gap-3 p-3 hover:bg-gray-50 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={pickupSelections[index] || false}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setPickupSelections(prev => prev.map((value, i) => (i === index ? checked : value)));
                      }}
                      className="mt-0.5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-semibold text-gray-800">{item.sku}</p>
                      <p className="text-xs text-gray-500">{item.productName || 'N/A'} · Qty {item.qty || 0}</p>
                    </div>
                  </label>
                ))}
              </div>

              {pickupSelections.some(v => !v) && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Reason for Partial Pickup</label>
                  <textarea
                    value={partialPickupReason}
                    onChange={(e) => setPartialPickupReason(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    placeholder="e.g. Out of stock for one SKU"
                  />
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowPickupItemsModal(false);
                    setPickupSelections([]);
                    setPartialPickupReason('');
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={continueToSignatureStep}
                  className="inline-flex items-center px-6 py-2 bg-indigo-600 rounded-lg text-sm font-medium text-white hover:bg-indigo-700 transition-colors shadow-sm"
                >
                  Continue to Signature
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Signature Modal */}
      {showSignatureModal && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <h2 className="text-lg font-bold text-gray-900">Confirm Pickup Signature</h2>
              <button 
                onClick={() => {
                  setShowSignatureModal(false);
                  setReceivedRemoteSignature(null);
                  setIsProjecting(false);
                  setPickupSelections([]);
                  setPartialPickupReason('');
                }} 
                className="p-2 hover:bg-gray-200 rounded-full"
                disabled={signatureLoading}
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            
            <div className="p-6 space-y-4">
              <p className="text-sm text-gray-600">
                Please ask the customer to sign below to confirm they have picked up order <span className="font-bold">{order.bookingNumber}</span>.
              </p>
              
              {receivedRemoteSignature ? (
                <div className="space-y-4">
                  <div className="border-2 border-emerald-100 rounded-2xl bg-white p-4 flex flex-col items-center justify-center text-center">
                    <p className="text-xs font-bold text-emerald-600 uppercase mb-2">Signature Received from Tablet</p>
                    <img 
                      src={receivedRemoteSignature} 
                      alt="Remote Signature" 
                      className="max-h-48 object-contain"
                      referrerPolicy="no-referrer"
                    />
                  </div>
                  <div className="flex gap-3">
                    <button
                      onClick={handleClearRemoteSignature}
                      className="flex-1 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-xl font-bold text-sm transition-all"
                      disabled={signatureLoading}
                    >
                      Clear & Resign
                    </button>
                    <button
                      onClick={handleSaveRemoteSignature}
                      className="flex-[2] py-3 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-emerald-200 flex items-center justify-center gap-2"
                      disabled={signatureLoading}
                    >
                      {signatureLoading ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <CheckCircle className="w-4 h-4" />
                      )}
                      Confirm & Save Signature
                    </button>
                  </div>
                </div>
              ) : isProjecting ? (
                <div className="border-2 border-indigo-100 rounded-2xl bg-indigo-50/50 p-8 flex flex-col items-center justify-center text-center space-y-4 min-h-[192px]">
                  <div className="w-16 h-16 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center animate-pulse">
                    <Smartphone className="w-8 h-8" />
                  </div>
                  <div>
                    <h4 className="font-bold text-indigo-900">Projecting to Tablet</h4>
                    <p className="text-sm text-indigo-600">Waiting for customer signature on the paired device...</p>
                  </div>
                  <button
                    onClick={handleCancelProjection}
                    className="px-4 py-2 bg-white border border-indigo-200 text-indigo-600 rounded-xl text-xs font-bold hover:bg-indigo-100 transition-all"
                  >
                    Cancel Projection
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div ref={signatureAreaRef} className="border-2 border-dashed border-gray-300 rounded-lg bg-gray-50 overflow-hidden">
                    <SignatureCanvas
                      ref={signatureRef}
                      penColor="black"
                      canvasProps={{
                        className: "w-full h-48 cursor-crosshair",
                        style: { width: '100%', height: '192px' }
                      }}
                    />
                  </div>
                  
                  <div className="flex justify-between items-center">
                    <div className="flex gap-4">
                      <button
                        onClick={() => signatureRef.current?.clear()}
                        className="text-sm text-gray-500 hover:text-gray-700 font-medium"
                        disabled={signatureLoading}
                      >
                        Clear Signature
                      </button>
                      {isGuestOnline && (
                        <button
                          onClick={handleProjectSignature}
                          className="inline-flex items-center text-sm text-indigo-600 hover:text-indigo-700 font-bold gap-2"
                          disabled={signatureLoading}
                        >
                          <Monitor className="w-4 h-4" />
                          Project to Tablet
                        </button>
                      )}
                    </div>
                    <div className="flex gap-3">
                      <button
                        onClick={() => {
                          setShowSignatureModal(false);
                          setReceivedRemoteSignature(null);
                          setIsProjecting(false);
                          setPickupSelections([]);
                          setPartialPickupReason('');
                        }}
                        className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                        disabled={signatureLoading}
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleConfirmPickup}
                        disabled={signatureLoading}
                        className="inline-flex items-center px-6 py-2 bg-green-600 rounded-lg text-sm font-medium text-white hover:bg-green-700 transition-colors shadow-sm disabled:opacity-50"
                      >
                        {signatureLoading ? (
                          <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin mr-2" />
                        ) : (
                          <CheckCircle className="w-4 h-4 mr-2" />
                        )}
                        Confirm & Save
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Payment Modal */}
      {isPaymentEditing && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-md overflow-hidden">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <h2 className="text-xl font-bold text-gray-900">Update Payment</h2>
              <button onClick={() => setIsPaymentEditing(false)} className="p-2 hover:bg-gray-200 rounded-full">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Status</label>
                <select
                  value={paymentForm.paymentStatus}
                  onChange={e => setPaymentForm(prev => ({ ...prev, paymentStatus: e.target.value as PaymentStatus }))}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="Unpaid">Unpaid</option>
                  <option value="Paid">Paid</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Payment Method</label>
                <select
                  value={paymentForm.paymentMethod}
                  onChange={e => setPaymentForm(prev => ({ ...prev, paymentMethod: e.target.value as PaymentMethod }))}
                  disabled={paymentForm.paymentStatus !== 'Paid'}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
                >
                  <option value="">Select Method</option>
                  <option value="Cash">Cash</option>
                  <option value="EFTPOS">EFTPOS</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Online Payment">Online Payment</option>
                </select>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex justify-end gap-3">
              <button
                onClick={() => setIsPaymentEditing(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdatePayment}
                className="px-6 py-2 rounded-lg text-sm font-medium text-white bg-emerald-600 hover:bg-emerald-700 transition-colors shadow-sm"
              >
                Save Payment
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {isEditing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-lg shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
            <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between bg-gray-50">
              <h2 className="text-xl font-bold text-gray-900">Edit Order</h2>
              <button onClick={() => setIsEditing(false)} className="p-2 hover:bg-gray-200 rounded-full">
                <X className="w-5 h-5 text-gray-500" />
              </button>
            </div>

              <div className="p-6 overflow-y-auto flex-1 space-y-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Customer Name</label>
                      <input
                        type="text"
                        value={editForm.customerName || ''}
                        onChange={e => setEditForm({ ...editForm, customerName: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Customer Email</label>
                      <input
                        type="email"
                        value={editForm.customerEmail || ''}
                        onChange={e => setEditForm({ ...editForm, customerEmail: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Store</label>
                      <select
                        value={editForm.storeId || ''}
                        onChange={e => setEditForm({ ...editForm, storeId: e.target.value })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      >
                        {stores.map(s => (
                          <option key={s.id} value={s.storeId}>{s.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Pickup Date</label>
                      <input
                        type="date"
                        value={editForm.pickupDateScheduled?.split('T')[0] || ''}
                        onChange={e => setEditForm({ ...editForm, pickupDateScheduled: new Date(e.target.value).toISOString() })}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Notes</label>
                      <textarea
                        value={editForm.notes || ''}
                        onChange={e => setEditForm({ ...editForm, notes: e.target.value })}
                        rows={2}
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                    </div>
                  </div>
                </div>

                {/* Items Management */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-semibold text-gray-900">Order Items</h3>
                    <div className="relative w-64">
                      <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                        <Search className="h-4 w-4 text-gray-400" />
                      </div>
                      <input
                        type="text"
                        placeholder="Search SKU to add..."
                        value={skuSearch}
                        onChange={e => searchSKU(e.target.value)}
                        className="block w-full pl-10 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      
                      {showSkuResults && (
                        <div className="absolute z-10 mt-1 w-full bg-white border border-gray-200 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                          {skuResults.map(sku => (
                            <button
                              key={sku.id}
                              onClick={() => addItem(sku)}
                              className="w-full text-left px-4 py-2 hover:bg-gray-50 flex flex-col border-b border-gray-100 last:border-0"
                            >
                              <span className="font-mono font-bold text-blue-600">{sku.sku}</span>
                              <span className="text-xs text-gray-500 truncate">{sku.productName}</span>
                              <span className="text-[10px] text-gray-400">Loc: {sku.location}</span>
                            </button>
                          ))}
                          {skuSearch.length > 0 && (
                            <button
                              onClick={addManualItem}
                              className="w-full text-left px-4 py-3 hover:bg-indigo-50 flex items-center gap-2 text-indigo-600 border-t border-gray-100"
                            >
                              <Plus className="w-4 h-4" />
                              <div className="flex flex-col">
                                <span className="text-sm font-bold">Add Custom: {skuSearch.toUpperCase()}</span>
                                <span className="text-[10px] opacity-70 italic">Not in database</span>
                              </div>
                            </button>
      )}

                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border border-gray-200 rounded-xl overflow-hidden">
                    <table className="w-full text-left">
                      <thead className="bg-gray-50 text-xs font-medium text-gray-500 uppercase">
                        <tr>
                          <th className="px-4 py-3">SKU</th>
                          <th className="px-4 py-3">Product</th>
                          <th className="px-4 py-3">Location</th>
                          <th className="px-4 py-3 w-20 text-center">Qty</th>
                          <th className="px-4 py-3 w-28 text-right">Price</th>
                          <th className="px-4 py-3 w-16"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {editForm.items?.map((item, idx) => (
                          <tr key={idx}>
                            <td className="px-4 py-3 font-mono text-sm">
                              <input
                                type="text"
                                value={item.sku}
                                onChange={e => updateItemSku(idx, e.target.value)}
                                className="w-full px-2 py-1 border border-gray-300 rounded text-sm font-mono uppercase focus:ring-1 focus:ring-blue-500 outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              <input
                                type="text"
                                value={item.productName || ''}
                                onChange={e => updateItemProductName(idx, e.target.value)}
                                className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none"
                              />
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">
                              <input
                                type="text"
                                value={item.location || ''}
                                onChange={e => updateItemLocation(idx, e.target.value)}
                                className="w-full px-2 py-1 border border-gray-300 rounded text-sm focus:ring-1 focus:ring-blue-500 outline-none"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <input
                                type="number"
                                min="1"
                                value={item.qty}
                                onChange={e => updateItemQty(idx, parseInt(e.target.value))}
                                className="w-full text-center px-2 py-1 border border-gray-300 rounded"
                              />
                            </td>
                            <td className="px-4 py-3">
                              <div className="relative">
                                <span className="absolute left-1 top-1/2 -translate-y-1/2 text-gray-400 text-[10px]">$</span>
                                <input
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  value={item.unit_price || 0}
                                  onChange={e => updateItemPrice(idx, parseFloat(e.target.value))}
                                  className="w-full text-right pl-3 pr-1 py-1 border border-gray-300 rounded text-sm"
                                />
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right">
                              <button onClick={() => removeItem(idx)} className="text-red-500 hover:text-red-700">
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                        {(!editForm.items || editForm.items.length === 0) && (
                          <tr>
                            <td colSpan={4} className="px-4 py-8 text-center text-gray-500 text-sm">
                              No items added to this order.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="px-6 py-4 border-t border-gray-100 bg-gray-50 flex items-center justify-end gap-3">
                <button
                  onClick={() => setIsEditing(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpdateOrder}
                  className="inline-flex items-center px-6 py-2 bg-blue-600 rounded-lg text-sm font-medium text-white hover:bg-blue-700 transition-colors shadow-sm"
                >
                  <Save className="w-4 h-4 mr-2" />
                  Save Changes
                </button>
              </div>
            </div>
          </div>
        )}

        </div>
      </div>

      {/* Confirmation Modal */}
      <AnimatePresence>
        {showConfirmModal && confirmAction && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden"
            >
              <div className="p-6">
                <div className="flex items-center gap-4 mb-4">
                  <div className={cn(
                    "p-3 rounded-full",
                    confirmAction.type === 'danger' ? "bg-red-100 text-red-600" : "bg-blue-100 text-blue-600"
                  )}>
                    {confirmAction.type === 'danger' ? <AlertTriangle className="w-6 h-6" /> : <Info className="w-6 h-6" />}
                  </div>
                  <h3 className="text-xl font-bold text-gray-900">{confirmAction.title}</h3>
                </div>
                <p className="text-gray-600 leading-relaxed">
                  {confirmAction.message}
                </p>
              </div>
              <div className="px-6 py-4 bg-gray-50 flex justify-end gap-3">
                <button
                  onClick={() => {
                    setShowConfirmModal(false);
                    setConfirmAction(null);
                  }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    confirmAction.onConfirm();
                    setShowConfirmModal(false);
                    setConfirmAction(null);
                  }}
                  className={cn(
                    "px-6 py-2 rounded-lg text-sm font-medium text-white transition-colors shadow-sm",
                    confirmAction.type === 'danger' ? "bg-red-600 hover:bg-red-700" : "bg-blue-600 hover:bg-blue-700"
                  )}
                >
                  Confirm
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Print View (Hidden) */}
      <div className="hidden print:block p-8 bg-white text-black">
        <div className="flex justify-between items-start mb-8 border-b-2 border-black pb-4">
          <div>
            <h1 className="text-3xl font-bold uppercase tracking-tighter">Pick List</h1>
            <p className="text-lg font-mono mt-1">{order.bookingNumber}</p>
            <p className="text-sm text-gray-600">Ref: {order.refNumber}</p>
          </div>
          <div className="text-right">
            <h2 className="text-xl font-bold">{store?.name || order.storeId}</h2>
            <p className="text-sm">Warehouse: {activeWarehouse}</p>
            <p className="text-sm">Date: {formatDate(new Date().toISOString(), 'PPP')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 mb-8">
          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase text-gray-500">Customer Details</h3>
            <p className="text-lg font-bold">{order.customerName}</p>
            <p className="text-sm">ID: {order.customerId}</p>
            <p className="text-sm">Pickup Scheduled: {formatDate(order.pickupDateScheduled, 'PPP')}</p>
          </div>
          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase text-gray-500">Payment Info</h3>
            <p className="text-lg font-bold">{order.paymentStatus}</p>
            {order.paymentMethod && <p className="text-sm">Method: {order.paymentMethod}</p>}
            {order.paymentTime && <p className="text-sm">Paid at: {formatDate(order.paymentTime, 'PPp')}</p>}
          </div>
        </div>

        <table className="w-full mb-8 border-collapse">
          <thead>
            <tr className="border-b-2 border-black">
              <th className="py-2 text-left text-sm font-bold uppercase">SKU</th>
              <th className="py-2 text-left text-sm font-bold uppercase">Product Name</th>
              <th className="py-2 text-left text-sm font-bold uppercase">Location</th>
              <th className="py-2 text-right text-sm font-bold uppercase">Qty</th>
              <th className="py-2 text-center text-sm font-bold uppercase w-12">Pick</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-300">
            {order.items.map((item, idx) => (
              <tr key={idx}>
                <td className="py-4 font-mono font-bold">{item.sku}</td>
                <td className="py-4 text-sm">{item.productName}</td>
                <td className="py-4">
                  <span className="px-2 py-1 border border-black rounded text-xs font-bold">
                    {item.location || 'N/A'}
                  </span>
                </td>
                <td className="py-4 text-right font-bold text-lg">{item.qty}</td>
                <td className="py-4">
                  <div className="w-6 h-6 border-2 border-black mx-auto rounded" />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {order.notes && (
          <div className="mb-8 p-4 border-2 border-dashed border-gray-300 rounded">
            <h3 className="text-xs font-bold uppercase text-gray-500 mb-2">Special Notes</h3>
            <p className="text-sm italic">{order.notes}</p>
          </div>
        )}

        <div className="mt-20 grid grid-cols-2 gap-12">
          <div className="border-t border-black pt-2">
            <p className="text-xs font-bold uppercase">Picker Signature</p>
            <p className="text-xs text-gray-400 mt-8">Name: ________________________</p>
          </div>
          <div className="border-t border-black pt-2">
            <p className="text-xs font-bold uppercase">Customer Signature</p>
            <p className="text-xs text-gray-400 mt-8">Date: ________________________</p>
          </div>
        </div>
        
        <div className="mt-8 text-[10px] text-gray-400 text-center">
          Printed by {profile?.name} at {formatDate(new Date().toISOString(), 'PPp')}
        </div>
      </div>
    </div>
  );
};

// export default OrderDetail;
