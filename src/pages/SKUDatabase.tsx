import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { collection, query, getDocs, addDoc, updateDoc, deleteDoc, doc, getDoc, writeBatch, orderBy, limit, startAfter, getCountFromServer, where, setDoc, documentId } from 'firebase/firestore';
import { db } from '../firebase';
import { useAuth } from '../components/AuthProvider';
import { SKU } from '../types';
import { logAction, hasPermission, isAdmin, isSystemAdmin, getSkuWarehouseLocation, getWarehouseDisplayName } from '../utils';
import { 
  Search, 
  Plus, 
  Upload, 
  Edit2, 
  Trash2, 
  X, 
  Save, 
  Download,
  Database,
  AlertCircle,
  CheckCircle2,
  FileText,
  ArrowUpDown,
  MapPin,
  Loader2,
  ShieldAlert,
  History
} from 'lucide-react';

import { PageHeader } from '../components/PageHeader';
import { useDebounce } from '../hooks/useDebounce';

export const SKUDatabase = () => {
  const { profile, user, activeWarehouse } = useAuth();
  const navigate = useNavigate();
  const [skus, setSkus] = useState<SKU[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [lastDoc, setLastDoc] = useState<any>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [sortBy, setSortBy] = useState<'sku' | 'productName' | 'location'>('sku');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [locationFilter, setLocationFilter] = useState('All');
  const debouncedSearchTerm = useDebounce(searchTerm, 500);
  
  // Pagination states
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(50);
  
  // Modal states
  const [showEditModal, setShowEditModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [editingSku, setEditingSku] = useState<SKU | null>(null);
  const [deletingSku, setDeletingSku] = useState<{id: string, sku: string} | null>(null);
  const [selectedSkuIds, setSelectedSkuIds] = useState<string[]>([]);
  const [showBulkDeleteModal, setShowBulkDeleteModal] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showHealthCheckModal, setShowHealthCheckModal] = useState(false);
  const [brokenSkus, setBrokenSkus] = useState<any[]>([]);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [cleaningHealth, setCleaningHealth] = useState(false);
  const [clearConfirmText, setClearConfirmText] = useState('');
  const [clearing, setClearing] = useState(false);
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
  
  // Form states
  const [formSku, setFormSku] = useState('');
  const [formName, setFormName] = useState('');
  const [formLocation, setFormLocation] = useState('');
  const [csvData, setCsvData] = useState('');
  const [uploading, setUploading] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState('');

  const handleDataHealthCheck = async () => {
    if (!profile || !isAdmin(profile, profile?.email)) return;
    
    // 1. Get total count first to warn user
    const skusRef = collection(db, 'skus');
    const countSnap = await getCountFromServer(skusRef);
    const total = countSnap.data().count;
    
    if (total > 2000) {
      const proceed = window.confirm(`Database has ${total} records. A full health check will consume ${total} read operations. Proceed?`);
      if (!proceed) return;
    }

    setCheckingHealth(true);
    try {
      const issues: any[] = [];
      const skuGroups = new Map<string, SKU[]>();
      
      // 2. Process in chunks of 1000 to avoid browser lag
      let lastVisible = null;
      let processed = 0;
      const CHUNK_SIZE = 1000;

      while (processed < total) {
        let q = query(skusRef, limit(CHUNK_SIZE));
        if (lastVisible) {
          q = query(skusRef, startAfter(lastVisible), limit(CHUNK_SIZE));
        }

        const snapshot = await getDocs(q);
        if (snapshot.empty) break;

        snapshot.docs.forEach(doc => {
          const s = { id: doc.id, ...doc.data() } as SKU;
          const normalized = (s.sku || '').trim().toUpperCase();
          
          if (!normalized) {
            issues.push({ type: 'invalid', id: s.id, sku: '(MISSING)', name: s.productName || '', reason: 'Missing SKU' });
          } else {
            if (!skuGroups.has(normalized)) {
              skuGroups.set(normalized, []);
            }
            skuGroups.get(normalized)!.push(s);

            if (!s.productName || s.productName.trim() === '') {
              issues.push({ type: 'missing_name', id: s.id, sku: s.sku, name: '(MISSING)', reason: 'Missing Product Name' });
            }
          }
        });

        processed += snapshot.docs.length;
        lastVisible = snapshot.docs[snapshot.docs.length - 1];
      }

      // 3. Check for duplicates in the gathered groups
      for (const [sku, group] of skuGroups.entries()) {
        if (group.length > 1) {
          issues.push({ 
            type: 'duplicate', 
            sku, 
            count: group.length, 
            ids: group.map(s => s.id),
            reason: 'Duplicate SKU' 
          });
        }
      }

      setBrokenSkus(issues);
      setShowHealthCheckModal(true);
    } catch (err) {
      console.error("Health check failed:", err);
      alert("Failed to perform health check.");
    } finally {
      setCheckingHealth(false);
    }
  };

  const handleFixBrokenSkus = async () => {
    if (!profile || !isAdmin(profile, profile?.email) || brokenSkus.length === 0) return;
    
    const proceed = window.confirm(`This will perform write operations to fix ${brokenSkus.length} identified issues. Proceed?`);
    if (!proceed) return;

    setCleaningHealth(true);
    try {
      const deleteIds = new Set<string>();
      const updateMap = new Map<string, any>();
      
      // We already have the brokenSkus from handleDataHealthCheck.
      // We don't need to fetch the entire database again!
      
      // Group issues by SKU for duplicate handling
      const duplicateIssues = brokenSkus.filter(i => i.type === 'duplicate');
      const otherIssues = brokenSkus.filter(i => i.type !== 'duplicate');

      // Handle simple issues
      otherIssues.forEach(issue => {
        if (issue.type === 'invalid') {
          if (issue.id) deleteIds.add(issue.id);
        } else if (issue.type === 'missing_name') {
          if (issue.id && !deleteIds.has(issue.id)) {
            updateMap.set(issue.id, { 
              productName: issue.sku,
              updatedAt: new Date().toISOString()
            });
          }
        }
      });

      // Handle duplicates
      // Note: The 'duplicate' issue object already contains the IDs of the duplicates.
      for (const issue of duplicateIssues) {
        // We need to fetch the actual data for these specific IDs to decide which one to keep
        // or we can just use a simple strategy: keep the first ID, delete the rest.
        // To be safer, we can fetch just these specific documents.
        
        const ids = issue.ids as string[];
        if (!ids || ids.length <= 1) continue;

        // Fetch just these specific docs
        const docsToCompare: SKU[] = [];
        for (const id of ids) {
          const d = await getDoc(doc(db, 'skus', id));
          if (d.exists()) {
            docsToCompare.push({ id: d.id, ...d.data() } as SKU);
          }
        }

        if (docsToCompare.length > 1) {
          const sorted = [...docsToCompare].sort((a, b) => {
            const aHasName = a.productName && a.productName.trim() !== '';
            const bHasName = b.productName && b.productName.trim() !== '';
            if (aHasName && !bHasName) return -1;
            if (!aHasName && bHasName) return 1;
            return (a.id || '').localeCompare(b.id || '');
          });

          const [keep, ...toDelete] = sorted;
          toDelete.forEach(s => {
            if (s.id) deleteIds.add(s.id);
          });
          
          if (keep.id && (!keep.productName || keep.productName.trim() === '')) {
            updateMap.set(keep.id, { 
              productName: keep.sku,
              updatedAt: new Date().toISOString()
            });
          }
        }
      }

      // Apply deletions and updates in chunks
      const operations: { type: 'delete' | 'update', id: string, data?: any }[] = [];
      
      deleteIds.forEach(id => {
        operations.push({ type: 'delete', id });
        updateMap.delete(id);
      });

      updateMap.forEach((data, id) => {
        operations.push({ type: 'update', id, data });
      });

      if (operations.length === 0) {
        alert("No actions needed to be performed.");
        setShowHealthCheckModal(false);
        return;
      }

      const CHUNK_SIZE = 450;
      for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
        const chunk = operations.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        
        chunk.forEach(op => {
          const docRef = doc(db, 'skus', op.id);
          if (op.type === 'delete') {
            batch.delete(docRef);
          } else {
            batch.update(docRef, op.data);
          }
        });
        
        await batch.commit();
      }

      await logAction(profile, 'Data Health Fix', `Fixed ${updateMap.size} records and removed ${deleteIds.size} duplicates/invalid records.`, null, 'SKU');
      alert(`Successfully processed ${operations.length} records.`);
      setBrokenSkus([]);
      setShowHealthCheckModal(false);
      fetchSKUs();
    } catch (err: any) {
      console.error("Fixing failed:", err);
      alert(`Failed to fix records: ${err.message || 'Unknown error'}`);
    } finally {
      setCleaningHealth(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setSelectedFileName(file.name);
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target?.result;
        if (typeof text === 'string') {
          setCsvData(text);
        }
      } catch (err) {
        console.error("File read error:", err);
        alert("Failed to read CSV file.");
      }
    };
    reader.onerror = () => {
      alert("Error reading file.");
    };
    reader.readAsText(file);
    // Reset input so same file can be uploaded again if needed
    e.target.value = '';
  };

  const locationWarehouse = activeWarehouse || 'AKL';
  const effectiveSkuLocation = (sku: SKU) => getSkuWarehouseLocation(sku, locationWarehouse);

  useEffect(() => {
    fetchSKUs();
  }, [sortBy, sortOrder]);

  const fetchSKUs = async (isNextPage = false) => {
    setLoading(true);
    try {
      const skusRef = collection(db, 'skus');
      
      // 1. Get Total Count (Cheap)
      if (!isNextPage) {
        const countSnap = await getCountFromServer(skusRef);
        setTotalCount(countSnap.data().count);
      }

      // 2. Build Query
      let q = query(skusRef, orderBy(sortBy, sortOrder), limit(itemsPerPage));
      
      if (isNextPage && lastDoc) {
        q = query(q, startAfter(lastDoc));
      }

      const snap = await getDocs(q);
      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as SKU));
      
      if (isNextPage) {
        setSkus(prev => [...prev, ...list]);
      } else {
        setSkus(list);
      }

      setLastDoc(snap.docs[snap.docs.length - 1]);
      setHasMore(snap.docs.length === itemsPerPage);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSaveSku = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    
    if (!hasPermission(profile, 'Edit SKU', profile?.email)) {
      alert('You do not have permission to add or edit SKUs.');
      return;
    }

    if (!formSku) {
      alert('SKU is required.');
      return;
    }

    const skuUpper = formSku.trim().toUpperCase();
    const safeDocId = skuUpper.replace(/\//g, '_');
    const rawName = formName.trim();
    const rawLocation = formLocation.trim().toUpperCase();
    
    try {
      const docRef = doc(db, 'skus', safeDocId);
      const currentSnap = await getDoc(docRef);
      
      let finalName, finalLocation;
      let needsUpdate = false;

      // 2. 🧠 核心大脑：判断是老数据合并，还是新数据创建
      if (currentSnap.exists()) {
        const dbData = currentSnap.data() as SKU;
        const dbName = (dbData.productName || "").toString().trim();
        const dbLocations = dbData.locations || {};
        const dbLocation = getSkuWarehouseLocation(dbData, locationWarehouse);

        // 规则：有新值用新值，没新值保老值
        finalName = rawName !== "" ? rawName : dbName;
        finalLocation = rawLocation !== "" ? rawLocation : dbLocation;

        if (finalName !== dbName || finalLocation !== dbLocation || (editingSku?.id && editingSku.id !== safeDocId) || dbLocations[locationWarehouse] !== finalLocation) {
          needsUpdate = true;
        }
      } else {
        // 完全陌生的新 SKU：触发 Fallback
        finalName = rawName !== "" ? rawName : skuUpper;
        finalLocation = rawLocation !== "" ? rawLocation : "N/A";
        needsUpdate = true;
      }

      // 3. 🛡️ 拦截器执行
      if (!needsUpdate) {
        setShowEditModal(false);
        return;
      }

      const now = new Date().toISOString();
      const existingData = currentSnap.exists() ? currentSnap.data() as SKU : null;
      const existingLocations = existingData?.locations || {};
      const data: any = {
        sku: skuUpper, // 存入原始 SKU (带斜杠)
        productName: finalName,
        location: locationWarehouse === 'AKL'
          ? finalLocation
          : (existingData?.location || 'N/A'),
        locations: {
          ...existingLocations,
          [locationWarehouse]: finalLocation
        },
        updatedAt: now
      };

      if (!currentSnap.exists()) {
        data.createdAt = now;
      }

      // If we are editing an existing record and the SKU ID has changed, 
      // we need to delete the old document.
      if (editingSku?.id && editingSku.id !== safeDocId) {
        try {
          await deleteDoc(doc(db, 'skus', editingSku.id));
        } catch (err) {
          handleFirestoreError(err, 'delete', `skus/${editingSku.id}`);
        }
      }
      
      try {
        await setDoc(docRef, data, { merge: true });
      } catch (err) {
        handleFirestoreError(err, 'write', `skus/${safeDocId}`);
      }
      
      await logAction(profile, editingSku?.id ? 'Edit SKU' : 'Add SKU', `${editingSku?.id ? 'Updated' : 'Added'} SKU ${skuUpper}`, null, 'SKU');
      
      setShowEditModal(false);
      fetchSKUs();
    } catch (err) {
      console.error(err);
      if (err instanceof Error && err.message.startsWith('{')) {
        const info = JSON.parse(err.message);
        alert(`Failed to save SKU: ${info.error}`);
      } else {
        alert('Failed to save SKU.');
      }
    }
  };

  const handleDeleteSku = async () => {
    if (!profile || !deletingSku) return;
    if (!isAdmin(profile, user?.email)) {
      alert('Only administrators can delete SKUs.');
      return;
    }
    try {
      await deleteDoc(doc(db, 'skus', deletingSku.id));
      await logAction(profile, 'Delete SKU', `Deleted SKU ${deletingSku.sku}`, null, 'SKU');
      setShowDeleteModal(false);
      setDeletingSku(null);
      setSelectedSkuIds(prev => prev.filter(id => id !== deletingSku.id));
      fetchSKUs();
    } catch (err) {
      console.error(err);
      alert('Failed to delete SKU.');
    }
  };

  const handleBulkDelete = async () => {
    if (!profile || selectedSkuIds.length === 0) return;
    if (!isAdmin(profile, user?.email)) {
      alert('Only administrators can delete SKUs.');
      return;
    }
    
    setLoading(true);
    try {
      const CHUNK_SIZE = 450;
      for (let i = 0; i < selectedSkuIds.length; i += CHUNK_SIZE) {
        const chunk = selectedSkuIds.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        chunk.forEach(id => {
          batch.delete(doc(db, 'skus', id));
        });
        await batch.commit();
      }
      
      await logAction(profile, 'Bulk Delete SKU', `Deleted ${selectedSkuIds.length} SKUs`, null, 'SKU');
      setSelectedSkuIds([]);
      setShowBulkDeleteModal(false);
      fetchSKUs();
      alert(`Successfully deleted ${selectedSkuIds.length} SKUs.`);
    } catch (err) {
      console.error(err);
      alert('Failed to delete SKUs.');
    } finally {
      setLoading(false);
    }
  };

  const handleClearDatabase = async () => {
    if (!profile || !isSystemAdmin(profile?.email)) return;
    if (clearConfirmText !== 'CLEAR DATABASE') {
      alert('Please type "CLEAR DATABASE" to confirm.');
      return;
    }

    const skusRef = collection(db, 'skus');
    const countSnap = await getCountFromServer(skusRef);
    const total = countSnap.data().count;

    if (total === 0) {
      alert('Database is already empty.');
      setShowClearModal(false);
      return;
    }

    const proceed = window.confirm(`This will delete ALL ${total} records. This action is irreversible. Proceed?`);
    if (!proceed) return;

    setClearing(true);
    try {
      let deletedCount = 0;
      const CHUNK_SIZE = 500;

      while (true) {
        // Fetch only IDs for the next batch to delete
        const q = query(skusRef, limit(CHUNK_SIZE));
        const snap = await getDocs(q);
        
        if (snap.empty) break;

        const batch = writeBatch(db);
        snap.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        
        await batch.commit();
        deletedCount += snap.docs.length;
        
        // If we got fewer than CHUNK_SIZE, we're done
        if (snap.docs.length < CHUNK_SIZE) break;
      }

      await logAction(profile, 'Clear Database', `System Admin cleared the entire SKU database (${deletedCount} items)`, null, 'SKU');
      setShowClearModal(false);
      setClearConfirmText('');
      fetchSKUs();
      alert(`Successfully cleared ${deletedCount} SKUs from the database.`);
    } catch (err: any) {
      console.error(err);
      alert(`Failed to clear database: ${err.message}`);
    } finally {
      setClearing(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedSkuIds.length === paginatedSkus.length) {
      setSelectedSkuIds([]);
    } else {
      setSelectedSkuIds(paginatedSkus.map(s => s.id!));
    }
  };

  const toggleSelectSku = (id: string) => {
    setSelectedSkuIds(prev => 
      prev.includes(id) ? prev.filter(i => i !== id) : [...prev, id]
    );
  };

  const handleFirestoreError = (error: any, operation: string, path: string) => {
    const errInfo = {
      error: error instanceof Error ? error.message : String(error),
      operationType: operation,
      path,
      authInfo: {
        userId: user?.uid,
        email: profile?.email,
        emailVerified: true,
        isAnonymous: false,
        tenantId: undefined,
        providerInfo: []
      }
    };
    console.error('Firestore Error:', JSON.stringify(errInfo));
    throw new Error(JSON.stringify(errInfo));
  };

  const processBatchUpload = async (dataToProcess: string) => {
    if (!dataToProcess) {
      alert('No data to process.');
      return;
    }
    if (!profile) {
      alert('User profile not loaded. Please wait or refresh.');
      return;
    }
    if (!hasPermission(profile, 'Upload SKU', profile?.email)) {
      alert('You do not have permission to upload SKUs.');
      return;
    }
    setUploading(true);
    try {
      const allLines = dataToProcess.split('\n').map(l => l.trim()).filter(l => l);
      if (allLines.length === 0) {
        alert('CSV is empty.');
        return;
      }

      // Detect and skip header if it looks like one
      let lines = allLines;
      const firstLine = allLines[0].toLowerCase();
      if (firstLine.includes('sku') || firstLine.includes('name') || firstLine.includes('location')) {
        lines = allLines.slice(1);
      }

      if (lines.length === 0) {
        alert('No data rows found in CSV (only header or empty).');
        return;
      }
      
      // Deduplicate within the CSV itself (last one wins)
      const toProcess = new Map<string, { rawName: string, rawLocation: string }>();
      const skippedRows: string[] = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const parts = line.split(',').map(s => s.trim());
        const rawSku = parts[0];
        
        // Validation: ONLY SKU is strictly REQUIRED
        if (!rawSku) {
          skippedRows.push(`Row ${i + 1}: ${line} (Missing SKU)`);
          continue;
        }

        const skuUpper = rawSku.toUpperCase();
        const rawName = parts[1] || "";
        const rawLocation = (parts[2] || "").toUpperCase();

        toProcess.set(skuUpper, { rawName, rawLocation });
      }

      if (toProcess.size === 0) {
        alert('No valid SKUs to upload. Ensure each row has at least a SKU.');
        if (skippedRows.length > 0) {
          console.warn('Skipped rows:', skippedRows);
        }
        return;
      }

      // Firestore batch limit is 500. We'll process in chunks.
      const entries = Array.from(toProcess.entries());
      const CHUNK_SIZE = 450;
      let totalUploaded = 0;
      let unmodifiedSkipped = 0;
      const addedSkus: string[] = [];
      const updatedSkus: string[] = [];

      for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
        const chunk = entries.slice(i, i + CHUNK_SIZE);
        const batch = writeBatch(db);
        
        const docRefs = chunk.map(([skuUpper]) => {
          const safeDocId = skuUpper.replace(/\//g, '_');
          return doc(db, 'skus', safeDocId);
        });
        const existingSnaps = await Promise.all(docRefs.map(ref => getDoc(ref)));

        let updatesInThisBatch = 0;

        for (let j = 0; j < chunk.length; j++) {
          const [skuUpper, data] = chunk[j];
          const currentSnap = existingSnaps[j];
          
          let finalName, finalLocation;
          let needsUpdate = false;
          let isNew = !currentSnap.exists();

          if (currentSnap.exists()) {
            const currentData = currentSnap.data() as SKU;
            const dbName = (currentData.productName || "").toString().trim();
            const dbLocations = currentData.locations || {};
            const dbLocation = getSkuWarehouseLocation(currentData, locationWarehouse);

            finalName = data.rawName !== "" ? data.rawName : dbName;
            finalLocation = data.rawLocation !== "" ? data.rawLocation : dbLocation;

            if (finalName !== dbName || finalLocation !== dbLocation || dbLocations[locationWarehouse] !== finalLocation) {
              needsUpdate = true;
            }
          } else {
            finalName = data.rawName !== "" ? data.rawName : skuUpper;
            finalLocation = data.rawLocation !== "" ? data.rawLocation : "N/A";
            needsUpdate = true;
          }

          if (!needsUpdate) {
            unmodifiedSkipped++;
            continue;
          }

          if (isNew) addedSkus.push(skuUpper);
          else updatedSkus.push(skuUpper);

          const skuData: SKU = {
            sku: skuUpper,
            productName: finalName,
            location: locationWarehouse === 'AKL'
              ? finalLocation
              : ((currentSnap.data() as SKU | undefined)?.location || 'N/A'),
            locations: {
              ...(((currentSnap.data() as SKU | undefined)?.locations) || {}),
              [locationWarehouse]: finalLocation
            }
          };

          const now = new Date().toISOString();
          const updateData: any = {
            ...skuData,
            updatedAt: now
          };

          if (isNew) {
            updateData.createdAt = now;
          }

          batch.set(docRefs[j], updateData, { merge: true });
          
          updatesInThisBatch++;
          totalUploaded++;
        }
        
        if (updatesInThisBatch > 0) {
          try {
            await batch.commit();
          } catch (err) {
            handleFirestoreError(err, 'write', 'skus/batch');
          }
        }
      }
      
      // Create detailed log message
      let logDetails = `Batch processed ${totalUploaded} items. `;
      if (addedSkus.length > 0) {
        const addedList = addedSkus.length > 20 ? `${addedSkus.slice(0, 20).join(', ')}... (+${addedSkus.length - 20} more)` : addedSkus.join(', ');
        logDetails += `Added (${addedSkus.length}): [${addedList}]. `;
      }
      if (updatedSkus.length > 0) {
        const updatedList = updatedSkus.length > 20 ? `${updatedSkus.slice(0, 20).join(', ')}... (+${updatedSkus.length - 20} more)` : updatedSkus.join(', ');
        logDetails += `Updated (${updatedSkus.length}): [${updatedList}]. `;
      }
      if (unmodifiedSkipped > 0) {
        logDetails += `Skipped ${unmodifiedSkipped} unchanged items.`;
      }

      await logAction(profile, 'Upload SKU', logDetails, null, 'SKU');
      setShowUploadModal(false);
      setCsvData('');
      setSelectedFileName('');
      fetchSKUs();
      
      let message = `Successfully processed ${totalUploaded} SKUs.`;
      if (unmodifiedSkipped > 0) {
        message += `\n\nSkipped ${unmodifiedSkipped} unchanged items to save database quotas.`;
      }
      if (skippedRows.length > 0) {
        message += `\n\nSkipped ${skippedRows.length} invalid rows (missing data). Check console for details.`;
      }
      alert(message);
    } catch (err) {
      console.error(err);
      if (err instanceof Error && err.message.startsWith('{')) {
        const info = JSON.parse(err.message);
        alert(`Failed to upload SKUs: ${info.error}`);
      } else {
        alert('Failed to upload SKUs. Ensure CSV format is: SKU,Name,Location.');
      }
    } finally {
      setUploading(false);
    }
  };

  const handleBatchUpload = async () => {
    await processBatchUpload(csvData);
  };

  const downloadTemplate = () => {
    const headers = 'SKU,Product Name,Location';
    const example = 'ABC-123,Wireless Mouse,A-01-02\nXYZ-789,Keyboard,B-02-03';
    const csvContent = `${headers}\n${example}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'sku_upload_template.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const filteredSkus = useMemo(() => {
    return skus
      .filter(s => {
        const matchesSearch = 
          (s.sku || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase()) ||
          (s.productName || '').toLowerCase().includes(debouncedSearchTerm.toLowerCase());
        
        const effectiveLocation = effectiveSkuLocation(s);
        const matchesLocation = locationFilter === 'All' || effectiveLocation === locationFilter;
        
        return matchesSearch && matchesLocation;
      })
      .sort((a, b) => {
        const valA = sortBy === 'location'
          ? effectiveSkuLocation(a).toLowerCase()
          : ((a[sortBy] || '') as string).toLowerCase();
        const valB = sortBy === 'location'
          ? effectiveSkuLocation(b).toLowerCase()
          : ((b[sortBy] || '') as string).toLowerCase();
        if (sortOrder === 'asc') {
          return valA.localeCompare(valB);
        } else {
          return valB.localeCompare(valA);
        }
      });
  }, [skus, debouncedSearchTerm, locationFilter, sortBy, sortOrder, locationWarehouse]);

  // Pagination logic
  const totalItems = filteredSkus.length;
  const totalPages = Math.ceil(totalItems / itemsPerPage);
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedSkus = useMemo(() => 
    filteredSkus.slice(startIndex, startIndex + itemsPerPage),
    [filteredSkus, startIndex, itemsPerPage]
  );

  // Reset to page 1 when filters change
  useEffect(() => {
    setCurrentPage(1);
    setSelectedSkuIds([]);
  }, [debouncedSearchTerm, locationFilter, sortBy, sortOrder]);

  const locations = useMemo(() => 
    ['All', ...new Set(skus.map(s => effectiveSkuLocation(s)).filter(Boolean))].sort(),
    [skus, locationWarehouse]
  );

  const openEdit = (sku?: SKU) => {
    if (sku) {
      setEditingSku(sku);
      setFormSku(sku.sku);
      setFormName(sku.productName);
      setFormLocation(effectiveSkuLocation(sku));
    } else {
      setEditingSku(null);
      setFormSku('');
      setFormName('');
      setFormLocation('');
    }
    setShowEditModal(true);
  };

  const canView = hasPermission(profile, 'View SKU', profile?.email) || isAdmin(profile, profile?.email);

  if (!canView && !loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <ShieldAlert className="w-16 h-16 mb-4 opacity-20" />
        <h2 className="text-xl font-bold text-slate-900 mb-2">Access Denied</h2>
        <p>You do not have permission to view the SKU Database.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full w-full bg-slate-50 overflow-hidden font-sans">
      <PageHeader
        title={`SKU Database (${totalCount})`}
        subtitle={`Manage product information and ${getWarehouseDisplayName(locationWarehouse)} locations.`}
        icon={Database}
        isScrolled={isScrolled}
        actions={
          <>
            {isSystemAdmin(profile?.email) && (
              <button 
                onClick={() => setShowClearModal(true)}
                className={cn(
                  "inline-flex items-center gap-2 bg-rose-50 text-rose-600 border border-rose-200 rounded-xl font-semibold hover:bg-rose-100 transition-all",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2 rounded-xl text-sm"
                )}
              >
                <Trash2 className="w-4 h-4" />
                <span className={isScrolled ? "hidden group-hover:inline" : "inline"}>Clear Database</span>
              </button>
            )}
            {isAdmin(profile, profile?.email) && (
              <button 
                onClick={handleDataHealthCheck}
                disabled={checkingHealth}
                className={cn(
                  "inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-all disabled:opacity-50",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2 rounded-xl text-sm"
                )}
              >
                <ShieldAlert className={cn("w-4 h-4 text-amber-500", checkingHealth ? "animate-pulse" : "")} />
                <span className={isScrolled ? "hidden group-hover:inline" : "inline"}>{checkingHealth ? 'Checking...' : 'Data Health Check'}</span>
              </button>
            )}
            {isAdmin(profile, profile?.email) && (
              <button 
                onClick={() => navigate('/skus/logs')}
                className={cn(
                  "inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-all",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2 rounded-xl text-sm"
                )}
              >
                <History className="w-4 h-4 text-indigo-500" />
                <span className={isScrolled ? "hidden group-hover:inline" : "inline"}>View Logs</span>
              </button>
            )}
            {hasPermission(profile, 'Upload SKU', profile?.email) && (
              <button 
                onClick={() => setShowUploadModal(true)}
                className={cn(
                  "inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl font-semibold hover:bg-slate-50 transition-all",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2 rounded-xl text-sm"
                )}
              >
                <Upload className="w-4 h-4" />
                <span className={isScrolled ? "hidden group-hover:inline" : "inline"}>Batch Upload</span>
              </button>
            )}
            {hasPermission(profile, 'Edit SKU', profile?.email) && (
              <button 
                onClick={() => openEdit()}
                className={cn(
                  "inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl font-semibold transition-all shadow-lg shadow-indigo-200",
                  isScrolled ? "px-3 py-1.5 text-xs group-hover:px-4 group-hover:py-2.5 group-hover:text-sm" : "px-4 py-2 rounded-xl text-sm"
                )}
              >
                <Plus className="w-4 h-4" />
                <span>Add SKU</span>
              </button>
            )}
          </>
        }
      >
        <div className="space-y-4">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
              placeholder="Filter currently loaded SKUs..."
            />
          </div>

          <div className={cn(
            "grid grid-cols-1 md:grid-cols-3 gap-4 transition-all duration-300 ease-in-out overflow-hidden",
            isScrolled 
              ? "h-0 opacity-0 mt-0 group-hover:h-auto group-hover:opacity-100 group-hover:mt-4" 
              : "h-auto opacity-100 mt-4"
          )}>
            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                <MapPin className="w-3 h-3" /> Filter Location
              </label>
              <select
                value={locationFilter}
                onChange={(e) => setLocationFilter(e.target.value)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              >
                {locations.map(loc => (
                  <option key={loc} value={loc}>{loc}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                <ArrowUpDown className="w-3 h-3" /> Sort By
              </label>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              >
                <option value="sku">SKU Code</option>
                <option value="productName">Product Name</option>
                <option value="location">Location</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-bold text-slate-400 uppercase mb-2 flex items-center gap-1">
                <ArrowUpDown className="w-3 h-3" /> Direction
              </label>
              <select
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value as any)}
                className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              >
                <option value="asc">Ascending</option>
                <option value="desc">Descending</option>
              </select>
            </div>
          </div>
        </div>
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div ref={sentinelRef} className="h-px w-full pointer-events-none -mt-8" />
        <div className="max-w-[1600px] mx-auto space-y-8">
        </div>

        {/* Content Area (Scrolling) */}
        {selectedSkuIds.length > 0 && isAdmin(profile, profile?.email) && (
          <div className="bg-rose-50 border border-rose-100 p-4 rounded-2xl flex items-center justify-between animate-in fade-in slide-in-from-top-2 mb-6">
            <div className="flex items-center gap-3 text-rose-700">
              <AlertCircle className="w-5 h-5" />
              <span className="font-semibold">{selectedSkuIds.length} SKUs selected</span>
            </div>
            <div className="flex gap-2">
              <button 
                onClick={() => setSelectedSkuIds([])}
                className="px-4 py-2 text-rose-600 font-bold hover:bg-rose-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={() => setShowBulkDeleteModal(true)}
                className="bg-rose-600 text-white px-4 py-2 rounded-lg font-bold hover:bg-rose-700 transition-colors shadow-lg shadow-rose-200 flex items-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                Bulk Delete
              </button>
            </div>
          </div>
        )}

      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                {isAdmin(profile, profile?.email) && (
                  <th className="px-6 py-4 w-10">
                    <input 
                      type="checkbox" 
                      checked={paginatedSkus.length > 0 && selectedSkuIds.length === paginatedSkus.length}
                      onChange={toggleSelectAll}
                      className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                )}
                <th className="px-6 py-4">SKU</th>
                <th className="px-6 py-4">Product Name</th>
                <th className="px-6 py-4">Location</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {loading ? (
                [1,2,3].map(i => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={isAdmin(profile, profile?.email) ? 5 : 4} className="px-6 py-4"><div className="h-6 bg-slate-100 rounded"></div></td>
                  </tr>
                ))
              ) : paginatedSkus.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin(profile, profile?.email) ? 5 : 4} className="px-6 py-12 text-center text-slate-400">No SKUs found.</td>
                </tr>
              ) : (
                paginatedSkus.map((sku) => (
                  <tr key={sku.id} className={cn(
                    "hover:bg-slate-50 transition-colors",
                    selectedSkuIds.includes(sku.id!) && "bg-indigo-50/50"
                  )}>
                    {isAdmin(profile, profile?.email) && (
                      <td className="px-6 py-4">
                        <input 
                          type="checkbox" 
                          checked={selectedSkuIds.includes(sku.id!)}
                          onChange={() => toggleSelectSku(sku.id!)}
                          className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                    )}
                    <td className="px-6 py-4 font-bold text-slate-900">{sku.sku}</td>
                    <td className="px-6 py-4 text-slate-600">{sku.productName}</td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 bg-indigo-50 text-indigo-600 rounded text-xs font-bold">
                        {effectiveSkuLocation(sku)}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-right space-x-2">
                      {hasPermission(profile, 'Edit SKU', profile?.email) && (
                        <button onClick={() => openEdit(sku)} className="p-2 text-slate-400 hover:text-indigo-600 transition-colors">
                          <Edit2 className="w-5 h-5" />
                        </button>
                      )}
                      {isAdmin(profile, profile?.email) && (
                        <button onClick={() => {
                          setDeletingSku({ id: sku.id!, sku: sku.sku });
                          setShowDeleteModal(true);
                        }} className="p-2 text-slate-400 hover:text-red-600 transition-colors">
                          <Trash2 className="w-5 h-5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Controls */}
        {!loading && totalCount > 0 && (
          <div className="px-6 py-4 bg-slate-50 border-t border-slate-100 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-sm text-slate-500">
              Showing <span className="font-semibold text-slate-900">{skus.length}</span> of <span className="font-semibold text-slate-900">{totalCount}</span> SKUs
            </div>
            
            <div className="flex items-center gap-2">
              {hasMore && (
                <button
                  onClick={() => fetchSKUs(true)}
                  className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-xs font-bold hover:bg-indigo-700 transition-colors"
                >
                  Load More
                </button>
              )}
              <select
                value={itemsPerPage}
                onChange={(e) => {
                  setItemsPerPage(Number(e.target.value));
                }}
                className="px-2 py-1 bg-white border border-slate-200 rounded text-xs outline-none focus:ring-1 focus:ring-indigo-500"
              >
                <option value={20}>20 per page</option>
                <option value={50}>50 per page</option>
                <option value={100}>100 per page</option>
                <option value={200}>200 per page</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {showEditModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-slate-900">{editingSku ? 'Edit SKU' : 'Add New SKU'}</h3>
              <button onClick={() => setShowEditModal(false)}><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            <form onSubmit={handleSaveSku} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">SKU Code</label>
                <input
                  type="text"
                  required
                  value={formSku}
                  onChange={(e) => setFormSku(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. ABC-123"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">Product Name (Optional)</label>
                <input
                  type="text"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. Wireless Mouse (Defaults to SKU if empty)"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">
                  {getWarehouseDisplayName(locationWarehouse)} Location (Optional)
                </label>
                <input
                  type="text"
                  value={formLocation}
                  onChange={(e) => setFormLocation(e.target.value)}
                  className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder="e.g. A-01-02"
                />
              </div>
              <div className="pt-6 flex gap-3">
                <button type="button" onClick={() => setShowEditModal(false)} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                  Cancel
                </button>
                <button type="submit" className="flex-1 px-4 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors">
                  Save SKU
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Upload Modal */}
      {showUploadModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-8 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-xl font-bold text-slate-900">Batch Upload SKUs</h3>
              <button onClick={() => {
                setShowUploadModal(false);
                setSelectedFileName('');
                setCsvData('');
              }}><X className="w-6 h-6 text-slate-400" /></button>
            </div>
            <div className="space-y-4">
              <div className="p-4 bg-blue-50 border border-blue-100 rounded-xl text-blue-700 text-sm flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 flex-shrink-0" />
                  <p>Upload a CSV file or paste data below. Format: <strong>SKU,Product Name,Location</strong>. Only SKU is required.</p>
                </div>
                <button 
                  onClick={downloadTemplate}
                  className="flex items-center gap-2 text-blue-600 hover:text-blue-800 font-bold text-xs transition-colors w-fit ml-8"
                >
                  <Download className="w-4 h-4" />
                  Download CSV Template
                </button>
              </div>

                <div className="relative group">
                  <input
                    type="file"
                    accept=".csv"
                    onChange={handleFileChange}
                    disabled={uploading}
                    className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10 disabled:cursor-not-allowed"
                  />
                  <div className={`w-full px-4 py-10 border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 transition-colors ${uploading ? 'bg-slate-100 border-slate-300' : 'bg-slate-50 border-slate-200 group-hover:border-indigo-400'}`}>
                    <div className="p-3 bg-white rounded-full shadow-sm">
                      {uploading ? (
                        <Loader2 className="w-8 h-8 text-indigo-500 animate-spin" />
                      ) : (
                        <FileText className="w-8 h-8 text-indigo-500" />
                      )}
                    </div>
                    <div className="text-center">
                      <p className="text-sm font-bold text-slate-900">
                        {uploading ? 'Processing file...' : selectedFileName ? `Selected: ${selectedFileName}` : 'Click to upload CSV file'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">
                        {uploading ? 'Please wait while we update the database' : selectedFileName ? 'Click "Upload Now" to confirm' : 'or drag and drop here'}
                      </p>
                    </div>
                  </div>
                </div>

              <details className="group">
                <summary className="text-xs font-bold text-slate-400 uppercase cursor-pointer hover:text-slate-600 transition-colors flex items-center gap-1">
                  Or paste CSV content manually
                </summary>
                <div className="mt-3">
                  <textarea
                    value={csvData}
                    onChange={(e) => setCsvData(e.target.value)}
                    className="w-full h-32 p-4 bg-slate-50 border border-slate-200 rounded-xl outline-none focus:ring-2 focus:ring-indigo-500 font-mono text-sm"
                    placeholder="ABC123,Phone Case,A01-02&#10;XYZ789,,B04-05 (Empty name defaults to SKU)"
                  />
                </div>
              </details>

              <div className="pt-6 flex gap-3">
                <button onClick={() => {
                  setShowUploadModal(false);
                  setSelectedFileName('');
                  setCsvData('');
                }} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                  Cancel
                </button>
                <button 
                  onClick={handleBatchUpload} 
                  disabled={uploading || !csvData}
                  className="flex-1 px-4 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors disabled:opacity-50"
                >
                  {uploading ? 'Uploading...' : 'Upload Now'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Data Health Check Modal */}
      {showHealthCheckModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full p-8 shadow-2xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3 text-amber-600">
                <ShieldAlert className="w-8 h-8" />
                <h3 className="text-xl font-bold">Data Health Check Results</h3>
              </div>
              <button onClick={() => setShowHealthCheckModal(false)} className="p-2 hover:bg-slate-100 rounded-full transition-colors">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            
            <div className="mb-8">
              {brokenSkus.length === 0 ? (
                <div className="bg-emerald-50 border border-emerald-100 p-6 rounded-2xl text-center">
                  <CheckCircle2 className="w-12 h-12 text-emerald-500 mx-auto mb-4" />
                  <h4 className="text-lg font-bold text-emerald-900 mb-2">All Clear!</h4>
                  <p className="text-emerald-700">No data issues were found in the database.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-amber-50 border border-amber-100 p-4 rounded-xl text-amber-800 text-sm">
                    Found <strong>{brokenSkus.length}</strong> potential issues. This includes duplicate SKUs and records with missing product names.
                  </div>
                  <div className="max-h-60 overflow-y-auto border border-slate-100 rounded-xl">
                    <table className="w-full text-left text-sm">
                      <thead className="bg-slate-50 text-slate-500 uppercase text-xs sticky top-0">
                        <tr>
                          <th className="px-4 py-2">Type</th>
                          <th className="px-4 py-2">SKU</th>
                          <th className="px-4 py-2">Issue</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50">
                        {brokenSkus.map((issue, idx) => (
                          <tr key={idx}>
                            <td className="px-4 py-2">
                              <span className={cn(
                                "px-2 py-0.5 rounded text-[10px] font-bold uppercase",
                                issue.type === 'duplicate' ? "bg-amber-100 text-amber-700" : "bg-rose-100 text-rose-700"
                              )}>
                                {issue.type}
                              </span>
                            </td>
                            <td className="px-4 py-2 font-bold">{issue.sku}</td>
                            <td className="px-4 py-2 text-slate-500">{issue.reason} {issue.count ? `(${issue.count})` : ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setShowHealthCheckModal(false)} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                Close
              </button>
              {brokenSkus.length > 0 && (
                <button 
                  onClick={handleFixBrokenSkus}
                  disabled={cleaningHealth}
                  className="flex-1 px-4 py-3 bg-indigo-600 text-white font-semibold rounded-xl hover:bg-indigo-700 transition-colors shadow-lg shadow-indigo-200 disabled:opacity-50"
                >
                  {cleaningHealth ? 'Processing...' : `Fix All Issues`}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {/* Delete Confirmation Modal */}
      {showDeleteModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="flex items-center gap-3 text-red-600 mb-4">
              <AlertCircle className="w-8 h-8" />
              <h3 className="text-xl font-bold">Delete SKU</h3>
            </div>
            <p className="text-slate-600 mb-8">Are you sure you want to delete SKU <strong>{deletingSku?.sku}</strong>? This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowDeleteModal(false)} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                Cancel
              </button>
              <button 
                onClick={handleDeleteSku}
                className="flex-1 px-4 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Bulk Delete Confirmation Modal */}
      {showBulkDeleteModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="flex items-center gap-3 text-red-600 mb-4">
              <AlertCircle className="w-8 h-8" />
              <h3 className="text-xl font-bold">Bulk Delete SKUs</h3>
            </div>
            <p className="text-slate-600 mb-8">Are you sure you want to delete <strong>{selectedSkuIds.length}</strong> selected SKUs? This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setShowBulkDeleteModal(false)} className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors">
                Cancel
              </button>
              <button 
                onClick={handleBulkDelete}
                className="flex-1 px-4 py-3 bg-red-600 text-white font-semibold rounded-xl hover:bg-red-700 transition-colors"
              >
                Delete All
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Database Modal */}
      {showClearModal && (
        <div className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600 mb-4">
              <AlertCircle className="w-8 h-8" />
              <h3 className="text-xl font-bold">Clear Entire Database</h3>
            </div>
            <div className="space-y-4 mb-8">
              <p className="text-slate-600">
                This will permanently delete <strong>ALL {skus.length} SKUs</strong> from the database. This action is irreversible.
              </p>
              <div className="p-4 bg-rose-50 border border-rose-100 rounded-xl">
                <p className="text-sm text-rose-700 font-medium mb-2">To confirm, please type "CLEAR DATABASE" below:</p>
                <input 
                  type="text"
                  value={clearConfirmText}
                  onChange={(e) => setClearConfirmText(e.target.value)}
                  className="w-full px-4 py-2 bg-white border border-rose-200 rounded-lg outline-none focus:ring-2 focus:ring-rose-500 font-bold text-center"
                  placeholder="CLEAR DATABASE"
                />
              </div>
            </div>
            <div className="flex gap-3">
              <button 
                onClick={() => {
                  setShowClearModal(false);
                  setClearConfirmText('');
                }} 
                className="flex-1 px-4 py-3 text-slate-600 font-semibold hover:bg-slate-100 rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={handleClearDatabase}
                disabled={clearing || clearConfirmText !== 'CLEAR DATABASE'}
                className="flex-1 px-4 py-3 bg-rose-600 text-white font-semibold rounded-xl hover:bg-rose-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {clearing ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Clearing...
                  </>
                ) : 'Confirm Clear'}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </div>
  );
};

function cn(...classes: string[]) {
  return classes.filter(Boolean).join(' ');
}
