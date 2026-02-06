import { supabaseAdmin } from "../config/supabaseClient.js";

// Simple UUID checker (kept in sync with other controllers)
const isUuid = (str) => {
    if (!str || typeof str !== "string") return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str.trim());
};

/**
 * GET league config for a category
 * GET /api/admin/events/:id/categories/:categoryId/league
 * (categoryId can be UUID or plain label; categoryLabel can also be passed as query)
 * 
 * Now uses dedicated 'leagues' table instead of event_brackets
 */
export const getLeagueConfig = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        // Try category_id first (can be UUID or string like "1767354643599")
        if (categoryId) {
            // category_id in leagues table is TEXT, so it accepts both UUID and string IDs
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            // Use category_label for lookup (fallback)
            query = query.eq("category_label", categoryLabel);
        }

        const { data, error } = await query.maybeSingle();

        if (error && error.code !== "PGRST116") {
            // PGRST116 = no rows found
            throw error;
        }

        if (!data) {
            // No config yet – return sensible defaults
            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: [],
                    rules: {
                        pointsWin: 3,
                        pointsLoss: 0,
                        pointsDraw: 1
                    }
                }
            });
        }

        return res.json({
            success: true,
            league: {
                format: "LEAGUE",
                participants: Array.isArray(data.participants) ? data.participants : [],
                rules: data.rules || {
                    pointsWin: 3,
                    pointsLoss: 0,
                    pointsDraw: 1
                }
            }
        });
    } catch (err) {
        console.error("GET LEAGUE CONFIG ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch league config" });
    }
};

/**
 * Save (create or update) league config for a category
 * POST /api/admin/events/:id/categories/:categoryId/league
 * Body: { categoryLabel, participants: [{id,name}], rules: { pointsWin, pointsLoss, pointsDraw? } }
 *
 * Uses dedicated 'leagues' table for clean separation from event_brackets
 */
export const saveLeagueConfig = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, participants, rules } = req.body || {};

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({ success: false, message: "At least one participant is required" });
        }

        // Clean and deduplicate participants
        // IMPORTANT: preserve group assignment (p.group) so group mode survives reloads
        const participantMap = new Map();
        participants.forEach((p) => {
            if (p && p.id && p.name) {
                const id = String(p.id);
                const name = String(p.name);
                const group = p.group || p.group_id || p.groupLabel || null;
                // Only keep first occurrence if duplicate IDs exist
                if (!participantMap.has(id)) {
                    participantMap.set(id, { id, name, ...(group ? { group: String(group) } : {}) });
                }
            }
        });

        const cleanedParticipants = Array.from(participantMap.values());

        if (cleanedParticipants.length === 0) {
            return res.status(400).json({ success: false, message: "Participants must have id and name" });
        }

        // Warn if duplicates were removed
        if (cleanedParticipants.length < participants.length) {
            console.warn(`Removed ${participants.length - cleanedParticipants.length} duplicate participant(s) from league config`);
        }

        const defaultRules = {
            pointsWin: 3,
            pointsLoss: 0,
            pointsDraw: 1
        };

        const cleanedRules = {
            pointsWin: typeof rules?.pointsWin === "number" ? rules.pointsWin : defaultRules.pointsWin,
            pointsLoss: typeof rules?.pointsLoss === "number" ? rules.pointsLoss : defaultRules.pointsLoss,
            pointsDraw: typeof rules?.pointsDraw === "number" ? rules.pointsDraw : defaultRules.pointsDraw
        };

        // Determine category_id and category_label
        // category_id can be UUID or string/number ID (like "1767354643599")
        // Store the categoryId as-is if provided (leagues.category_id is TEXT, so accepts any string)
        const categoryIdValue = categoryId ? String(categoryId) : null;
        const categoryLabelValue = categoryLabel || categoryId || "Unknown";

        // Check if league already exists
        let existingQuery = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId)
            .eq("category_label", categoryLabelValue);

        const { data: existing, error: fetchError } = await existingQuery.maybeSingle();

        if (fetchError && fetchError.code !== "PGRST116") {
            throw fetchError;
        }

        if (existing) {
            // Update existing league
            const { data, error } = await supabaseAdmin
                .from("leagues")
                .update({
                    category_id: categoryIdValue,
                    category_label: categoryLabelValue,
                    participants: cleanedParticipants,
                    rules: cleanedRules,
                    updated_at: new Date().toISOString()
                })
                .eq("id", existing.id)
                .select()
                .maybeSingle();

            if (error) throw error;

            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: cleanedParticipants,
                    rules: cleanedRules
                },
                leagueId: data.id,
                message: "League configuration updated"
            });
        }

        // Create new league
        const insertPayload = {
            event_id: eventId,
            category_id: categoryIdValue,
            category_label: categoryLabelValue,
            participants: cleanedParticipants,
            rules: cleanedRules
        };

        const { data, error } = await supabaseAdmin
            .from("leagues")
            .insert(insertPayload)
            .select()
            .maybeSingle();

        if (error) throw error;

        return res.status(201).json({
            success: true,
            league: {
                format: "LEAGUE",
                participants: cleanedParticipants,
                rules: cleanedRules
            },
            leagueId: data.id,
            message: "League configuration saved"
        });
    } catch (err) {
        console.error("SAVE LEAGUE CONFIG ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to save league config" });
    }
};

/**
 * DELETE league configuration and optionally all associated matches
 * DELETE /api/admin/events/:id/categories/:categoryId/league
 * Query params: deleteMatches (optional, default: true) - whether to delete associated matches
 * 
 * This will:
 * 1. Delete the league record from the 'leagues' table
 * 2. Optionally delete all matches with round_name='LEAGUE' for this category
 */
export const deleteLeague = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;
        const deleteMatches = req.query.deleteMatches !== 'false'; // Default: true

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ success: false, message: "Event ID and Category required" });
        }

        // Find the league record
        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category_label", categoryLabel);
        } else if (categoryId) {
            query = query.eq("category_label", categoryId);
        }

        const { data: leagueRecord, error: fetchError } = await query.maybeSingle();

        if (fetchError && fetchError.code !== "PGRST116") {
            throw fetchError;
        }

        if (!leagueRecord) {
            return res.status(404).json({
                success: false,
                message: "League configuration not found"
            });
        }

        // Optionally delete associated matches
        if (deleteMatches) {
            // Get category identifier for match deletion
            const categoryIdForMatches = leagueRecord.category_id || categoryId || categoryLabel;
            const categoryLabelForMatches = leagueRecord.category_label || categoryLabel || categoryId;

            // CRITICAL FIX: Use safe in-memory filtering instead of dangerous fallback
            // This prevents accidentally deleting matches from other categories

            // First, fetch all LEAGUE matches for this event
            const { data: allLeagueMatches, error: fetchMatchesError } = await supabaseAdmin
                .from("matches")
                .select("id, category_id, event_id, round_name")
                .eq("event_id", eventId)
                .eq("round_name", "LEAGUE");

            if (fetchMatchesError) {
                console.error("Error fetching league matches for deletion:", fetchMatchesError);
                // Continue with league deletion even if match fetch fails
            } else {
                // Filter matches in memory to ensure exact category match
                // This is safer than database-level filtering which might fail
                const matchesToDelete = (allLeagueMatches || []).filter(m => {
                    const mCatId = m.category_id;
                    if (!mCatId) return false;

                    // Try exact match first
                    if (String(mCatId) === String(categoryIdForMatches)) {
                        return true;
                    }

                    // Try type-coerced match
                    if (mCatId == categoryIdForMatches) {
                        return true;
                    }

                    // If categoryIdForMatches is not available, use category_label matching
                    // This is a fallback but should be avoided
                    if (!categoryIdForMatches && categoryLabelForMatches) {
                        // Note: matches table doesn't have category_label, so we can't match by label
                        // This is why we require category_id
                        return false;
                    }

                    return false;
                });

                if (matchesToDelete.length > 0) {
                    const matchIds = matchesToDelete.map(m => m.id);

                    // Delete only the filtered matches
                    const { error: matchDeleteError } = await supabaseAdmin
                        .from("matches")
                        .delete()
                        .in("id", matchIds);

                    if (matchDeleteError) {
                        console.error("Error deleting league matches:", matchDeleteError);
                        // Continue with league deletion even if match deletion fails
                    } else {
                        console.log(`Deleted ${matchesToDelete.length} league match(es) for category ${categoryLabelForMatches}`);
                    }
                } else {
                    console.log(`No league matches found to delete for category ${categoryLabelForMatches}`);
                }
            }
        }

        // Delete the league record
        const { error: deleteError } = await supabaseAdmin
            .from("leagues")
            .delete()
            .eq("id", leagueRecord.id);

        if (deleteError) {
            throw deleteError;
        }

        return res.json({
            success: true,
            message: deleteMatches
                ? "League configuration and all associated matches deleted successfully"
                : "League configuration deleted successfully (matches preserved)",
            deletedLeagueId: leagueRecord.id
        });
    } catch (err) {
        console.error("DELETE LEAGUE ERROR:", err);
        return res.status(500).json({
            success: false,
            message: "Failed to delete league configuration",
            error: err.message
        });
    }
};
