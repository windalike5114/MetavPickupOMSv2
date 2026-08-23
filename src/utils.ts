import { addDoc, collection, serverTimestamp, getDocs, query, where } from 'firebase/firestore';
import { db } from './firebase';
import { UserProfile, Permission, Notification, UserGroup, OperationLog } from './types';

import { format, isValid, parseISO } from 'date-fns';

export const formatDate = (date: any, formatStr: string, fallback = 'N/A'): string => {
  if (!date) return fallback;
  try {
    let d: Date;
    if (typeof date === 'string') {
      d = parseISO(date);
      // If parseISO fails (e.g., for "2026/3/25"), try standard Date constructor
      if (!isValid(d)) {
        d = new Date(date);
      }
    } else {
      d = new Date(date);
    }
    
    if (!isValid(d)) return fallback;
    return format(d, formatStr);
  } catch (err) {
    return fallback;
  }
};

export const logAction = async (user: UserProfile, action: string, details: string, orderId?: string, category?: OperationLog['category']) => {
  try {
    const response = await fetch('/api/logs/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-v2-auth-token': localStorage.getItem('x-v2-auth-token') || ''
      },
      body: JSON.stringify({
        action,
        details,
        orderId: orderId || null,
        category
      })
    });
    const result = await response.json();
    if (!result.success) {
      console.error('Failed to log action:', result.error);
    }
  } catch (error) {
    console.error('Failed to log action:', error);
  }
};

export const hasPermission = (profile: UserProfile | null, permission: Permission, username?: string | null): boolean => {
  if (isSystemAdmin(username)) return true;
  if (!profile) return false;
  if (profile.status === 'Disabled') return false;
  
  // Explicitly deny SKU access for Sales/Reception roles
  if (permission === 'View SKU' && (profile.roleTemplate === 'Sales' || profile.roleTemplate === 'Reception')) {
    return false;
  }

  return (profile.permissions || []).includes(permission);
};

export const isSystemAdmin = (username: string | null | undefined): boolean => {
  if (!username) return false;
  const admins = ['windalike5104@gmail.com', 'alan@pickup.system', 'admin'];
  return admins.includes(username.trim().toLowerCase());
};

export const createNotification = async (
  type: 'New Order' | 'Order Picked Up' | 'System',
  orderId: string,
  bookingNumber: string,
  recipientUids: string[]
) => {
  try {
    const notifications = recipientUids.map(uid => ({
      recipientUid: uid,
      title: type === 'New Order' ? 'New Order Created' : 'Order Picked Up',
      body: type === 'New Order' 
        ? `Order ${bookingNumber} has been created.` 
        : `Order ${bookingNumber} has been picked up.`,
      type,
      orderId,
      isRead: false,
      createdAt: new Date().toISOString()
    }));

    // Add all notifications
    const promises = notifications.map(n => addDoc(collection(db, 'notifications'), n));
    await Promise.all(promises);
  } catch (err) {
    console.error('Error creating notifications:', err);
  }
};

export const resolveRecipients = async (recipientIds: string[]): Promise<string[]> => {
  const uids = new Set<string>();
  const groupIds: string[] = [];
  const individualUids: string[] = [];

  recipientIds.forEach(id => {
    if (id.startsWith('group:')) {
      groupIds.push(id.replace('group:', ''));
    } else {
      individualUids.push(id);
    }
  });

  // Add individual UIDs
  individualUids.forEach(uid => uids.add(uid));

  // Fetch group members
  if (groupIds.length > 0) {
    try {
      const groupsSnap = await getDocs(collection(db, 'userGroups'));
      groupsSnap.docs.forEach(doc => {
        if (groupIds.includes(doc.id)) {
          const groupData = doc.data() as UserGroup;
          (groupData.userIds || []).forEach(uid => uids.add(uid));
        }
      });
    } catch (err) {
      console.error('Error resolving groups:', err);
    }
  }

  return Array.from(uids);
};

export const isAdmin = (profile: UserProfile | null, username?: string | null): boolean => {
  if (isSystemAdmin(username)) return true;
  if (!profile) return false;
  return profile.roleTemplate === 'Admin' || (profile.permissions || []).includes('Manage Users');
};

export const cn = (...inputs: any[]) => {
  return inputs.filter(Boolean).join(' ');
};

export const getWarehouseDisplayName = (warehouseId?: string | null): string => {
  if (!warehouseId) return 'Unassigned';
  if (warehouseId === 'AKL') return 'Auckland';
  if (warehouseId === 'CHC') return 'Christchurch';
  return warehouseId;
};

export const getSkuWarehouseLocation = (
  sku: { location?: string | null; locations?: Record<string, string> | null },
  warehouseId?: string | null
): string => {
  const wh = warehouseId || 'AKL';
  const warehouseLocation = sku.locations?.[wh];
  if (warehouseLocation && String(warehouseLocation).trim()) {
    return String(warehouseLocation).trim().toUpperCase();
  }
  const fallback = sku.location && String(sku.location).trim()
    ? String(sku.location).trim().toUpperCase()
    : 'N/A';
  return fallback;
};

export const safeSearch = (value: string | null | undefined, term: string): boolean => {
  if (!term) return true;
  if (!value) return false;
  return value.toLowerCase().includes(term.toLowerCase());
};

export const getAucklandDateKey = (value: string | number | Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));

export const getAucklandBusinessDayWindow = (value: string | number | Date, cutoffHour = 15) => {
  const formatter = new Intl.DateTimeFormat('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour);
  const base = new Date(Date.UTC(year, month - 1, day, cutoffHour, 0, 0));
  const tzOffsetMinutes = new Date().getTimezoneOffset();
  const utcCandidate = new Date(base.getTime() - tzOffsetMinutes * 60 * 1000);
  const start = new Date(utcCandidate);
  if (hour < cutoffHour) start.setDate(start.getDate() - 1);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
};

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

import { auth } from './firebase';

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const currentUser = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo: currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
