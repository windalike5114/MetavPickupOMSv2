import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './components/AuthProvider';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Orders } from './pages/Orders';
import { OrderCreate } from './pages/OrderCreate';
import { OrderDetail } from './pages/OrderDetail';
import { SKUDatabase } from './pages/SKUDatabase';
import SKULogs from './pages/SKULogs';
import { Settings } from './pages/Settings';
import { UserManagement } from './pages/UserManagement';
import UserGroups from './pages/UserGroups';
import { StoreManagement } from './pages/StoreManagement';
import OperationLogs from './pages/OperationLogs';
import { ReportSettings } from './pages/ReportSettings';
import { BulkOrderUpload } from './pages/BulkOrderUpload';
import { WarehouseSelection } from './pages/WarehouseSelection';
import { GuestDisplay } from './pages/GuestDisplay';
import { PickingQueue } from './pages/PickingQueue';
import { OverdueOrders } from './pages/OverdueOrders';
import { CounterPickupListing } from './pages/CounterPickupListing';
import { PutbackTasks } from './pages/PutbackTasks';
import { TaskProvider } from './components/TaskProvider';
import { ErrorBoundary } from './components/ErrorBoundary';
import { NotificationManager } from './components/NotificationManager';
import { CnPortalLayout } from './components/CnPortalLayout';
import { CnPortalHome } from './pages/CnPortalHome';
import { CN_API_ONLY } from './constants';

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthReady, profile, activeWarehouse } = useAuth();
  const [timedOut, setTimedOut] = React.useState(false);

  React.useEffect(() => {
    let timer: NodeJS.Timeout;
    if (!isAuthReady) {
      timer = setTimeout(() => {
        setTimedOut(true);
      }, 10000); // 10 seconds timeout
    }
    return () => clearTimeout(timer);
  }, [isAuthReady]);

  if (!isAuthReady && !timedOut) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
        <p className="text-slate-500 animate-pulse">Initializing system...</p>
      </div>
    );
  }

  if (!isAuthReady && timedOut) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 p-6 text-center">
        <div className="bg-white p-8 rounded-2xl shadow-xl border border-slate-100 max-w-md">
          <div className="w-16 h-16 bg-amber-100 text-amber-600 rounded-full flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-2">Connection is taking longer than usual</h1>
          <p className="text-slate-600 mb-6">This might be due to a slow network or a configuration issue. You can try refreshing the page.</p>
          <button 
            onClick={() => window.location.reload()}
            className="w-full bg-indigo-600 text-white px-6 py-3 rounded-xl font-semibold hover:bg-indigo-700 transition-all"
          >
            Refresh Page
          </button>
          <button 
            onClick={() => {
              // Fallback: try to proceed anyway if user is present
              if (user) window.location.href = '/';
              else window.location.href = '/login';
            }}
            className="mt-4 text-sm text-slate-400 hover:text-slate-600"
          >
            Try to bypass
          </button>
        </div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" />;
  }

  if (!activeWarehouse && window.location.pathname !== '/select-warehouse') {
    return <Navigate to="/select-warehouse" />;
  }

  if (profile?.status === 'Disabled') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 text-center">
        <div>
          <h1 className="text-2xl font-bold text-red-600 mb-2">Account Disabled</h1>
          <p className="text-slate-600">Please contact your administrator for assistance.</p>
        </div>
      </div>
    );
  }

  // Warehouse role redirection
  if (profile?.roleTemplate === 'Warehouse' && window.location.pathname === '/') {
    return <Navigate to="/picking-queue" />;
  }

  return <Layout>{children}</Layout>;
};

const ProtectedCnRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthReady, profile, activeWarehouse } = useAuth();

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mb-4"></div>
        <p className="text-slate-500 animate-pulse">Initializing CN portal...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/login" />;
  if (profile?.status === 'Disabled') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4 text-center">
        <div>
          <h1 className="text-2xl font-bold text-red-600 mb-2">Account Disabled</h1>
          <p className="text-slate-600">Please contact your administrator for assistance.</p>
        </div>
      </div>
    );
  }

  return <CnPortalLayout>{children}</CnPortalLayout>;
};

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <TaskProvider>
          <Router>
            <NotificationManager />
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/select-warehouse" element={<WarehouseSelection />} />
              <Route path="/guest-display" element={<GuestDisplay />} />
              <Route path="/" element={CN_API_ONLY ? <Navigate to="/cn" /> : <ProtectedRoute><Dashboard /></ProtectedRoute>} />
              <Route path="/orders" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
              <Route path="/orders/create" element={<ProtectedRoute><OrderCreate /></ProtectedRoute>} />
              <Route path="/orders/bulk-import" element={<ProtectedRoute><BulkOrderUpload /></ProtectedRoute>} />
              <Route path="/orders/:id" element={<ProtectedRoute><OrderDetail /></ProtectedRoute>} />
              <Route path="/overdue" element={<ProtectedRoute><OverdueOrders /></ProtectedRoute>} />
              <Route path="/picking-queue" element={<ProtectedRoute><PickingQueue /></ProtectedRoute>} />
              <Route path="/counter-pickups" element={<ProtectedRoute><CounterPickupListing /></ProtectedRoute>} />
              <Route path="/putback-tasks" element={<ProtectedRoute><PutbackTasks /></ProtectedRoute>} />
              <Route path="/skus" element={<ProtectedRoute><SKUDatabase /></ProtectedRoute>} />
              <Route path="/skus/logs" element={<ProtectedRoute><SKULogs /></ProtectedRoute>} />
              <Route path="/history" element={<ProtectedRoute><Orders /></ProtectedRoute>} />
              <Route path="/users" element={<ProtectedRoute><UserManagement /></ProtectedRoute>} />
              <Route path="/groups" element={<ProtectedRoute><UserGroups /></ProtectedRoute>} />
              <Route path="/stores" element={<ProtectedRoute><StoreManagement /></ProtectedRoute>} />
              <Route path="/report-settings" element={<ProtectedRoute><ReportSettings /></ProtectedRoute>} />
              <Route path="/settings" element={<ProtectedRoute><Settings /></ProtectedRoute>} />
              <Route path="/logs" element={<ProtectedRoute><OperationLogs /></ProtectedRoute>} />
              <Route path="/cn" element={<ProtectedCnRoute><CnPortalHome /></ProtectedCnRoute>} />
              <Route path="/cn/orders" element={<ProtectedCnRoute><Orders /></ProtectedCnRoute>} />
              <Route path="/cn/orders/create" element={<ProtectedCnRoute><OrderCreate /></ProtectedCnRoute>} />
              <Route path="/cn/orders/bulk-import" element={<ProtectedCnRoute><BulkOrderUpload /></ProtectedCnRoute>} />
              <Route path="/cn/orders/:id" element={<ProtectedCnRoute><OrderDetail /></ProtectedCnRoute>} />
              <Route path="/cn/overdue" element={<ProtectedCnRoute><OverdueOrders /></ProtectedCnRoute>} />
              <Route path="/cn/counter-pickups" element={<ProtectedCnRoute><CounterPickupListing /></ProtectedCnRoute>} />
              <Route path="/cn/users" element={<ProtectedCnRoute><UserManagement /></ProtectedCnRoute>} />
              <Route path="*" element={<Navigate to={CN_API_ONLY ? "/cn" : "/"} />} />
            </Routes>
          </Router>
        </TaskProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
