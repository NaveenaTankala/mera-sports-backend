import express from "express";
import { getPublicSettings, getPublicCategoryDraw, getPublicEventDraws } from "../controllers/publicController.js";

const router = express.Router();

router.get("/settings", getPublicSettings);

// Public draw/bracket endpoints (no auth required, only returns published draws)
router.get("/events/:id/categories/:categoryId/draw", getPublicCategoryDraw);
router.get("/events/:id/categories/draw", getPublicCategoryDraw); // Alternative with categoryLabel query
router.get("/events/:id/draws", getPublicEventDraws); // All published draws for an event

export default router;
