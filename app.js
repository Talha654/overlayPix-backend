import express from "express";
import cors from "cors";
import dotenv from "dotenv";

// Services
import { initializeCronJobs } from "./services/cron.service.js";

// Routes
import eventRoutes from "./routes/event.routes.js";
import guestRoutes from "./routes/guests.routes.js";
import deleteUserRoutes from "./routes/deleteUser.routes.js";

import pricingPlansRoutes from "./routes/admin/pricing-plans.route.js";
import adminOverlayRoutes from "./routes/admin/overlay.route.js";
import makeAdminRoutes from "./routes/admin/MakeAdmin.route.js";

import paymentRoutes from "./routes/payment.routes.js";

import dashboardRoutes from "./routes/admin/dashboard.route.js";
import eventPageRoutes from "./routes/admin/EventPage.route.js";
import userManagementRoutes from "./routes/admin/userManagement.route.js";
import auditRoutes from "./routes/admin/audit.route.js";
import discountCodeRoutes from "./routes/admin/discountcode.route.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Increase payload limit for image uploads
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Add URL-encoded middleware

// API Routes
app.use("/api/user", deleteUserRoutes)
app.use("/api/events", eventRoutes);
app.use("/api/guests", guestRoutes);

app.use("/api/plans", pricingPlansRoutes);
app.use("/api/admin/overlays", adminOverlayRoutes);

app.use("/api/payments", paymentRoutes);
app.use("/api/admin/dashboard", dashboardRoutes);
app.use("/api/admin/eventpage", eventPageRoutes);
app.use("/api/admin/users", userManagementRoutes);
app.use("/api/admin/audit", auditRoutes);
app.use("/api/admin/discountcodes", discountCodeRoutes);
app.use("/api/admin", makeAdminRoutes);

app.get('/api/images/proxy', async (req, res) => {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL parameter required' });
  }

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return res.status(response.status).json({ error: 'Image not found' });
    }

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/png';

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour

    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Failed to proxy image' });
  }
});

// Health check endpoint
app.get('/', (req, res) => {
  res.status(200).json({ message: 'Welcome to Overlay Pix' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Backend running at http://localhost:${PORT}`);

  // Initialize cron jobs after server starts
  try {
    initializeCronJobs();
    console.log('Cron jobs initialized successfully');
  } catch (error) {
    console.error('Failed to initialize cron jobs:', error);
  }
})

// For Vercel: export the app (do not call app.listen)
// export default app;

