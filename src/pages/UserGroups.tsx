import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  collection, 
  query, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  onSnapshot 
} from 'firebase/firestore';
import { db } from '../firebase';
import { UserGroup, UserProfile } from '../types';
import { useAuth } from '../components/AuthProvider';
import { handleFirestoreError, OperationType, hasPermission, isAdmin, isSystemAdmin, cn } from '../utils';
import { 
  Users, 
  Plus, 
  Edit2, 
  Trash2, 
  X, 
  Check, 
  Search,
  UserPlus
} from 'lucide-react';

import { subscribeDuringWorkHours, getWorkWindow } from '../lib/workHours';
import { useLocation } from 'react-router-dom';
import { PageHeader } from '../components/PageHeader';

export default function UserGroups() {
  const { profile: currentProfile, user, token } = useAuth();
  const isCnRoute = useLocation().pathname.startsWith("/cn");
  const [groups, setGroups] = useState<UserGroup[]>([]);
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

  const [showModal, setShowModal] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<UserGroup | null>(null);
  const [groupName, setGroupName] = useState('');
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const canManage = isAdmin(currentProfile, currentProfile?.email) || hasPermission(currentProfile, 'Manage User Groups', currentProfile?.email);

  const loadGroupsOnce = async () => {
    try {
      const snapshot = await getDocs(collection(db, 'userGroups'));
      setGroups(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as UserGroup)));
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to load groups.');
    } finally {
      setLoading(false);
    }
  };

  const loadCnGroups = async () => {
    if (!canManage || !token) { setLoading(false); return; }
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/user-groups/list', { headers: { 'x-v2-auth-token': token }, cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.error || '无法加载用户组。');
      setGroups(data.groups);
      setUsers(data.users);
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法加载用户组。');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isCnRoute) { void loadCnGroups(); return; }
    let retryCount = 0;
    const MAX_RETRIES = 10;
    let unsubscribeGroups: (() => void) | null = null;
    let retryTimeout: NodeJS.Timeout | null = null;

    const setupGroupsListener = () => {
      // Clean up existing listener before retrying
      if (unsubscribeGroups) {
        unsubscribeGroups();
        unsubscribeGroups = null;
      }

      unsubscribeGroups = onSnapshot(collection(db, 'userGroups'), (snapshot) => {
        retryCount = 0;
        const groupsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as UserGroup));
        setGroups(groupsData);
        setLoading(false);
      }, (error) => {
        console.error("User groups listener error:", error);
        if (retryCount < MAX_RETRIES) {
          retryCount++;
          const delay = Math.min(1000 * Math.pow(2, retryCount), 30000); // Exponential backoff
          console.log(`Retrying user groups listener in ${delay}ms (Attempt ${retryCount}/${MAX_RETRIES})...`);
          retryTimeout = setTimeout(setupGroupsListener, delay);
        } else {
          console.error("User groups listener: Exceeded maximum number of retries allowed.");
          setLoading(false);
        }
      });
    };

    const stopGroups = subscribeDuringWorkHours('nz', () => {
      retryCount = 0;
      setupGroupsListener();
      return () => {
        unsubscribeGroups?.();
        unsubscribeGroups = null;
        if (retryTimeout) clearTimeout(retryTimeout);
      };
    }, loadGroupsOnce);

    const fetchUsers = async () => {
      try {
        const snapshot = await getDocs(collection(db, 'users'));
        const usersData = snapshot.docs.map(doc => ({ uid: doc.id, ...doc.data() } as UserProfile));
        // Hide system administrator from the list
        setUsers(usersData.filter(u => !isSystemAdmin(u.username)));
      } catch (error) {
        console.error("Error fetching users:", error);
      }
    };

    fetchUsers();
    return () => {
      stopGroups();
    };
  }, [isCnRoute, canManage, token]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupName.trim()) return;
    if (!canManage) {
      setError('You do not have permission to manage groups.');
      return;
    }

    const data = {
      name: groupName,
      userIds: selectedUserIds
    };

    try {
      const token = localStorage.getItem('x-v2-auth-token');
      const response = await fetch('/api/user-groups/save', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ id: editingGroup?.id, ...data })
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to save group');
      }

      closeModal();
      if (isCnRoute) await loadCnGroups();
      else if (!getWorkWindow('nz').open) await loadGroupsOnce();
    } catch (error: any) {
      console.error("Error saving group:", error);
      setError(`Failed to save group: ${error.message}`);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const token = localStorage.getItem('x-v2-auth-token');
      const response = await fetch('/api/user-groups/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-v2-auth-token': `Bearer ${token}`
        },
        body: JSON.stringify({ id })
      });

      if (!response.ok) {
        const result = await response.json();
        throw new Error(result.error || 'Failed to delete group');
      }

      setShowDeleteConfirm(null);
      if (isCnRoute) await loadCnGroups();
      else if (!getWorkWindow('nz').open) await loadGroupsOnce();
    } catch (error: any) {
      console.error("Error deleting group:", error);
      setError(`Failed to delete group: ${error.message}`);
    }
  };

  const openModal = (group?: UserGroup) => {
    if (group) {
      setEditingGroup(group);
      setGroupName(group.name);
      setSelectedUserIds(group.userIds || []);
    } else {
      setEditingGroup(null);
      setGroupName('');
      setSelectedUserIds([]);
    }
    setShowModal(true);
  };

  const closeModal = () => {
    setShowModal(false);
    setEditingGroup(null);
    setGroupName('');
    setSelectedUserIds([]);
  };

  const toggleUser = (uid: string) => {
    setSelectedUserIds(prev => 
      prev.includes(uid) ? prev.filter(id => id !== uid) : [...prev, uid]
    );
  };

  const filteredUsers = useMemo(() => {
    try {
      return users.filter(user => 
        (user.name || "").toLowerCase().includes(searchTerm.toLowerCase()) ||
        (user.username || "").toLowerCase().includes(searchTerm.toLowerCase())
      );
    } catch (error) {
      console.error("Error filtering users:", error);
      return [];
    }
  }, [users, searchTerm]);

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden">
      <PageHeader
        compact={isCnRoute}
        title={isCnRoute ? "用户组" : "User Groups"}
        subtitle={isCnRoute ? undefined : "Manage groups for targeted notifications"}
        icon={Users}
        isScrolled={isScrolled}
        actions={
          canManage && (
            <button 
              onClick={() => openModal()}
              className="bg-indigo-600 text-white px-6 py-3 rounded-xl font-bold flex items-center gap-2 hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
            >
              <Plus className="w-5 h-5" />
              Create Group
            </button>
          )
        }
      />

      {/* 🚀 Scrollable Content */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        {/* Sentinel for Scroll Detection */}
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-6xl mx-auto">
          {error && (
            <div className="mb-6 p-4 bg-rose-50 border border-rose-100 rounded-2xl text-rose-700 text-sm flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
              {error}
              <button onClick={() => setError('')} className="ml-auto text-rose-400 hover:text-rose-600">
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {loading ? (
          [1,2,3].map(i => (
            <div key={i} className="bg-white p-6 rounded-2xl border border-slate-100 animate-pulse">
              <div className="h-6 bg-slate-100 rounded w-1/2 mb-4"></div>
              <div className="h-4 bg-slate-100 rounded w-1/3 mb-6"></div>
              <div className="flex gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-100"></div>
                <div className="w-8 h-8 rounded-full bg-slate-100"></div>
              </div>
            </div>
          ))
        ) : groups.length === 0 ? (
          <div className="col-span-full text-center py-12 bg-white rounded-2xl border border-dashed border-slate-200">
            <Users className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <p className="text-slate-500">No groups created yet</p>
          </div>
        ) : (
          groups.map(group => (
            <div 
              key={group.id}
              className="bg-white p-6 rounded-2xl border border-slate-100 shadow-sm hover:shadow-md transition-shadow"
            >
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="text-lg font-bold text-slate-900">{group.name}</h3>
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mt-1">
                    {(group.userIds || []).length} Members
                  </p>
                </div>
                <div className="flex gap-2">
                  {canManage ? (
                    <>
                      <button 
                        onClick={() => openModal(group)}
                        className="p-2 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => setShowDeleteConfirm(group.id!)}
                        className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </>
                  ) : (
                    <span className="text-xs text-slate-400 italic">View Only</span>
                  )}
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                {(group.userIds || []).slice(0, 5).map(uid => {
                  const user = users.find(u => u.uid === uid);
                  return (
                    <div 
                      key={uid}
                      className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600 text-xs font-bold border-2 border-white"
                      title={user?.name || 'Unknown User'}
                    >
                      {user?.name?.[0] || '?'}
                    </div>
                  );
                })}
                {(group.userIds || []).length > 5 && (
                  <div className="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 text-xs font-bold border-2 border-white">
                    +{(group.userIds || []).length - 5}
                  </div>
                )}
              </div>
            </div>
          ))
        )}
      </div>

        {showDeleteConfirm && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
            <div 
              className="bg-white rounded-2xl w-full max-w-md p-6 shadow-2xl"
            >
              <h3 className="text-xl font-bold text-slate-900 mb-2">Delete Group?</h3>
              <p className="text-slate-500 mb-6">This action cannot be undone. All members will be removed from this group.</p>
              <div className="flex gap-3">
                <button 
                  onClick={() => setShowDeleteConfirm(null)}
                  className="flex-1 px-4 py-3 rounded-lg font-bold text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  Cancel
                </button>
                <button 
                  onClick={() => handleDelete(showDeleteConfirm)}
                  className="flex-1 bg-rose-600 text-white px-4 py-3 rounded-lg font-bold hover:bg-rose-700 transition-colors shadow-lg shadow-rose-200"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {showModal && (
          <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
            <div 
              className="bg-white rounded-2xl w-full max-w-2xl overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-slate-100 flex justify-between items-center">
                <h2 className="text-xl font-bold text-slate-900">
                  {editingGroup ? 'Edit Group' : 'Create New Group'}
                </h2>
                <button onClick={closeModal} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                  <X className="w-5 h-5 text-slate-500" />
                </button>
              </div>

              <form onSubmit={handleSave} className="p-6">
                <div className="mb-6">
                  <label className="block text-sm font-bold text-slate-700 mb-2">Group Name</label>
                  <input 
                    type="text"
                    value={groupName}
                    onChange={(e) => setGroupName(e.target.value)}
                    className="w-full px-4 py-3 rounded-lg border border-slate-200 focus:ring-2 focus:ring-indigo-500 focus:border-transparent outline-none transition-all"
                    placeholder="e.g. Warehouse Team"
                    required
                  />
                </div>

                <div className="mb-6">
                  <div className="flex justify-between items-center mb-4">
                    <label className="block text-sm font-bold text-slate-700">Select Members</label>
                    <div className="relative">
                      <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input 
                        type="text"
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="pl-9 pr-4 py-2 text-sm rounded-lg border border-slate-200 outline-none focus:ring-2 focus:ring-indigo-500"
                        placeholder="Search users..."
                      />
                    </div>
                  </div>

                  <div className="max-h-64 overflow-y-auto border border-slate-100 rounded-lg p-2 space-y-1">
                    {filteredUsers.map(user => (
                      <button
                        key={user.uid}
                        type="button"
                        onClick={() => toggleUser(user.uid)}
                        className={`w-full flex items-center justify-between p-3 rounded-lg transition-colors ${
                          selectedUserIds.includes(user.uid) 
                            ? 'bg-indigo-50 text-indigo-700' 
                            : 'hover:bg-slate-50 text-slate-600'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                            selectedUserIds.includes(user.uid) ? 'bg-indigo-200' : 'bg-slate-200'
                          }`}>
                            {user.name?.[0] || '?'}
                          </div>
                          <div className="text-left">
                            <p className="font-bold text-sm">{user.name || 'Unknown'}</p>
                            <p className="text-xs opacity-70">{user.username}</p>
                          </div>
                        </div>
                        {selectedUserIds.includes(user.uid) ? (
                          <Check className="w-5 h-5" />
                        ) : (
                          <Plus className="w-5 h-5 opacity-30" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-3 pt-4">
                  <button 
                    type="button"
                    onClick={closeModal}
                    className="flex-1 px-4 py-3 rounded-lg font-bold text-slate-600 hover:bg-slate-100 transition-colors"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    className="flex-1 bg-indigo-600 text-white px-4 py-3 rounded-lg font-bold hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200"
                  >
                    {editingGroup ? 'Update Group' : 'Create Group'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </div>
    </div>
  </div>
);
}
