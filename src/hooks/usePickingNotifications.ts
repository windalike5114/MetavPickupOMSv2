import type { QuerySnapshot, DocumentData } from 'firebase/firestore';
import { startWorkPolling, subscribeDuringWorkHours } from '../lib/workHours';
import { useEffect, useRef, useState } from 'react';
import { collection, query, where, onSnapshot, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { useNavigate, useLocation } from 'react-router-dom';
import { CN_API_ONLY } from '../constants';
import { CounterPickup } from '../types';

const NOTIFICATION_SOUND_URL = 'https://assets.mixkit.co/active_storage/sfx/2358/2358-preview.mp3';
const ALERT_AUDIO_VOLUME = 1.0;

export const usePickingNotifications = () => {
  const { user, profile, activeWarehouse, token } = useAuth();
  const location = useLocation();
  const isCnRoute = location.pathname.startsWith('/cn');
  const routePrefix = isCnRoute ? '/cn' : '';
  const [isInitialized, setIsInitialized] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const knownOrderIds = useRef(new Set<string>());
  const counterInitializedRef = useRef(false);
  const knownCounterPickupStates = useRef(new Map<string, string>());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const navigate = useNavigate();

  const hasPickingPermission =
    profile?.permissions?.includes('view_picking_queue') ||
    profile?.roleTemplate === 'Admin' ||
    profile?.roleTemplate === 'Warehouse';

  useEffect(() => {
    audioRef.current = new Audio(NOTIFICATION_SOUND_URL);
    audioRef.current.volume = ALERT_AUDIO_VOLUME;
    audioRef.current.preload = 'auto';
    audioRef.current.load();
  }, []);

  const playSynthAlert = () => {
    try {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      if (!audioContextRef.current) {
        audioContextRef.current = new Ctx();
      }
      const ctx = audioContextRef.current;
      if (!ctx) return;

      const now = ctx.currentTime;
      const notes = [
        { freq: 880, start: 0.0, duration: 0.1 },
        { freq: 1174, start: 0.12, duration: 0.1 },
        { freq: 1568, start: 0.24, duration: 0.16 }
      ];

      notes.forEach((n) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(n.freq, now + n.start);
        gain.gain.setValueAtTime(0.0001, now + n.start);
        gain.gain.exponentialRampToValueAtTime(0.26, now + n.start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + n.start);
        osc.stop(now + n.start + n.duration);
      });
    } catch (err) {
      console.warn('Synth alert failed:', err);
    }
  };

  const enableAudio = () => {
    if (!audioRef.current) return;

    const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (Ctx && !audioContextRef.current) {
      audioContextRef.current = new Ctx();
    }
    if (audioContextRef.current?.state === 'suspended') {
      audioContextRef.current.resume().catch(() => undefined);
    }

    audioRef.current.muted = true;
    audioRef.current.play().then(() => {
      audioRef.current?.pause();
      if (audioRef.current) {
        audioRef.current.muted = false;
        audioRef.current.currentTime = 0;
        audioRef.current.volume = ALERT_AUDIO_VOLUME;
      }
      setAudioEnabled(true);
      console.log('Audio notifications enabled.');
    }).catch((err) => {
      console.error('Failed to enable audio:', err);
    });
  };

  const triggerNotification = ({
    storageKey,
    tag,
    title,
    body,
    onClick
  }: {
    storageKey: string;
    tag: string;
    title: string;
    body: string;
    onClick?: () => void;
  }) => {
    const lastNotified = localStorage.getItem(storageKey);
    const now = Date.now();

    if (lastNotified && now - parseInt(lastNotified, 10) < 300000) {
      return;
    }
    localStorage.setItem(storageKey, now.toString());

    if (audioEnabled && audioRef.current) {
      audioRef.current.currentTime = 0;
      audioRef.current.volume = ALERT_AUDIO_VOLUME;
      audioRef.current.play().catch((e) => console.warn('Audio play blocked:', e));

      window.setTimeout(() => {
        if (!audioRef.current) return;
        audioRef.current.currentTime = 0;
        audioRef.current.volume = ALERT_AUDIO_VOLUME;
        audioRef.current.play().catch(() => undefined);
      }, 350);
    }

    playSynthAlert();

    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([200, 100, 200]);
    }

    if (typeof window !== 'undefined' && 'Notification' in window && window.Notification.permission === 'granted') {
      const notification = new window.Notification(title, {
        body,
        icon: '/pwa-192x192.png',
        tag,
        requireInteraction: true
      });

      notification.onclick = () => {
        window.focus();
        onClick?.();
        notification.close();
      };
    }
  };

  useEffect(() => {
    if (CN_API_ONLY || isCnRoute) return;

    if (!user || !activeWarehouse || !hasPickingPermission) {
      setIsInitialized(false);
      knownOrderIds.current.clear();
      return;
    }

    const q = query(
      collection(db, 'orders'),
      where('warehouseId', '==', activeWarehouse),
      where('warehouseStatus', '==', 'Pending')
    );

    const applySnapshot = (snapshot: QuerySnapshot<DocumentData>) => {
      if (!isInitialized) {
        snapshot.docs.forEach((d) => knownOrderIds.current.add(d.id));
        setIsInitialized(true);
        return;
      }

      snapshot.docChanges().forEach((change) => {
        const orderId = change.doc.id;
        const orderData = change.doc.data();

        if (change.type === 'added') {
          if (!knownOrderIds.current.has(orderId)) {
            triggerNotification({
              storageKey: `notified_order_${orderId}`,
              tag: orderId,
              title: 'New Picking Task',
              body: `Order ${orderData.bookingNumber} is ready for picking.`,
              onClick: () => navigate(`${routePrefix}/orders/${orderId}`)
            });
            knownOrderIds.current.add(orderId);
          }
        } else if (change.type === 'removed') {
          knownOrderIds.current.delete(orderId);
        }
      });
      knownOrderIds.current = new Set(snapshot.docs.map(order => order.id));
    };
    return subscribeDuringWorkHours('nz', () => onSnapshot(q, applySnapshot, error => {
      console.error('Picking listener error:', error);
    }), async () => applySnapshot(await getDocs(q)), false);
  }, [user?.uid, activeWarehouse, hasPickingPermission, isInitialized, isCnRoute, navigate, routePrefix]);

  useEffect(() => {
    if (!user || !token || !activeWarehouse || !hasPickingPermission) {
      counterInitializedRef.current = false;
      knownCounterPickupStates.current.clear();
      return;
    }

    let stopped = false;

    const notifyCounterPickupChange = (pickup: CounterPickup, prevState?: string | null) => {
      const nextState = `${pickup.status}:${pickup.queueStatus}`;
      const isNewPending = !prevState && pickup.status === 'PendingPick' && pickup.queueStatus === 'Pending';
      const becameReady = prevState !== nextState && pickup.status === 'Picked' && pickup.queueStatus === 'Picked';
      const becamePutbackPending = prevState !== nextState && pickup.status === 'PendingPutback';

      if (!isNewPending && !becameReady && !becamePutbackPending) {
        return;
      }

      const title = isNewPending
        ? 'Counter Pickup Priority'
        : becameReady
          ? 'Counter Pickup Ready'
          : 'Counter Pickup Putback Pending';
      const body = isNewPending
        ? `${pickup.id} (${pickup.sku}) is waiting in picking queue.`
        : becameReady
          ? `${pickup.id} (${pickup.sku}) is ready at the counter.`
          : `${pickup.id} (${pickup.sku}) is waiting for putback confirmation.`;

      triggerNotification({
        storageKey: `notified_counter_pickup_${pickup.id}_${nextState}`,
        tag: `counter-pickup-${pickup.id}-${nextState}`,
        title,
        body,
        onClick: () => navigate(`${routePrefix}/picking-queue`)
      });
    };

    const loadCounterPickups = async () => {
      try {
        const response = await fetch('/api/counter-pickups/list?view=active&limit=200', {
          headers: {
            'x-v2-auth-token': `Bearer ${token}`,
            'x-warehouse-id': activeWarehouse
          }
        });
        const data = await response.json();
        if (!response.ok || !data.success) {
          throw new Error(data.error || 'Failed to load counter pickups for notifications');
        }
        if (stopped) return;

        const rows = ((data.requests || []) as CounterPickup[]).filter((item) =>
          item.status === 'PendingPick' || item.status === 'Picked' || item.status === 'PendingPutback'
        );
        const nextStates = new Map<string, string>();

        rows.forEach((pickup) => {
          const nextState = `${pickup.status}:${pickup.queueStatus}`;
          nextStates.set(pickup.id, nextState);

          if (!counterInitializedRef.current) {
            return;
          }

          const prevState = knownCounterPickupStates.current.get(pickup.id) || null;
          if (prevState !== nextState) {
            notifyCounterPickupChange(pickup, prevState);
          }
        });

        knownCounterPickupStates.current = nextStates;
        counterInitializedRef.current = true;
      } catch (error) {
        console.error('Counter pickup notification polling failed:', error);
      }
    };

    const stopPolling = startWorkPolling({ site: 'nz', interval: 15_000, load: loadCounterPickups, loadOnMount: false, whileHidden: true });

    return () => {
      stopped = true;
      stopPolling();
    };
  }, [user?.uid, token, activeWarehouse, hasPickingPermission, navigate, routePrefix]);

  return {
    audioEnabled,
    enableAudio,
    hasPickingPermission,
    requestPermission: () => {
      if (typeof window !== 'undefined' && 'Notification' in window) {
        return window.Notification.requestPermission();
      }
      return Promise.resolve('default' as any);
    }
  };
};
