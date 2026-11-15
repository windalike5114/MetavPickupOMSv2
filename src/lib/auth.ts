import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import admin from 'firebase-admin';
import { config } from 'dotenv';
import { Response, NextFunction } from 'express';
import { SUPER_ADMINS, isSuperAdmin } from './auth-shared';

config({ path: ['.env.local', '.env'], quiet: true });

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET?.trim()) {
  throw new Error('JWT_SECRET is required. Set it in the server environment or .env.local.');
}

/**
 * Generates a JWT token valid for 30 days.
 */
export const generateToken = (payload: any) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
};

/**
 * Middleware to authenticate JWT and parse user info.
 */
import { writeLog } from './logger';

// ... (existing code)

export const authenticate = (req: any, res: Response, next: NextFunction) => {
  // 1. OPTIONS 预检请求直接放行
  if (req.method === 'OPTIONS') {
    return next();
  }

  // 2. 尝试从多个可能的 Key 中读取（防止网关改名或大小写问题）
  const authHeader = 
    req.headers['x-v2-auth-token'] as string ||
    req.headers['authorization'] as string;

  // 🔍 [核心调试] 在服务器终端打印出收到的所有 Header
  if (!authHeader) {
    const receivedKeys = Object.keys(req.headers);
    console.error(`🔥 [AUTH FAIL] No token found in headers for ${req.method} ${req.path}!`);
    console.log("🔍 Received Headers:", JSON.stringify(req.headers, null, 2));
    writeLog('WARN', `Missing token for ${req.method} ${req.path}`, { headers: req.headers });
    
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Missing token',
      debug: {
        received_keys: receivedKeys,
        msg: "I looked for 'x-v2-auth-token' and 'authorization' but they are not here."
      }
    });
  }

  // 3. 剥离 Bearer 前缀
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  
  // 4. 检查剥离后是否为空
  if (!token || token === 'null' || token === 'undefined') {
    writeLog('WARN', 'Invalid token format', { token });
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized: Invalid token format',
      received_headers: Object.keys(req.headers)
    });
  }

  let decoded: any;
  try {
    // 5. 使用 JWT 校验
    decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    return res.status(401).json({
      success: false,
      code: err instanceof jwt.TokenExpiredError ? 'SESSION_EXPIRED' : 'SESSION_INVALID',
      error: 'Your session has ended. Please sign in again.'
    });
  }

  try {
    req.user = decoded;
    
    // Extract and validate warehouse if provided
    const warehouseId = req.headers['x-warehouse-id'];
    if (warehouseId) {
      const isSuper = SUPER_ADMINS.includes(decoded.username.toLowerCase());
      if (!isSuper && !decoded.allowedWarehouses.includes(warehouseId)) {
        writeLog('WARN', `User ${decoded.username} denied access to warehouse ${warehouseId}`);
        return res.status(403).json({ success: false, error: 'Forbidden: You do not have access to this warehouse' });
      }
      req.selectedWarehouse = warehouseId;
    }
    
    next();
  } catch (err: any) {
    console.error(`🔥 [JWT ERROR] for ${req.method} ${req.path}:`, err.message);
    writeLog('ERROR', 'Session authorization error', { message: err.message });
    return res.status(403).json({ 
      success: false, 
      error: `Forbidden: ${err.message}`
    });
  }
};

/**
 * Login logic: validates username/password using Admin SDK.
 * @param db - The firebase-admin firestore instance
 */
export const loginUser = async (db: any, { username, password }: any) => {
  if (!admin.apps.length) {
    console.warn("⚠️ [Auth] Firebase Admin SDK not initialized yet in auth.ts module context!");
  }
  
  const normalizedUsername = username.toLowerCase();
  
  console.log(`Attempting login for: ${username} (normalized: ${normalizedUsername})`);

  // 1. Try to find by normalized username in the 'username' field (New Standard)
  const userQuery = await db.collection('users').where('username', '==', normalizedUsername).limit(1).get();
  
  if (!userQuery.empty) {
    const foundDoc = userQuery.docs[0];
    const foundData = foundDoc.data();
    console.log('User found via normalized username query');
    return processUserLogin(foundDoc, foundData, password);
  }

  // 2. Fallback: Try to find by EXACT username (Legacy Support)
  // This handles users created before the normalization was implemented
  const legacyQuery = await db.collection('users').where('username', '==', username).limit(1).get();
  
  if (!legacyQuery.empty) {
    const foundDoc = legacyQuery.docs[0];
    const foundData = foundDoc.data();
    console.log('User found via legacy exact username query');
    return processUserLogin(foundDoc, foundData, password);
  }

  // 3. Fallback: Try using the username as a Document ID (Oldest Standard)
  const userRef = db.collection('users').doc(username);
  const userDoc = await userRef.get();
  
  if (userDoc.exists) {
    const userData = userDoc.data();
    console.log('User found via document ID');
    return processUserLogin(userDoc, userData, password);
  }

  // 4. Fallback: Try using the normalized username as a Document ID
  const normalizedUserRef = db.collection('users').doc(normalizedUsername);
  const normalizedUserDoc = await normalizedUserRef.get();
  
  if (normalizedUserDoc.exists) {
    const normalizedUserData = normalizedUserDoc.data();
    console.log('User found via normalized document ID');
    return processUserLogin(normalizedUserDoc, normalizedUserData, password);
  }

  throw new Error('Invalid username or password');
};

const processUserLogin = async (userDoc: any, userData: any, password: any) => {
  if (userData.status === 'Disabled') {
    throw new Error('Account disabled');
  }

  if (!userData.password) {
    console.error(`User ${userData.username || userDoc.id} found but has no password field in database.`);
    throw new Error('Invalid user configuration: No password found in database');
  }

  const isPasswordValid = await bcrypt.compare(password, userData.password);
  if (!isPasswordValid) {
    throw new Error('Invalid username or password');
  }

  const isSuper = isSuperAdmin(userData.username || userDoc.id);
  const role = isSuper ? 'Admin' : (userData.roleTemplate || 'User');

  const payload = {
    uid: userDoc.id,
    username: userData.username || userDoc.id,
    email: userData.email || userData.username || userDoc.id,
    name: userData.name || userData.username || userDoc.id,
    role: role,
    permissions: userData.permissions || [],
    allowedWarehouses: isSuper ? ['*'] : (userData.allowedWarehouses || [])
  };

  const token = generateToken(payload);

  // Generate Firebase Custom Token for direct Firestore access
  let firebaseCustomToken = null;
  try {
    console.log(`[Auth] Attempting to generate Firebase Custom Token for UID: ${userDoc.id}`);
    firebaseCustomToken = await admin.auth().createCustomToken(userDoc.id, {
      email: userData.email || userData.username || userDoc.id,
      email_verified: true,
      role: role,
      permissions: userData.permissions || [],
      allowedWarehouses: isSuper ? ['*'] : (userData.allowedWarehouses || [])
    });
    console.log(`[Auth] Firebase Custom Token generated successfully for ${userDoc.id}`);
  } catch (e: any) {
    console.error('❌ Failed to create Firebase custom token with claims:', e.message || e);
    
    // Fallback: Try without claims
    try {
      console.log(`[Auth] Retrying Firebase Custom Token without claims for UID: ${userDoc.id}`);
      firebaseCustomToken = await admin.auth().createCustomToken(userDoc.id);
      console.log(`[Auth] Firebase Custom Token generated successfully (without claims) for ${userDoc.id}`);
    } catch (e2: any) {
      console.error('❌ Failed to create Firebase custom token even without claims:', e2.message || e2);
      console.log('💡 Tip: This usually means the Firebase Admin SDK is not initialized with a Service Account or the environment lacks "Service Account Token Creator" permissions.');
    }
  }

  return {
    token,
    firebaseCustomToken,
    user: payload
  };
};
