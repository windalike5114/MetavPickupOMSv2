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
  MapPinned
} from 'lucide-react';
import { useAuth } from './AuthProvider';
import { hasPermission, isAdmin, isSystemAdmin } from '../utils';
import { ChangePasswordModal } from './ChangePasswordModal';
import { NotificationCenter } from './NotificationCenter';
import { APP_VERSION } from '../constants';

export const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { profile, user, logout } = useAuth();
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
        { name: 'Field Visits', path: '/field-visits', icon: MapPinned, visible: profile?.roleTemplate === 'Sales' || profile?.roleTemplate === 'Admin' },
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
          className={cn(
            "flex items-center gap-3 px-4 py-2 rounded-xl transition-colors",
            isMobile ? "py-4" : "py-2",
            isActive
              ? "bg-indigo-50 text-indigo-700"
              : "text-slate-600 hover:bg-slate-50"
          )}
        >
          <item.icon className={isMobile ? "w-6 h-6" : "w-4 h-4"} />
          <span className={isMobile ? "text-lg font-medium" : "text-sm font-medium"}>{item.name}</span>
        </Link>
      );
    });
  };

  return (
    <div className="h-screen w-full bg-slate-50 flex flex-col overflow-hidden">
      {/* Top Header */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between flex-shrink-0 z-30 shadow-sm">
        <div className="flex items-center gap-4">
          <button 
            className="md:hidden p-2 hover:bg-slate-100 rounded-lg transition-colors"
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
          >
            {isMobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </button>
          <Link to="/" className="flex items-center gap-2">
            <Warehouse className="w-8 h-8 text-indigo-600" />
            <span className="hidden sm:flex items-end gap-2 tracking-tight">
              <span className="text-xl font-bold text-slate-900">WMS System</span>
              <span className="text-[10px] font-semibold text-slate-400 mb-0.5">v{APP_VERSION}</span>
            </span>
          </Link>
        </div>

        <div className="flex items-center gap-4">
          <NotificationCenter />
          <div className="h-8 w-[1px] bg-slate-200 hidden sm:block mx-2"></div>
          <Link to="/settings" className="hidden sm:flex flex-col items-end hover:opacity-80 transition-opacity">
            <p className="text-sm font-bold text-slate-900">{profile?.name}</p>
            <p className="text-[10px] text-slate-500 font-medium">{profile?.username}</p>
          </Link>
        </div>
      </header>

      <div className="flex flex-1 w-full overflow-hidden">
        {/* Sidebar for Desktop */}
        <aside className="hidden md:flex flex-col w-64 bg-white border-r border-slate-100 flex-shrink-0">
          <nav className="flex-1 p-4 space-y-2 overflow-y-auto">
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
                    className="w-full flex items-center justify-between px-4 py-2 text-xs font-bold text-slate-400 uppercase tracking-wider hover:text-slate-600 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {group.icon && <group.icon className="w-3 h-3" />}
                      {group.name}
                    </div>
                    {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  </button>
                  {isExpanded && (
                    <div className="pl-2 space-y-1">
                      {renderNavItems(visibleItems)}
                    </div>
                  )}
                </div>
              );
            })}
          </nav>
          <div className="p-4 border-t border-slate-100 flex flex-col gap-2">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-4 py-2 text-slate-600 hover:bg-red-50 hover:text-red-600 rounded-xl transition-colors text-sm font-medium"
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </button>
          </div>
        </aside>

        {/* Mobile Menu Overlay */}
        {isMobileMenuOpen && (
          <div className="md:hidden fixed inset-0 bg-white z-40 pt-16 overflow-y-auto">
            <nav className="p-4 space-y-4">
              {navGroups.map((group) => {
                const visibleItems = group.items.filter(i => i.visible);
                if (visibleItems.length === 0) return null;

                return (
                  <div key={group.name} className="space-y-2">
                    <div className="px-4 text-xs font-bold text-slate-400 uppercase tracking-wider">
                      {group.name}
                    </div>
                    {renderNavItems(visibleItems, true)}
                  </div>
                );
              })}
              <div className="pt-4 border-t border-slate-100">
                <button
                  onClick={() => {
                    setIsMobileMenuOpen(false);
                    setShowPasswordModal(true);
                  }}
                  className="w-full flex items-center gap-3 px-4 py-4 text-slate-600 hover:bg-slate-50 rounded-lg transition-colors"
                >
                  <Key className="w-6 h-6" />
                  <span className="text-lg font-medium">Change Password</span>
                </button>
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-3 px-4 py-4 text-slate-600 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors"
                >
                  <LogOut className="w-6 h-6" />
                  <span className="text-lg font-medium">Logout</span>
                </button>
              </div>
            </nav>
          </div>
        )}

        {/* Main Content */}
        <main className="flex-1 h-full w-full overflow-hidden flex flex-col min-w-0">
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

function cn(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}
