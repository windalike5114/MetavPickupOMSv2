import { APP_VERSION } from '../constants';
import React, { useState, useEffect, useRef } from 'react';
import { doc, updateDoc, collection, getDocs, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { UserSettings } from '../types';
import { 
  Bell, 
  Moon, 
  Sun, 
  Save, 
  CheckCircle2, 
  AlertCircle,
  User,
  Shield,
  FileText,
  Key,
  Settings as SettingsIcon,
  Bug,
  Info,
  Monitor,
  ExternalLink,
  Megaphone
} from 'lucide-react';
import { logAction, isSystemAdmin, isAdmin, hasPermission, handleFirestoreError, OperationType, cn } from '../utils';
import { ChangePasswordModal } from '../components/ChangePasswordModal';
import { BugReportModal } from '../components/BugReportModal';

import { PageHeader } from '../components/PageHeader';

export const Settings = () => {
  const { profile, user, loading: authLoading } = useAuth();
  const [settings, setSettings] = useState<UserSettings>({
    notificationsEnabled: true,
    emailNotifications: true,
    theme: 'light'
  });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

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

  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showBugModal, setShowBugModal] = useState(false);
  const [pairingPassword, setPairingPassword] = useState(localStorage.getItem('pairing_password') || '');

  // Sync settings when profile updates
  useEffect(() => {
    if (profile?.settings) {
      setSettings(profile.settings);
    }
  }, [profile?.settings]);

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600"></div>
      </div>
    );
  }

  const handleSave = async () => {
    if (!user || !profile) return;
    setSubmitting(true);
    setSuccess(false);
    setError('');

    try {
      const token = localStorage.getItem('x-v2-auth-token');
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ settings })
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to save settings');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error(err);
      setError(`Failed to save settings: ${err.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        title="Account Settings"
        subtitle="Manage your personal preferences and account details."
        icon={SettingsIcon}
        isScrolled={isScrolled}
        actions={
          <>
            {success && (
              <div className="flex items-center gap-2 text-emerald-600 font-bold text-sm animate-bounce">
                <CheckCircle2 className="w-5 h-5" /> Settings saved!
              </div>
            )}
            <button 
              onClick={handleSave}
              disabled={submitting}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2.5 rounded-xl font-bold transition-all shadow-lg shadow-indigo-200 disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {submitting ? 'Saving...' : 'Save Changes'}
            </button>
          </>
        }
      />

      {/* 🚀 Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-4xl mx-auto space-y-8">
          {error && (
            <div className="flex items-center gap-2 text-red-600 font-bold text-sm bg-red-50 p-4 rounded-xl border border-red-100">
              <AlertCircle className="w-5 h-5" /> {error}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
        <div className="md:col-span-1 space-y-4">
          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm text-center">
            <div className="w-20 h-20 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold text-2xl mx-auto mb-4">
              {profile?.name.charAt(0)}
            </div>
            <h3 className="font-bold text-slate-900 text-lg">{profile?.name}</h3>
            <p className="text-sm text-slate-500 mb-4">{profile?.username}</p>
            <span className="px-3 py-1 bg-indigo-50 text-indigo-700 rounded-full text-xs font-bold uppercase">
              {profile?.roleTemplate || 'User'}
            </span>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm">
            <h4 className="font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Shield className="w-4 h-4 text-indigo-600" />
              Permissions
            </h4>
            <div className="flex flex-wrap gap-2">
              {profile?.permissions.slice(0, 5).map(p => (
                <span key={p} className="text-[10px] bg-slate-100 text-slate-600 px-2 py-1 rounded font-medium">
                  {p}
                </span>
              ))}
              {(profile?.permissions.length || 0) > 5 && (
                <span className="text-[10px] text-slate-400">+{profile!.permissions.length - 5} more</span>
              )}
            </div>
          </div>
        </div>

        <div className="md:col-span-2 space-y-6">
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-50">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <Bell className="w-5 h-5 text-indigo-600" />
                Notification Preferences
              </h3>
            </div>
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900">Do Not Disturb (DND)</p>
                  <p className="text-sm text-slate-500">Mute all in-app notifications and alerts.</p>
                </div>
                <button 
                  onClick={() => setSettings({...settings, notificationsEnabled: !settings.notificationsEnabled})}
                  className={`w-12 h-6 rounded-full transition-colors relative ${!settings.notificationsEnabled ? 'bg-indigo-600' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${!settings.notificationsEnabled ? 'left-7' : 'left-1'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900">Email Notifications</p>
                  <p className="text-sm text-slate-500">Receive order updates and system alerts via email.</p>
                </div>
                <button 
                  onClick={() => setSettings({...settings, emailNotifications: !settings.emailNotifications})}
                  className={`w-12 h-6 rounded-full transition-colors relative ${settings.emailNotifications ? 'bg-indigo-600' : 'bg-slate-200'}`}
                >
                  <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${settings.emailNotifications ? 'left-7' : 'left-1'}`} />
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-50">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <Sun className="w-5 h-5 text-indigo-600" />
                Appearance
              </h3>
            </div>
            <div className="p-6">
              <div className="flex items-center gap-4">
                <button 
                  onClick={() => setSettings({...settings, theme: 'light'})}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${settings.theme === 'light' ? 'border-indigo-600 bg-indigo-50' : 'border-slate-100 hover:border-slate-200'}`}
                >
                  <Sun className={`w-6 h-6 ${settings.theme === 'light' ? 'text-indigo-600' : 'text-slate-400'}`} />
                  <span className={`text-sm font-bold ${settings.theme === 'light' ? 'text-indigo-700' : 'text-slate-600'}`}>Light Mode</span>
                </button>
                <button 
                  onClick={() => setSettings({...settings, theme: 'dark'})}
                  className={`flex-1 p-4 rounded-xl border-2 transition-all flex flex-col items-center gap-2 ${settings.theme === 'dark' ? 'border-indigo-600 bg-indigo-50' : 'border-slate-100 hover:border-slate-200'}`}
                >
                  <Moon className={`w-6 h-6 ${settings.theme === 'dark' ? 'text-indigo-600' : 'text-slate-400'}`} />
                  <span className={`text-sm font-bold ${settings.theme === 'dark' ? 'text-indigo-700' : 'text-slate-600'}`}>Dark Mode</span>
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-50">
              <h3 className="font-bold text-slate-900 flex items-center gap-2">
                <Key className="w-5 h-5 text-indigo-600" />
                Security
              </h3>
            </div>
            <div className="p-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900">Account Password</p>
                  <p className="text-sm text-slate-500">Update your password regularly to keep your account secure.</p>
                </div>
                <button 
                  onClick={() => setShowPasswordModal(true)}
                  className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold text-sm transition-colors flex items-center gap-2"
                >
                  <Key className="w-4 h-4" />
                  Change Password
                </button>
              </div>
            </div>
          </div>
          
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
            <div className="p-6 space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900">App Version</p>
                  <p className="text-sm text-slate-500">Current version of the Pickup Management System.</p>
                </div>
                <span className="px-3 py-1 bg-slate-100 text-slate-600 rounded-lg font-bold text-sm">
                  v{APP_VERSION}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <div>
                  <p className="font-bold text-slate-900">Report a Bug</p>
                  <p className="text-sm text-slate-500">Found an issue? Let our development team know.</p>
                </div>
                <button 
                  onClick={() => setShowBugModal(true)}
                  className="px-4 py-2 bg-red-50 hover:bg-red-100 text-red-600 rounded-lg font-bold text-sm transition-colors flex items-center gap-2"
                >
                  <Bug className="w-4 h-4" />
                  Report Bug
                </button>
              </div>
            </div>
          </div>

          {(isAdmin(profile, profile?.email) || hasPermission(profile, 'Capture Signature', profile?.email)) && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-50">
                <h3 className="font-bold text-slate-900 flex items-center gap-2">
                  <Monitor className="w-5 h-5 text-indigo-600" />
                  Guest Display
                </h3>
              </div>
              <div className="p-6 space-y-4">
                <p className="text-sm text-slate-600">
                  Open the customer-facing signature display on a separate touch screen or tablet.
                </p>
                <div className="flex flex-col gap-3">
                <div className="flex flex-col gap-4">
                  <div>
                    <label className="block text-xs font-bold text-slate-400 uppercase mb-2">Pairing Password</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={pairingPassword}
                        onChange={(e) => {
                          const val = e.target.value;
                          setPairingPassword(val);
                          localStorage.setItem('pairing_password', val);
                        }}
                        placeholder="e.g. 123456"
                        className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none text-sm font-mono"
                      />
                    </div>
                    <p className="mt-1.5 text-[10px] text-slate-400">
                      Set a password here and enter the same password on the Guest Display to pair them.
                    </p>
                  </div>

                  <a 
                    href={pairingPassword ? `/guest-display?pairingId=${pairingPassword}` : "/guest-display"} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="inline-flex items-center justify-between p-4 rounded-xl border border-slate-100 hover:border-indigo-200 hover:bg-indigo-50 transition-all group"
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center">
                        <Monitor className="w-5 h-5" />
                      </div>
                      <div>
                        <p className="font-bold text-slate-900">Open Guest Display</p>
                        <p className="text-xs text-slate-500">Opens in a new tab</p>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-slate-400 group-hover:text-indigo-600 transition-colors" />
                  </a>
                  <div className="bg-amber-50 border border-amber-100 p-4 rounded-xl space-y-2">
                    <p className="text-xs text-amber-800 leading-relaxed font-bold">
                      How to use:
                    </p>
                    <ol className="text-xs text-amber-800 list-decimal list-inside space-y-1">
                      <li>Open the display on your customer-facing screen.</li>
                      <li>Enter the <strong>Pairing Password</strong> you set above.</li>
                      <li>In an order, click <strong>Confirm Pickup</strong> then <strong>Push to Guest Screen</strong>.</li>
                    </ol>
                  </div>
                </div>
                </div>
              </div>
            </div>
          )}

          {isSystemAdmin(profile?.email) && (
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-50">
                <h3 className="font-bold text-slate-900 flex items-center gap-2">
                  <Shield className="w-5 h-5 text-indigo-600" />
                  Developer Resources
                </h3>
              </div>
              <div className="p-6 space-y-4">
                <p className="text-sm text-slate-600">
                  Access API documentation and integration guides for external systems.
                </p>
                <a 
                  href="/API_DOCUMENTATION.md" 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 text-indigo-600 hover:text-indigo-700 font-bold text-sm"
                >
                  <FileText className="w-4 h-4" />
                  View API Documentation (Markdown)
                </a>
              </div>
            </div>
          )}

          </div>
        </div>
      </div>
      <ChangePasswordModal 
        isOpen={showPasswordModal} 
        onClose={() => setShowPasswordModal(false)} 
      />
      <BugReportModal 
        isOpen={showBugModal}
        onClose={() => setShowBugModal(false)}
      />
      </div>
    </div>
  );
};
