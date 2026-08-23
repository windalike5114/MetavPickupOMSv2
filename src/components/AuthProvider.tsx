import React, { createContext, useContext, useEffect, useState, useMemo, useRef } from 'react';
import { signInWithCustomToken } from 'firebase/auth';
import { onSnapshot, doc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { UserProfile, ROLE_TEMPLATES } from '../types';
import { requestNotificationPermission } from '../messaging';
import { WarehouseSelector } from './WarehouseSelector';
import { CN_API_ONLY } from '../constants';

interface AuthContextType {
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
  const [loading, setLoading] = useState(true);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeWarehouse, setActiveWarehouseState] = useState<string | null>(() => sessionStorage.getItem('activeWarehouse'));
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

  // Initialize auth state from localStorage
  useEffect(() => {
    const savedToken = localStorage.getItem('x-v2-auth-token');
    const savedUser = localStorage.getItem('user_info');

    if (savedToken && savedUser) {
      try {
        const parsedUser = JSON.parse(savedUser);
        setToken(savedToken);
        setUser(parsedUser);
        
        setProfile(buildProfileFromUser(parsedUser));

        // CN API-only mode: skip all Firebase dependencies.
        if (CN_API_ONLY) {
          setLoading(false);
          setIsAuthReady(true);
          return;
        }

        // Restore Firebase Auth session if custom token exists
        const savedFirebaseToken = localStorage.getItem('firebase_custom_token');
        
        const refreshFirebaseToken = async () => {
          try {
            const res = await fetch('/api/auth/firebase-token', {
              headers: { 'x-v2-auth-token': savedToken }
            });
            const data = await res.json();
            if (data.success && data.firebaseCustomToken) {
              localStorage.setItem('firebase_custom_token', data.firebaseCustomToken);
              await signInWithCustomToken(auth, data.firebaseCustomToken);
              console.log('✅ Firebase Auth session refreshed');
              
              // Add real-time profile listener
              if (profileUnsubRef.current) profileUnsubRef.current();
              profileUnsubRef.current = onSnapshot(doc(db, 'users', parsedUser.uid), (docSnap) => {
                if (docSnap.exists()) {
                  setProfile(mergeRealtimeProfile(parsedUser, docSnap.data()));
                }
              });
            } else {
              throw new Error(data.error || 'Failed to refresh token');
            }
          } catch (err) {
            console.error('❌ Failed to refresh Firebase Auth session:', err);
          } finally {
            setLoading(false);
            setIsAuthReady(true);
          }
        };

        if (savedFirebaseToken) {
          signInWithCustomToken(auth, savedFirebaseToken)
            .then(() => {
              console.log('✅ Firebase Auth session restored');
              // Add real-time profile listener
              if (profileUnsubRef.current) profileUnsubRef.current();
              profileUnsubRef.current = onSnapshot(doc(db, 'users', parsedUser.uid), (docSnap) => {
                if (docSnap.exists()) {
                  setProfile(mergeRealtimeProfile(parsedUser, docSnap.data()));
                }
              });
              setLoading(false);
              setIsAuthReady(true);
            })
            .catch(err => {
              console.warn('⚠️ Firebase token might be expired, attempting refresh...', err.message);
              refreshFirebaseToken();
            });
        } else {
          // No firebase token but we have JWT, try to get one
          refreshFirebaseToken();
        }
        return; // Wait for promise
      } catch (e) {
        console.error('Failed to parse saved user info', e);
        localStorage.removeItem('x-v2-auth-token');
        localStorage.removeItem('user_info');
      }
    }
    
    setLoading(false);
    setIsAuthReady(true);
  }, []);

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

    localStorage.setItem('x-v2-auth-token', data.token);
    localStorage.setItem('user_info', JSON.stringify(data.user));
    
    if (!CN_API_ONLY && data.firebaseCustomToken) {
      localStorage.setItem('firebase_custom_token', data.firebaseCustomToken);
      try {
        await signInWithCustomToken(auth, data.firebaseCustomToken);
        
        // Add real-time profile listener
        if (profileUnsubRef.current) profileUnsubRef.current();
        profileUnsubRef.current = onSnapshot(doc(db, 'users', data.user.uid), (docSnap) => {
          if (docSnap.exists()) {
            setProfile(mergeRealtimeProfile(data.user, docSnap.data()));
          }
        });
      } catch (err) {
        console.error('Firebase Auth sign-in failed:', err);
      }
    }

    setToken(data.token);
    setUser(data.user);
    
    // Construct initial profile from user data
    setProfile(buildProfileFromUser(data.user));
    return data;
  };

  const logout = () => {
    localStorage.removeItem('x-v2-auth-token');
    localStorage.removeItem('user_info');
    localStorage.removeItem('firebase_custom_token');
    sessionStorage.removeItem('activeWarehouse');
    if (profileUnsubRef.current) profileUnsubRef.current();
    if (!CN_API_ONLY) auth.signOut();
    setToken(null);
    setUser(null);
    setProfile(null);
    setActiveWarehouseState(null);
  };

  // Sync state if localStorage changes in other tabs
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === 'x-v2-auth-token' || e.key === 'user_info') {
        const savedToken = localStorage.getItem('x-v2-auth-token');
        const savedUser = localStorage.getItem('user_info');
        
        if (!savedToken || !savedUser) {
          logout();
        } else {
          try {
            const parsedUser = JSON.parse(savedUser);
            setToken(savedToken);
            setUser(parsedUser);
            setProfile(buildProfileFromUser(parsedUser));
          } catch (e) {
            logout();
          }
        }
      }
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  const value = useMemo(() => ({ 
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
  }), [user, token, profile, loading, isAuthReady, activeWarehouse]);

  return (
    <AuthContext.Provider value={value}>
      {children}
      {!CN_API_ONLY && user && profile && profile.allowedWarehouses && profile.allowedWarehouses.length > 1 && !activeWarehouse && (
        <WarehouseSelector 
          allowedWarehouses={profile.allowedWarehouses} 
          onSelect={setActiveWarehouse} 
        />
      )}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
