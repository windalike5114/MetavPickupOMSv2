import type { QuerySnapshot, DocumentData } from 'firebase/firestore';
import React, { useState, useEffect, useRef } from 'react';
import { collection, query, where, orderBy, onSnapshot, getDocs, doc, updateDoc, limit } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from './AuthProvider';
import { Bell, Check, X, ExternalLink, Clock } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useClickOutside } from '../hooks/useClickOutside';
import { subscribeDuringWorkHours } from '../lib/workHours';
import { formatDate } from '../utils';

export const NotificationCenter: React.FC = () => {
  const { user, profile } = useAuth();
  const [notifications, setNotifications] = useState<any[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const dropdownRef = useRef<HTMLDivElement>(null);
  useClickOutside(dropdownRef, () => setShowDropdown(false));

    useEffect(() => {
    if (!user || !profile || !profile.uid) return;
    if (profile.settings?.notificationsEnabled === false) {
      setNotifications([]);
      setUnreadCount(0);
      return;
    }

    const q = query(
      collection(db, 'notifications'),
      where('recipientUid', '==', profile.uid),
      orderBy('createdAt', 'desc'),
      limit(30)
    );

    let retryCount = 0;
    const MAX_RETRIES = 10;
    let unsubscribe: (() => void) | null = null;
    let retryTimeout: NodeJS.Timeout | null = null;

    const applySnapshot = (snap: QuerySnapshot<DocumentData>) => {
      const allNotifications = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as any));
      setNotifications(allNotifications);
      setUnreadCount(allNotifications.filter((n: any) => !n.isRead).length);
    };
    const setupListener = () => {
      // Clean up existing listener before retrying
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }

      unsubscribe = onSnapshot(q, (snap) => {
        retryCount = 0; // Reset on success
        applySnapshot(snap);
      }, (error) => {
        // Log the full error for debugging
        console.error("Notification listener error details:", {
          code: (error as any).code,
          message: error.message,
          name: error.name,
          stack: error.stack
        });
        
        // Only retry if it's a potentially transient error and we haven't exceeded retries
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Exponential backoff
          console.log(`Retrying notification listener in ${delay}ms (Attempt ${retryCount}/${MAX_RETRIES})...`);
          retryTimeout = setTimeout(setupListener, delay);
        } else {
          console.error("Notification listener: Exceeded maximum number of retries allowed.");
        }
      });
    };

    return subscribeDuringWorkHours('nz', () => {
      retryCount = 0;
      setupListener();
      return () => {
        unsubscribe?.();
        unsubscribe = null;
        if (retryTimeout) clearTimeout(retryTimeout);
      };
    }, async () => applySnapshot(await getDocs(q)));
  }, [user, profile]);

  const markAsRead = async (id: string) => {
    try {
      await updateDoc(doc(db, 'notifications', id), { isRead: true });
    } catch (err) {
      console.error('Error marking notification as read:', err);
    }
  };

  const markAllAsRead = async () => {
    try {
      const promises = notifications.map(n => updateDoc(doc(db, 'notifications', n.id), { isRead: true }));
      await Promise.all(promises);
    } catch (err) {
      console.error('Error marking all as read:', err);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button 
        onClick={() => setShowDropdown(!showDropdown)}
        className="p-2 text-slate-600 hover:bg-slate-100 rounded-xl transition-all relative"
      >
        <Bell className="w-6 h-6" />
        {unreadCount > 0 && (
          <span 
            className="absolute top-1 right-1 w-5 h-5 text-[10px] font-bold flex items-center justify-center rounded-full border-2"
            style={{ 
              backgroundColor: '#ef4444', 
              color: '#ffffff', 
              borderColor: '#ffffff' 
            }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {showDropdown && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl shadow-2xl z-40 overflow-hidden animate-in fade-in zoom-in duration-200 origin-top-right">
          <div className="p-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
              <h3 className="font-bold text-slate-900 dark:text-slate-900">Notifications</h3>
              {unreadCount > 0 && (
                <button 
                  onClick={markAllAsRead}
                  className="text-xs font-semibold text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
                >
                  <Check className="w-3 h-3" /> Mark all read
                </button>
              )}
            </div>

            <div className="max-h-96 overflow-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center">
                  <Bell className="w-10 h-10 text-slate-200 mx-auto mb-2" />
                  <p className="text-sm text-slate-400">No new notifications</p>
                </div>
              ) : (
                <div className="divide-y divide-slate-50">
                  {notifications.map((n) => (
                    <div key={n.id} className={`p-4 hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors group relative ${!n.isRead ? 'bg-indigo-50/30 dark:bg-indigo-900/10' : ''}`}>
                      {!n.isRead && (
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-indigo-600" />
                      )}
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          <p className={`text-sm font-bold ${!n.isRead ? 'text-indigo-900 dark:text-indigo-300' : 'text-slate-900 dark:text-slate-900'}`}>{n.title}</p>
                          <p className="text-xs text-slate-600 dark:text-slate-400 mt-1 leading-relaxed">{n.body}</p>
                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-[10px] text-slate-400 flex items-center gap-1">
                              <Clock className="w-3 h-3" /> {formatDate(n.createdAt, 'HH:mm')}
                            </span>
                            <Link 
                              to={`/orders/${n.orderId}`}
                              onClick={() => {
                                markAsRead(n.id);
                                setShowDropdown(false);
                              }}
                              className="text-[10px] font-bold text-indigo-600 hover:text-indigo-700 flex items-center gap-0.5"
                            >
                              View Order <ExternalLink className="w-2.5 h-2.5" />
                            </Link>
                          </div>
                        </div>
                        <button 
                          onClick={() => markAsRead(n.id)}
                          className="p-1 text-slate-300 hover:text-slate-600 transition-colors"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  };
