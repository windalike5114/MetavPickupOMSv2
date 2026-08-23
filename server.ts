import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import fs from "fs";
import http from "http";
import { Server } from "socket.io";
import bcrypt from 'bcryptjs';
import firebaseConfig from './firebase-applet-config.json' with { type: 'json' };
import { sendEmail, sendBulkEmails } from './src/lib/mailer';
import { isValidDateString } from './src/lib/firebase';
import { authenticate, loginUser } from './src/lib/auth';
import { SUPER_ADMINS, isSuperAdmin } from './src/lib/auth-shared';
import cron from "node-cron";
import { generateAndSendDailyReport } from "./src/services/reportService";
import { DateTime } from "luxon";

// Helper to write to debug log
const writeDebugLog = (message: string) => {
  const logPath = path.join(process.cwd(), "debug.log");
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] ${message}\n`;
  fs.appendFileSync(logPath, logEntry);
};

// Initialize Firebase Admin lazily and safely
let db: admin.firestore.Firestore | null = null;
let lastInitError: string | null = null;

const initDb = async () => {
  if (db) return db;
  try {
    if (!admin.apps.length) {
      // 1. Check for explicit service account in environment
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      
      if (serviceAccountJson) {
        try {
          const serviceAccount = JSON.parse(serviceAccountJson);
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: firebaseConfig.databaseURL
          });
          console.log("🚀 [Server] Firebase Admin SDK initialized with Service Account (God Mode ON)");
        } catch (e: any) {
          console.error("❌ Failed to parse FIREBASE_SERVICE_ACCOUNT_JSON:", e.message);
          // Fallback to other methods if parsing fails
        }
      }

      // 2. Fallback to projectId or default credentials if not already initialized
      if (!admin.apps.length) {
        if (firebaseConfig.projectId) {
          try {
            admin.initializeApp({
              credential: admin.credential.applicationDefault(),
              projectId: firebaseConfig.projectId,
              databaseURL: firebaseConfig.databaseURL
            });
            console.log("🚀 [Server] Admin SDK initialized with Application Default Credentials and project ID:", firebaseConfig.projectId);
          } catch (e: any) {
            console.warn("⚠️ Failed to initialize with Application Default Credentials, falling back to simple config:", e.message);
            admin.initializeApp({
              projectId: firebaseConfig.projectId,
              databaseURL: firebaseConfig.databaseURL
            });
            console.log("Admin SDK initialized with simple config project ID:", firebaseConfig.projectId);
          }
        } else {
          try {
            admin.initializeApp();
            console.log("Admin SDK initialized with default ambient credentials");
          } catch (e) {
            throw e;
          }
        }
      }
    }
    
    try {
      // Correct way to get a specific database instance in Firebase Admin SDK
      const databaseId = (firebaseConfig as any).firestoreDatabaseId;
      db = admin.firestore(databaseId); 
      console.log(`Firestore instance created for database: ${databaseId || "(default)"}`);
      lastInitError = null;
    } catch (e: any) {
      console.error("Failed to connect to Firestore:", e.message);
      lastInitError = `Failed to connect to Firestore: ${e.message}`;
      throw e;
    }
    
    return db;
  } catch (error: any) {
    lastInitError = error.message || String(error);
    console.error("CRITICAL: Failed to initialize Firebase Admin:", error);
    return null;
  }
};

// Helper Functions for Backend
const hasPermission = (user: any, permission: string) => {
  const isSuper = SUPER_ADMINS.includes(user.username.toLowerCase());
  if (isSuper) return true;
  return (user.permissions || []).includes(permission);
};

const logAction = async (user: any, action: string, details: string, orderId?: string, category?: string) => {
  try {
    const currentDb = await initDb();
    if (!currentDb) return;
    await currentDb.collection('logs').add({
      timestamp: new Date().toISOString(),
      userId: user.uid,
      userName: user.name || user.username,
      action,
      details,
      orderId: orderId || null,
      category: category || 'System'
    });
  } catch (error) {
    console.error('Failed to log action:', error);
  }
};

const AUCKLAND_TIMEZONE = "Pacific/Auckland";

const nowAucklandIso = () => DateTime.now().setZone(AUCKLAND_TIMEZONE).toISO();

const normalizeCounterPickupRequestType = (value: any) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "scheduleddelivery" || raw === "scheduled_delivery" || raw === "delivery") return "scheduledDelivery";
  return "counterPickup";
};

const normalizeCounterPickupSourceType = (value: any) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "metav" || raw === "metav order" || raw === "metav-order") return "metav";
  if (raw === "offline" || raw === "offline order" || raw === "offline-order") return "offline";
  if (raw === "blackfern" || raw === "blackfern order" || raw === "blackfern-order") return "blackfern";
  return "other";
};

const normalizeCounterPickupOutcome = (value: any) => {
  const raw = String(value || "").trim().toLowerCase();
  if (raw === "sold") return "sold";
  if (raw === "returned" || raw === "returnedtowarehouse" || raw === "returned_to_warehouse") return "returnedToWarehouse";
  if (raw === "warranty" || raw === "swap" || raw === "parts" || raw === "warrantyswapparts" || raw === "warranty/swap/parts") return "warrantySwapParts";
  return "other";
};

const normalizeCounterPickupOrderNumber = (sourceType: any, value: any) => {
  const source = normalizeCounterPickupSourceType(sourceType);
  const raw = String(value || "").replace(/\D/g, "").trim();
  if (!raw) return "";
  const prefix = source === "metav" ? "MVNZ" : source === "blackfern" ? "BFINV-" : "INV-";
  return raw.startsWith(prefix) ? raw : `${prefix}${raw}`;
};

const resolveSkuLocationForWarehouse = (skuData: any, warehouseId?: string | null) => {
  const wh = warehouseId || "AKL";
  const warehouseLocation = skuData?.locations?.[wh];
  if (warehouseLocation && String(warehouseLocation).trim()) {
    return String(warehouseLocation).trim().toUpperCase();
  }
  const legacyLocation = skuData?.location;
  return legacyLocation && String(legacyLocation).trim()
    ? String(legacyLocation).trim().toUpperCase()
    : "N/A";
};

const normalizeWarehouseId = (value: any) => {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "AKL" || raw === "CHC" ? raw : "";
};

const normalizeLocationValue = (value: any) => String(value || "").trim().toUpperCase();

const normalizeSkuLocationsPayload = (value: any) => {
  const normalized: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;

  ["AKL", "CHC"].forEach((warehouseId) => {
    const location = normalizeLocationValue(value[warehouseId] ?? value[warehouseId.toLowerCase()]);
    if (location) normalized[warehouseId] = location;
  });

  return normalized;
};

const normalizeExistingSkuLocations = (value: any) => {
  const normalized: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return normalized;

  Object.entries(value).forEach(([key, val]) => {
    const warehouseId = normalizeWarehouseId(key);
    const location = normalizeLocationValue(val);
    if (warehouseId && location) normalized[warehouseId] = location;
  });

  return normalized;
};

const pickNumericPayloadField = (item: any, keys: string[]) => {
  for (const key of keys) {
    const value = item?.[key];
    if (value === undefined || value === null || value === "") continue;
    const numericValue = Number(value);
    if (Number.isFinite(numericValue)) return numericValue;
  }
  return undefined;
};

const extractSkuInventoryFields = (item: any) => {
  const fields: Record<string, number> = {};
  const mappings: Array<[string, string[]]> = [
    ["availableQty", ["availableQty", "available_qty", "qtyAvailable", "quantityAvailable"]],
    ["stockQty", ["stockQty", "stock_qty", "stock", "stockQuantity"]],
    ["onHandQty", ["onHandQty", "on_hand_qty", "onHand", "on_hand"]],
    ["allocatedQty", ["allocatedQty", "allocated_qty", "allocated"]],
    ["inventoryQty", ["inventoryQty", "inventory_qty", "inventory"]]
  ];

  mappings.forEach(([targetKey, sourceKeys]) => {
    const numericValue = pickNumericPayloadField(item, sourceKeys);
    if (numericValue !== undefined) fields[targetKey] = numericValue;
  });

  return fields;
};

const locationsEqual = (a: Record<string, string>, b: Record<string, string>) =>
  a.AKL === b.AKL && a.CHC === b.CHC;

const isCnPortalRequest = (req: any) => {
  const host = String(req.headers?.host || "").toLowerCase();
  const referer = String(req.headers?.referer || "").toLowerCase();
  return host.startsWith("cn.") || referer.includes("/cn");
};

const isFrontDeskRole = (user: any) => {
  const role = user?.roleTemplate || user?.role || "";
  return ["Reception", "Admin"].includes(role);
};

const isWarehouseRole = (user: any) => {
  const role = user?.roleTemplate || user?.role || "";
  return role === "Warehouse" || role === "Admin";
};

const writeCounterPickupLog = async (
  currentDb: admin.firestore.Firestore,
  counterPickupId: string,
  operator: string,
  action: string,
  detail: string,
  user?: any
) => {
  const timestamp = nowAucklandIso();
  await currentDb.collection("counter_pickups").doc(counterPickupId).collection("logs").add({
    timestamp,
    operator,
    action,
    detail
  });
  await currentDb.collection("logs").add({
    timestamp,
    userId: user?.uid || "system",
    userName: operator,
    action,
    details: detail,
    orderId: counterPickupId,
    category: "Counter Pickup"
  });
};

const buildCounterPickupDetail = (pickup: any) => {
  const items = Array.isArray(pickup.items) ? pickup.items : [];
  const primaryItem = items[0] || {};
  const putbackItems = Array.isArray(pickup.putbackItems) ? pickup.putbackItems : [];
  return {
    id: pickup.id,
    sku: pickup.sku || primaryItem.sku || "",
    productName: pickup.productName || primaryItem.productName || "",
    location: pickup.location || primaryItem.location || "NOT_ASSIGNED",
    qty: Number(pickup.putbackQty || pickup.qty || primaryItem.qty || 0),
    requestType: pickup.requestType || "counterPickup",
    sourceType: pickup.sourceType || null,
    items,
    putbackItems,
    putbackQty: Number(pickup.putbackQty || 0),
    status: pickup.status,
    queueStatus: pickup.queueStatus,
    destination: pickup.destination || null,
    outcome: pickup.outcome || null,
    orderNumber: pickup.orderNumber || null,
    referenceNo: pickup.referenceNo || null,
    otherNotes: pickup.otherNotes || null,
    comment: pickup.comment || null,
    pickupNote: pickup.pickupNote || null,
    warehouseId: pickup.warehouseId || null,
    createdBy: pickup.createdBy,
    createdByUid: pickup.createdByUid || null,
    pickedBy: pickup.pickedBy || null,
    pickedAt: pickup.pickedAt || null,
    finalizedBy: pickup.finalizedBy || null,
    finalizedAt: pickup.finalizedAt || null,
    expiredBySystem: !!pickup.expiredBySystem,
    expiredReason: pickup.expiredReason || null,
    completedAt: pickup.completedAt || null,
    completedBy: pickup.completedBy || null,
    createdAt: pickup.createdAt,
    updatedAt: pickup.updatedAt
  };
};

const getNextCounterPickupId = async (currentDb: admin.firestore.Firestore) => {
  const today = DateTime.now().setZone(AUCKLAND_TIMEZONE).toFormat("yyyyMMdd");
  const counterRef = currentDb.collection("system_counters").doc(`counter_pickups_${today}`);
  const sequence = await currentDb.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const current = snap.exists ? Number(snap.data()?.seq || 0) : 0;
    const next = current + 1;
    tx.set(counterRef, {
      seq: next,
      updatedAt: nowAucklandIso()
    }, { merge: true });
    return next;
  });
  return `CP-${today}-${String(sequence).padStart(3, "0")}`;
};

const expireStaleCounterPickups = async (currentDb: admin.firestore.Firestore) => {
  const now = DateTime.now().setZone(AUCKLAND_TIMEZONE);
  const expiredBeforeMs = now.minus({ hours: 12 }).toMillis();
  const snap = await currentDb.collection("counter_pickups")
    .where("status", "in", ["PendingPick", "Picked"])
    .get();

  const expiredSummaries: any[] = [];
  for (const docSnap of snap.docs) {
    const data = docSnap.data() as any;
    const createdMs = data?.createdAt ? DateTime.fromISO(data.createdAt, { zone: AUCKLAND_TIMEZONE }).toMillis() : 0;
    if (!createdMs || createdMs > expiredBeforeMs) continue;

    const detail = `System expired counter pickup ${data.id} after 12+ hours without closure.`;
    await docSnap.ref.set({
      status: "Finalized",
      queueStatus: "Picked",
      destination: data.destination || "Other",
      otherNotes: data.otherNotes || "System expired after 12 hours without completion.",
      expiredBySystem: true,
      expiredReason: "System expired after 12 hours without completion.",
      finalizedAt: nowAucklandIso(),
      finalizedBy: "System",
      completedAt: nowAucklandIso(),
      completedBy: "System",
      updatedAt: nowAucklandIso()
    }, { merge: true });

    await writeCounterPickupLog(currentDb, docSnap.id, "System", "CP_SYSTEM_EXPIRED", detail);
    expiredSummaries.push({
      id: data.id || docSnap.id,
      sku: data.sku || "N/A",
      qty: data.qty || 0,
      warehouseId: data.warehouseId || "N/A",
      createdAt: data.createdAt || null
    });
  }

  return expiredSummaries;
};

const toListOrder = (o: any) => {
  // Avoid large payload fields (e.g. base64 signatures) in list endpoint.
  const {
    customerSignature,
    signatureData,
    ...rest
  } = o || {};
  return rest;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { writeLog, readLogs, clearLogs } from './src/lib/logger';

// ... (existing code)

async function startServer() {
  const app = express();
  
  // 1. CORS 配置 (必须在所有路由之前)
  app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-v2-auth-token', 'x-warehouse-id'],
    credentials: true
  }));

  // 2. JSON 解析 (必须在所有路由之前)
  app.use(express.json({ limit: '10mb' }));

  // 3. 🚨 终极调试：监控所有进入服务器的请求
  app.use((req, res, next) => {
    // 记录所有非静态资源的请求
    if (!req.url.includes('.') && !req.url.startsWith('/@')) {
      writeLog('DEBUG', `📥 Request: ${req.method} ${req.url}`, { headers: req.headers });
    }
    
    // 拦截响应，确保报错时我们能看到
    const originalSend = res.send;
    res.send = function(body) {
      if (res.statusCode >= 400) {
        writeLog('ERROR', `📤 Error Response (${res.statusCode}) for ${req.method} ${req.url}`, { body });
      }
      return originalSend.apply(res, arguments as any);
    };
    next();
  });

  // Operation Logs Endpoints
  app.get("/api/admin/logs", authenticate, (req: any, res) => {
    const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
    if (!isSuper) return res.status(403).json({ error: "Forbidden" });
    
    const logs = readLogs(200);
    res.json({ success: true, logs });
  });

  app.post("/api/admin/logs/clear", authenticate, (req: any, res) => {
    const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
    if (!isSuper) return res.status(403).json({ error: "Forbidden" });
    
    clearLogs();
    res.json({ success: true });
  });

  // Setup Daily Report Cron Job
  // 23:30 Pacific/Auckland
  cron.schedule('30 23 * * *', async () => {
    console.log("[Cron] Triggering daily report...");
    try {
      const currentDb = await initDb();
      if (currentDb) {
        const expiredCounterPickups = await expireStaleCounterPickups(currentDb);
        console.log(`[Cron] Auto-expired counter pickups: ${expiredCounterPickups.length}`);
        await generateAndSendDailyReport(currentDb);
        console.log("[Cron] Daily report completed successfully.");
      }
    } catch (err) {
      console.error("[Cron] Daily report failed:", err);
    }
  }, {
    timezone: "Pacific/Auckland"
  });

  // Report Configuration Endpoints
  app.get("/api/admin/report-config", authenticate, async (req: any, res) => {
    const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
    const isAdmin = req.user.role === 'Admin' || isSuper;
    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

    try {
      const currentDb = await initDb();
      if (!currentDb) throw new Error("Database not initialized");
      
      const configDoc = await currentDb.collection("settings").doc("report_config").get();
      if (!configDoc.exists) {
        return res.json({
          success: true,
          config: {
            enabled: false,
            toEmails: "",
            ccEmails: "",
            senderName: "Acapickup WMS"
          }
        });
      }
      res.json({ success: true, config: configDoc.data() });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/admin/report-config", authenticate, async (req: any, res) => {
    const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
    const isAdmin = req.user.role === 'Admin' || isSuper;
    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

    try {
      const currentDb = await initDb();
      if (!currentDb) throw new Error("Database not initialized");
      
      const { enabled, toEmails, ccEmails, senderName } = req.body;
      
      await currentDb.collection("settings").doc("report_config").set({
        enabled: !!enabled,
        toEmails: toEmails || "",
        ccEmails: ccEmails || "",
        senderName: senderName || "Acapickup WMS",
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.username
      }, { merge: true });

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Test Report Endpoint
  app.get("/api/admin/test-report", authenticate, async (req: any, res) => {
    const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
    const isAdmin = req.user.role === 'Admin' || isSuper;
    if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

    try {
      const currentDb = await initDb();
      if (!currentDb) throw new Error("Database not initialized");
      
      await expireStaleCounterPickups(currentDb);
      const result = await generateAndSendDailyReport(currentDb);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Orders list endpoint (API-first mode support for CN portal)
  app.get("/api/orders/list", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const warehouseId = (req.query.warehouseId as string) || "";
      const requestedWh = (req.headers['x-warehouse-id'] as string) || "";
      const updatedAfterRaw = (req.query.updatedAfter as string) || "";
      const updatedAfterMs = updatedAfterRaw ? new Date(updatedAfterRaw).getTime() : 0;
      // Keep payload bounded to avoid oversized-response 500s on Cloud Run.
      const limitValue = Math.min(Math.max(Number(req.query.limit) || 1000, 1), 2000);
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const isSales = (req.user.role === 'Sales') || (req.user.roleTemplate === 'Sales');
      const isCnPortal = isCnPortalRequest(req);
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];

      if (!isSuper && !isSales && !allowedWarehouses.includes("*") && warehouseId && !allowedWarehouses.includes(warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }

      const getOrderSortTime = (o: any) => {
        const updated = o?.updatedAt;
        let updatedMs = 0;
        if (updated && typeof updated === 'object' && typeof updated._seconds === 'number') {
          updatedMs = updated._seconds * 1000;
        } else if (typeof updated === 'string') {
          const t = new Date(updated).getTime();
          updatedMs = Number.isFinite(t) ? t : 0;
        }
        if (updatedMs > 0) return updatedMs;
        const created = o?.createdTime ? new Date(o.createdTime).getTime() : 0;
        return Number.isFinite(created) ? created : 0;
      };

      const sortByCreatedDesc = (rows: any[]) =>
        rows.sort((a: any, b: any) => {
          const ta = getOrderSortTime(a);
          const tb = getOrderSortTime(b);
          return tb - ta;
        });

      const fetchByWarehouseEq = async (wh: string) => {
        try {
          const snap = await currentDb.collection("orders")
            .where("warehouseId", "==", wh)
            .orderBy("createdTime", "desc")
            .limit(limitValue)
            .get();
          return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (_e) {
          const snap = await currentDb.collection("orders")
            .where("warehouseId", "==", wh)
            .limit(limitValue)
            .get();
          return sortByCreatedDesc(snap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        }
      };

      const fetchRecentUnassigned = async () => {
        try {
          const snap = await currentDb.collection("orders")
            .where("warehouseId", "==", null)
            .orderBy("updatedAt", "desc")
            .limit(Math.min(limitValue, 1000))
            .get();
          return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (_e) {
          // Fallback for environments where compound ordering/indexes are not ready.
          try {
            const snap = await currentDb.collection("orders")
              .where("warehouseId", "==", null)
              .limit(Math.min(limitValue, 1000))
              .get();
            const rows = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
            return sortByCreatedDesc(rows);
          } catch (_e2) {
            return [];
          }
        }
      };

      const mergeOrdersDedup = (primary: any[], extra: any[]) => {
        const merged = new Map<string, any>();
        [...primary, ...extra].forEach((o: any) => {
          if (o?.id) merged.set(o.id, o);
        });
        return sortByCreatedDesc(Array.from(merged.values())).slice(0, limitValue);
      };

      const fetchByWarehouseIn = async (warehouseList: string[]) => {
        try {
          const snap = await currentDb.collection("orders")
            .where("warehouseId", "in", warehouseList.slice(0, 10))
            .orderBy("createdTime", "desc")
            .limit(limitValue)
            .get();
          return snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        } catch (_e) {
          const snap = await currentDb.collection("orders")
            .where("warehouseId", "in", warehouseList.slice(0, 10))
            .limit(limitValue)
            .get();
          return sortByCreatedDesc(snap.docs.map((d: any) => ({ id: d.id, ...d.data() })));
        }
      };

      // Unassigned orders stay cross-warehouse visible until pickup confirms warehouse.
      const needsAklCompatScan = !warehouseId || warehouseId === "AKL";
      let effectiveWarehouses = isCnPortal
        ? ["AKL", "CHC"]
        : isSuper || isSales || allowedWarehouses.includes("*")
        ? null
        : allowedWarehouses;
      // Compatibility fallback: if user's warehouse permissions are empty,
      // use current selected warehouse from header to avoid empty-list false negatives.
      if (!effectiveWarehouses || effectiveWarehouses.length === 0) {
        effectiveWarehouses = requestedWh ? [requestedWh] : effectiveWarehouses;
      }
      let orders: any[] = [];
      if (needsAklCompatScan) {
        const snap = await currentDb.collection("orders").orderBy("createdTime", "desc").limit(limitValue).get();
        orders = snap.docs
          .map((d: any) => ({ id: d.id, ...d.data() }))
          .filter((o: any) => {
            const wh = o.warehouseId || null;
            if (warehouseId) {
              if (!wh) return true;
              if (isSuper || isSales || allowedWarehouses.includes("*")) return wh === warehouseId;
              return wh === warehouseId && allowedWarehouses.includes(warehouseId);
            }
            if (!wh) return true;
            if (!effectiveWarehouses) return true;
            return effectiveWarehouses.includes(wh);
          });

        // New orders are unassigned by default (warehouseId=null).
        // Always merge recent unassigned orders into the list and de-duplicate.
        orders = mergeOrdersDedup(orders, await fetchRecentUnassigned());
      } else {
        // If no explicit warehouse is provided, aggregate by allowed warehouses.
        if (!warehouseId) {
          if (!effectiveWarehouses || effectiveWarehouses.length === 0) {
            const snap = await currentDb.collection("orders")
              .orderBy("createdTime", "desc")
              .limit(limitValue)
              .get();
            orders = snap.docs.map((d: any) => toListOrder({ id: d.id, ...d.data() }));
          } else if (effectiveWarehouses.length === 1) {
            orders = await fetchByWarehouseEq(effectiveWarehouses[0]);
          } else {
            orders = await fetchByWarehouseIn(effectiveWarehouses);
          }
        } else {
          orders = await fetchByWarehouseEq(warehouseId);
        }
        // New orders are unassigned by default (warehouseId=null).
        // Keep them visible in all warehouse contexts until warehouse is assigned in picking flow.
        orders = mergeOrdersDedup(orders, await fetchRecentUnassigned());
      }
      let normalizedOrders = orders.map(toListOrder);
      if (updatedAfterMs > 0) {
        normalizedOrders = normalizedOrders.filter((o: any) => getOrderSortTime(o) > updatedAfterMs);
      }
      const maxOrderTime = normalizedOrders.reduce((max: number, o: any) => {
        const t = getOrderSortTime(o);
        return t > max ? t : max;
      }, 0);
      return res.json({ success: true, orders: normalizedOrders, maxOrderTime });
    } catch (error: any) {
      console.error("Orders List Error:", error);
      const safeMessage = error?.message || "Unknown server error";
      return res.status(500).json({ success: false, error: safeMessage });
    }
  });

  // Order detail endpoint (API-first mode support for CN portal)
  app.get("/api/orders/detail/:orderId", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const { orderId } = req.params;
      const orderDoc = await currentDb.collection("orders").doc(orderId).get();
      if (!orderDoc.exists) return res.status(404).json({ success: false, error: "Order not found" });

      const order = { id: orderDoc.id, ...orderDoc.data() } as any;
      const orderWarehouse = order.warehouseId || null;
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const isSales = (req.user.role === 'Sales') || (req.user.roleTemplate === 'Sales');
      const isCnPortal = isCnPortalRequest(req);
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];
      if (isCnPortal && orderWarehouse && !["AKL", "CHC"].includes(orderWarehouse)) {
        return res.status(403).json({ success: false, error: "Forbidden: CN portal can only view AKL and CHC warehouse records" });
      }
      if (!isCnPortal && !isSuper && !isSales && orderWarehouse && !allowedWarehouses.includes("*") && !allowedWarehouses.includes(orderWarehouse)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
      }

      return res.json({ success: true, order });
    } catch (error: any) {
      console.error("Order Detail Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Stores list endpoint
  app.get("/api/stores/list", authenticate, async (_req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const snap = await currentDb.collection("stores").get();
      const stores = snap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
      return res.json({ success: true, stores });
    } catch (error: any) {
      console.error("Stores List Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Order logs endpoint
  app.get("/api/logs/order/:orderId", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const { orderId } = req.params;
      const limitValue = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
      const snap = await currentDb.collection("logs")
        .where("orderId", "==", orderId)
        .limit(limitValue)
        .get();
      const logs = snap.docs
        .map((d: any) => ({ id: d.id, ...d.data() }))
        .sort((a: any, b: any) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      return res.json({ success: true, logs });
    } catch (error: any) {
      console.error("Order Logs Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // SKU search endpoint (for edit item search in CN API-only mode)
  app.get("/api/skus/search", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const term = ((req.query.q as string) || "").trim().toUpperCase();
      const limitValue = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
      if (term.length < 2) return res.json({ success: true, skus: [] });

      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const snap = await currentDb.collection("skus")
        .where("sku", ">=", term)
        .where("sku", "<=", term + "\uf8ff")
        .limit(limitValue)
        .get();
      const skus = snap.docs.map((d: any) => {
        const data = d.data();
        return {
          id: d.id,
          ...data,
          location: resolveSkuLocationForWarehouse(data, requestedWh)
        };
      });
      return res.json({ success: true, skus });
    } catch (error: any) {
      console.error("SKU Search Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.get("/api/counter-pickups/list", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      const view = (req.query.view as string) === "history" ? "history" : "active";
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const limitValue = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const isCnPortal = isCnPortalRequest(req);
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];

      let warehouseIds: string[] = [];
      if (requestedWh) {
        warehouseIds = [requestedWh];
      } else if (isCnPortal) {
        warehouseIds = ["AKL", "CHC"];
      } else if (isSuper || allowedWarehouses.includes("*")) {
        const allSnap = await currentDb.collection("counter_pickups")
          .orderBy(view === "history" ? "updatedAt" : "createdAt", "desc")
          .limit(limitValue)
          .get();
        let allRows = allSnap.docs.map((d: any) => buildCounterPickupDetail({ id: d.id, ...d.data() }));
        allRows = allRows.filter((row: any) => view === "history" ? row.status === "Finalized" : row.status !== "Finalized");
        allRows.sort((a: any, b: any) => new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime());
        return res.json({ success: true, requests: allRows.slice(0, limitValue) });
      } else {
        warehouseIds = allowedWarehouses.filter(Boolean).slice(0, 10);
      }

      if (!isCnPortal && !isSuper && !allowedWarehouses.includes("*") && warehouseIds.some((wh) => !allowedWarehouses.includes(wh))) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }

      let rows: any[] = [];
      if (warehouseIds.length === 1) {
        let snap;
        try {
          snap = await currentDb.collection("counter_pickups")
            .where("warehouseId", "==", warehouseIds[0])
            .orderBy(view === "history" ? "updatedAt" : "createdAt", "desc")
            .limit(limitValue)
            .get();
        } catch (queryError: any) {
          if (queryError?.code !== 9 && queryError?.code !== "failed-precondition") throw queryError;
          snap = await currentDb.collection("counter_pickups")
            .where("warehouseId", "==", warehouseIds[0])
            .get();
        }
        rows = snap.docs.map((d: any) => buildCounterPickupDetail({ id: d.id, ...d.data() }));
      } else if (warehouseIds.length > 1) {
        let snap;
        try {
          snap = await currentDb.collection("counter_pickups")
            .where("warehouseId", "in", warehouseIds)
            .orderBy(view === "history" ? "updatedAt" : "createdAt", "desc")
            .limit(limitValue)
            .get();
        } catch (queryError: any) {
          if (queryError?.code !== 9 && queryError?.code !== "failed-precondition") throw queryError;
          snap = await currentDb.collection("counter_pickups")
            .where("warehouseId", "in", warehouseIds)
            .get();
        }
        rows = snap.docs.map((d: any) => buildCounterPickupDetail({ id: d.id, ...d.data() }));
      }

      rows = rows.filter((row: any) => view === "history" ? row.status === "Finalized" : row.status !== "Finalized");
      rows.sort((a: any, b: any) => {
        const sortA = view === "history" ? a.updatedAt : a.createdAt;
        const sortB = view === "history" ? b.updatedAt : b.createdAt;
        return new Date(sortB).getTime() - new Date(sortA).getTime();
      });
      return res.json({ success: true, requests: rows.slice(0, limitValue) });
    } catch (error: any) {
      console.error("Counter Pickup List Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/counter-pickups/create", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      if (!isFrontDeskRole(req.user)) {
        return res.status(403).json({ success: false, error: "Forbidden: Reception access required" });
      }

      const rawSku = String(req.body?.sku || "").trim().toUpperCase();
      const qty = Number(req.body?.qty || 0);
      const manualProductName = String(req.body?.productName || "").trim();
      const manualLocation = String(req.body?.location || "").trim().toUpperCase();
      const comment = String(req.body?.comment || "").trim();
      const pickupNote = String(req.body?.pickupNote || req.body?.note || "").trim();
      const requestType = normalizeCounterPickupRequestType(req.body?.requestType);
      const sourceType = normalizeCounterPickupSourceType(req.body?.sourceType);
      const incomingItems = Array.isArray(req.body?.items) ? req.body.items : [];
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const warehouseId = requestedWh || (req.user.allowedWarehouses || [])[0] || "";

      if (!warehouseId) return res.status(400).json({ success: false, error: "Warehouse is required" });
      const normalizedItems = incomingItems.length > 0
        ? incomingItems
        : (rawSku ? [{ sku: rawSku, qty, productName: manualProductName, location: manualLocation }] : []);

      if (normalizedItems.length === 0) return res.status(400).json({ success: false, error: "At least one item is required" });

      const resolvedItems: Array<{ sku: string; qty: number; productName: string; location: string; }> = [];
      for (const item of normalizedItems) {
        const itemSku = String(item?.sku || "").trim().toUpperCase();
        const itemQty = Number(item?.qty || 0);
        const itemManualProductName = String(item?.productName || "").trim();
        const itemManualLocation = String(item?.location || "").trim().toUpperCase();
        if (!itemSku) return res.status(400).json({ success: false, error: "SKU is required" });
        if (!Number.isInteger(itemQty) || itemQty <= 0) return res.status(400).json({ success: false, error: "Quantity must be a positive integer" });
        const skuSnap = await currentDb.collection("skus").where("sku", "==", itemSku).limit(1).get();
        const skuData = skuSnap.empty ? null : skuSnap.docs[0].data() as any;
        const resolvedProductName = skuData?.productName || itemManualProductName || itemSku;
        const skuLocation = skuData ? resolveSkuLocationForWarehouse(skuData, warehouseId) : "";
        const resolvedLocation = skuLocation && skuLocation !== "N/A"
          ? skuLocation
          : (itemManualLocation || "NOT_ASSIGNED");
        if (!resolvedProductName) {
          return res.status(400).json({ success: false, error: "Product name is required for unmatched or special SKU" });
        }
        resolvedItems.push({
          sku: itemSku,
          qty: itemQty,
          productName: resolvedProductName,
          location: resolvedLocation
        });
      }

      const counterPickupId = await getNextCounterPickupId(currentDb);
      const timestamp = nowAucklandIso();
      const primaryItem = resolvedItems[0];
      const payload = {
        id: counterPickupId,
        sku: primaryItem.sku,
        productName: primaryItem.productName,
        location: primaryItem.location,
        qty: resolvedItems.reduce((sum: number, item: any) => sum + Number(item.qty || 0), 0),
        warehouseId,
        requestType,
        sourceType,
        items: resolvedItems,
        status: "PendingPick",
        queueStatus: "Pending",
        destination: null,
        outcome: null,
        orderNumber: null,
        referenceNo: null,
        otherNotes: null,
        comment: comment || null,
        pickupNote: pickupNote || null,
        createdBy: req.user.name || req.user.username,
        createdByUid: req.user.uid,
        pickedBy: null,
        pickedAt: null,
        finalizedBy: null,
        finalizedAt: null,
        expiredBySystem: false,
        expiredReason: null,
        completedAt: null,
        completedBy: null,
        createdAt: timestamp,
        updatedAt: timestamp
      };

      await currentDb.collection("counter_pickups").doc(counterPickupId).set(payload);
      await writeCounterPickupLog(
        currentDb,
        counterPickupId,
        req.user.name || req.user.username,
        "CP_CREATED",
        `Counter pickup created for ${resolvedItems.length} item(s), total qty ${payload.qty}, warehouse ${warehouseId}.`,
        req.user
      );

      return res.json({ success: true, request: payload });
    } catch (error: any) {
      console.error("Counter Pickup Create Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/counter-pickups/:id/start-picking", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      if (!isWarehouseRole(req.user) && !hasPermission(req.user, "Manage Picking")) {
        return res.status(403).json({ success: false, error: "Forbidden: Warehouse access required" });
      }

      const docRef = currentDb.collection("counter_pickups").doc(req.params.id);
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Counter pickup not found" });

      const data = snap.data() as any;
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];
      if (data.warehouseId && requestedWh && data.warehouseId !== requestedWh) {
        return res.status(403).json({ success: false, error: "Forbidden: Counter pickup belongs to a different warehouse" });
      }
      if (!isSuper && data.warehouseId && !allowedWarehouses.includes("*") && !allowedWarehouses.includes(data.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }
      if (data.status !== "PendingPick" || data.queueStatus !== "Pending") {
        return res.status(409).json({ success: false, error: "Counter pickup is not in Pending queue state" });
      }

      const timestamp = nowAucklandIso();
      await docRef.set({
        queueStatus: "Picking",
        pickedBy: req.user.name || req.user.username,
        updatedAt: timestamp
      }, { merge: true });

      await writeCounterPickupLog(
        currentDb,
        req.params.id,
        req.user.name || req.user.username,
        "CP_PICKING_STARTED",
        `Warehouse started picking counter pickup ${req.params.id}.`,
        req.user
      );

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Counter Pickup Start Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/counter-pickups/:id/mark-picked", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      if (!isWarehouseRole(req.user) && !hasPermission(req.user, "Manage Picking")) {
        return res.status(403).json({ success: false, error: "Forbidden: Warehouse access required" });
      }

      const docRef = currentDb.collection("counter_pickups").doc(req.params.id);
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Counter pickup not found" });

      const data = snap.data() as any;
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];
      if (data.warehouseId && requestedWh && data.warehouseId !== requestedWh) {
        return res.status(403).json({ success: false, error: "Forbidden: Counter pickup belongs to a different warehouse" });
      }
      if (!isSuper && data.warehouseId && !allowedWarehouses.includes("*") && !allowedWarehouses.includes(data.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }
      if (data.status !== "PendingPick") {
        return res.status(409).json({ success: false, error: "Only PendingPick requests can be marked as picked" });
      }

      const timestamp = nowAucklandIso();
      await docRef.set({
        status: "Picked",
        queueStatus: "Picked",
        pickedAt: timestamp,
        pickedBy: req.user.name || req.user.username,
        updatedAt: timestamp
      }, { merge: true });

      await writeCounterPickupLog(
        currentDb,
        req.params.id,
        req.user.name || req.user.username,
        "CP_PICKED",
        `Warehouse delivered SKU ${data.sku} to reception.`,
        req.user
      );

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Counter Pickup Mark Picked Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/counter-pickups/:id/finalize", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      if (!isFrontDeskRole(req.user)) {
        return res.status(403).json({ success: false, error: "Forbidden: Reception access required" });
      }

      const defaultOutcome = normalizeCounterPickupOutcome(req.body?.outcome || req.body?.destination || req.body?.defaultOutcome || "");
      const otherNotes = String(req.body?.otherNotes || req.body?.comment || "").trim();
      const comment = String(req.body?.comment || req.body?.otherNotes || "").trim();
      const itemActions = Array.isArray(req.body?.itemActions) ? req.body.itemActions : [];
      const docRef = currentDb.collection("counter_pickups").doc(req.params.id);
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Counter pickup not found" });

      const data = snap.data() as any;
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];
      if (data.warehouseId && requestedWh && data.warehouseId !== requestedWh) {
        return res.status(403).json({ success: false, error: "Forbidden: Counter pickup belongs to a different warehouse" });
      }
      if (!isSuper && data.warehouseId && !allowedWarehouses.includes("*") && !allowedWarehouses.includes(data.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }
      if (data.status !== "Picked") {
        return res.status(409).json({ success: false, error: "Only Picked requests can be finalized by reception" });
      }

      const timestamp = nowAucklandIso();
      const sourceType = normalizeCounterPickupSourceType(req.body?.sourceType || data.sourceType);
      const requestType = normalizeCounterPickupRequestType(req.body?.requestType || data.requestType);
      const referenceNo = normalizeCounterPickupOrderNumber(sourceType, req.body?.orderNumber || req.body?.referenceNo || "");
      const baseItems = Array.isArray(data.items) && data.items.length > 0
        ? data.items
        : [{ sku: data.sku, productName: data.productName, location: data.location, qty: data.qty }];

      const normalizedActions = baseItems.map((item: any, index: number) => {
        const raw = itemActions[index] || {};
        const itemOutcome = normalizeCounterPickupOutcome(raw.outcome || raw.destination || defaultOutcome);
        const itemOrderNumber = normalizeCounterPickupOrderNumber(sourceType, raw.orderNumber || raw.referenceNo || referenceNo || "");
        const itemComment = String(raw.comment || raw.otherNotes || comment || otherNotes || "").trim();
        return {
          outcome: itemOutcome,
          orderNumber: itemOrderNumber,
          comment: itemComment
        };
      });

      if (normalizedActions.some((item: any) => !item.outcome)) {
        return res.status(400).json({ success: false, error: "Invalid outcome" });
      }

      const allSold = normalizedActions.every((item: any) => item.outcome === "sold");
      const allOther = normalizedActions.every((item: any) => item.outcome === "other");
      const allReturned = normalizedActions.every((item: any) => item.outcome === "returnedToWarehouse");
      const allWarranty = normalizedActions.every((item: any) => item.outcome === "warrantySwapParts");
      const anyReturned = normalizedActions.some((item: any) => item.outcome === "returnedToWarehouse");
      const topLevelOutcome = allSold ? "sold" : allReturned ? "returnedToWarehouse" : allWarranty ? "warrantySwapParts" : allOther ? "other" : "Mixed";

      const normalizeDisplayDestination = (outcome: string) => {
        if (outcome === "returnedToWarehouse") return "Returned";
        if (outcome === "sold") return "Sold";
        if (outcome === "warrantySwapParts") return "Warranty / Swap / Parts";
        if (outcome === "other") return "Other";
        return "Mixed";
      };

      const updatePayload: any = {
        sourceType,
        requestType,
        outcome: topLevelOutcome,
        destination: normalizeDisplayDestination(topLevelOutcome),
        comment: comment || null,
        updatedAt: timestamp
      };

      const updatedItems = baseItems.map((item: any, index: number) => {
        const itemAction = normalizedActions[index];
        const itemUpdate: any = {
          ...item,
          requestType,
          outcome: itemAction.outcome,
          destination: normalizeDisplayDestination(itemAction.outcome),
          orderNumber: itemAction.orderNumber || null,
          comment: itemAction.comment || null
        };

        if (itemAction.outcome === "returnedToWarehouse") {
          itemUpdate.status = "PendingPutback";
          itemUpdate.finalizedAt = null;
          itemUpdate.finalizedBy = null;
          itemUpdate.completedAt = null;
          itemUpdate.completedBy = null;
          itemUpdate.comment = itemAction.comment || comment || null;
        } else if (itemAction.outcome === "sold") {
          if (!itemAction.orderNumber) {
            throw new Error("Order Number is required when outcome is Sold");
          }
          itemUpdate.comment = itemAction.comment || comment || null;
          itemUpdate.finalizedAt = timestamp;
          itemUpdate.finalizedBy = req.user.name || req.user.username;
          itemUpdate.completedAt = timestamp;
          itemUpdate.completedBy = req.user.name || req.user.username;
        } else if (itemAction.outcome === "warrantySwapParts") {
          if (!itemAction.orderNumber) {
            throw new Error("Order Number is required when outcome is Warranty / Swap / Parts");
          }
          if (itemAction.comment.length < 5) {
            throw new Error("Comment must be at least 5 characters when outcome is Warranty / Swap / Parts");
          }
          itemUpdate.comment = itemAction.comment;
          itemUpdate.finalizedAt = timestamp;
          itemUpdate.finalizedBy = req.user.name || req.user.username;
          itemUpdate.completedAt = timestamp;
          itemUpdate.completedBy = req.user.name || req.user.username;
        } else if (itemAction.outcome === "other") {
          if (itemAction.comment.length < 5) {
            throw new Error("Comment must be at least 5 characters when outcome is Other");
          }
          itemUpdate.comment = itemAction.comment;
          itemUpdate.finalizedAt = timestamp;
          itemUpdate.finalizedBy = req.user.name || req.user.username;
          itemUpdate.completedAt = timestamp;
          itemUpdate.completedBy = req.user.name || req.user.username;
        } else {
          throw new Error("Invalid outcome");
        }

        return itemUpdate;
      });

      const anyPendingPutback = updatedItems.some((item: any) => item.outcome === "returnedToWarehouse");
      if (anyPendingPutback) {
        updatePayload.status = "PendingPutback";
        updatePayload.otherNotes = null;
        updatePayload.referenceNo = null;
        updatePayload.orderNumber = null;
        updatePayload.putbackItems = updatedItems.filter((item: any) => item.outcome === "returnedToWarehouse");
        updatePayload.putbackQty = updatePayload.putbackItems.reduce((sum: number, item: any) => sum + Number(item.qty || 0), 0);
      } else {
        updatePayload.status = "Finalized";
        updatePayload.putbackItems = [];
        updatePayload.putbackQty = 0;
      }
      updatePayload.items = updatedItems;

      if (allSold) {
        updatePayload.orderNumber = normalizeCounterPickupOrderNumber(sourceType, referenceNo || updatedItems[0]?.orderNumber || null) || null;
        if (!updatePayload.orderNumber) {
          return res.status(400).json({ success: false, error: "Order Number is required when outcome is Sold" });
        }
      }
      if (allOther) {
        updatePayload.comment = otherNotes || updatedItems[0]?.comment || null;
        if (!updatePayload.comment || String(updatePayload.comment).length < 5) {
          return res.status(400).json({ success: false, error: "Comment must be at least 5 characters when outcome is Other" });
        }
      }

      if (normalizedActions.length === 1) {
        const onlyAction = normalizedActions[0];
        if (onlyAction.outcome === "returnedToWarehouse") {
          await writeCounterPickupLog(currentDb, req.params.id, req.user.name || req.user.username, "CP_RETURN_INIT", `Reception requested putback for SKU ${data.sku}, qty ${data.qty}.`, req.user);
        } else if (onlyAction.outcome === "sold") {
          await writeCounterPickupLog(currentDb, req.params.id, req.user.name || req.user.username, "CP_FINALIZE_SOLD", `Reception finalized counter pickup as Sold. Order Number: ${onlyAction.orderNumber || referenceNo}.`, req.user);
        } else if (onlyAction.outcome === "warrantySwapParts") {
          await writeCounterPickupLog(currentDb, req.params.id, req.user.name || req.user.username, "CP_FINALIZE_WARRANTY", `Reception finalized counter pickup as Warranty / Swap / Parts. Order Number: ${onlyAction.orderNumber || referenceNo}. Comment: ${onlyAction.comment || comment}.`, req.user);
        } else {
          await writeCounterPickupLog(currentDb, req.params.id, req.user.name || req.user.username, "CP_FINALIZE_OTHER", `Reception finalized counter pickup as Other. Comment: ${onlyAction.comment || otherNotes}.`, req.user);
        }
      } else {
        await writeCounterPickupLog(
          currentDb,
          req.params.id,
          req.user.name || req.user.username,
          anyPendingPutback ? "CP_RETURN_INIT" : "CP_FINALIZE_MIXED",
          `Reception finalized counter pickup with mixed item actions: ${normalizedActions.map((item: any, index: number) => `${baseItems[index]?.sku || index}:${item.outcome}`).join(', ')}.`,
          req.user
        );
      }

      await docRef.set(updatePayload, { merge: true });

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Counter Pickup Finalize Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/counter-pickups/:id/complete-putback", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) return res.status(503).json({ success: false, error: "Database not initialized" });

    try {
      if (!isWarehouseRole(req.user) && !hasPermission(req.user, "Manage Picking")) {
        return res.status(403).json({ success: false, error: "Forbidden: Warehouse access required" });
      }

      const docRef = currentDb.collection("counter_pickups").doc(req.params.id);
      const snap = await docRef.get();
      if (!snap.exists) return res.status(404).json({ success: false, error: "Counter pickup not found" });

      const data = snap.data() as any;
      const requestedWh = (req.headers["x-warehouse-id"] as string) || "";
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const allowedWarehouses: string[] = req.user.allowedWarehouses || [];
      if (data.warehouseId && requestedWh && data.warehouseId !== requestedWh) {
        return res.status(403).json({ success: false, error: "Forbidden: Putback task belongs to a different warehouse" });
      }
      if (!isSuper && data.warehouseId && !allowedWarehouses.includes("*") && !allowedWarehouses.includes(data.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: You do not have access to this warehouse" });
      }
      if (data.status !== "PendingPutback") {
        return res.status(409).json({ success: false, error: "Only PendingPutback requests can be completed" });
      }

      const timestamp = nowAucklandIso();
      await docRef.set({
        status: "Finalized",
        finalizedAt: timestamp,
        finalizedBy: req.user.name || req.user.username,
        completedAt: timestamp,
        completedBy: req.user.name || req.user.username,
        updatedAt: timestamp
      }, { merge: true });

      await writeCounterPickupLog(
        currentDb,
        req.params.id,
        req.user.name || req.user.username,
        "CP_PUTBACK_COMPLETED",
        `Warehouse completed putback for SKU ${data.sku}, qty ${data.qty}, location ${data.location}.`,
        req.user
      );

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Counter Pickup Putback Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  const server = http.createServer(app);
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });
  const PORT = Number(process.env.PORT) || 3000;

  // Get new Firebase Custom Token using existing JWT
  app.get("/api/auth/firebase-token", authenticate, async (req: any, res) => {
    try {
      const currentDb = await initDb();
      if (!currentDb) throw new Error("Database not initialized");

      const userDoc = await currentDb.collection('users').doc(req.user.uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: "User not found" });
      }
      const userData = userDoc.data()!;

      const isSuper = isSuperAdmin(userData.username || userDoc.id);
      const role = isSuper ? 'Admin' : (userData.roleTemplate || 'User');

      let firebaseCustomToken = null;
      try {
        console.log(`[TokenRefresh] Attempting to generate Firebase Custom Token for UID: ${userDoc.id}`);
        firebaseCustomToken = await admin.auth().createCustomToken(userDoc.id, {
          email: userData.email || userData.username || userDoc.id,
          email_verified: true,
          role: role,
          permissions: userData.permissions || [],
          allowedWarehouses: isSuper ? ['*'] : (userData.allowedWarehouses || [])
        });
        console.log(`[TokenRefresh] Firebase Custom Token generated successfully`);
      } catch (e: any) {
        console.error('[TokenRefresh] ❌ Failed to create Firebase custom token with claims:', e.message || e);
        
        // Fallback: Try without claims
        try {
          console.log(`[TokenRefresh] Retrying Firebase Custom Token without claims for UID: ${userDoc.id}`);
          firebaseCustomToken = await admin.auth().createCustomToken(userDoc.id);
          console.log(`[TokenRefresh] Firebase Custom Token generated successfully (without claims)`);
        } catch (e2: any) {
          console.error('[TokenRefresh] ❌ Failed to create Firebase custom token even without claims:', e2.message || e2);
          return res.status(500).json({ success: false, error: "Failed to generate Firebase token: " + (e2.message || e2) });
        }
      }

      res.json({ success: true, firebaseCustomToken });
    } catch (error: any) {
      console.error("Firebase Token Refresh Error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Login Endpoint
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: "Username and password required" });
    }

    try {
      const currentDb = await initDb();
      if (!currentDb) throw new Error("Database not initialized");
      const result = await loginUser(currentDb, { username, password });
      res.json({
        success: true,
        ...result
      });
    } catch (error: any) {
      console.error("Login Error:", error);
      res.status(401).json({ success: false, error: error.message });
    }
  });

  // Helper function to send order notification with checks
  const sendOrderNotification = async (currentDb: admin.firestore.Firestore, orderId: string, type: string, user: any, requestedWh?: string) => {
    try {
      // 1. Fetch order
      const orderDoc = await currentDb.collection("orders").doc(orderId).get();
      if (!orderDoc.exists) throw new Error("Order not found");
      const order = orderDoc.data();

      // 2. Data Isolation Check
      const allowedWarehouses = user.allowedWarehouses || [];
      const isSuper = SUPER_ADMINS.includes(user.username.toLowerCase());

      const orderWarehouse = order?.warehouseId || requestedWh || null;
      if (!isSuper) {
        // Must have access to the order's warehouse
        if (!allowedWarehouses.includes('*') && orderWarehouse && !allowedWarehouses.includes(orderWarehouse)) {
          throw new Error("Forbidden: You do not have access to this warehouse");
        }
        // If a specific warehouse was selected in the session, it must match the order's warehouse
        if (requestedWh && orderWarehouse && orderWarehouse !== requestedWh) {
          throw new Error("Forbidden: Order belongs to a different warehouse than selected");
        }
      }

      // 3. 24-hour check
      const now = new Date().getTime();
      const twentyFourHours = 24 * 60 * 60 * 1000;
      if (order?.emailStatus === 'sent' && order?.lastEmailSentAt) {
        const lastSent = new Date(order.lastEmailSentAt).getTime();
        if ((now - lastSent) <= twentyFourHours) {
          return { success: true, emailStatus: 'skipped', message: "Already sent in last 24h" };
        }
      }

      // 4. Fetch store
      const storeDoc = await currentDb.collection("stores").doc(order?.storeId || order?.storeName).get();
      const storeData = storeDoc.exists ? storeDoc.data() : null;

      // 5. Store disable check
      if (storeData?.disableEmail === true) {
        await currentDb.collection("orders").doc(orderId).update({
          emailStatus: 'skipped',
          lastEmailSentAt: new Date().toISOString(),
          lastEmailError: "Store email sending disabled"
        });
        return { success: true, emailStatus: 'skipped', message: "Email sending disabled for this store" };
      }

      if (!order?.customerEmail) {
        throw new Error("Order has no customer email");
      }

      // 6. Send email
      await sendEmail({
        to: order.customerEmail,
        storeId: order.storeId || order.storeName,
        storeName: storeData?.name || order.storeName,
        senderEmail: storeData?.senderEmail,
        subject: storeData?.template?.subject || "Order Notification",
        body: storeData?.template?.body || "Your order status is {{status}}",
        context: { 
          ...order, 
          status: order.status,
          customerName: order.customerName,
          bookingNumber: order.bookingNumber || order.id,
          pickupDate: order.pickupDateScheduled,
          customer_name: order.customerName,
          booking_number: order.bookingNumber || order.id,
          store_name: storeData?.name || order.storeName || "Our Store",
          warehouse_address: "15 COPSEY PLACE, AVONDALE, AUCKLAND",
          pickup_hours: "Mon-Fri 10am-5pm"
        }
      });

      // 7. Update order on success
      await currentDb.collection("orders").doc(orderId).update({
        [`emailLog.${type}`]: new Date().toISOString(),
        emailStatus: 'sent',
        lastEmailSentAt: new Date().toISOString(),
        lastEmailError: null
      });

      return { success: true, message: "Notification sent", emailStatus: 'sent' };
    } catch (error: any) {
      console.error(`Error processing email for order ${orderId}:`, error);
      // Update order on failure
      await currentDb.collection("orders").doc(orderId).update({
        emailStatus: 'failed',
        lastEmailAttemptAt: new Date().toISOString(),
        lastEmailError: error.message
      });
      throw error;
    }
  };

  // Order Notification Endpoint
  app.post("/api/orders/send-notification", authenticate, async (req: any, res) => {
    console.log(`📧 [API] Entering send-notification. User: ${req.user?.username}, Order: ${req.body?.orderId}`);
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, type = 'pickup_notification' } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: "Missing orderId" });
      }

      const result = await sendOrderNotification(currentDb, orderId, type, req.user, req.selectedWarehouse);
      return res.json(result);
    } catch (error: any) {
      const stack = error.stack || error;
      console.log("🔥 [SERVER ERROR] send-notification:");
      console.trace(error);
      writeDebugLog(`ERROR send-notification: ${stack}`);
      return res.status(500).json({ success: false, error: error.message, stack: stack });
    }
  });

  // Bulk Order Notification Endpoint
  app.post("/api/orders/bulk-send-notification", authenticate, async (req: any, res) => {
    console.log(`📧 [API] Entering bulk-send-notification. User: ${req.user?.username}, Orders count: ${req.body?.orderIds?.length}`);
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderIds, type = 'pickup_notification' } = req.body;
      if (!orderIds || !Array.isArray(orderIds)) {
        return res.status(400).json({ success: false, error: "Missing or invalid orderIds" });
      }

      const results = [];
      for (const orderId of orderIds) {
        try {
          const result = await sendOrderNotification(currentDb, orderId, type, req.user, req.selectedWarehouse);
          results.push({ orderId, ...result });
        } catch (error: any) {
          results.push({ orderId, success: false, error: error.message, emailStatus: 'failed' });
        }
        // Add a small delay between sends to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      return res.json({ success: true, message: `${results.filter(r => r.emailStatus === 'sent').length} notifications sent, ${results.filter(r => r.emailStatus === 'skipped').length} skipped, ${results.filter(r => r.emailStatus === 'failed').length} failed`, results });
    } catch (error: any) {
      const stack = error.stack || error;
      console.log("🔥 [SERVER ERROR] bulk-send-notification:");
      console.trace(error);
      writeDebugLog(`ERROR bulk-send-notification: ${stack}`);
      return res.status(500).json({ success: false, error: error.message, stack: stack });
    }
  });

  // Create Order Endpoint
  app.post("/api/orders/create", authenticate, async (req: any, res) => {
    console.log("🚀 [API Request]: POST /api/orders/create");
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      console.log("📦 [Incoming Order Data]:", JSON.stringify(req.body, null, 2));
      const { 
        bookingNumber, 
        refNumber, 
        customerName, 
        customerEmail, 
        customerId, 
        storeId, 
        warehouseId, 
        pickupDateScheduled, 
        notes, 
        items, 
        totalAmount,
        paymentStatus, 
        paymentMethod,
        notificationRecipients 
      } = req.body;
      const effectiveWarehouseId = warehouseId || null;

      if (!bookingNumber || typeof bookingNumber !== 'string' || !customerName) {
        return res.status(400).json({ success: false, error: "Missing required fields or invalid Booking Number." });
      }

      // Check for global uniqueness of bookingNumber
      const bKeyRef = currentDb.collection("unique_keys").doc(`bn_${bookingNumber}`);
      const rKeyRef = refNumber ? currentDb.collection("unique_keys").doc(`ref_${refNumber}`) : null;

      try {
        await currentDb.runTransaction(async (transaction) => {
          const bSnap = await transaction.get(bKeyRef);
          if (bSnap.exists) {
            throw new Error(`Booking Number [${bookingNumber}] already exists.`);
          }

          if (rKeyRef) {
            const rSnap = await transaction.get(rKeyRef);
            if (rSnap.exists) {
              throw new Error(`Customer Reference [${refNumber}] already exists.`);
            }
          }

          // Also check if order document exists (just in case)
          const orderDoc = await transaction.get(currentDb.collection("orders").doc(bookingNumber));
          if (orderDoc.exists) {
            throw new Error(`Order document [${bookingNumber}] already exists.`);
          }

          // Calculate totalAmount if not provided or to ensure accuracy
          const calculatedTotal = (items || []).reduce((sum: number, item: any) => sum + ((item.qty || 0) * (item.unit_price || 0)), 0);

          const orderData = {
            bookingNumber,
            refNumber: refNumber || null,
            customerName,
            customerEmail: customerEmail || null,
            customerId: customerId || null,
            storeId: storeId || null,
            warehouseId: effectiveWarehouseId,
            pickupDateScheduled: pickupDateScheduled || null,
            notes: notes || null,
            createdBy: req.user.name || req.user.username,
            creatorEmail: req.user.username,
            creatorUid: req.user.uid,
            createdTime: new Date().toISOString(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            items: items || [],
            totalAmount: totalAmount !== undefined ? totalAmount : calculatedTotal,
            paymentStatus,
            paymentMethod: paymentMethod || "Not Specified",
            paymentTime: paymentStatus === 'Paid' ? new Date().toISOString() : null,
            paymentBy: paymentStatus === 'Paid' ? (req.user.name || req.user.username) : null,
            status: 'Created',
            statusUpdatedAt: new Date().toISOString(),
            notificationRecipients: notificationRecipients || []
          };

          // Set unique keys and order
          transaction.set(bKeyRef, { createdAt: admin.firestore.FieldValue.serverTimestamp(), bookingNumber });
          if (rKeyRef) {
            transaction.set(rKeyRef, { createdAt: admin.firestore.FieldValue.serverTimestamp(), refNumber });
          }
          transaction.set(currentDb.collection("orders").doc(bookingNumber), orderData);
        });
      } catch (txError: any) {
        console.error("🔥 Transaction Error:", txError);
        return res.status(409).json({ 
          success: false, 
          error: txError.message || "Failed to create order due to uniqueness constraint."
        });
      }

      // Log the action
      try {
        await currentDb.collection("logs").add({
          timestamp: new Date().toISOString(),
          userId: req.user.uid,
          userName: req.user.name || req.user.username,
          action: 'Order Created',
          details: `Created order ${bookingNumber}`,
          orderId: bookingNumber
        });
      } catch (logErr) {
        console.error("Failed to log order creation:", logErr);
      }

      // Handle Notifications
      if (notificationRecipients && Array.isArray(notificationRecipients) && notificationRecipients.length > 0) {
        try {
          const uids = new Set<string>();
          const groupIds: string[] = [];
          const individualUids: string[] = [];

          notificationRecipients.forEach((id: string) => {
            if (id.startsWith('group:')) {
              groupIds.push(id.replace('group:', ''));
            } else {
              individualUids.push(id);
            }
          });

          individualUids.forEach(uid => uids.add(uid));

          if (groupIds.length > 0) {
            const groupsSnap = await currentDb.collection("userGroups").get();
            groupsSnap.docs.forEach(doc => {
              if (groupIds.includes(doc.id)) {
                const groupData = doc.data();
                (groupData.userIds || []).forEach((uid: string) => uids.add(uid));
              }
            });
          }

          const resolvedUids = Array.from(uids);
          const notificationPromises = resolvedUids.map(uid => {
            return currentDb.collection("notifications").add({
              recipientUid: uid,
              title: 'New Order Created',
              body: `Order ${bookingNumber} has been created.`,
              type: 'New Order',
              orderId: bookingNumber,
              isRead: false,
              createdAt: new Date().toISOString()
            });
          });
          await Promise.all(notificationPromises);
        } catch (notifErr) {
          console.error("Failed to create notifications:", notifErr);
        }
      }

      console.log(`Order ${bookingNumber} created by ${req.user.username}`);

      return res.json({ 
        success: true, 
        orderId: bookingNumber,
        id: bookingNumber,
        bookingNumber: bookingNumber
      });
    } catch (error: any) {
      console.log("❌ [Firestore Write Error Detail]:", error); 
      if (error.stack) console.log("📜 [Error Stack]:", error.stack);
      return res.status(500).json({ 
        success: false, 
        error: error.message,
        code: error.code,
        stack: error.stack
      });
    }
  });

  // Update Order Endpoint
  app.post("/api/orders/update", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, updateData } = req.body;
      if (!orderId || !updateData) {
        return res.status(400).json({ success: false, error: "Missing orderId or updateData" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data();
      const requestedWh = (req.headers['x-warehouse-id'] as string) || '';
      const orderWarehouse = order?.warehouseId || requestedWh || null;
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];

      // Data Isolation Check
      if (!isSuper) {
        if (!orderWarehouse) {
          return res.status(403).json({ success: false, error: "Forbidden: Missing warehouse context" });
        }
        if (!allowedWarehouses.includes('*') && !allowedWarehouses.includes(orderWarehouse)) {
          return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
        }
      }

      // Guard: partial-pickup exception orders can only be transitioned to Picked Up
      // by users who have explicit permission.
      if (updateData.status === 'Picked Up' && order?.pickupExceptionStatus && !hasPermission(req.user, 'Finalize Partial Pickup')) {
        return res.status(403).json({
          success: false,
          error: "Forbidden: Finalize Partial Pickup permission required for exception orders"
        });
      }

      const enrichedUpdateData: any = { ...updateData };
      // Late-binding warehouse: keep orders unassigned at creation/email stage,
      // but bind warehouse once picking is explicitly requested/started.
      const isPickingFlowTouch =
        typeof enrichedUpdateData.warehouseStatus !== 'undefined' ||
        typeof enrichedUpdateData['pickingLog.requestedAt'] !== 'undefined' ||
        typeof enrichedUpdateData['pickingLog.startedAt'] !== 'undefined' ||
        typeof enrichedUpdateData['pickingLog.finishedAt'] !== 'undefined';
      if (!order?.warehouseId && requestedWh && isPickingFlowTouch) {
        enrichedUpdateData.warehouseId = requestedWh;
      }

      // Atomic lock/ownership checks for picking flow.
      if (enrichedUpdateData.warehouseStatus === 'Picking' || enrichedUpdateData.warehouseStatus === 'Picked') {
        await currentDb.runTransaction(async (tx) => {
          const snap = await tx.get(orderRef);
          if (!snap.exists) throw new Error("Order not found");
          const latest = snap.data() as any;
          const currentStatus = latest?.warehouseStatus || 'Pending';
          const currentPickerId = latest?.pickingLog?.pickerId || null;

          if (enrichedUpdateData.warehouseStatus === 'Picking') {
            if (currentStatus !== 'Pending') {
              throw new Error("Order is already being handled by another picker");
            }
            enrichedUpdateData['pickingLog.startedAt'] = enrichedUpdateData['pickingLog.startedAt'] || new Date().toISOString();
            enrichedUpdateData['pickingLog.pickerId'] = req.user.uid;
            enrichedUpdateData['pickingLog.pickerName'] = req.user.name || req.user.username;
          }

          if (enrichedUpdateData.warehouseStatus === 'Picked') {
            if (currentPickerId && currentPickerId !== req.user.uid) {
              throw new Error("Only the picker who started this order can complete it");
            }
            const items = latest?.items || [];
            const allPicked = items.length > 0 && items.every((i: any) => i.status === 'Picked');
            if (!allPicked) {
              throw new Error("All items must be picked before completing order");
            }
          }

          tx.update(orderRef, {
            ...enrichedUpdateData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: req.user.username
          });
        });
      } else {
        await orderRef.update({
          ...enrichedUpdateData,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: req.user.username
        });
      }

      // Build readable field-level change summary for operation logs.
      const prettyName: Record<string, string> = {
        status: 'Order Status',
        warehouseStatus: 'Warehouse Status',
        warehouseId: 'Warehouse',
        notes: 'Notes',
        paymentStatus: 'Payment Status',
        paymentMethod: 'Payment Method',
        customerEmail: 'Customer Email',
        customerName: 'Customer Name',
        pickupDateScheduled: 'Scheduled Pickup Date'
      };
      const ignoredKeys = new Set([
        'id',
        'updatedAt',
        'updatedBy',
        'createdTime',
        'pickingLog.requestedAt',
        'pickingLog.startedAt',
        'pickingLog.finishedAt',
        'pickingLog.pickerName',
        'pickingLog.pickerId'
      ]);
      const toText = (v: any) => {
        if (typeof v === 'undefined' || v === null || v === '') return '(none)';
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      };
      const normalizedItems = (arr: any[]) =>
        (Array.isArray(arr) ? arr : []).map((it: any) => ({
          sku: it?.sku || '',
          qty: Number(it?.qty || 0),
          unit_price: Number(it?.unit_price || 0),
          location: it?.location || '',
          status: it?.status || ''
        }));
      const stable = (obj: any): any => {
        if (Array.isArray(obj)) return obj.map(stable);
        if (!obj || typeof obj !== 'object') return obj;
        return Object.keys(obj).sort().reduce((acc: any, k: string) => {
          acc[k] = stable(obj[k]);
          return acc;
        }, {});
      };
      const changeLines: string[] = [];
      Object.keys(enrichedUpdateData || {}).forEach((k) => {
        if (ignoredKeys.has(k)) return;
        let beforeValue = (order as any)?.[k];
        let afterValue = (enrichedUpdateData as any)[k];

        if (k === 'items') {
          const beforeNorm = normalizedItems(beforeValue);
          const afterNorm = normalizedItems(afterValue);
          if (JSON.stringify(stable(beforeNorm)) !== JSON.stringify(stable(afterNorm))) {
            const beforeCount = Array.isArray(beforeValue) ? beforeValue.length : 0;
            const afterCount = Array.isArray(afterValue) ? afterValue.length : 0;
            changeLines.push(`Items Updated (${beforeCount} -> ${afterCount})`);
          }
          return;
        }

        if (JSON.stringify(stable(beforeValue)) !== JSON.stringify(stable(afterValue))) {
          const label = prettyName[k] || k;
          changeLines.push(`${label}: ${toText(beforeValue)} -> ${toText(afterValue)}`);
        }
      });

      // Log the action
      try {
        await currentDb.collection("logs").add({
          timestamp: new Date().toISOString(),
          userId: req.user.uid,
          userName: req.user.name || req.user.username,
          action: 'Order Updated',
          details: changeLines.length
            ? `Updated order ${orderId}; changes: ${changeLines.join(' | ')}`
            : `Updated order ${orderId}; no material field changes detected`,
          orderId: orderId
        });
      } catch (logErr) {
        console.error("Failed to log order update:", logErr);
      }

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Order Update Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Update Order Item Status Endpoint
  app.post("/api/orders/item-status", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, sku, status } = req.body;
      if (!orderId || !sku || !status) {
        return res.status(400).json({ success: false, error: "Missing orderId, sku, or status" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data()!;
      const requestedWh = (req.headers['x-warehouse-id'] as string) || '';
      const isSuper = SUPER_ADMINS.includes((req.user.username || "").toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];
      const orderWarehouse = order?.warehouseId || requestedWh || null;
      if (!isSuper && !allowedWarehouses.includes('*') && !allowedWarehouses.includes(orderWarehouse)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
      }

      const currentPickerId = order?.pickingLog?.pickerId || null;
      const currentWarehouseStatus = order?.warehouseStatus || 'Pending';
      if (status === 'Picked') {
        if (currentWarehouseStatus !== 'Picking') {
          return res.status(409).json({ success: false, error: "Order must be started before picking items" });
        }
        if (currentPickerId && currentPickerId !== req.user.uid) {
          return res.status(403).json({ success: false, error: "Only the assigned picker can update item status" });
        }
      }
      const items = order.items || [];
      const updatedItems = items.map((item: any) => {
        if (item.sku === sku) {
          return { ...item, status };
        }
        return item;
      });

      // Check if all items are picked
      const allPicked = updatedItems.every((item: any) => item.status === 'Picked');
      const updateData: any = { items: updatedItems };
      if (allPicked) {
        updateData.warehouseStatus = 'Picked';
        updateData['pickingLog.finishedAt'] = new Date().toISOString();
      } else if (status === 'Picked') {
        updateData.warehouseStatus = 'Picking';
        if (!order.pickingLog?.startedAt) {
          updateData['pickingLog.startedAt'] = new Date().toISOString();
          updateData['pickingLog.pickerId'] = req.user.uid;
          updateData['pickingLog.pickerName'] = req.user.name || req.user.username;
        }
      }

      await orderRef.update({
        ...updateData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user.username
      });

      // Log the action
      try {
        await currentDb.collection("logs").add({
          timestamp: new Date().toISOString(),
          userId: req.user.uid,
          userName: req.user.name || req.user.username,
          action: 'Item Status Updated',
          details: `Set status of ${sku} to ${status} for order ${orderId}`,
          orderId: orderId
        });
      } catch (logErr) {
        console.error("Failed to log item status update:", logErr);
      }

      return res.json({ success: true, allPicked });
    } catch (error: any) {
      console.error("Item Status Update Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Delete Order Endpoint
  app.post("/api/orders/delete", authenticate, async (req: any, res) => {
    return res.status(403).json({ 
      success: false, 
      error: "Forbidden: Order deletion is strictly prohibited. Use 'Cancel' status instead." 
    });
    /* Original deletion logic disabled per security requirements
    const currentDb = await initDb();
    ...
    */
  });

  /**
   * 🚀 V2 批量更新订单状态
   * 解决前端直接写库权限不足的问题
   */
  app.post("/api/v2/orders/bulk-update-status", authenticate, async (req: any, res) => {
    const { orderIds, status } = req.body;
    const currentDb = await initDb();

    if (!orderIds || !Array.isArray(orderIds) || !status) {
      return res.status(400).json({ success: false, error: "Missing orderIds or status" });
    }

    if (!currentDb) return res.status(503).json({ error: "Database Offline" });

    try {
      const batch = currentDb.batch();
      const timestamp = new Date().toISOString();

      for (const id of orderIds) {
        const orderRef = currentDb.collection("orders").doc(id);
        batch.update(orderRef, {
          status: status,
          statusUpdatedAt: timestamp,
          updatedAt: timestamp,
          updatedBy: req.user.username // 这里的 req.user 来自我们的 jwt.verify
        });

        // 同时写入操作日志 (复用你之前的 logAction 逻辑)
        const logRef = currentDb.collection("logs").doc();
        batch.set(logRef, {
          timestamp,
          userId: req.user.uid,
          userName: req.user.name || req.user.username,
          action: 'Bulk Status Update',
          details: `Set status to ${status} for order ${id}`,
          orderId: id
        });
      }

      await batch.commit();
      console.log(`✅ [V2 Update] ${orderIds.length} orders updated to ${status} by ${req.user.username}`);
      
      res.json({ success: true, message: `Successfully updated ${orderIds.length} orders` });
    } catch (error: any) {
      console.error("🔥 [V2 Update Error]:", error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Create Log Endpoint
  app.post("/api/logs/create", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { action, details, orderId, category } = req.body;
      await currentDb.collection('logs').add({
        timestamp: new Date().toISOString(),
        userId: req.user.uid,
        userName: req.user.name || req.user.username,
        action,
        details,
        orderId: orderId || null,
        category: category || 'System'
      });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // V2 Audit Order Endpoint
  app.post("/api/v2/orders/audit", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, auditLog } = req.body;
      if (!orderId || !auditLog) {
        return res.status(400).json({ success: false, error: "Missing orderId or auditLog" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data();
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];

      // Data Isolation Check
      if (!isSuper) {
        if (!allowedWarehouses.includes('*') && !allowedWarehouses.includes(order?.warehouseId)) {
          return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
        }
        // Check for Audit permission
        if (req.user.role !== 'Admin' && !(req.user.permissions || []).includes('Review Orders') && !(req.user.permissions || []).includes('Audit Overdue Orders')) {
          return res.status(403).json({ success: false, error: "Forbidden: Insufficient permissions to audit order" });
        }
      }

      const batch = currentDb.batch();
      const timestamp = new Date().toISOString();

      // Step 1: Mark as Picked Up (if not already)
      const pickupData: any = {
        status: 'Picked Up',
        statusUpdatedAt: timestamp,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user.username
      };

      if (!order?.actualPickupTime) {
        pickupData.actualPickupTime = timestamp;
        pickupData.pickedUpBy = req.user.name || req.user.username;
      }

      batch.update(orderRef, pickupData);

      // Step 2: Mark as Reviewed with Audit Log
      batch.update(orderRef, {
        status: 'Reviewed',
        statusUpdatedAt: timestamp,
        auditLog: auditLog,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedBy: req.user.username
      });

      // Log the action
      const logRef = currentDb.collection("logs").doc();
      batch.set(logRef, {
        timestamp,
        userId: req.user.uid,
        userName: req.user.name || req.user.username,
        action: 'Audit Close Order',
        details: `Overdue audit closure for ${order?.bookingNumber || orderId}. Reason: ${auditLog.reason}. Status transitioned: Picked Up -> Reviewed`,
        orderId: orderId,
        category: 'Audit'
      });

      await batch.commit();

      console.log(`✅ [Audit] Order ${orderId} audited by ${req.user.username}`);
      return res.json({ success: true });
    } catch (error: any) {
      console.error("Audit Order Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Confirm Pickup Endpoint
  app.post("/api/orders/confirm-pickup", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, signatureData, pickedItemIndexes, partialReason } = req.body;
      if (!orderId || !signatureData) {
        return res.status(400).json({ success: false, error: "Missing orderId or signatureData" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data();
      const requestedWh = (req.headers['x-warehouse-id'] as string) || '';
      const orderWarehouse = order?.warehouseId || requestedWh || null;
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];

      // Data Isolation Check
      if (!isSuper) {
        if (!orderWarehouse) {
          return res.status(403).json({ success: false, error: "Forbidden: Missing warehouse context" });
        }
        if (!allowedWarehouses.includes('*') && !allowedWarehouses.includes(orderWarehouse)) {
          return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
        }
      }

      const items = Array.isArray(order?.items) ? order.items : [];
      if (!items.length) {
        return res.status(400).json({ success: false, error: "Order has no items to confirm pickup" });
      }
      if (order?.status !== 'Created') {
        return res.status(409).json({ success: false, error: "Only orders in Created status can be confirmed for pickup" });
      }
      if (order?.warehouseStatus !== 'Picked') {
        return res.status(409).json({ success: false, error: "Warehouse must mark this order as Picked before reception confirmation" });
      }

      const pickedIndexes = Array.isArray(pickedItemIndexes)
        ? [...new Set(pickedItemIndexes.filter((idx: any) => Number.isInteger(idx) && idx >= 0 && idx < items.length))]
        : items.map((_: any, idx: number) => idx);

      if (!pickedIndexes.length) {
        return res.status(400).json({ success: false, error: "At least one picked item is required" });
      }

      const pickedSet = new Set<number>(pickedIndexes);
      const updatedItems = items.map((item: any, index: number) => ({
        ...item,
        status: pickedSet.has(index) ? 'Picked' : 'Pending'
      }));

      const pickedItems = updatedItems
        .map((item: any, index: number) => ({ item, index }))
        .filter(({ index }) => pickedSet.has(index))
        .map(({ item }) => ({
          sku: item.sku,
          productName: item.productName || null,
          qty: item.qty || 0
        }));

      const unpickedItems = updatedItems
        .map((item: any, index: number) => ({ item, index }))
        .filter(({ index }) => !pickedSet.has(index))
        .map(({ item }) => ({
          sku: item.sku,
          productName: item.productName || null,
          qty: item.qty || 0
        }));

      const isPartialPickup = pickedIndexes.length < items.length;
      const timestamp = new Date().toISOString();
      const updatePayload: any = {
        items: updatedItems,
        customerSignature: signatureData,
        updatedAt: timestamp,
        updatedBy: req.user.username
      };
      if (!order?.warehouseId && requestedWh) {
        updatePayload.warehouseId = requestedWh;
      }

      if (isPartialPickup) {
        updatePayload.status = 'Created';
        updatePayload.statusUpdatedAt = timestamp;
        updatePayload.pickupExceptionStatus = 'PartialPendingSales';
        updatePayload.partialPickupInfo = {
          confirmedAt: timestamp,
          confirmedBy: req.user.name || req.user.username,
          reason: typeof partialReason === 'string' && partialReason.trim() ? partialReason.trim() : 'Partial pickup confirmed by reception',
          pickedItemIndexes: pickedIndexes,
          pickedItems,
          unpickedItems
        };
      } else {
        updatePayload.status = 'Picked Up';
        updatePayload.statusUpdatedAt = timestamp;
        updatePayload.actualPickupTime = timestamp;
        updatePayload.pickedUpBy = req.user.name || req.user.username;
        updatePayload.pickupExceptionStatus = null;
      }

      await orderRef.update(updatePayload);

      // Log the action
      try {
        await currentDb.collection("logs").add({
          timestamp: new Date().toISOString(),
          userId: req.user.uid,
          userName: req.user.name || req.user.username,
          action: isPartialPickup ? 'Confirm Partial Pickup' : 'Confirm Pickup',
          details: isPartialPickup
            ? `Confirmed partial pickup for order ${orderId}. Picked ${pickedIndexes.length}/${items.length} items.`
            : `Confirmed pickup for order ${orderId}`,
          orderId: orderId
        });
      } catch (logErr) {
        console.error("Failed to log pickup confirmation:", logErr);
      }

      return res.json({
        success: true,
        isPartialPickup,
        pickupExceptionStatus: isPartialPickup ? 'PartialPendingSales' : null
      });
    } catch (error: any) {
      console.error("Pickup Confirmation Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Mark partial pickup as ready for finalization after Sales has updated the order.
  app.post("/api/orders/partial-pickup/mark-ready", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId, resolutionNote } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: "Missing orderId" });
      }

      if (!hasPermission(req.user, 'Edit Order') && !hasPermission(req.user, 'Finalize Partial Pickup')) {
        return res.status(403).json({ success: false, error: "Forbidden: Edit Order permission required" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data();
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];
      if (!isSuper && !allowedWarehouses.includes('*') && !allowedWarehouses.includes(order?.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
      }

      if (order?.pickupExceptionStatus !== 'PartialPendingSales') {
        return res.status(400).json({ success: false, error: "Order is not in PartialPendingSales state" });
      }

      await orderRef.update({
        pickupExceptionStatus: 'PendingFinalize',
        partialPickupInfo: {
          ...(order?.partialPickupInfo || {}),
          salesResolvedAt: new Date().toISOString(),
          salesResolvedBy: req.user.name || req.user.username,
          resolutionNote: typeof resolutionNote === 'string' && resolutionNote.trim() ? resolutionNote.trim() : null
        },
        updatedAt: new Date().toISOString(),
        updatedBy: req.user.username
      });

      await currentDb.collection("logs").add({
        timestamp: new Date().toISOString(),
        userId: req.user.uid,
        userName: req.user.name || req.user.username,
        action: 'Mark Partial Pickup Ready',
        details: `Marked partial pickup order ${orderId} as PendingFinalize`,
        orderId
      });

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Mark Partial Pickup Ready Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Finalize partial pickup into standard Picked Up state (permission-based, exception-only).
  app.post("/api/orders/partial-pickup/finalize", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orderId } = req.body;
      if (!orderId) {
        return res.status(400).json({ success: false, error: "Missing orderId" });
      }

      if (!hasPermission(req.user, 'Finalize Partial Pickup')) {
        return res.status(403).json({ success: false, error: "Forbidden: Finalize Partial Pickup permission required" });
      }

      const orderRef = currentDb.collection("orders").doc(orderId);
      const orderDoc = await orderRef.get();
      if (!orderDoc.exists) {
        return res.status(404).json({ success: false, error: "Order not found" });
      }

      const order = orderDoc.data();
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const allowedWarehouses = req.user.allowedWarehouses || [];
      if (!isSuper && !allowedWarehouses.includes('*') && !allowedWarehouses.includes(order?.warehouseId)) {
        return res.status(403).json({ success: false, error: "Forbidden: Access denied to this warehouse" });
      }

      if (order?.status !== 'Created') {
        return res.status(400).json({ success: false, error: "Only Created orders can be finalized from partial pickup flow" });
      }
      if (order?.pickupExceptionStatus !== 'PendingFinalize') {
        return res.status(400).json({
          success: false,
          error: "Order must be submitted for finalization before it can be finalized"
        });
      }

      const timestamp = new Date().toISOString();
      await orderRef.update({
        status: 'Picked Up',
        statusUpdatedAt: timestamp,
        actualPickupTime: order?.actualPickupTime || timestamp,
        pickedUpBy: order?.pickedUpBy || req.user.name || req.user.username,
        pickupExceptionStatus: null,
        partialPickupInfo: {
          ...(order?.partialPickupInfo || {}),
          finalizedAt: timestamp,
          finalizedBy: req.user.name || req.user.username
        },
        updatedAt: timestamp,
        updatedBy: req.user.username
      });

      await currentDb.collection("logs").add({
        timestamp,
        userId: req.user.uid,
        userName: req.user.name || req.user.username,
        action: 'Finalize Partial Pickup',
        details: `Finalized partial pickup order ${orderId} into Picked Up`,
        orderId
      });

      return res.json({ success: true });
    } catch (error: any) {
      console.error("Finalize Partial Pickup Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Bulk Order Creation
  app.post("/api/orders/bulk-create", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { orders } = req.body;
      if (!Array.isArray(orders)) {
        return res.status(400).json({ error: "Invalid orders data" });
      }

      const results = {
        success: 0,
        failed: 0,
        errors: [] as string[]
      };

      const BATCH_SIZE = 50;
      for (let i = 0; i < orders.length; i += BATCH_SIZE) {
        const chunk = orders.slice(i, i + BATCH_SIZE);
        try {
          // Use Admin SDK for transaction
          await currentDb.runTransaction(async (transaction: any) => {
            const preparedOrders = chunk.map(orderData => {
              // Support both snake_case and camelCase for better compatibility
              const bookingNumber = (orderData.booking_number || orderData.bookingNumber || '').trim().toUpperCase();
              const refNumber = (orderData.customer_ref || orderData.refNumber || '').trim().toUpperCase();
              
              if (!bookingNumber) throw new Error("Booking Number is missing in one of the orders");
              if (!refNumber) throw new Error("Customer Ref is missing in one of the orders");

              return {
                orderData,
                bookingNumber,
                refNumber,
                bKeyRef: currentDb.collection("unique_keys").doc(`bn_${bookingNumber}`),
                rKeyRef: currentDb.collection("unique_keys").doc(`ref_${refNumber}`),
                orderRef: currentDb.collection("orders").doc(bookingNumber)
              };
            });

            // 1. All Reads First
            const bSnaps = await Promise.all(preparedOrders.map(p => transaction.get(p.bKeyRef)));
            const rSnaps = await Promise.all(preparedOrders.map(p => transaction.get(p.rKeyRef)));

            // 2. Validation and Writes
            preparedOrders.forEach((p, index) => {
              if (bSnaps[index].exists) throw new Error(`Booking Number ${p.bookingNumber} already exists`);
              if (rSnaps[index].exists) throw new Error(`Customer Ref ${p.refNumber} already exists`);

              const raw = p.orderData;
              const finalOrderData = {
                bookingNumber: p.bookingNumber,
                refNumber: p.refNumber,
                customerName: raw.customer_name || raw.customerName || '',
                customerId: raw.customer_id || raw.customerId || '',
                customerEmail: raw.customer_email || raw.customerEmail || '',
                storeId: raw.store_id || raw.storeId || '',
                pickupDateScheduled: raw.scheduled_pickup_date || raw.pickupDateScheduled || '',
                warehouseId: raw.warehouse_id || raw.warehouseId || '',
                paymentStatus: raw.payment_state || raw.paymentStatus || 'Unpaid',
                paymentMethod: raw.payment_method || raw.paymentMethod || null,
                orderNote: raw.order_note || raw.orderNote || '',
                items: (raw.items || []).map((item: any) => ({
                  sku: item.sku || '',
                  qty: item.qty || 0,
                  unit_price: item.unit_price || 0,
                  productName: item.productName || '',
                  location: item.location || ''
                })),
                totalAmount: raw.totalAmount !== undefined ? raw.totalAmount : (raw.items || []).reduce((sum: number, item: any) => sum + ((item.qty || 0) * (item.unit_price || 0)), 0),
                createdTime: new Date().toISOString(),
                createdBy: req.user.name || 'System',
                creatorUid: req.user.uid,
                status: 'Created',
                sendPickupEmail: raw.sendPickupEmail || false
              };

              transaction.set(p.bKeyRef, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
              transaction.set(p.rKeyRef, { createdAt: admin.firestore.FieldValue.serverTimestamp() });
              transaction.set(p.orderRef, finalOrderData);
            });
          });
          results.success += chunk.length;
          await logAction(req.user, 'Bulk Import', `Bulk imported ${chunk.length} orders.`, null, 'Order');
        } catch (err: any) {
          results.failed += chunk.length;
          results.errors.push(err.message);
        }
      }

      res.json(results);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Store Management
  app.post("/api/stores/save", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const isAdmin = req.user.role === 'Admin' || SUPER_ADMINS.includes(req.user.username.toLowerCase());
      if (!isAdmin && !hasPermission(req.user, 'Manage Stores')) {
        return res.status(403).json({ error: "Permission denied: Admin role required" });
      }

      const storeData = req.body;
      const docId = storeData.id || storeData.storeId;
      
      await currentDb.collection('stores').doc(docId).set({
        ...storeData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      await logAction(req.user, 'Store Saved', `Saved store: ${storeData.storeId}`, null, 'Store');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/stores/delete", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const isAdmin = req.user.role === 'Admin' || SUPER_ADMINS.includes(req.user.username.toLowerCase());
      if (!isAdmin && !hasPermission(req.user, 'Manage Stores')) {
        return res.status(403).json({ error: "Permission denied: Admin role required" });
      }

      const { id, storeId } = req.body;
      await currentDb.collection('stores').doc(id).delete();
      await logAction(req.user, 'Store Deleted', `Deleted store: ${storeId}`, null, 'Store');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // User Groups
  app.post("/api/user-groups/save", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const isAdmin = req.user.role === 'Admin' || isSuper;

      if (!isAdmin && !hasPermission(req.user, 'Manage User Groups')) {
        return res.status(403).json({ success: false, error: "Permission denied: Manage User Groups permission required" });
      }

      const { id, ...data } = req.body;
      const updateData = {
        ...data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      if (id) {
        await currentDb.collection('userGroups').doc(id).update(updateData);
      } else {
        await currentDb.collection('userGroups').add({
          ...updateData,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  app.post("/api/user-groups/delete", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const isSuper = SUPER_ADMINS.includes(req.user.username.toLowerCase());
      const isAdmin = req.user.role === 'Admin' || isSuper;

      if (!isAdmin && !hasPermission(req.user, 'Manage User Groups')) {
        return res.status(403).json({ success: false, error: "Permission denied: Manage User Groups permission required" });
      }

      const { id } = req.body;
      await currentDb.collection('userGroups').doc(id).delete();
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // User Settings
  app.post("/api/user/settings", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { settings } = req.body;
      await currentDb.collection('users').doc(req.user.uid).update({ 
        settings,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await logAction(req.user, 'Update Settings', 'Updated personal settings', null, 'User');
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Socket.io Logic
  io.on("connection", (socket) => {
    console.log("A user connected:", socket.id);

    // Join a room based on Store ID or Order ID
    socket.on("join-room", (roomId) => {
      socket.join(roomId);
      console.log(`Socket ${socket.id} joined room: ${roomId}`);
    });

    // Operator requests a signature
    socket.on("request-signature", (data) => {
      // data: { orderId, storeId, customerName }
      console.log(`Signature requested for order ${data.orderId} in store ${data.storeId}`);
      io.to(data.storeId).emit("show-signature-pad", data);
    });

    // Guest submits a signature
    socket.on("submit-signature", (data) => {
      // data: { orderId, storeId, signatureData }
      console.log(`Signature submitted for order ${data.orderId}`);
      io.to(data.storeId).emit("signature-received", data);
    });

    // Cancel signature request
    socket.on("cancel-signature", (storeId) => {
      io.to(storeId).emit("reset-guest-display");
    });

    // Presence checks
    socket.on("check-guest-presence", (roomId) => {
      // Forward the check to the room
      socket.to(roomId).emit("check-guest-presence", { from: socket.id, roomId });
    });

    socket.on("guest-online", (roomId) => {
      // Broadcast that a guest is online in this room
      io.to(roomId).emit("guest-online");
    });

    socket.on("disconnect", () => {
      console.log("User disconnected:", socket.id);
    });
  });

  // Unsubscribe endpoint
  app.get("/api/unsubscribe", async (req, res) => {
    const { email, orderId } = req.query;
    console.log(`Unsubscribe request received for email: ${email}, orderId: ${orderId}`);
    
    // In a real app, we would mark this email as unsubscribed in a database
    // For now, we'll just show a confirmation page
    res.send(`
      <html>
        <head>
          <title>Unsubscribed</title>
          <style>
            body { font-family: sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #f8fafc; }
            .card { background: white; padding: 2rem; border-radius: 1rem; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1); text-align: center; max-width: 400px; }
            h1 { color: #1e293b; margin-bottom: 1rem; }
            p { color: #64748b; line-height: 1.5; }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>Unsubscribed</h1>
            <p>You have been successfully unsubscribed from pickup notifications for order <strong>${orderId}</strong>.</p>
            <p>If this was a mistake, please contact our support team.</p>
          </div>
        </body>
      </html>
    `);
  });

  app.get("/api/debug/last-error", async (req, res) => {
    const logPath = path.join(process.cwd(), "debug.log");
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, "utf8");
      res.header("Content-Type", "text/plain");
      res.send(content);
    } else {
      res.send("No logs found yet. Try triggering the error first.");
    }
  });

  app.get("/api/debug/firebase", async (req, res) => {
    const currentDb = await initDb();
    res.json({
      initialized: !!currentDb,
      lastError: lastInitError,
      apps: admin.apps.length,
      projectId: admin.app().options.projectId || "ambient",
      databaseId: currentDb ? (currentDb as any)._databaseId : "unknown",
      env: process.env.NODE_ENV,
      hasConfig: fs.existsSync(path.join(process.cwd(), "firebase-applet-config.json"))
    });
  });

  // Initial attempt - don't block startup if it fails
  initDb().then(currentDb => {
    if (currentDb) {
      setupNotificationListener(currentDb);
    }
  }).catch(err => console.error("Initial DB init failed:", err));

  let retryCount = 0;
  const MAX_RETRIES = 10;
  let unsubscribeNotifications: (() => void) | null = null;

  async function setupNotificationListener(currentDb: admin.firestore.Firestore) {
    if (unsubscribeNotifications) {
      unsubscribeNotifications();
      unsubscribeNotifications = null;
    }
    console.log("Setting up Firestore notification listener...");
    const startTime = new Date().toISOString();
    
    try {
      // Check if collection exists by doing a small get first
      // This can help diagnose permission issues early
      await currentDb.collection("notifications").limit(1).get();

      unsubscribeNotifications = currentDb.collection("notifications")
        .where("isRead", "==", false)
        .onSnapshot(async (snapshot) => {
          console.log(`Notification snapshot received: ${snapshot.size} unread notifications`);
          retryCount = 0; // Reset retry count on successful snapshot
          for (const change of snapshot.docChanges()) {
            if (change.type === "added") {
              const notification = change.doc.data();
              // Only process notifications created after the server started to avoid duplicates
              if (notification.createdAt >= startTime) {
                console.log(`Processing new notification: ${change.doc.id}`);
                await sendPushNotification(currentDb, notification);
              }
            }
          }
        }, (error) => {
          console.error("Notification listener error:", error);
          
          // If permission error, log more details
          if (error.message.includes("Missing or insufficient permissions")) {
            console.error("CRITICAL PERMISSION ERROR: The server service account may lack access to the 'notifications' collection.");
            console.error("Check Firestore rules and ensure the collection exists.");
          }

          if (retryCount < MAX_RETRIES) {
            retryCount++;
            const delay = Math.min(1000 * Math.pow(2, retryCount), 60000); // Exponential backoff
            console.log(`Retrying notification listener in ${delay}ms (Attempt ${retryCount}/${MAX_RETRIES})...`);
            setTimeout(() => setupNotificationListener(currentDb), delay);
          } else {
            console.error("MAX_RETRIES reached for notification listener. Stopping retries.");
          }
        });
    } catch (err: any) {
      console.error("Failed to setup notification listener:", err);
      if (err.message.includes("Missing or insufficient permissions")) {
        console.error("Initial permission check failed for 'notifications' collection.");
      }
    }
  }

  async function sendPushNotification(currentDb: admin.firestore.Firestore, notification: any) {
    const { recipientUid, title, body } = notification;
    if (!recipientUid) return;

    try {
      // Get recipient's FCM token
      const userDoc = await currentDb.collection("users").doc(recipientUid).get();
      const userData = userDoc.data();
      const fcmToken = userData?.fcmToken;

      if (fcmToken) {
        const message = {
          notification: {
            title: title || "New Notification",
            body: body || ""
          },
          token: fcmToken,
          webpush: {
            fcmOptions: {
              link: notification.orderId ? `/orders/${notification.orderId}` : "/"
            }
          }
        };

        await admin.messaging().send(message);
        console.log(`Push notification sent to user ${recipientUid}`);
      }
    } catch (error) {
      console.error(`Error sending push notification to user ${recipientUid}:`, error);
    }
  }

  console.log(`ECPP API Key status: ${process.env.ECPP_API_KEY ? "Configured" : "Not Configured"}`);

  // ECPP Push API
  // Accepts legacy { sku, location } and warehouse-aware { sku, warehouseId, location } or { sku, locations: { AKL, CHC } }.
  // Header: Authorization: <API_KEY>
  app.post("/api/ecpp/push", async (req, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }
    
    const authHeader = req.headers.authorization;
    const apiKey = (process.env.ECPP_API_KEY || process.env.EXTERNAL_API_KEY || "").trim();

    if (!apiKey) {
      return res.status(500).json({ success: false, error: "Server Configuration Error: API Key is not set." });
    }

    const cleanHeader = authHeader ? authHeader.replace("Bearer ", "").trim() : "";
    if (cleanHeader !== apiKey) {
      return res.status(401).json({ success: false, error: "Unauthorized: API Key mismatch." });
    }

    const items = Array.isArray(req.body) ? req.body : [req.body];
    if (items.length === 0) {
      return res.status(400).json({ success: false, error: "Request body is empty" });
    }

    try {
      const skusRef = currentDb.collection("skus");
      const results = {
        received: items.length,
        memoryDuplicates: 0,
        unmodifiedSkipped: 0,
        actuallyProcessed: 0,
        errors: [] as string[]
      };

      // ==========================================
      // 第一重防御：内存去重 (零成本，极速)
      // 应对 ECPP 推送包内部自身的重复数据
      // ==========================================
      const uniqueItemsMap = new Map();
      
      for (const item of items) {
        const rawSku = item.sku || item.SKU;
        if (!rawSku) {
          results.errors.push("Missing SKU for an item");
          continue;
        }
        
        const skuUpper = rawSku.toString().trim().toUpperCase();
        // 如果 payload 里有同一个 SKU 的多条记录，保留最后一条
        if (uniqueItemsMap.has(skuUpper)) {
          results.memoryDuplicates++;
        }
        uniqueItemsMap.set(skuUpper, item);
      }

      const uniqueItems = Array.from(uniqueItemsMap.values());
      const CHUNK_SIZE = 450; // 安全低于 Firestore 500 的限制
      
      // ==========================================
      // 第二重防御：分批处理与数据库严格比对拦截
      // ==========================================
      for (let i = 0; i < uniqueItems.length; i += CHUNK_SIZE) {
        const chunk = uniqueItems.slice(i, i + CHUNK_SIZE);
        const batch = currentDb.batch();
        
        // 1. 构建这一批要查询的文档引用
        const docRefs = chunk.map(item => {
          const skuUpper = (item.sku || item.SKU).toString().trim().toUpperCase();
          const safeDocId = skuUpper.replace(/\//g, '_');
          return skusRef.doc(safeDocId);
        });

        // 2. 批量读取现有数据 (用便宜的 Read 换昂贵的 Write)
        const existingDocs = await currentDb.getAll(...docRefs);

        let updatesInThisBatch = 0;

        for (let j = 0; j < chunk.length; j++) {
          const item = chunk[j];
          
          // 1. 获取推过来的原始数据
          const skuUpper = (item.sku || item.SKU).toString().trim().toUpperCase();
          const safeDocId = skuUpper.replace(/\//g, '_');
          const rawName = (item.productName || item.productname || item.product_name || item.name || "").toString().trim();
          const rawLocation = normalizeLocationValue(item.location || item.Location);
          const payloadWarehouseId = normalizeWarehouseId(item.warehouseId || item.warehouse || item.Warehouse || item.warehouse_id);
          const payloadLocations = normalizeSkuLocationsPayload(item.locations || item.Locations);
          const inventoryFields = extractSkuInventoryFields(item);
          const hasLegacyLocationPayload = !payloadWarehouseId && Object.keys(payloadLocations).length === 0 && rawLocation !== "";
          const hasWarehouseLocationPayload = !!payloadWarehouseId && rawLocation !== "";
          const hasLocationsPayload = Object.keys(payloadLocations).length > 0;

          const currentSnap = existingDocs[j];
          let finalName: string;
          let finalLocation: string;
          let finalLocations: Record<string, string> = {};
          let needsUpdate = false;

          // 2. 🧠 核心大脑：判断是老数据合并，还是新数据创建
          if (currentSnap.exists) {
            // 【情况 A：老数据存在】
            const dbData = currentSnap.data() || {};
            const dbName = (dbData.productName || "").toString().trim();
            const dbLocation = normalizeLocationValue(dbData.location);
            const dbLocations = normalizeExistingSkuLocations(dbData.locations);

            // 规则：有新值用新值，没新值保老值（绝不触发 Fallback 破坏数据）
            finalName = rawName !== "" ? rawName : dbName;
            finalLocations = { ...dbLocations };

            if (hasLocationsPayload) {
              Object.assign(finalLocations, payloadLocations);
            }

            if (hasWarehouseLocationPayload) {
              finalLocations[payloadWarehouseId] = rawLocation;
            }

            if (hasLegacyLocationPayload) {
              finalLocation = rawLocation;
              finalLocations.AKL = rawLocation;
            } else if (payloadLocations.AKL) {
              finalLocation = payloadLocations.AKL;
            } else if (payloadWarehouseId === "AKL" && rawLocation) {
              finalLocation = rawLocation;
            } else {
              finalLocation = dbLocation || "N/A";
            }

            // 对比是否真的发生改变
            if (finalName !== dbName || finalLocation !== dbLocation || !locationsEqual(finalLocations, dbLocations)) {
              needsUpdate = true;
            }

            for (const [field, value] of Object.entries(inventoryFields)) {
              if (Number(dbData[field]) !== value) needsUpdate = true;
            }
          } else {
            // 【情况 B：完全陌生的新 SKU】
            // 规则：触发 Fallback 自动填充
            finalName = rawName !== "" ? rawName : skuUpper;
            finalLocations = { ...payloadLocations };

            if (hasWarehouseLocationPayload) {
              finalLocations[payloadWarehouseId] = rawLocation;
            }

            if (hasLegacyLocationPayload) {
              finalLocation = rawLocation;
              finalLocations.AKL = rawLocation;
            } else if (payloadLocations.AKL) {
              finalLocation = payloadLocations.AKL;
            } else if (payloadWarehouseId === "AKL" && rawLocation) {
              finalLocation = rawLocation;
            } else {
              finalLocation = "N/A";
            }
            needsUpdate = true; // 新数据必须写入
          }

          // 3. 🛡️ 拦截器执行
          if (!needsUpdate) {
            results.unmodifiedSkipped++;
            continue; // 数据没实质变化，完美拦截！
          }

          // 4. 组装最终安全的数据并写入
          const updateData: any = { 
            sku: skuUpper, // 存入原始 SKU (带斜杠)
            productName: finalName,
            location: finalLocation,
            updatedAt: new Date().toISOString()
          };

          if (Object.keys(finalLocations).length > 0) {
            updateData.locations = finalLocations;
          }

          Object.assign(updateData, inventoryFields);

          if (!currentSnap.exists) {
            updateData.createdAt = updateData.updatedAt;
          }
          
          batch.set(docRefs[j], updateData, { merge: true });
          updatesInThisBatch++;
          results.actuallyProcessed++;
        }
        
        // 只有当 Batch 里有真实需要更新的数据时才提交
        if (updatesInThisBatch > 0) {
          await batch.commit();
        }
      }

      console.log(`SKU Push Success: Received ${results.received}, Memory Deduped: ${results.memoryDuplicates}, Skipped (Unchanged): ${results.unmodifiedSkipped}, Written: ${results.actuallyProcessed}`);

      return res.json({ 
        success: true, 
        message: `Processed. Skipped ${results.unmodifiedSkipped} unchanged items to save database quotas.`,
        details: results
      });
    } catch (error: any) {
      console.error("ECPP Push Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // ECPP Sync API Placeholder (Original)
  app.post("/api/ecpp/sync", async (req, res) => {
    const authHeader = req.headers.authorization;
    const apiKey = process.env.ECPP_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ 
        success: false, 
        error: "Server Configuration Error: ECPP_API_KEY is not set." 
      });
    }

    if (authHeader !== apiKey && authHeader !== `Bearer ${apiKey}`) {
      return res.status(401).json({ 
        success: false, 
        error: "Unauthorized: Invalid or missing API Key" 
      });
    }

    try {
      console.log("Starting ECPP Sync...");
      // This could trigger a full sync if needed
      res.json({ 
        success: true, 
        message: "ECPP Sync completed successfully",
        timestamp: new Date().toISOString(),
        itemsSynced: 0
      });
    } catch (error: any) {
      console.error("ECPP Sync Error:", error);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // Admin: Update User Password
  app.post("/api/admin/update-password", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const callerUsername = req.user.username.toLowerCase();
      const callerEmail = (req.user.email || "").toLowerCase();
      const isSuper = isSuperAdmin(callerEmail) || isSuperAdmin(callerUsername);
      const isAdmin = req.user.role === 'Admin' || isSuper;

      if (!isAdmin) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin access required" });
      }

      const { targetUid, newPassword } = req.body;
      if (!targetUid || !newPassword) {
        return res.status(400).json({ success: false, error: "Missing targetUid or newPassword" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
      }

      // Fetch target user to check their role
      const targetDoc = await currentDb.collection("users").doc(targetUid).get();
      if (!targetDoc.exists) {
        return res.status(404).json({ success: false, error: "Target user not found" });
      }

      const targetData = targetDoc.data() || {};
      const targetUsername = (targetData.username || "").toLowerCase();
      const targetIsSuper = SUPER_ADMINS.includes(targetUsername);
      const targetIsAdmin = targetData.roleTemplate === 'Admin' || targetIsSuper;

      // Restriction: SUPER_ADMINS cannot be managed via API
      if (targetIsSuper && !isSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: System administrators cannot be managed." });
      }

      // Restriction: Admin cannot be managed by other admins (only by SUPER_ADMIN)
      if (targetIsAdmin && !isSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin accounts can only be managed by system administrators." });
      }

      // Hash the new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update the password in Firestore
      await currentDb.collection("users").doc(targetUid).update({
        password: hashedPassword,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`Admin ${req.user.uid} updated password for user ${targetUid}`);
      await logAction(req.user, 'Admin Change Password', `Admin changed password for user ${targetUsername}`, null, 'User');
      
      return res.json({ success: true, message: "Password updated successfully" });
    } catch (error: any) {
      console.error("Admin Password Update Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Admin: Create User
  app.post("/api/admin/create-user", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      // Check if caller is admin
      if (req.user.role !== 'Admin') {
        return res.status(403).json({ success: false, error: "Forbidden: Admin access required" });
      }

      const { username: rawUsername, password, name, roleTemplate, permissions, allowedWarehouses } = req.body;
      const username = (rawUsername || "").toLowerCase();
      
      if (!username || !password || !name) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }

      // Check if user already exists (case-insensitive check)
      const userSnap = await currentDb.collection("users").where("username", "==", username).limit(1).get();
      const legacySnap = await currentDb.collection("users").where("username", "==", rawUsername).limit(1).get();
      
      if (!userSnap.empty || !legacySnap.empty) {
        return res.status(400).json({ success: false, error: "Username already exists" });
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(password, 10);

      // Create user in Firestore
      const newUserRef = currentDb.collection("users").doc();
      const newUser = {
        uid: newUserRef.id,
        username,
        password: hashedPassword,
        name,
        roleTemplate: roleTemplate || 'Sales',
        permissions: permissions || [],
        allowedWarehouses: allowedWarehouses || [],
        status: 'Active',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        settings: {
          notificationsEnabled: true,
          emailNotifications: true,
          theme: 'light'
        }
      };

      await newUserRef.set(newUser);
      
      console.log(`Admin ${req.user.uid} created user ${username}`);
      
      return res.json({ success: true, message: "User created successfully", uid: newUserRef.id });
    } catch (error: any) {
      console.error("Admin Create User Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Admin: Update User
  app.get("/api/admin/list-users", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const callerUsername = (req.user.username || "").toLowerCase();
      const isSuper = SUPER_ADMINS.includes(callerUsername);
      const isAdmin = req.user.role === 'Admin' || isSuper;

      if (!isAdmin && !hasPermission(req.user, 'Manage Users')) {
        return res.status(403).json({ success: false, error: "Forbidden: Manage Users permission required" });
      }

      const snap = await currentDb.collection("users").get();
      const users = snap.docs
        .map((d: any) => ({ uid: d.id, ...d.data() }))
        // Never expose password hash to frontend.
        .map((u: any) => {
          const { password, ...rest } = u;
          return rest;
        });

      return res.json({ success: true, users });
    } catch (error: any) {
      console.error("Admin List Users Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Admin: Update User
  app.post("/api/admin/update-user", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const callerUsername = req.user.username.toLowerCase();
      const callerEmail = (req.user.email || "").toLowerCase();
      const isSuper = isSuperAdmin(callerEmail) || isSuperAdmin(callerUsername);
      const isAdmin = req.user.role === 'Admin' || isSuper;

      if (!isAdmin && !hasPermission(req.user, 'Manage Users')) {
        return res.status(403).json({ success: false, error: "Forbidden: Manage Users permission required" });
      }

      const { uid, name, status, permissions, allowedWarehouses, roleTemplate } = req.body;
      if (!uid) {
        return res.status(400).json({ success: false, error: "Missing uid" });
      }

      // Prevent self-revocation of Manage Users permission
      if (uid === req.user.uid && !permissions.includes('Manage Users')) {
        return res.status(400).json({ success: false, error: "To avoid system lockouts, you cannot revoke your own 'Manage Users' permission." });
      }

      // Fetch target user to check their role
      const targetDoc = await currentDb.collection("users").doc(uid).get();
      if (!targetDoc.exists) {
        return res.status(404).json({ success: false, error: "Target user not found" });
      }

      const targetData = targetDoc.data() || {};
      const targetUsername = (targetData.username || "").toLowerCase();
      const targetIsSuper = SUPER_ADMINS.includes(targetUsername);
      const targetIsAdmin = targetData.roleTemplate === 'Admin' || targetIsSuper;

      // Restriction: SUPER_ADMINS cannot be managed via API
      if (targetIsSuper && !isSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: System administrators cannot be managed." });
      }

      // Restriction: Admin cannot be managed by other admins (only by SUPER_ADMIN)
      if (targetIsAdmin && !isSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin accounts can only be managed by system administrators." });
      }

      await currentDb.collection("users").doc(uid).update({
        name,
        status,
        permissions,
        allowedWarehouses,
        roleTemplate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log(`Admin ${req.user.uid} updated user ${uid} (${targetUsername})`);
      await logAction(req.user, 'Update User', `Updated user profile: ${targetUsername}`, null, 'User');
      
      return res.json({ success: true, message: "User updated successfully" });
    } catch (error: any) {
      console.error("Admin Update User Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Admin: Delete User
  app.post("/api/admin/delete-user", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const callerUsername = req.user.username.toLowerCase();
      const isSuper = SUPER_ADMINS.includes(callerUsername);
      const isAdmin = req.user.role === 'Admin' || isSuper;
      
      console.log(`[Delete User] Caller: ${callerUsername}, Role: ${req.user.role}, isAdmin: ${isAdmin}, isSuper: ${isSuper}`);

      if (!isAdmin && !hasPermission(req.user, 'Manage Users')) {
        console.warn(`[Delete User] Permission denied for ${callerUsername}`);
        return res.status(403).json({ success: false, error: "Forbidden: Manage Users permission required" });
      }

      const { uid } = req.body;
      if (!uid) {
        return res.status(400).json({ success: false, error: "Missing uid" });
      }

      // Prevent self-deletion
      if (uid === req.user.uid) {
        return res.status(400).json({ success: false, error: "You cannot delete your own account." });
      }

      // Fetch target user to check their role
      const targetDoc = await currentDb.collection("users").doc(uid).get();
      if (!targetDoc.exists) {
        return res.status(404).json({ success: false, error: "Target user not found" });
      }

      const targetData = targetDoc.data() || {};
      const targetUsername = (targetData.username || "").toLowerCase();
      const targetIsSuper = SUPER_ADMINS.includes(targetUsername);
      const targetIsAdmin = targetData.roleTemplate === 'Admin' || targetIsSuper;

      console.log(`[Delete User] Target: ${targetUsername}, targetIsAdmin: ${targetIsAdmin}, targetIsSuper: ${targetIsSuper}`);

      // Restriction: SUPER_ADMINS cannot be deleted via API
      if (targetIsSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: System administrators cannot be deleted." });
      }

      // Restriction: Admin cannot be deleted by other admins (only by SUPER_ADMIN)
      if (targetIsAdmin && !isSuper) {
        return res.status(403).json({ success: false, error: "Forbidden: Admin accounts can only be deleted by system administrators." });
      }

      await currentDb.collection("users").doc(uid).delete();
      
      console.log(`Admin ${req.user.uid} deleted user ${uid} (${targetUsername})`);
      await logAction(req.user, 'Delete User', `Deleted user account: ${targetUsername}`, null, 'User');
      
      return res.json({ success: true, message: "User deleted successfully" });
    } catch (error: any) {
      console.error("Admin Delete User Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // User: Update Own Password
  app.post("/api/user/update-password", authenticate, async (req: any, res) => {
    const currentDb = await initDb();
    if (!currentDb) {
      return res.status(503).json({ success: false, error: "Database not initialized" });
    }

    try {
      const { currentPassword, newPassword } = req.body;
      const uid = req.user.uid;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ success: false, error: "Missing required fields" });
      }

      // Get user from Firestore
      const userDoc = await currentDb.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      const userData = userDoc.data();
      
      // Verify current password
      const isMatch = await bcrypt.compare(currentPassword, userData.password);
      if (!isMatch) {
        return res.status(401).json({ success: false, error: "Current password is incorrect" });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password in Firestore
      await currentDb.collection("users").doc(uid).update({
        password: hashedPassword,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`User ${uid} updated their own password`);
      
      return res.json({ success: true, message: "Password updated successfully" });
    } catch (error: any) {
      console.error("User Password Update Error:", error);
      return res.status(500).json({ success: false, error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    
    // Ensure service-worker.js and index.html are never cached
    const noCacheHeaders = (res: any) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    };

    app.get('/service-worker.js', (req, res, next) => {
      noCacheHeaders(res);
      next();
    });

    app.use(express.static(distPath, {
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) {
          noCacheHeaders(res);
        }
      }
    }));

    // Ensure static assets return 404 if not found, instead of falling back to index.html
    app.get(/\.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2|json|txt|map)$/, (req, res) => {
      res.status(404).send('Not Found');
    });

    app.get('*', (req, res) => {
      noCacheHeaders(res);
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // 全局错误处理中间件 - 捕捉所有未处理的异常
  app.use((err: any, req: any, res: any, next: any) => {
    console.log("🔥 [Global Server Error]:", err);
    const stack = err.stack || "No stack trace available";
    console.error(stack);
    res.status(500).json({ 
      success: false, 
      error: err.message || "Internal Server Error",
      stack: stack 
    });
  });

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
