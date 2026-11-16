import React, { useState, useEffect, useRef } from 'react';
import { X, Save, AlertCircle, Key, Mail, Server, Hash, Code, Info } from 'lucide-react';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType, logAction } from '../utils';
import { Store, UserProfile } from '../types';
import { useLocation } from 'react-router-dom';
import { useAuth } from './AuthProvider';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
  editingStore: Store | null;
}

export const StoreConfigModal: React.FC<Props> = ({ isOpen, onClose, onSave, editingStore }) => {
  const { profile } = useAuth();
  const isCnRoute = useLocation().pathname.startsWith("/cn");
  const [activeTab, setActiveTab] = useState<'general' | 'template'>('general');
  const [store, setStore] = useState<Store>({
    storeId: '',
    name: '',
    senderEmail: '',
    template: {
      subject: '',
      body: ''
    },
    disableEmail: false
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertVariable = (variable: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const text = store.template.body;
    const before = text.substring(0, start);
    const after = text.substring(end);
    const newText = `${before}{{${variable}}}${after}`;

    setStore({
      ...store,
      template: {
        ...store.template,
        body: newText
      }
    });

    // Reset focus and cursor position after state update
    setTimeout(() => {
      textarea.focus();
      const newPos = start + variable.length + 4; // +4 for {{ }}
      textarea.setSelectionRange(newPos, newPos);
    }, 0);
  };

  useEffect(() => {
    if (isOpen) {
      if (editingStore) {
        setStore({
          ...editingStore,
          senderEmail: editingStore.senderEmail || '',
          template: {
            ...editingStore.template,
            subject: editingStore.template?.subject || '',
            body: editingStore.template?.body || ''
          }
        });
      } else {
        setStore({
          storeId: '',
          name: '',
          senderEmail: '',
          template: {
            subject: '',
            body: ''
          },
          disableEmail: false
        });
      }
      setActiveTab('general');
      setError('');
    }
  }, [isOpen, editingStore]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!store.storeId || !store.name || !store.senderEmail) {
      setError('Store ID, Name, and Sender Email are required.');
      setActiveTab('general');
      return;
    }
    if (!store.template.subject || !store.template.body) {
      setError('Template subject and body are required.');
      setActiveTab('template');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const token = localStorage.getItem('x-v2-auth-token');
      const response = await fetch('/api/stores/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify(store)
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to save store');
      }

      if (profile && !isCnRoute) {
        await logAction(profile, editingStore ? 'Edit Store' : 'Add Store', `${editingStore ? 'Updated' : 'Added'} store configuration for ${store.storeId}`, null, 'Store');
      }
      onSave?.();
      onClose();
    } catch (err: any) {
      console.error('Error saving store:', err);
      setError(`Failed to save store: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-2xl overflow-hidden animate-in fade-in zoom-in duration-200 flex flex-col max-h-[90vh]">
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-indigo-600 text-white">
          <div className="flex items-center gap-3">
            <Server className="w-6 h-6" />
            <h2 className="text-xl font-bold">{editingStore ? 'Edit Store' : 'Add Store'}</h2>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        <div className="flex border-b border-slate-100 bg-slate-50">
          <button
            onClick={() => setActiveTab('general')}
            className={`flex-1 py-3 text-sm font-bold transition-all border-b-2 ${activeTab === 'general' ? 'border-indigo-600 text-indigo-600 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            General Settings
          </button>
          <button
            onClick={() => setActiveTab('template')}
            className={`flex-1 py-3 text-sm font-bold transition-all border-b-2 ${activeTab === 'template' ? 'border-indigo-600 text-indigo-600 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            Email Template
          </button>
        </div>

        <form onSubmit={handleSave} className="flex-1 overflow-y-auto p-6 space-y-6">
          {error && (
            <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600 text-sm font-medium">
              <AlertCircle className="w-5 h-5 flex-shrink-0" />
              {error}
            </div>
          )}

          {activeTab === 'general' ? (
            <div className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-1 mb-2 ml-1">
                    <label className="block text-xs font-bold text-slate-400 uppercase">Store ID</label>
                    <Info className="w-3 h-3 text-slate-300" />
                  </div>
                  <input
                    type="text"
                    value={store.storeId}
                    onChange={(e) => setStore({ ...store, storeId: e.target.value.toUpperCase().replace(/\s+/g, '_') })}
                    disabled={!!editingStore}
                    placeholder="e.g. SHOPIFY_NZ_01"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all disabled:opacity-50 font-mono text-sm"
                  />
                </div>
                <div>
                  <div className="flex items-center gap-1 mb-2 ml-1">
                    <label className="block text-xs font-bold text-slate-400 uppercase">Store Name</label>
                    <Info className="w-3 h-3 text-slate-300" />
                  </div>
                  <input
                    type="text"
                    value={store.name}
                    onChange={(e) => setStore({ ...store, name: e.target.value })}
                    placeholder="e.g. Shopify NZ"
                    className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center gap-1 mb-2 ml-1">
                  <label className="block text-xs font-bold text-slate-400 uppercase">Sender Email</label>
                  <Info className="w-3 h-3 text-slate-300" />
                </div>
                <input
                  type="email"
                  value={store.senderEmail}
                  onChange={(e) => setStore({ ...store, senderEmail: e.target.value })}
                  placeholder="info@yourstore.com"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
                <p className="mt-2 text-[10px] text-slate-400 ml-1 italic">
                  This email will be used as the 'From' and 'Reply-To' address.
                </p>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <label className="flex items-center gap-3 p-4 bg-red-50 border border-red-100 rounded-2xl cursor-pointer hover:bg-red-100 transition-all">
                  <input
                    type="checkbox"
                    checked={store.disableEmail}
                    onChange={(e) => setStore({ ...store, disableEmail: e.target.checked })}
                    className="w-5 h-5 rounded border-red-300 text-red-600 focus:ring-red-500"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-red-700">Disable Email Sending</span>
                    <span className="text-[10px] text-red-400">Skip all notifications for this store</span>
                  </div>
                </label>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Email Subject</label>
                <input
                  type="text"
                  value={store.template.subject}
                  onChange={(e) => setStore({ ...store, template: { ...store.template, subject: e.target.value } })}
                  placeholder="Pickup Instructions for Order {{bookingNumber}}"
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-400 uppercase mb-2 ml-1">Email Body (HTML)</label>
                <textarea
                  ref={textareaRef}
                  value={store.template.body}
                  onChange={(e) => setStore({ ...store, template: { ...store.template, body: e.target.value } })}
                  placeholder="<p>Hello {{customerName}},</p><p>Your order {{bookingNumber}} is ready for pickup at {{storeName}}.</p>..."
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-2xl focus:ring-2 focus:ring-indigo-500 outline-none h-64 font-mono text-xs"
                />
              </div>

              <div className="bg-indigo-50 p-4 rounded-2xl space-y-2">
                <div className="flex items-center gap-2 text-indigo-700 font-bold text-xs">
                  <Code className="w-4 h-4" />
                  Available Variables (Click to insert)
                </div>
                <div className="flex flex-wrap gap-2">
                  {['customerName', 'bookingNumber', 'refNumber', 'warehouseLocation', 'status', 'storeName'].map(v => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => insertVariable(v)}
                      className="text-[10px] bg-white px-2 py-1 rounded border border-indigo-100 text-indigo-600 font-bold hover:bg-indigo-600 hover:text-white transition-colors"
                    >
                      {'{{'}{v}{'}}'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-4 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-2xl font-bold transition-all"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex-2 py-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl font-bold transition-all flex items-center justify-center gap-2 disabled:opacity-50 shadow-lg shadow-indigo-200"
            >
              {saving ? (
                <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <Save className="w-5 h-5" />
              )}
              {saving ? 'Saving...' : 'Save Configuration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
