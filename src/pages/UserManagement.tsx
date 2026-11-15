import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../components/AuthProvider';
import { UserProfile, PERMISSIONS, ROLE_TEMPLATES, UserStatus, AccountType } from '../types';
import { logAction, hasPermission, handleFirestoreError, OperationType, isSystemAdmin, cn } from '../utils';
import { 
  UserPlus, 
  Shield, 
  User as UserIcon, 
  Edit2, 
  Trash2, 
  X, 
  AlertCircle,
  ShieldCheck,
  Key
} from 'lucide-react';
import { AdminChangePasswordModal } from '../components/AdminChangePasswordModal';

import { WAREHOUSE_NAMES } from '../constants';
import { useLocation } from 'react-router-dom';

import { PageHeader } from '../components/PageHeader';

export const UserManagement = () => {
  const { profile: currentProfile, user, token } = useAuth();
  const location = useLocation();
  const isCnRoute = location.pathname.startsWith('/cn');
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
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

  const canManage = hasPermission(currentProfile, 'Manage Users', user?.username);
  const [showEditModal, setShowEditModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<UserProfile | null>(null);
  const [editingUser, setEditingUser] = useState<Partial<UserProfile> | null>(null);
  
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [passwordTargetUser, setPasswordTargetUser] = useState<UserProfile | null>(null);
  
  // Form states
  const [formUsername, setFormUsername] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formName, setFormName] = useState('');
  const [formStatus, setFormStatus] = useState<UserStatus>('Active');
  const [formPermissions, setFormPermissions] = useState<string[]>([]);
  const [formAllowedWarehouses, setFormAllowedWarehouses] = useState<string[]>([]);
  const [formAccountType, setFormAccountType] = useState<AccountType>('Sales');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchUsers();
  }, []);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/admin/list-users', {
        headers: {
          'x-v2-auth-token': `Bearer ${token}`
        }
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || (isCnRoute ? '获取用户失败' : 'Failed to fetch users'));
      }
      const allUsers = (data.users || []) as UserProfile[];
      // Hide system administrator from the list
      setUsers(allUsers.filter(u => !isSystemAdmin(u.username)));
    } catch (err: any) {
      console.error(err);
      setError(err.message || (isCnRoute ? '加载用户失败' : 'Failed to load users'));
    } finally {
      setLoading(false);
    }
  };

  const handleSaveUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProfile) return;
    if (!canManage) {
      setError(isCnRoute ? '你没有管理用户的权限。' : 'You do not have permission to manage users.');
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      if (editingUser?.uid) {
        // Prevent self-revocation of Manage Users permission
        if (editingUser.uid === currentProfile.uid && !formPermissions.includes('Manage Users')) {
          setError('To avoid system lockouts, you cannot revoke your own "Manage Users" permission.');
          setSubmitting(false);
          return;
        }

        // Update existing user via backend API
        const response = await fetch('/api/admin/update-user', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-v2-auth-token': `Bearer ${token}`
          },
          body: JSON.stringify({
            uid: editingUser.uid,
            name: formName,
            status: formStatus,
            permissions: formPermissions,
            allowedWarehouses: formAllowedWarehouses,
            roleTemplate: formAccountType
          })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to update user');
        }
        
        await logAction(currentProfile, 'Update User', `Updated permissions for ${formUsername}`, null, 'User');
      } else {
        // Create new user via backend API
        const response = await fetch('/api/admin/create-user', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-v2-auth-token': `Bearer ${token}`
          },
          body: JSON.stringify({
            username: formUsername,
            password: formPassword,
            name: formName,
            roleTemplate: formAccountType,
            permissions: formPermissions,
            allowedWarehouses: formAllowedWarehouses
          })
        });

        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || 'Failed to create user');
        }

        await logAction(currentProfile, 'Create User', `Created new user ${formUsername}`, null, 'User');
      }
      
      setShowEditModal(false);
      fetchUsers();
    } catch (err: any) {
      console.error(err);
      if (!editingUser?.uid) {
        setError(err.message || 'Failed to create user.');
      } else {
        handleFirestoreError(err, OperationType.UPDATE, `users/${editingUser.uid}`);
        setError(err.message || 'Failed to update user.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const togglePermission = (perm: string) => {
    if (formPermissions.includes(perm)) {
      setFormPermissions(formPermissions.filter(p => p !== perm));
    } else {
      setFormPermissions([...formPermissions, perm]);
    }
  };

  const toggleWarehouse = (warehouseId: string) => {
    if (formAllowedWarehouses.includes(warehouseId)) {
      setFormAllowedWarehouses(formAllowedWarehouses.filter(w => w !== warehouseId));
    } else {
      setFormAllowedWarehouses([...formAllowedWarehouses, warehouseId]);
    }
  };

  const applyTemplate = (templateName: AccountType) => {
    setFormAccountType(templateName);
    setFormPermissions(ROLE_TEMPLATES[templateName]);
  };

  const openEdit = (user?: UserProfile) => {
    setError('');
    if (user) {
      setEditingUser(user);
      setFormUsername(user.username);
      setFormName(user.name);
      setFormStatus(user.status);
      setFormPermissions(user.permissions || []);
      setFormAllowedWarehouses(user.allowedWarehouses || []);
      setFormAccountType(user.roleTemplate || 'Sales');
      setFormPassword(''); // Not used for editing
    } else {
      setEditingUser(null);
      setFormUsername('');
      setFormName('');
      setFormStatus('Active');
      setFormPermissions(ROLE_TEMPLATES.Sales);
      setFormAllowedWarehouses([]);
      setFormAccountType('Sales');
      setFormPassword('');
    }
    setShowEditModal(true);
  };

  const handleDeleteUser = async (user: UserProfile) => {
    if (!currentProfile) return;
    if (!canManage) {
      setError(isCnRoute ? '你没有删除用户的权限。' : 'You do not have permission to delete users.');
      return;
    }

    try {
      const response = await fetch('/api/admin/delete-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ uid: user.uid })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || 'Failed to delete user');
      }

      await logAction(currentProfile, 'Delete User', `Deleted user profile for ${user.username}`, null, 'User');
      setShowDeleteConfirm(null);
      fetchUsers();
    } catch (err: any) {
      console.error(err);
      setError(err.message || 'Failed to delete user profile.');
    }
  };

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        compact={isCnRoute}
        title={isCnRoute ? "账号管理" : "User Management"}
        subtitle={isCnRoute ? undefined : "Manage employee accounts and permissions."}
        icon={UserIcon}
        isScrolled={isScrolled}
        actions={
          canManage && (
            <button 
              onClick={() => openEdit()}
              className="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-3 rounded-xl font-semibold transition-all shadow-lg shadow-indigo-200"
            >
              <UserPlus className="w-5 h-5" />
              {isCnRoute ? '创建账号' : 'Create Account'}
            </button>
          )
        }
      />

      {/* 🚀 Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="px-6 py-4">Employee</th>
                <th className="px-6 py-4">Username</th>
                <th className="px-6 py-4">Status</th>
                <th className="px-6 py-4">Permissions</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                [1,2,3].map(i => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={5} className="px-6 py-4"><div className="h-12 bg-slate-100 rounded"></div></td>
                  </tr>
                ))
              ) : users.map((user) => (
                <tr key={user.uid} className="hover:bg-slate-50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center font-bold">
                        {user.name.charAt(0)}
                      </div>
                      <span className="font-bold text-slate-900">{user.name}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-slate-600">{user.username}</td>
                  <td className="px-6 py-4">
                    <span className={cn(
                      "px-2 py-1 rounded text-xs font-bold",
                      user.status === 'Active' ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                    )}>
                      {user.status}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex flex-col gap-1">
                      <span className="text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded w-fit">
                        {user.roleTemplate || 'No Type'}
                      </span>
                      <span className="text-[10px] text-slate-400">
                        {(user.permissions || []).length} Permissions • {(user.allowedWarehouses || []).length} Warehouses
                      </span>
                    </div>
                  </td>
                   <td className="px-6 py-4 text-right">
                    <div className="flex justify-end gap-2">
                      {canManage ? (
                        <>
                          <button 
                            onClick={() => {
                              setPasswordTargetUser(user);
                              setShowPasswordModal(true);
                            }} 
                            className="p-2 text-slate-400 hover:text-amber-600 transition-colors"
                            title="Reset Password"
                          >
                            <Key className="w-5 h-5" />
                          </button>
                          <button onClick={() => openEdit(user)} className="p-2 text-slate-400 hover:text-indigo-600 transition-colors">
                            <Edit2 className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={() => setShowDeleteConfirm(user)} 
                            className="p-2 text-slate-400 hover:text-red-600 transition-colors"
                            title="Delete User"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </>
                      ) : (
                        <span className="text-xs text-slate-400 italic">View Only</span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <AdminChangePasswordModal 
        isOpen={showPasswordModal} 
        onClose={() => {
          setShowPasswordModal(false);
          setPasswordTargetUser(null);
        }} 
        targetUser={passwordTargetUser} 
      />

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="w-16 h-16 bg-red-100 text-red-600 rounded-full flex items-center justify-center mx-auto mb-6">
              <Trash2 className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-bold text-slate-900 text-center mb-2">Delete Account?</h3>
            <p className="text-slate-600 text-center mb-8">
              Are you sure you want to delete <span className="font-bold text-slate-900">{showDeleteConfirm.name}</span>? 
              This action cannot be undone.
            </p>
            <div className="flex gap-3">
              <button 
                onClick={() => setShowDeleteConfirm(null)} 
                className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => handleDeleteUser(showDeleteConfirm)} 
                className="flex-1 px-4 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition-colors shadow-lg shadow-red-200"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="p-6 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900">{editingUser?.uid ? 'Edit Permissions' : 'Create New Account'}</h3>
              <button onClick={() => setShowEditModal(false)}><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            
            <form onSubmit={handleSaveUser} className="flex-1 overflow-auto p-8 space-y-8">
              {error && (
                <div className="p-4 bg-red-50 border border-red-100 rounded-xl flex items-start gap-3 text-red-700 text-sm">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <p>{error}</p>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-4">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2">
                    <UserIcon className="w-5 h-5 text-indigo-600" />
                    Account Details
                  </h4>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Username</label>
                    <input
                      type="text"
                      required
                      disabled={!!editingUser?.uid}
                      value={formUsername}
                      onChange={(e) => setFormUsername(e.target.value)}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
                      placeholder="e.g. alice"
                    />
                  </div>
                  {!editingUser?.uid && (
                    <div>
                      <label className="block text-sm font-medium text-slate-700 mb-2">Password</label>
                      <input
                        type="password"
                        required
                        value={formPassword}
                        onChange={(e) => setFormPassword(e.target.value)}
                        className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Min 6 characters"
                      />
                    </div>
                  )}
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Full Name</label>
                    <input
                      type="text"
                      required
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                      placeholder="e.g. Alice Smith"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Account Type</label>
                    <select
                      value={formAccountType}
                      onChange={(e) => applyTemplate(e.target.value as AccountType)}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Sales">Sales</option>
                      <option value="Reception">Reception</option>
                      <option value="Warehouse">Warehouse</option>
                      <option value="Admin">Admin</option>
                    </select>
                    <p className="mt-1 text-[10px] text-slate-400 italic">Changing type will reset permissions to template defaults.</p>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-2">Status</label>
                    <select
                      value={formStatus}
                      onChange={(e) => setFormStatus(e.target.value as UserStatus)}
                      className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <option value="Active">Active</option>
                      <option value="Disabled">Disabled</option>
                    </select>
                  </div>

                  <div className="pt-4">
                    <h4 className="font-bold text-slate-900 flex items-center gap-2 mb-4">
                      <ShieldCheck className="w-5 h-5 text-indigo-600" />
                      Allowed Warehouses
                    </h4>
                    <div className="grid grid-cols-1 gap-2">
                      {Object.entries(WAREHOUSE_NAMES).map(([id, name]) => (
                        <label key={id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                          <input
                            type="checkbox"
                            checked={formAllowedWarehouses.includes(id)}
                            onChange={() => toggleWarehouse(id)}
                            className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          />
                          <span className="text-sm font-medium text-slate-700">{name} ({id})</span>
                        </label>
                      ))}
                    </div>
                    <p className="mt-2 text-[10px] text-slate-400 italic">Users with multiple warehouses will be prompted to select one at login.</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <h4 className="font-bold text-slate-900 flex items-center gap-2">
                    <Shield className="w-5 h-5 text-indigo-600" />
                    Permissions
                  </h4>
                  <div className="flex flex-wrap gap-2 mb-4">
                    <button type="button" onClick={() => applyTemplate('Sales')} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full font-semibold">Sales Template</button>
                    <button type="button" onClick={() => applyTemplate('Reception')} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full font-semibold">Reception Template</button>
                    <button type="button" onClick={() => applyTemplate('Warehouse')} className="text-xs bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-full font-semibold">Warehouse Template</button>
                    <button type="button" onClick={() => applyTemplate('Admin')} className="text-xs bg-indigo-100 text-indigo-700 hover:bg-indigo-200 px-3 py-1.5 rounded-full font-semibold">Admin Template</button>
                  </div>
                  <div className="grid grid-cols-1 gap-2 max-h-64 overflow-y-auto p-1">
                    {PERMISSIONS.map(perm => (
                      <label key={perm} className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                        <input
                          type="checkbox"
                          checked={formPermissions.includes(perm)}
                          onChange={() => togglePermission(perm)}
                          className="w-5 h-5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                        <span className="text-sm font-medium text-slate-700">{perm}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            </form>

            <div className="p-6 border-t border-slate-100 flex gap-3">
              <button type="button" onClick={() => setShowEditModal(false)} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                Cancel
              </button>
              <button 
                onClick={handleSaveUser} 
                disabled={submitting}
                className="flex-1 px-4 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 disabled:opacity-50"
              >
                {submitting ? 'Saving...' : 'Save Account'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};
