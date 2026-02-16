import { admin } from "../services/firebase.service.js";

export const authenticate = async (req, res, next) => {
  // Detailed logging of incoming request
  console.log(`[AUTH] Incoming request: ${req.method} ${req.originalUrl}`);
  console.log(`[AUTH] Headers:`, JSON.stringify(req.headers, null, 2));

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn('[AUTH] No Authorization header provided');
    return res.status(401).json({ error: 'Unauthorized - No Authorization header provided' });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.warn('[AUTH] Authorization header does not start with Bearer');
    return res.status(401).json({ error: 'Unauthorized - Authorization header must start with Bearer' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (!idToken) {
    console.warn('[AUTH] Bearer token missing after Bearer keyword');
    return res.status(401).json({ error: 'Unauthorized - Bearer token missing' });
  }

  try {
    console.log('[AUTH] Verifying Firebase ID token...');
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Check if user is anonymous
    const isAnonymous = decodedToken.provider_id === 'anonymous' || decodedToken.sign_in_provider === 'anonymous';
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: decodedToken.role || 'user',
      isAnonymous: isAnonymous,
      providerId: decodedToken.provider_id || decodedToken.sign_in_provider
    };
    
    console.log(`[AUTH] Token verified for user: ${req.user.uid} (${req.user.email}) - Anonymous: ${isAnonymous}`);
    next();
  } catch (error) {
    console.error('[AUTH] Token verification failed:', error.message, error.stack);
    res.status(403).json({ error: 'Forbidden - Invalid or expired token', details: error.message });
  }
};

// Middleware for guest routes (allows both anonymous and authenticated users)
export const authenticateGuest = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn('[AUTH] No Authorization header provided for guest route');
    return res.status(401).json({ error: 'Unauthorized - No Authorization header provided' });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.warn('[AUTH] Authorization header does not start with Bearer');
    return res.status(401).json({ error: 'Unauthorized - Authorization header must start with Bearer' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (!idToken) {
    console.warn('[AUTH] Bearer token missing after Bearer keyword');
    return res.status(401).json({ error: 'Unauthorized - Bearer token missing' });
  }

  try {
    console.log('[AUTH] Verifying Firebase ID token for guest...');
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Check if user is anonymous
    const isAnonymous = decodedToken.provider_id === 'anonymous' || decodedToken.sign_in_provider === 'anonymous';
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: isAnonymous ? 'guest' : 'user',
      isAnonymous: isAnonymous,
      providerId: decodedToken.provider_id || decodedToken.sign_in_provider
    };
    
    console.log(`[AUTH] Guest token verified: ${req.user.uid} - Anonymous: ${isAnonymous}`);
    next();
  } catch (error) {
    console.error('[AUTH] Guest token verification failed:', error.message, error.stack);
    res.status(403).json({ error: 'Forbidden - Invalid or expired token', details: error.message });
  }
};

// Middleware to require authenticated (non-anonymous) users
export const requireAuthenticated = (req, res, next) => {
  if (req.user.isAnonymous) {
    console.warn(`[AUTH] Anonymous user ${req.user.uid} attempted to access authenticated-only route`);
    return res.status(403).json({ error: 'Forbidden - This action requires a registered account' });
  }
  next();
};

// Middleware to allow only anonymous users
export const requireAnonymous = (req, res, next) => {
  if (!req.user.isAnonymous) {
    console.warn(`[AUTH] Authenticated user ${req.user.uid} attempted to access anonymous-only route`);
    return res.status(403).json({ error: 'Forbidden - This action is for anonymous users only' });
  }
  next();
};

export const authorizeRole = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      console.warn(`[AUTH] User ${req.user.uid} does not have required role. Required: ${roles}, Found: ${req.user.role}`);
      return res.status(403).json({ error: 'Forbidden - Insufficient permissions' });
    }
    next();
  };
};

// Middleware to verify admin users specifically
export const verifyAdmin = async (req, res, next) => {
  // Detailed logging of incoming request
  console.log(`[AUTH] Admin verification request: ${req.method} ${req.originalUrl}`);
  console.log(`[AUTH] Headers:`, JSON.stringify(req.headers, null, 2));

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    console.warn('[AUTH] No Authorization header provided for admin verification');
    return res.status(401).json({ error: 'Unauthorized - No Authorization header provided' });
  }

  if (!authHeader.startsWith('Bearer ')) {
    console.warn('[AUTH] Authorization header does not start with Bearer');
    return res.status(401).json({ error: 'Unauthorized - Authorization header must start with Bearer' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  if (!idToken) {
    console.warn('[AUTH] Bearer token missing after Bearer keyword');
    return res.status(401).json({ error: 'Unauthorized - Bearer token missing' });
  }

  try {
    console.log('[AUTH] Verifying Firebase ID token for admin...');
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Check if user is anonymous
    const isAnonymous = decodedToken.provider_id === 'anonymous' || decodedToken.sign_in_provider === 'anonymous';
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email || '',
      role: decodedToken.role || 'user',
      isAnonymous: isAnonymous,
      providerId: decodedToken.provider_id || decodedToken.sign_in_provider
    };
    
    // Check if user has admin role
    if (req.user.role !== 'admin') {
      console.warn(`[AUTH] User ${req.user.uid} attempted admin access. Role: ${req.user.role}, Required: admin`);
      return res.status(403).json({ error: 'Forbidden - Admin access required' });
    }

    console.log(`[AUTH] Admin access granted for user: ${req.user.uid} (${req.user.email})`);
    next();
  } catch (error) {
    console.error('[AUTH] Admin token verification failed:', error.message, error.stack);
    res.status(403).json({ error: 'Forbidden - Invalid or expired token', details: error.message });
  }
};