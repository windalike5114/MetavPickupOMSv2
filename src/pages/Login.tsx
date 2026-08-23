import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../components/AuthProvider';
import { Package, Lock, User, AlertCircle, CheckCircle2, ChevronRight } from 'lucide-react';
import { CN_API_ONLY } from '../constants';

export const Login = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);
  const { user, profile, loading: authLoading, activeWarehouse, setActiveWarehouse, clearActiveWarehouse, login, logout } = useAuth();
  const navigate = useNavigate();
  const [showWarehouseSelector, setShowWarehouseSelector] = useState(false);

  useEffect(() => {
    if (user && profile) {
      if (CN_API_ONLY) {
        navigate('/cn');
        return;
      }
      if (activeWarehouse) {
        navigate('/');
      } else {
        navigate('/select-warehouse');
      }
    }
  }, [user, profile, activeWarehouse, navigate]);

  useEffect(() => {
    if (!user) {
      clearActiveWarehouse();
    }

    const savedUsername = localStorage.getItem('remembered_username');
    if (savedUsername) {
      setUsername(savedUsername);
      setRememberMe(true);
    }
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    try {
      const result = await login(username, password);
      
      console.log("API 返回的全量数据:", result);

      if (result && result.token) {
        console.log("正在存入 Token:", result.token);
        localStorage.setItem('x-v2-auth-token', result.token);
        localStorage.setItem('user_info', JSON.stringify(result.user));
        
        // Ensure warehouse is selected before entering order pages.
        if (localStorage.getItem('x-v2-auth-token')) {
           const savedWarehouse = sessionStorage.getItem('activeWarehouse');
           navigate(CN_API_ONLY ? '/cn' : (savedWarehouse ? '/' : '/select-warehouse'));
        } else {
           alert("LocalStorage 写入失败！");
        }
      } else {
        alert("API 返回的数据里没有 Token！");
      }

      if (rememberMe) {
        localStorage.setItem('remembered_username', username);
      } else {
        localStorage.removeItem('remembered_username');
      }
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Invalid username or password.');
    } finally {
      setLoading(false);
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="w-10 h-10 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-md p-8 border border-slate-200">
        <div className="text-center mb-8">
          <div 
            className="inline-flex items-center justify-center w-16 h-16 bg-indigo-100 rounded-2xl mb-4 select-none active:scale-95 transition-transform"
          >
            <Package className="w-8 h-8 text-indigo-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Pickup System</h1>
          <p className="text-slate-500 mt-2">
            Internal Order Management
          </p>
        </div>


        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-lg flex items-start gap-3 text-red-700 text-sm">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {success && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-100 rounded-lg flex items-start gap-3 text-emerald-700 text-sm">
            <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
            <p>{success}</p>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">
              Username
            </label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                placeholder="Enter your username"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Password</label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                placeholder="Enter your password"
                required
                minLength={6}
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
              />
              <span className="text-sm text-slate-500 group-hover:text-slate-700 transition-colors">Remember Me</span>
            </label>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-semibold py-3 rounded-lg transition-all shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Processing...' : (isRegistering ? 'Create Account' : 'Sign In')}
          </button>
        </form>

        <div className="mt-8 pt-6 border-t border-slate-100 text-center">
          <p className="text-xs text-slate-400">
            &copy; 2026 Pickup Order Management System. All rights reserved.
          </p>
        </div>
      </div>
    </div>
  );
};
