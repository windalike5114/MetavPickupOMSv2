import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, getDocs, orderBy } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { SKU, OrderItem, Store, UserProfile, UserGroup } from '../types';
import { handleFirestoreError, OperationType, resolveRecipients, cn, getSkuWarehouseLocation } from '../utils';
import { useClickOutside } from '../hooks/useClickOutside';
import { 
  Plus, 
  Trash2, 
  Search, 
  Save, 
  ArrowLeft,
  AlertCircle,
  Package,
  Store as StoreIcon,
  Bell,
  Users as UsersIcon,
  User as UserIcon,
  Check
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { SUPER_ADMINS } from '../lib/auth-shared';
import { API_BASE_URL, CN_API_ONLY } from '../constants';
import { useLocation } from 'react-router-dom';

import { PageHeader } from '../components/PageHeader';

export const OrderCreate = () => {
  const { profile, activeWarehouse, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const routePrefix = location.pathname.startsWith('/cn') ? '/cn' : '';
  const isCnRoute = routePrefix === '/cn';
  const isCnApiMode = CN_API_ONLY && routePrefix === '/cn';
  const ordersBasePath = `${routePrefix}/orders`;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form state
  const [bookingNumber, setBookingNumber] = useState('');
  const [refNumber, setRefNumber] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [storeId, setStoreId] = useState('');
  const [customerEmail, setCustomerEmail] = useState('');
  const [pickupDateScheduled, setPickupDateScheduled] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<OrderItem[]>([]);
  const [paymentStatus, setPaymentStatus] = useState<'Paid' | 'Unpaid'>('Unpaid');
  const [paymentMethod, setPaymentMethod] = useState<string>('EFTPOS');
  const [notificationRecipients, setNotificationRecipients] = useState<string[]>([]);
  
  // Stores state
  const [stores, setStores] = useState<Store[]>([]);
  
  // Users and Groups state
  const [allUsers, setAllUsers] = useState<UserProfile[]>([]);
  const [allGroups, setAllGroups] = useState<UserGroup[]>([]);
  const [storeConfigs, setStoreConfigs] = useState<Record<string, boolean>>({});
  const [showNotificationMenu, setShowNotificationMenu] = useState(false);
  
  // Scroll state for collapsible header
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
  
  // SKU Search state
  const [skuSearch, setSkuSearch] = useState('');
  const [skuResults, setSkuResults] = useState<SKU[]>([]);
  const [showSkuResults, setShowSkuResults] = useState(false);
  
  // Refs for click outside
  const skuRef = useRef<HTMLDivElement>(null);
  const notificationRef = useRef<HTMLDivElement>(null);
  
  useClickOutside(skuRef, () => setShowSkuResults(false));
  useClickOutside(notificationRef, () => setShowNotificationMenu(false));
  
  useEffect(() => {
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
          const storesData = (data.stores || []) as Store[];
          const configs: Record<string, boolean> = {};
          storesData.forEach((s: any) => {
            if (s.storeId) configs[s.storeId] = s.autoSend || false;
          });
          setStoreConfigs(configs);
          setStores(storesData.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
          return;
        }

        const q = query(collection(db, 'stores'));
        const snap = await getDocs(q);
        const storesData = snap.docs.map(doc => ({ 
          id: doc.id, 
          ...doc.data() 
        } as Store));
        
        const configs: Record<string, boolean> = {};
        snap.docs.forEach(doc => {
          configs[doc.data().storeId] = doc.data().autoSend || false;
        });
        setStoreConfigs(configs);
        // Sort in memory
        setStores(storesData.sort((a, b) => a.name.localeCompare(b.name)));
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, 'stores');
      }
    };
    fetchStores();
  }, [isCnApiMode, token, activeWarehouse]);
  
  useEffect(() => {
    const fetchUsersAndGroups = async () => {
      try {
        const usersSnap = await getDocs(collection(db, 'users'));
        const groupsSnap = await getDocs(collection(db, 'userGroups'));
        
        const usersData = usersSnap.docs.map(doc => {
          const data = doc.data();
          return {
            ...data,
            uid: data.uid || doc.id // Ensure uid is present
          } as UserProfile;
        }).filter(u => !SUPER_ADMINS.includes(u.username.toLowerCase()));

        const groupsData = groupsSnap.docs.map(doc => ({ 
          id: doc.id, 
          ...doc.data() 
        } as UserGroup));
        
        console.log('Fetched Users:', usersData.length);
        console.log('Fetched Groups:', groupsData.length);
        
        setAllUsers(usersData);
        setAllGroups(groupsData);
      } catch (err) {
        console.error('Error fetching users/groups:', err);
      }
    };
    fetchUsersAndGroups();
  }, []);

  useEffect(() => {
    if (skuSearch.length >= 2) {
      const fetchSKUs = async () => {
        if (isCnApiMode) {
          if (!token) return;
          const params = new URLSearchParams({ q: skuSearch, limit: '50' });
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
          where('sku', '>=', skuSearch.toUpperCase()),
          where('sku', '<=', skuSearch.toUpperCase() + '\uf8ff')
        );
        const snap = await getDocs(q);
        setSkuResults(snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as SKU)));
        setShowSkuResults(true);
      };
      fetchSKUs();
    } else {
      setSkuResults([]);
      setShowSkuResults(false);
    }
  }, [skuSearch, isCnApiMode, token, activeWarehouse]);

  const addItem = (sku?: SKU) => {
    if (sku) {
      const existingIndex = items.findIndex(i => i.sku === sku.sku);
      if (existingIndex >= 0) {
        const newItems = [...items];
        newItems[existingIndex].qty = (newItems[existingIndex].qty || 0) + 1;
        setItems(newItems);
      } else {
        setItems([...items, { 
          sku: sku.sku, 
          productName: sku.productName, 
          location: getSkuWarehouseLocation(sku, activeWarehouse), 
          qty: 1, 
          unit_price: 0 
        }]);
      }
      setSkuSearch('');
      setShowSkuResults(false);
    } else {
      // Manual add
      setItems([...items, { sku: skuSearch.toUpperCase() || '', productName: '', location: '', qty: 1, unit_price: 0 }]);
      setSkuSearch('');
      setShowSkuResults(false);
    }
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItemField = (index: number, field: keyof OrderItem, value: any) => {
    const newItems = [...items];
    newItems[index] = { ...newItems[index], [field]: value };
    setItems(newItems);
  };

  const updateQuantity = (index: number, qty: number) => {
    const newItems = [...items];
    newItems[index].qty = Math.max(1, qty);
    setItems(newItems);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;

    // Logic: If Booking Number is empty, use Customer Reference
    let finalBookingNumber = bookingNumber.trim().toUpperCase();
    const finalRefNumber = refNumber.trim().toUpperCase();

    if (!finalBookingNumber && finalRefNumber) {
      finalBookingNumber = finalRefNumber;
    }

    if (!finalBookingNumber) {
      setError('Booking Number cannot be empty');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    if (items.length === 0) {
      setError('Please add at least one item to the order.');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }

    setLoading(true);
    setError('');

    const totalAmount = items.reduce((sum, item) => sum + (item.qty * item.unit_price), 0);

    try {
      const response = await fetch('/api/orders/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${localStorage.getItem('x-v2-auth-token')}`,
          'x-warehouse-id': activeWarehouse || ''
        },
        body: JSON.stringify({
          bookingNumber: finalBookingNumber,
          refNumber: finalRefNumber,
          customerName,
          customerEmail,
          customerId,
          storeId,
          warehouseId: null,
          pickupDateScheduled,
          notes,
          items,
          totalAmount,
          paymentStatus,
          paymentMethod: paymentStatus === 'Paid' ? paymentMethod : null,
          notificationRecipients
        })
      });

      const data = await response.json();
      console.log("📡 [Server Response]:", data);

      if (!data.success) {
        console.error("❌ [Order Creation Failed]:", data);
        throw new Error(data.error || 'Failed to create order');
      }

      // Use orderId, id, or bookingNumber from response
      const result = data.orderId || data.id || data.bookingNumber;

      if (!result) {
        console.warn("⚠️ [Order Creation Warning]: No ID returned from server, using local booking number.");
      }

      navigate(`${ordersBasePath}/${result || finalBookingNumber}`);
    } catch (err: any) {
      console.error(err);
      setError(err.message || (isCnRoute ? '创建订单失败，请重试。' : 'Failed to create order. Please try again.'));
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } finally {
      setLoading(false);
    }
  };

  if (!activeWarehouse) {
    return (
      <div className="max-w-4xl mx-auto py-12 text-center">
        <AlertCircle className="w-16 h-16 text-amber-500 mx-auto mb-4" />
        <h2 className="text-2xl font-bold text-slate-900">{isCnRoute ? '未选择仓库' : 'No Warehouse Selected'}</h2>
        <p className="text-slate-500 mt-2">{isCnRoute ? '请先选择当前操作仓库后再继续。' : 'Please select your current operation warehouse before continuing.'}</p>
        <Link to={ordersBasePath} className="text-indigo-600 mt-4 inline-block font-medium">{isCnRoute ? '返回订单列表' : 'Back to Orders'}</Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        title={isCnRoute ? "创建新订单" : "Create New Order"}
        subtitle={isCnRoute ? "填写信息以创建新的提货订单。" : "Fill in the details to create a new pickup order."}
        icon={Plus}
        isScrolled={isScrolled}
        maxWidth="max-w-4xl"
        backButton={
          <Link to={ordersBasePath} className="p-2 hover:bg-slate-100 rounded-full transition-colors block">
            <ArrowLeft className="w-6 h-6 text-slate-500" />
          </Link>
        }
      />

      {/* Content Area (Scrolling) */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-4xl mx-auto space-y-8">
          {error && (
            <div className="p-4 bg-red-50 border-2 border-red-500 rounded-xl flex items-start gap-3 text-red-700 text-sm animate-shake">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-bold mb-1">{isCnRoute ? '发生错误' : 'Error Occurred'}</p>
                <p>{error}</p>
              </div>
            </div>
          )}

      <form onSubmit={handleSubmit} className="space-y-8">
        {/* Basic Info Section */}
        <section className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-6">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center text-sm">1</span>
            Basic Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Booking Number *</label>
              <input
                type="text"
                value={bookingNumber}
                onChange={(e) => setBookingNumber(e.target.value.toUpperCase())}
                onBlur={(e) => setBookingNumber(e.target.value.toUpperCase())}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="e.g. BK12345"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Customer Reference</label>
              <input
                type="text"
                value={refNumber}
                onChange={(e) => setRefNumber(e.target.value.toUpperCase())}
                onBlur={(e) => setRefNumber(e.target.value.toUpperCase())}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="e.g. REF-99"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Customer Name *</label>
              <input
                type="text"
                required
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="Full Name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Customer ID</label>
              <input
                type="text"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="e.g. CUST-001"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Customer Email</label>
              <input
                type="email"
                value={customerEmail}
                onChange={(e) => setCustomerEmail(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                placeholder="customer@example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Store</label>
              <select
                value={storeId}
                onChange={(e) => setStoreId(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
              >
                <option value="">Select a Store</option>
                {stores.map(store => (
                  <option key={store.id} value={store.storeId}>{store.name} ({store.storeId})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Scheduled Pickup Date</label>
              <input
                type="date"
                value={pickupDateScheduled}
                onChange={(e) => setPickupDateScheduled(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-medium text-slate-700 mb-2">Order Notes (Optional)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none h-24 resize-none"
                placeholder="Add any special instructions or notes for this order..."
              />
            </div>
          </div>
        </section>

        {/* Items Section */}
        <section className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-6">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center text-sm">2</span>
            Order Items
          </h2>
          
          <div className="flex gap-4">
            <div className="relative flex-1" ref={skuRef}>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
                <input
                  type="text"
                  value={skuSearch}
                  onChange={(e) => setSkuSearch(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                  placeholder={isCnRoute ? "搜索 SKU 或商品名称..." : "Search SKU or Product Name..."}
                />
              </div>
              
              {showSkuResults && (
                <div className="absolute z-10 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-64 overflow-auto">
                  {skuResults.map(sku => (
                    <button
                      key={sku.id}
                      type="button"
                      onClick={() => addItem(sku)}
                      className="w-full text-left px-4 py-3 hover:bg-slate-50 flex items-center justify-between border-b border-slate-100 last:border-0"
                    >
                      <div>
                        <p className="font-bold text-slate-900">{sku.sku}</p>
                        <p className="text-sm text-slate-500">{sku.productName}</p>
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-semibold bg-indigo-50 text-indigo-600 px-2 py-1 rounded">
                          {sku.location}
                        </span>
                      </div>
                    </button>
                  ))}
                  {skuSearch.length > 0 && (
                    <button
                      type="button"
                      onClick={() => addItem()}
                      className="w-full text-left px-4 py-4 hover:bg-indigo-50 flex items-center gap-3 text-indigo-600 border-t border-slate-100"
                    >
                      <Plus className="w-5 h-5" />
                      <div className="flex flex-col">
                        <span className="text-sm font-bold">{isCnRoute ? `添加自定义：${skuSearch.toUpperCase()}` : `Add Custom: ${skuSearch.toUpperCase()}`}</span>
                        <span className="text-[10px] opacity-70 italic uppercase tracking-wider">Not in SKU database</span>
                      </div>
                    </button>
                  )}
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={() => addItem()}
              className="px-6 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl transition-all flex items-center gap-2 whitespace-nowrap"
            >
              <Plus className="w-5 h-5" />
              {isCnRoute ? '手动添加' : 'Manual Add'}
            </button>
          </div>

          <div className="space-y-4">
            {items.length === 0 ? (
              <div className="text-center py-12 border-2 border-dashed border-slate-100 rounded-2xl">
                <Package className="w-12 h-12 text-slate-200 mx-auto mb-3" />
                <p className="text-slate-400">{isCnRoute ? '尚未添加商品，请先搜索后添加。' : 'No items added yet. Search above to add items.'}</p>
              </div>
            ) : (
              <div className="overflow-hidden border border-slate-100 rounded-xl">
                <table className="w-full text-left">
                  <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
                    <tr>
                      <th className="px-4 py-3">SKU</th>
                      <th className="px-4 py-3">Product</th>
                      <th className="px-4 py-3">Location</th>
                      <th className="px-4 py-3 w-24">Qty</th>
                      <th className="px-4 py-3 w-32">Price (NZD)</th>
                      <th className="px-4 py-3 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {items.map((item, index) => (
                      <tr key={index}>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={item.sku || ''}
                            onChange={(e) => updateItemField(index, 'sku', e.target.value.toUpperCase())}
                            className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none text-sm font-medium"
                            placeholder="SKU"
                            required
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={item.productName || ''}
                            onChange={(e) => updateItemField(index, 'productName', e.target.value)}
                            className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none text-sm"
                            placeholder="Product Name"
                            required
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="text"
                            value={item.location || ''}
                            onChange={(e) => updateItemField(index, 'location', e.target.value)}
                            className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none text-sm"
                            placeholder="Loc"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <input
                            type="number"
                            min="1"
                            value={item.qty || 1}
                            onChange={(e) => updateQuantity(index, parseInt(e.target.value) || 1)}
                            className="w-full px-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none text-sm"
                          />
                        </td>
                        <td className="px-4 py-2">
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400 text-xs">$</span>
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.unit_price || 0}
                              onChange={(e) => updateItemField(index, 'unit_price', parseFloat(e.target.value) || 0)}
                              className="w-full pl-5 pr-2 py-1 bg-slate-50 border border-slate-200 rounded outline-none text-sm"
                              placeholder="0.00"
                              required
                            />
                          </div>
                        </td>
                        <td className="px-4 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => removeItem(index)}
                            className="p-1 text-slate-400 hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            
            {items.length > 0 && (
              <div className="flex justify-end pt-4">
                <div className="bg-slate-50 px-6 py-4 rounded-2xl border border-slate-100 min-w-[200px]">
                  <p className="text-xs text-slate-500 uppercase font-bold tracking-wider mb-1">Total Amount (NZD)</p>
                  <p className="text-2xl font-bold text-slate-900">
                    ${items.reduce((sum, item) => sum + (item.qty * item.unit_price), 0).toFixed(2)}
                  </p>
                </div>
              </div>
            )}
          </div>
        </section>

        {/* Payment Section */}
        <section className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-6">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center text-sm">3</span>
            Payment Information
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Payment Status</label>
              <div className="flex gap-4">
                <button
                  type="button"
                  onClick={() => setPaymentStatus('Unpaid')}
                  className={`flex-1 py-2 rounded-xl font-semibold border transition-all ${
                    paymentStatus === 'Unpaid' 
                      ? 'bg-red-50 border-red-200 text-red-700' 
                      : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  Unpaid
                </button>
                <button
                  type="button"
                  onClick={() => setPaymentStatus('Paid')}
                  className={`flex-1 py-2 rounded-xl font-semibold border transition-all ${
                    paymentStatus === 'Paid' 
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-700' 
                      : 'bg-slate-50 border-slate-200 text-slate-500 hover:bg-slate-100'
                  }`}
                >
                  Paid
                </button>
              </div>
            </div>
            {paymentStatus === 'Paid' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Payment Method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  <option value="EFTPOS">EFTPOS</option>
                  <option value="Cash">Cash</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="Online Payment">Online Payment</option>
                </select>
              </div>
            )}
          </div>
        </section>

        {/* Notifications Section */}
        <section className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm space-y-6">
          <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <span className="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center text-sm">4</span>
            Notification Recipients
          </h2>
          <div className="relative" ref={notificationRef}>
            <label className="block text-sm font-medium text-slate-700 mb-2">Select Users or Groups to Notify</label>
            <div 
              className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer flex flex-wrap gap-2 min-h-[50px]"
              onClick={() => setShowNotificationMenu(!showNotificationMenu)}
            >
              {notificationRecipients.length === 0 ? (
                <span className="text-slate-400">Select recipients...</span>
              ) : (
                notificationRecipients.map(id => {
                  if (id.startsWith('group:')) {
                    const group = allGroups.find(g => g.id === id.replace('group:', ''));
                    return (
                      <span key={id} className="bg-indigo-100 text-indigo-700 px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1">
                        <UsersIcon className="w-3 h-3" />
                        {group?.name || 'Unknown Group'}
                      </span>
                    );
                  } else {
                    const user = allUsers.find(u => u.uid === id);
                    return (
                      <span key={id} className="bg-slate-200 text-slate-700 px-2 py-1 rounded-lg text-xs font-semibold flex items-center gap-1">
                        <UserIcon className="w-3 h-3" />
                        {user?.name || 'Unknown User'}
                      </span>
                    );
                  }
                })
              )}
            </div>

            {showNotificationMenu && (
              <div className="absolute z-20 w-full mt-2 bg-white border border-slate-200 rounded-xl shadow-xl max-h-80 overflow-auto p-2">
                <div className="p-2 text-xs font-bold text-slate-400 uppercase tracking-wider">User Groups</div>
                {allGroups.map(group => (
                  <button
                    key={group.id}
                    type="button"
                    onClick={() => {
                      const id = `group:${group.id}`;
                      setNotificationRecipients(prev => 
                        prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
                      );
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <UsersIcon className="w-4 h-4 text-indigo-500" />
                      <span className="text-sm font-medium text-slate-700">{group.name}</span>
                    </div>
                    {notificationRecipients.includes(`group:${group.id}`) && <Check className="w-4 h-4 text-indigo-600" />}
                  </button>
                ))}

                <div className="p-2 mt-2 text-xs font-bold text-slate-400 uppercase tracking-wider border-t border-slate-100 pt-4">Individual Users</div>
                {allUsers.map(user => (
                  <button
                    key={user.uid}
                    type="button"
                    onClick={() => {
                      setNotificationRecipients(prev => 
                        prev.includes(user.uid) ? prev.filter(i => i !== user.uid) : [...prev, user.uid]
                      );
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-slate-50 rounded-lg transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <UserIcon className="w-4 h-4 text-slate-400" />
                      <span className="text-sm font-medium text-slate-700">{user.name}</span>
                    </div>
                    {notificationRecipients.includes(user.uid) && <Check className="w-4 h-4 text-indigo-600" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </section>

        <div className="flex justify-end gap-4">
          <button
            type="button"
            onClick={() => navigate(ordersBasePath)}
            className="px-6 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors"
          >
            {isCnRoute ? '取消' : 'Cancel'}
          </button>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-200 disabled:opacity-50"
          >
            <Save className="w-5 h-5" />
            {loading ? (isCnRoute ? '创建中...' : 'Creating...') : (isCnRoute ? '创建订单' : 'Create Order')}
          </button>
        </div>
      </form>
    </div>
  </div>
</div>
  );
};
