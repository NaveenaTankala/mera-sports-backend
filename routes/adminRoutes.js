import express from "express";
import {
    approveAdmin,
    deleteAdmin,
    getDashboardStats,
    listAdmins,
    rejectAdmin,
    updateAdminRole,
    uploadAsset
} from "../controllers/adminController.js";
import {
    bulkUpdateTransactions,
    createEventNews,
    deleteBracket,
    deleteEventNews,
    getAllCategories,
    getBrackets,
    getEventNews,
    getRegistrations, getTransactions,
    rejectTransaction,
    saveBracket,
    updateEventNews,
    verifyTransaction
} from "../controllers/adminEventController.js";
import {
    getPlayerDetails,
    listPlayers
} from "../controllers/adminPlayerController.js";
import { sendBroadcast } from "../controllers/broadcastController.js";
import {
    getSettings, updateSettings
} from "../controllers/settingsController.js";
import { verifyAdmin } from "../middleware/rbacMiddleware.js";

const router = express.Router();

/* ================= ADMIN MANAGEMENT ================= */
router.get("/list-admins", verifyAdmin, listAdmins);
router.post("/approve-admin/:id", verifyAdmin, approveAdmin);
router.post("/reject-admin/:id", verifyAdmin, rejectAdmin);
router.post("/update-admin-role/:id", verifyAdmin, updateAdminRole);
router.delete("/delete-admin/:id", verifyAdmin, deleteAdmin);

/* ================= DASHBOARD ================= */
router.get("/dashboard-stats", verifyAdmin, getDashboardStats);
router.post("/upload", verifyAdmin, uploadAsset);
router.post("/broadcast", verifyAdmin, sendBroadcast); // Added Route

/* ================= PLAYER MANAGEMENT ================= */
router.get("/players", verifyAdmin, listPlayers);
router.get("/players/:id", verifyAdmin, getPlayerDetails);

/* ================= SETTINGS ================= */
router.get("/settings", verifyAdmin, getSettings);
router.post("/settings", verifyAdmin, updateSettings);

/* ================= EVENT MANAGEMENT (GLOBAL) ================= */
router.get("/all-categories", verifyAdmin, getAllCategories);
router.get("/registrations", verifyAdmin, getRegistrations);
router.get("/transactions", verifyAdmin, getTransactions);

/* ================= TRANSACTION ACTIONS ================= */
router.put("/transactions/:id/verify", verifyAdmin, verifyTransaction);
router.put("/transactions/:id/reject", verifyAdmin, rejectTransaction);
router.post("/transactions/bulk-update", verifyAdmin, bulkUpdateTransactions);

/* ================= NEWS MANAGEMENT ================= */
router.get("/news", verifyAdmin, getEventNews);
router.post("/news", verifyAdmin, createEventNews);
router.put("/news/:id", verifyAdmin, updateEventNews);
router.delete("/news/:id", verifyAdmin, deleteEventNews);

/* ================= BRACKETS MANAGEMENT ================= */
router.get("/brackets", verifyAdmin, getBrackets);
router.post("/brackets", verifyAdmin, saveBracket);
router.delete("/brackets/:id", verifyAdmin, deleteBracket); // Fixed to use param
// Cleaned up the confusing DELETE /brackets without ID from old code

export default router;