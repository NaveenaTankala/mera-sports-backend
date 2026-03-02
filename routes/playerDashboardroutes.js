import express from "express";
import multer from "multer";
import {
    addFamilyMember,
    changePassword,
    checkConflict, checkPassword,
    deleteAccount,
    deleteFamilyMember,
    getPlayerDashboard,
    updateFamilyMember,
    updateProfile
} from "../controllers/playerController.js";
import { deleteMedia, getMedia, uploadMedia } from "../controllers/mediaController.js";
import { verifyPlayer } from "../middleware/rbacMiddleware.js";

// Multer: memory storage, accept images ≤ 5MB & videos ≤ 50MB
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB hard cap per file
    fileFilter: (_req, file, cb) => {
        const allowed = [
            "image/jpeg", "image/png", "image/jpg", "image/webp",
            "video/mp4", "video/webm", "video/quicktime", "video/x-msvideo",
        ];
        if (allowed.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("Unsupported file type"), false);
        }
    },
});

const router = express.Router();

router.get("/dashboard", verifyPlayer, getPlayerDashboard);
router.post("/check-conflict", verifyPlayer, checkConflict);
router.post("/check-password", verifyPlayer, checkPassword);
router.put("/update-profile", verifyPlayer, updateProfile);
router.put("/change-password", verifyPlayer, changePassword);
router.delete("/delete-account", verifyPlayer, deleteAccount);

/* ================= FAMILY MEMBERS ================= */
router.post("/add-family-member", verifyPlayer, addFamilyMember);
router.put("/update-family-member/:id", verifyPlayer, updateFamilyMember);
router.delete("/delete-family-member/:id", verifyPlayer, deleteFamilyMember);

/* ================= MEDIA UPLOADS ================= */
router.post("/upload-media", verifyPlayer, upload.single("image"), uploadMedia);
router.get("/media", verifyPlayer, getMedia);
router.delete("/delete-media/:id", verifyPlayer, deleteMedia);

export default router;
