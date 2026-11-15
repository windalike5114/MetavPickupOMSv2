import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ClipboardList,
  Database,
  Users,
  LogOut,
  Menu,
  X,
  FileText,
  Settings,
  Store,
  Key,
  AlertCircle,
  Warehouse,
  ChevronDown,
  ChevronRight,
  Monitor,
  Clock,
  ShoppingCart,
  Mail,
  MapPinned,
  BarChart3
} from 'lucide-react';
import { useAuth } from './AuthProvider';
import { hasPermission, isAdmin, isSystemAdmin } from '../utils';
import { ChangePasswordModal } from './ChangePasswordModal';
import { NotificationCenter } from './NotificationCenter';
import { APP_VERSION } from '../constants';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { profile, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = React.useState(false);
  const [showPasswordModal, setShowPasswordModal] = React.useState(false);
  const [expandedGroups, setExpandedGroups] = React.useState<string[]>(['Orders', 'Management', 'System', 'Overdue', 'Warehouse']);

  const toggleGroup = (groupName: string) => {
    setExpandedGroups(prev =>
      prev.includes(groupName)
        ? prev.filter(g => g !== groupName)
        : [...prev, groupName]
    );
  };

  const handleLogout = async () => {
    logout();
    navigate('/login');
  };

  const navGroups = [
    {
      name: 'General',
      items: [
        { name: 'Dashboard', path: '/', icon: LayoutDashboard, visible: hasPermission(profile, 'View Orders', profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Order List', path: '/orders', icon: ClipboardList, visible: hasPermission(profile, 'View Orders', profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Counter Pickup', path: '/counter-pickups', icon: AlertCircle, visible: profile?.roleTemplate === 'Reception' || profile?.roleTemplate === 'Admin' },
        { name: 'Overdue Audit', path: '/overdue', icon: Clock, visible: hasPermission(profile, 'Audit Overdue Orders', profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'SKU Database', path: '/skus', icon: Database, visible: hasPermission(profile, 'View SKU', profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Field Visits', path: '/field-visits', icon: MapPinned, visible: !!profile },
        { name: 'Field Reports', path: '/field-visit-reports', icon: BarChart3, visible: profile?.roleTemplate === 'Admin' },
      ]
    },
    {
      name: 'Warehouse',
      icon: ShoppingCart,
      items: [
        { name: 'Picking Queue', path: '/picking-queue', icon: ShoppingCart, visible: hasPermission(profile, 'View Picking Queue', profile?.email) },
        { name: 'Putback Tasks', path: '/putback-tasks', icon: AlertCircle, visible: profile?.roleTemplate === 'Warehouse' || profile?.roleTemplate === 'Admin' },
      ]
    },
    {
      name: 'Management',
      icon: Users,
      items: [
        { name: 'User Management', path: '/users', icon: Users, visible: isAdmin(profile, profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'User Groups', path: '/groups', icon: Users, visible: (isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage User Groups', profile?.email)) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Store Management', path: '/stores', icon: Store, visible: (isAdmin(profile, profile?.email) || hasPermission(profile, 'Manage Stores', profile?.email)) && profile?.roleTemplate !== 'Warehouse' },
      ]
    },
    {
      name: 'System',
      icon: FileText,
      items: [
        { name: 'Operation Logs', path: '/logs', icon: FileText, visible: (isAdmin(profile, profile?.email) || isSystemAdmin(profile?.email)) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Report Settings', path: '/report-settings', icon: Mail, visible: isAdmin(profile, profile?.email) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Guest Display', path: '/guest-display', icon: Monitor, visible: (isAdmin(profile, profile?.email) || hasPermission(profile, 'Capture Signature', profile?.email)) && profile?.roleTemplate !== 'Warehouse' },
        { name: 'Settings', path: '/settings', icon: Settings, visible: true },
      ]
    }
  ];

  const renderNavItems = (items: any[], isMobile = false) => {
    return items.filter(item => item.visible).map((item, idx) => {
      const isPathActive = location.pathname === item.path;
      const isStateActive = !item.state || (
        location.state?.statusFilter === item.state.statusFilter &&
        location.state?.overdueThreshold === item.state.overdueThreshold
      );
      const isActive = isPathActive && isStateActive;

      return (
        <Link
          key={`${item.path}-${idx}`}
          to={item.path}
          state={item.state}
          onClick={() => isMobile && setIsMobileMenuOpen(false)}
          aria-current={isActive ? "page" : undefined}
          className={`wms-nav-link flex items-center gap-3 px-3 ${isMobile ? "py-3" : "py-2.5"}`}
        >
          <item.icon className="size-4 shrink-0" aria-hidden="true" />
          <span className="text-sm font-semibold">{item.name}</span>
        </Link>
      );
    });
  };

  return (
    <div className="wms-theme flex h-dvh w-full flex-col overflow-hidden">
      {/* Top Header */}
      <header className="wms-masthead relative z-40 flex h-14 shrink-0 items-center justify-between px-4 md:px-6">
        <div className="flex items-center gap-4">
          <button
            className="md:hidden p-2 hover:bg-slate-100 rounded-lg transition-colors"
            aria-label={isMobileMenuOpen ? "Close menu" : "Open menu"}
            aria-expanded={isMobileMenuOpen}
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
          <Link to="/" className="flex items-center gap-2">
            <span className="wms-brand-mark grid size-8 shrink-0 place-items-center">
              <Warehouse className="size-5" />
            </span>
            <span className="text-sm font-semibold tracking-tight">WMS System</span>
            <span className="wms-version hidden text-[11px] tabular-nums sm:inline">v{APP_VERSION}</span>
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <NotificationCenter />
          <div className="h-8 w-[1px] bg-slate-200 hidden sm:block mx-2"></div>
          <Link to="/settings" className="hidden max-w-36 truncate text-sm font-bold text-slate-900 hover:underline sm:block">
            {profile?.name || profile?.username}
          </Link>
        </div>
      </header>

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Sidebar for Desktop */}
        <aside className="wms-sidebar hidden w-52 shrink-0 flex-col md:flex lg:w-56">
          <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4" aria-label="Main navigation">
            {navGroups.map((group) => {
              const visibleItems = group.items.filter(i => i.visible);
              if (visibleItems.length === 0) return null;

              if (group.name === 'General') {
                return renderNavItems(visibleItems);
              }

              const isExpanded = expandedGroups.includes(group.name);

              return (
                <div key={group.name} className="space-y-1">
                  <button
                    onClick={() => toggleGroup(group.name)}
                    aria-expanded={isExpanded}
                    className="wms-nav-group flex w-full items-center justify-between px-3 pb-2 pt-3 text-xs font-semibold"
                  >
                    <div className="flex items-center gap-2">
                      {group.icon && <group.icon className="w-3 h-3" />}
                      {group.name}
                    </div>
                    {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </button>
                  {isExpanded && (
                    <div className="space-y-1">
                      {renderNavItems(visibleItems)}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="wms-nav-footer border-t p-3">
            <button
              onClick={handleLogout}
              className="wms-nav-link flex w-full items-center gap-3 px-3 py-2.5 text-sm font-semibold"
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        {/* Mobile Menu Overlay */}
        {isMobileMenuOpen && (
          <div className="wms-sidebar fixed inset-x-0 bottom-0 top-14 z-40 overflow-y-auto md:hidden">
            <nav className="space-y-3 p-3" aria-label="Main navigation">
              {navGroups.map((group) => {
                const visibleItems = group.items.filter(i => i.visible);
                if (visibleItems.length === 0) return null;

                return (
                  <div key={group.name} className="space-y-2">
                    <div className="wms-nav-group px-3 text-xs font-semibold">
                      {group.name}
                    </div>
                    {renderNavItems(visibleItems, true)}
                  </div>
                );
              })}
              <div className="wms-nav-footer border-t pt-3">
                <button
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    setShowPasswordModal(true);
                  }}
                  className="wms-nav-link flex w-full items-center gap-3 px-3 py-3"
                >
                  <Key className="w-6 h-6" />
                  <span className="text-lg font-medium">Change Password</span>
                </button>
                <button
                  onClick={handleLogout}
                  className="wms-nav-link flex w-full items-center gap-3 px-3 py-3"
                >
                  <LogOut className="w-6 h-6" />
                  <span className="text-lg font-medium">Logout</span>
                </button>
              </div>
            </nav>
          </div>
        )}

        {/* Main Content */}
        <main className="wms-workspace flex h-full min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>

      <ChangePasswordModal
        isOpen={showPasswordModal}
        onClose={() => setShowPasswordModal(false)}
      />
    </div>
  );
};
