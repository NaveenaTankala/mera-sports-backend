import express from "express";
import {
    requestBulkApproval,
    getApprovalStatus,
    finalizeBulkImport
} from "../controllers/instituteController.js";
import { verifyInstitute } from "../middleware/rbacMiddleware.js";

const router = express.Router();

// 1. POST /api/institute/request-bulk-approval
router.post("/request-bulk-approval", verifyInstitute, requestBulkApproval);

// 2. GET /api/institute/approval-status
router.get("/approval-status", verifyInstitute, getApprovalStatus);

// 3. POST /api/institute/bulk-import-finalize
router.post("/bulk-import-finalize", verifyInstitute, finalizeBulkImport);

export default router;
