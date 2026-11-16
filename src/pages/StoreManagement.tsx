import React, { useState, useEffect, useRef } from 'react';
import { collection, query, getDocs, deleteDoc, doc } from 'firebase/firestore';
import { useLocation, useNavigate } from 'react-router-dom';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { Store } from '../types';
import { logAction, hasPermission, isAdmin, handleFirestoreError, OperationType, cn } from '../utils';
import { StoreConfigModal } from '../components/StoreConfigModal';
import { 
  Plus, 
  Trash2, 
  Edit2, 
  Store as StoreIcon,
  Loader2,
  AlertCircle,
  Mail,
  CheckCircle2,
  Server
} from 'lucide-react';

import { PageHeader } from '../components/PageHeader';

export const StoreManagement = () => {
  const { profile, user, token } = useAuth();
  const isCnRoute = useLocation().pathname.startsWith("/cn");
  const [stores, setStores] = useState<Store[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  
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

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingStore, setEditingStore] = useState<Store | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<Store | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const navigate = useNavigate();

  const canManage = isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Stores', profile?.email);

  useEffect(() => {
    if (!loading && !canManage) {
      navigate(isCnRoute ? '/cn' : '/');
    }
  }, [loading, canManage, navigate, isCnRoute]);

  useEffect(() => {
    console.log("🔥 正在连接的项目 ID:", db.app.options.projectId);
    if (canManage) {
      fetchStores();
    }
  }, [canManage, isCnRoute, token]);

  const fetchStores = async () => {
    setLoading(true);
    try {
      let storesList: Store[];
      if (isCnRoute) {
        const response = await fetch('/api/stores/list?management=1', { headers: { 'x-v2-auth-token': token || '' }, cache: 'no-store' });
        const data = await response.json();
        if (!response.ok || !data.success) throw new Error(data.error || '无法加载门店。');
        storesList = data.stores;
      } else {
        const snapshot = await getDocs(query(collection(db, 'stores')));
        storesList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Store));
      }
      storesList.sort((a, b) => a.storeId.localeCompare(b.storeId));
      setStores(storesList);
    } catch (err: any) {
      console.error('Error fetching stores:', err);
      if (isCnRoute) { setError(err.message || '无法加载门店。'); return; }
      try {
        handleFirestoreError(err, OperationType.LIST, 'stores');
      } catch (formattedError: any) {
        setError(`Failed to load stores: ${formattedError.message}`);
      }
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (store: Store) => {
    setEditingStore(store);
    setIsModalOpen(true);
  };

  const handleAdd = () => {
    setEditingStore(null);
    setIsModalOpen(true);
  };

  const handleDelete = async (store: Store) => {
    if (!profile || !canManage || !store.id) return;
    
    setActionLoading(true);
    setError('');
    try {
      const token = localStorage.getItem('x-v2-auth-token');
      const response = await fetch('/api/stores/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ id: store.id, storeId: store.storeId })
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to delete store');
      }

      setSuccess(`Store "${store.storeId}" deleted successfully.`);
      if (profile && !isCnRoute) {
        await logAction(profile, 'Delete Store', `Deleted store configuration for ${store.storeId}`, null, 'Store');
      }
      setShowDeleteConfirm(null);
      fetchStores();
      setTimeout(() => setSuccess(''), 3000);
    } catch (err: any) {
      console.error('Error deleting store:', err);
      setError(`Failed to delete store: ${err.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (isCnRoute && !canManage) return <p role="alert" className="p-6">此账号没有门店管理权限。</p>;

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loader2 className="w-8 h-8 text-indigo-600 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        compact={isCnRoute}
        title={isCnRoute ? "门店管理" : "Store Management"}
        subtitle={isCnRoute ? undefined : "Manage store-specific SMTP settings and email templates."}
        icon={StoreIcon}
        isScrolled={isScrolled}
        actions={
          canManage && (
            <button
              onClick={handleAdd}
              className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-bold transition-all shadow-lg shadow-indigo-200 flex items-center gap-2"
            >
              <Plus className="w-5 h-5" />
              Add Store
            </button>
          )
        }
      />

      {/* 🚀 Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-6xl mx-auto space-y-8">
          {error && (
        <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 text-red-700 text-sm animate-in fade-in duration-300">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {success && (
        <div className="p-4 bg-emerald-50 border border-emerald-100 rounded-xl flex items-start gap-3 text-emerald-700 text-sm animate-in fade-in duration-300">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
          <p>{success}</p>
        </div>
      )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-slate-500 text-[10px] font-bold uppercase tracking-wider">
              <tr>
                <th className="px-6 py-4">Store ID</th>
                <th className="px-6 py-4">Store Name</th>
                <th className="px-6 py-4">Sender Email</th>
                <th className="px-6 py-4">Email Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stores.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-slate-400">
                    <StoreIcon className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p>No stores configured. {canManage && 'Add one to get started.'}</p>
                  </td>
                </tr>
              ) : (
                stores.map(store => (
                  <tr key={store.id} className="hover:bg-slate-50/50 transition-colors">
                    <td className="px-6 py-4">
                      <span className="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-1 rounded">
                        {store.storeId}
                      </span>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-slate-100 rounded-lg flex items-center justify-center">
                          <StoreIcon className="w-4 h-4 text-slate-500" />
                        </div>
                        <span className="font-bold text-slate-900">{store.name}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2 text-slate-600 text-sm italic">
                        <Mail className="w-3 h-3 opacity-40" />
                        {store.senderEmail || 'Not Set'}
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      {store.disableEmail ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-red-100 text-red-700">
                          <AlertCircle className="w-3 h-3" />
                          Disabled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-700">
                          <CheckCircle2 className="w-3 h-3" />
                          Active
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          onClick={() => handleEdit(store)}
                          className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                          title="Edit Configuration"
                        >
                          <Edit2 className="w-5 h-5" />
                        </button>
                        {canManage && (
                          <button
                            onClick={() => setShowDeleteConfirm(store)}
                            className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                            title="Delete"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Store Config Modal */}
      <StoreConfigModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setEditingStore(null);
        }}
        onSave={() => {
          fetchStores();
          setSuccess('Store configuration saved successfully.');
          setTimeout(() => setSuccess(''), 3000);
        }}
        editingStore={editingStore}
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-3xl w-full max-w-md p-6 shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="w-12 h-12 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center mb-4">
              <Trash2 className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 mb-2">Delete Store Config?</h3>
            <p className="text-slate-500 mb-6">
              Are you sure you want to delete configuration for <span className="font-bold text-slate-900">"{showDeleteConfirm.storeId}"</span>? 
              This will disable email notifications for this store.
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowDeleteConfirm(null)}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-slate-600 hover:bg-slate-100 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => handleDelete(showDeleteConfirm)}
                disabled={actionLoading}
                className="flex-1 bg-red-600 text-white px-4 py-3 rounded-xl font-bold hover:bg-red-700 transition-colors shadow-lg shadow-red-200 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {actionLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  </div>
);
};
