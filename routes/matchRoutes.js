import express from "express";
import {
    createMatch,
    deleteCategoryMatches,
    deleteMatch,
    finalizeRoundMatches,
    generateMatchesFromBracket,
    generateLeagueMatches,
    getMatches,
    updateMatchScore,
    updateRoundSelectedSets
} from "../controllers/matchController.js";

const router = express.Router();

// Generate matches from existing bracket (Idempotent)
// POST /api/admin/matches/generate/:eventId/:categoryId
router.post("/generate/:eventId/:categoryId", generateMatchesFromBracket);

// Generate league (round-robin) matches from league blueprint (Idempotent)
// POST /api/admin/matches/generate-league/:eventId/:categoryId
router.post("/generate-league/:eventId/:categoryId", generateLeagueMatches);

// Create manual match
// POST /api/admin/matches
router.post("/", createMatch);

// Finalize all matches in a round (calculate winners and set COMPLETED)
// POST /api/admin/matches/:eventId/finalize
router.post("/:eventId/finalize", finalizeRoundMatches);

// Update selected sets (Best of N) for a bracket round
// POST /api/admin/matches/round-sets
router.post("/round-sets/update", updateRoundSelectedSets);

// Delete all matches for a category (MUST come before parameterized routes)
// DELETE /api/admin/matches/category/:eventId?categoryId=xxx&categoryName=xxx
router.delete("/category/:eventId", deleteCategoryMatches);

// Update score and status
// PUT /api/admin/matches/:matchId/score
router.put("/:matchId/score", updateMatchScore);

// Delete match (MUST come before GET /:eventId to avoid conflicts)
// DELETE /api/admin/matches/:matchId
router.delete("/:matchId", deleteMatch);

// Get matches for event (with optional categoryId query)
// GET /api/admin/matches/:eventId
router.get("/:eventId", getMatches);

export default router;
