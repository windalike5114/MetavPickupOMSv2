import React, { createContext, useContext, useEffect, useState, useMemo, useRef } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { onSnapshot, doc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { UserProfile, ROLE_TEMPLATES } from '../types';
import { requestNotificationPermission } from '../messaging';
import { WarehouseSelector } from './WarehouseSelector';
import { CN_API_ONLY } from '../constants';

function sessionExpiry(token: string): number {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload));
    return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

interface AuthContextType {
  sessionEnded: boolean;
  user: { uid: string; username: string; email?: string; role: string; allowedWarehouses: string[] } | null;
  token: string | null;
  profile: UserProfile | null;
  loading: boolean;
  isAuthReady: boolean;
  activeWarehouse: string | null;
  setActiveWarehouse: (id: string) => void;
  clearActiveWarehouse: () => void;
  login: (username: string, password: string) => Promise<any>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextType>({
  sessionEnded: false,
  user: null,
  token: null,
  profile: null,
  loading: true,
  isAuthReady: false,
  activeWarehouse: null,
  setActiveWarehouse: () => {},
  clearActiveWarehouse: () => {},
  login: async () => {},
  logout: () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ uid: string; username: string; email: string; role: string; allowedWarehouses: string[] } | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const isCnPortalContext = CN_API_ONLY || window.location.pathname.startsWith('/cn');
  const [activeWarehouse, setActiveWarehouseState] = useState<string | null>(() =>
    isCnPortalContext ? null : sessionStorage.getItem('activeWarehouse')
  );
  const firebaseWork = useRef<Promise<unknown>>(Promise.resolve());
  const profileUnsubRef = useRef<(() => void) | null>(null);

  const buildProfileFromUser = (rawUser: any): UserProfile => ({
    uid: rawUser.uid,
    username: rawUser.username,
    email: rawUser.email,
    name: rawUser.name || rawUser.username,
    status: rawUser.status || 'Active',
    allowedWarehouses: rawUser.allowedWarehouses,
    roleTemplate: rawUser.role,
    permissions: rawUser.permissions || (ROLE_TEMPLATES as any)[rawUser.role] || []
  });

  const mergeRealtimeProfile = (baseUser: any, realtimeData: any): UserProfile => ({
    ...realtimeData,
    uid: realtimeData?.uid || baseUser.uid,
    username: realtimeData?.username || baseUser.username,
    email: realtimeData?.email || baseUser.email,
    name: realtimeData?.name || baseUser.name || baseUser.username,
    status: realtimeData?.status || 'Active',
    allowedWarehouses: realtimeData?.allowedWarehouses || baseUser.allowedWarehouses || [],
    roleTemplate: realtimeData?.roleTemplate || baseUser.role,
    permissions: realtimeData?.permissions || baseUser.permissions || (ROLE_TEMPLATES as any)[baseUser.role] || []
  });

  const stopProfileListener = () => {
    profileUnsubRef.current?.();
    profileUnsubRef.current = null;
  };

  const queueFirebaseWork = (work: () => Promise<unknown>) => {
    const result = firebaseWork.current.then(work);
    firebaseWork.current = result.catch((error) => {
      console.error('Firebase session update failed:', error);
    });
    return firebaseWork.current;
  };

  const connectFirebase = (customToken: string, sessionToken: string, sessionUser: NonNullable<typeof user>, isCurrent: () => boolean) =>
    queueFirebaseWork(async () => {
      if (!isCurrent() || localStorage.getItem('x-v2-auth-token') !== sessionToken) return;
      await signInWithCustomToken(auth, customToken);
      if (!isCurrent() || localStorage.getItem('x-v2-auth-token') !== sessionToken) return;
      stopProfileListener();
      profileUnsubRef.current = onSnapshot(doc(db, 'users', sessionUser.uid), (snapshot) => {
        if (snapshot.exists() && localStorage.getItem('x-v2-auth-token') === sessionToken) {
          setProfile(mergeRealtimeProfile(sessionUser, snapshot.data()));
        }
      }, (error) => console.error('Firebase profile subscription failed:', error));
    });

  const clearSession = (ended: boolean, clearSharedStorage = true) => {
    if (clearSharedStorage) {
      localStorage.removeItem('x-v2-auth-token');
      localStorage.removeItem('user_info');
      localStorage.removeItem('firebase_custom_token');
    }
    sessionStorage.removeItem('activeWarehouse');
    stopProfileListener();
    if (!CN_API_ONLY) {
      void queueFirebaseWork(async () => {
        if (!localStorage.getItem('x-v2-auth-token')) await auth.signOut();
      });
    }
    setToken(null);
    setUser(null);
    setProfile(null);
    setActiveWarehouseState(null);
    setSessionEnded(ended);
    setLoading(false);
    setIsAuthReady(true);
  };

  useEffect(() => {
    let restoration: AbortController | undefined;

    const restoreSession = async () => {
      restoration?.abort();
      const controller = new AbortController();
      restoration = controller;
      const savedToken = localStorage.getItem('x-v2-auth-token');
      const savedUser = localStorage.getItem('user_info');
      const isCurrent = () => !controller.signal.aborted &&
        localStorage.getItem('x-v2-auth-token') === savedToken;
      stopProfileListener();

      if (!savedToken) {
        clearSession(Boolean(savedUser), false);
        return;
      }
      if (!savedUser || sessionExpiry(savedToken) <= Date.now()) {
        clearSession(true);
        return;
      }

      let parsedUser: NonNullable<typeof user>;
      try {
        parsedUser = JSON.parse(savedUser);
        if (!parsedUser?.uid) throw new Error('Missing session user');
      } catch {
        clearSession(true);
        return;
      }

      setLoading(true);
      setIsAuthReady(false);
      try {
        if (!CN_API_ONLY) {
          const response = await fetch('/api/auth/firebase-token', {
            headers: { 'x-v2-auth-token': savedToken },
            cache: 'no-store',
            signal: controller.signal
          });
          if (!isCurrent()) return;
          if (response.status === 401 || response.status === 404) {
            clearSession(true);
            return;
          }
          const data = await response.json();
          if (data.success && data.firebaseCustomToken) {
            await connectFirebase(data.firebaseCustomToken, savedToken, parsedUser, isCurrent);
          }
        }
      } catch (error) {
        if (isCurrent()) console.error('Firebase session restoration failed:', error);
      } finally {
        if (isCurrent()) {
          if (sessionExpiry(savedToken) <= Date.now()) {
            clearSession(true);
          } else {
            setToken(savedToken);
            setUser(parsedUser);
            setProfile(buildProfileFromUser(parsedUser));
            setSessionEnded(false);
            setLoading(false);
            setIsAuthReady(true);
          }
        }
      }
    };

    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === 'x-v2-auth-token' || event.key === null) {
        if (!localStorage.getItem('x-v2-auth-token') && event.oldValue && sessionExpiry(event.oldValue) <= Date.now()) {
          restoration?.abort();
          clearSession(true, false);
          return;
        }
        void restoreSession();
      }
    };

    localStorage.removeItem('firebase_custom_token');
    void restoreSession();
    window.addEventListener('storage', handleStorageChange);
    return () => {
      restoration?.abort();
      stopProfileListener();
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    if (!token) return;
    let timer: number;
    const checkExpiry = () => {
      window.clearTimeout(timer);
      if (localStorage.getItem('x-v2-auth-token') !== token) return;
      const remaining = sessionExpiry(token) - Date.now();
      if (remaining <= 0) {
        clearSession(true);
      } else {
        timer = window.setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      }
    };
    checkExpiry();
    window.addEventListener('focus', checkExpiry);
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('focus', checkExpiry);
      document.removeEventListener('visibilitychange', checkExpiry);
    };
  }, [token]);

  const setActiveWarehouse = (id: string) => {
    if (!id) {
      sessionStorage.removeItem('activeWarehouse');
      setActiveWarehouseState(null);
    } else {
      sessionStorage.setItem('activeWarehouse', id);
      setActiveWarehouseState(id);
    }
  };

  const clearActiveWarehouse = () => {
    sessionStorage.removeItem('activeWarehouse');
    setActiveWarehouseState(null);
  };

  const login = async (username: string, password: string) => {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Login failed');
    }

    if (!data.token || !data.user?.uid) throw new Error('Login response is missing session information.');

    stopProfileListener();
    clearActiveWarehouse();
    localStorage.removeItem('firebase_custom_token');
    localStorage.setItem('user_info', JSON.stringify(data.user));
    localStorage.setItem('x-v2-auth-token', data.token);

    setProfile(buildProfileFromUser(data.user));
    if (!CN_API_ONLY) {
      await queueFirebaseWork(async () => {
        if (auth.currentUser && auth.currentUser.uid !== data.user.uid &&
            localStorage.getItem('x-v2-auth-token') === data.token) {
          await auth.signOut();
        }
      });
      if (data.firebaseCustomToken) {
        await connectFirebase(data.firebaseCustomToken, data.token, data.user, () => true);
      }
    }

    if (localStorage.getItem('x-v2-auth-token') !== data.token) return;
    setToken(data.token);
    setUser(data.user);
    setSessionEnded(false);
    setLoading(false);
    setIsAuthReady(true);
    return data;
  };

  const logout = () => clearSession(false);

  const value = useMemo(() => ({
    sessionEnded,
    user, 
    token,
    profile, 
    loading, 
    isAuthReady, 
    activeWarehouse, 
    setActiveWarehouse, 
    clearActiveWarehouse,
    login,
    logout
  }), [user, token, profile, loading, isAuthReady, activeWarehouse, sessionEnded]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      {!isCnPortalContext && user && profile && profile.allowedWarehouses && profile.allowedWarehouses.length > 1 && !activeWarehouse && (
        <WarehouseSelector 
          allowedWarehouses={profile.allowedWarehouses} 
          onSelect={setActiveWarehouse} 
        />
      )}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
