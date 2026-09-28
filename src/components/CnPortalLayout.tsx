import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Building2,
  ChevronRight,
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
  description: string;
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
    navigate('/login');
  };

  const navItems: CnNavItem[] = [
    { name: '门户首页', description: '今日跨仓总览', path: '/cn', icon: Home, visible: true },
    { name: '订单列表', description: '线上订单与提货', path: '/cn/orders', icon: ClipboardList, visible: hasPermission(profile, 'View Orders', profile?.email) },
    { name: '申请提货', description: '线下出库记录', path: '/cn/counter-pickups', icon: PackageCheck, visible: profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin' || hasPermission(profile, 'Manage Picking', profile?.email) },
    { name: '超期订单', description: '异常订单审核', path: '/cn/overdue', icon: Clock, visible: hasPermission(profile, 'Audit Overdue Orders', profile?.email) || hasPermission(profile, 'View Orders', profile?.email) },
    { name: '账号管理', description: '用户与权限', path: '/cn/users', icon: Users, visible: isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Users', profile?.email) },
  ];

  const visibleNavItems = navItems.filter((item) => item.visible);
  const isNavActive = (path: string) => path === '/cn'
    ? location.pathname === '/cn'
    : location.pathname === path || location.pathname.startsWith(`${path}/`);

  return (
    <div className="cn-portal-shell h-screen w-full bg-slate-50 flex flex-col overflow-hidden">
      <header className="relative z-40 flex h-16 flex-shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 md:px-6">
        <Link to="/cn" className="group flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-slate-950 text-white shadow-sm transition-transform group-hover:-translate-y-0.5">
            <Warehouse className="h-5 w-5" />
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate text-base font-black tracking-tight text-slate-950 sm:text-lg">WMS 中国门户</span>
              <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[9px] font-bold text-slate-500">v{APP_VERSION}</span>
            </span>
            <span className="hidden text-[11px] font-medium text-slate-400 sm:block">奥克兰与基督城统一跟单</span>
          </span>
        </Link>

        <div className="flex items-center gap-2 sm:gap-3">
          <div className="hidden items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-bold text-emerald-700 lg:flex">
            <Building2 className="h-3.5 w-3.5" />
            AKL + CHC
          </div>
          <div className="hidden border-l border-slate-200 pl-3 text-right sm:block">
            <p className="max-w-36 truncate text-sm font-bold text-slate-900">{profile?.name || profile?.username}</p>
            <p className="text-[10px] font-medium text-slate-400">{profile?.roleTemplate || 'Portal User'}</p>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-transparent px-2.5 text-sm font-semibold text-slate-500 transition-colors hover:border-red-100 hover:bg-red-50 hover:text-red-600"
            title="退出登录"
          >
            <LogOut className="h-4 w-4" />
            <span className="hidden sm:inline">退出登录</span>
          </button>
        </div>
      </header>

      <nav className="z-30 flex flex-shrink-0 gap-1 overflow-x-auto border-b border-slate-200 bg-white px-3 py-2 md:hidden" aria-label="中国门户导航">
        {visibleNavItems.map((item) => {
          const active = isNavActive(item.path);
          return (
            <Link
              key={item.path}
              to={item.path}
              className={[
                'inline-flex flex-shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-xs font-bold transition-colors',
                active ? 'bg-slate-950 text-white' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-900'
              ].join(' ')}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 w-full overflow-hidden">
        <aside className="hidden w-60 flex-shrink-0 flex-col border-r border-slate-200 bg-white md:flex">
          <div className="px-4 pb-2 pt-5 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">业务导航</div>
          <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4" aria-label="中国门户导航">
            {visibleNavItems.map((item) => {
              const active = isNavActive(item.path);
              return (
                <Link
                  key={item.path}
                  to={item.path}
                  className={[
                    'group flex items-center gap-3 rounded-xl px-3 py-2.5 transition-all',
                    active
                      ? 'bg-slate-950 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
                  ].join(' ')}
                >
                  <span className={[
                    'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
                    active ? 'bg-white/10 text-white' : 'bg-slate-100 text-slate-500 group-hover:bg-white'
                  ].join(' ')}>
                    <item.icon className="h-4 w-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold">{item.name}</span>
                    <span className="block truncate text-[10px] text-slate-400">{item.description}</span>
                  </span>
                  <ChevronRight className={['h-3.5 w-3.5 flex-shrink-0', active ? 'text-slate-500' : 'text-slate-300'].join(' ')} />
                </Link>
              );
            })}
          </nav>

          <div className="m-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
              <Building2 className="h-4 w-4 text-emerald-600" />
              跨仓查看模式
            </div>
            <p className="mt-1.5 text-[11px] leading-4 text-slate-500">无需切换仓库，可同时查看 AKL 与 CHC 数据。</p>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50">
          {children}
        </main>
      </div>
    </div>
  );
};