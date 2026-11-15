import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  ClipboardList,
  Clock,
  Home,
  LogOut,
  PackageCheck,
  Users,
  Warehouse,
} from 'lucide-react';
import { useAuth } from './AuthProvider';
import { APP_VERSION } from '../constants';
import { hasPermission, isAdmin } from '../utils';

type CnNavItem = {
  name: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
  visible: boolean;
};

export const CnPortalLayout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/cn/login', { replace: true });
  };

  const navItems: CnNavItem[] = [
    { name: '业务总览', path: '/cn', icon: Home, visible: true },
    { name: '订单列表', path: '/cn/orders', icon: ClipboardList, visible: hasPermission(profile, 'View Orders', profile?.email) },
    { name: '线下出库记录', path: '/cn/counter-pickups', icon: PackageCheck, visible: profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin' || hasPermission(profile, 'Manage Picking', profile?.email) },
    { name: '超期订单', path: '/cn/overdue', icon: Clock, visible: hasPermission(profile, 'Audit Overdue Orders', profile?.email) || hasPermission(profile, 'View Orders', profile?.email) },
    { name: '账号管理', path: '/cn/users', icon: Users, visible: isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Users', profile?.email) },
  ];

  const visibleNavItems = navItems.filter((item) => item.visible);
  const isNavActive = (path: string) => path === '/cn'
    ? location.pathname === '/cn'
    : location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <div className="cn-portal-shell flex h-dvh w-full flex-col overflow-hidden">
      <header className="cn-masthead relative z-40 flex h-14 shrink-0 items-center justify-between px-4 md:px-6">
        <Link to="/cn" className="flex min-w-0 items-center gap-2.5">
          <span className="cn-brand-mark grid size-8 shrink-0 place-items-center">
            <Warehouse className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold tracking-tight">WMS 中国门户</span>
              <span className="cn-version hidden text-[11px] tabular-nums sm:inline">v{APP_VERSION}</span>
            </span>
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden text-right sm:block">
            <p className="max-w-36 truncate text-sm font-bold text-slate-900">{profile?.name || profile?.username}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-transparent px-2.5 text-sm font-semibold text-slate-500 transition-colors hover:border-red-100 hover:bg-red-50 hover:text-red-600"
            title="退出登录"
            aria-label="退出登录"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">退出登录</span>
          </button>
        </div>
      </header>

      <nav className="cn-mobile-nav z-30 flex shrink-0 gap-5 overflow-x-auto px-4 md:hidden" aria-label="中国门户导航">
        {visibleNavItems.map((item) => {
          const active = isNavActive(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              aria-current={active ? 'page' : undefined}
              className="cn-nav-link inline-flex shrink-0 items-center gap-1.5 py-3 text-xs font-medium"
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 w-full overflow-hidden">
        <aside className="cn-sidebar hidden w-44 shrink-0 flex-col md:flex lg:w-48">
          <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="中国门户导航">
            {visibleNavItems.map((item) => {
              const active = isNavActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  aria-current={active ? 'page' : undefined}
                  className="cn-nav-link flex items-center gap-3 px-3 py-2.5"
                >
                  <item.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span className="text-sm font-semibold">{item.name}</span>
                </Link>
              );
            })}
          </nav>

        </aside>

        <main className="cn-workspace flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    </div>
  );
};
