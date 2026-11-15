import React, { useState, useEffect } from 'react';
import { usePickingNotifications } from '../hooks/usePickingNotifications';
import { Bell, Volume2, X, AlertTriangle } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useLocation } from 'react-router-dom';
import { CN_API_ONLY } from '../constants';

export const NotificationManager: React.FC = () => {
  const location = useLocation();
  const isCnPortal = CN_API_ONLY || location.pathname === '/cn' || location.pathname.startsWith('/cn/');
  const { audioEnabled, enableAudio, hasPickingPermission } = usePickingNotifications();
  const [showBanner, setShowBanner] = useState(false);
  const [permissionStatus, setPermissionStatus] = useState<any>(
    typeof window !== 'undefined' && 'Notification' in window 
      ? window.Notification.permission 
      : 'default'
  );

  useEffect(() => {
    // If Notification API is not supported, we only care about audio
    const isNotificationSupported = typeof window !== 'undefined' && 'Notification' in window;
    
    // Show banner ONLY if user has picking permission AND (notification permission is not granted OR audio is not enabled)
    // If notifications aren't supported, we just check audio
    const needsPermission = isNotificationSupported 
      ? (permissionStatus !== 'granted' || !audioEnabled)
      : !audioEnabled;

    if (!isCnPortal && hasPickingPermission && needsPermission) {
      const timer = setTimeout(() => setShowBanner(true), 2000);
      return () => clearTimeout(timer);
    } else {
      setShowBanner(false);
    }
  }, [permissionStatus, audioEnabled, hasPickingPermission, isCnPortal]);

  const handleEnableAll = async () => {
    // 1. Request Notification Permission if supported
    if (typeof window !== 'undefined' && 'Notification' in window) {
      const status = await window.Notification.requestPermission();
      setPermissionStatus(status);
      if (status === 'granted') {
        // Audio will be enabled below
      }
    }

    // 2. Enable Audio (requires user gesture)
    enableAudio();
    
    // If notifications aren't supported, just hide after audio enable
    if (!('Notification' in window)) {
      setShowBanner(false);
    }
  };

  const isIOS = typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream;
  const isStandalone = typeof window !== 'undefined' && (window.matchMedia('(display-mode: standalone)').matches || (window.navigator as any).standalone);

  return (
    <AnimatePresence>
      {showBanner && !isCnPortal && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] w-[90%] max-w-md"
        >
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 p-5 flex flex-col gap-4">
            <div className="flex items-start justify-between">
              <div className="flex gap-3">
                <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-xl flex items-center justify-center flex-shrink-0">
                  <Bell className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="font-bold text-slate-900">Enable Picking Alerts</h4>
                  <p className="text-sm text-slate-500 leading-tight mt-1">
                    {isIOS && !isStandalone 
                      ? "For best results on iOS, tap 'Share' and 'Add to Home Screen'. Then enable alerts here."
                      : "Get real-time notifications and sound alerts when new picking tasks or counter pickup updates enter the queue."}
                  </p>
                </div>
              </div>
              <button 
                onClick={() => setShowBanner(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {permissionStatus === 'denied' && (
              <div className="flex items-center gap-2 text-xs text-amber-600 bg-amber-50 p-2 rounded-lg border border-amber-100">
                <AlertTriangle className="w-4 h-4" />
                <span>Notifications are blocked. Please enable them in browser settings.</span>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={handleEnableAll}
                className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 rounded-xl font-bold text-sm transition-all flex items-center justify-center gap-2"
              >
                <Volume2 className="w-4 h-4" />
                Enable Alerts & Sound
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
