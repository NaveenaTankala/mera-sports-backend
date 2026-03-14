import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";

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

        //console.log(`📋 Getting league config: eventId=${eventId}, categoryId=${categoryId}, categoryLabel=${categoryLabel}`);

        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        // IMPORTANT: Use category_id as primary identifier (can be UUID or string like "1767354643599")
        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            // Use category_label as fallback only if category_id not provided
            query = query.eq("category_label", categoryLabel);
        }

        let { data, error } = await query.maybeSingle();

        if (error && error.code !== "PGRST116") {
            // PGRST116 = no rows found
            throw error;
        }

        // If not found AND categoryId was provided but not UUID, try category_label as fallback
        if (!data && categoryId && !isUuid(categoryId)) {
            const fallbackQuery = supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", String(categoryId));
            
            const { data: fallbackData, error: fallbackError } = await fallbackQuery.maybeSingle();
            if (!fallbackError || fallbackError.code === "PGRST116") {
                data = fallbackData;
            }
        }

        if (!data) {
            // No config yet - return sensible defaults
            //console.log(`ℹ️ No league config found for eventId=${eventId}, categoryId=${categoryId}. Returning defaults.`);
            return res.json({
                success: true,
                league: {
                    format: "LEAGUE",
                    participants: [],
                    rules: {
                        pointsWin: 3,
                        pointsLoss: 0,
                        pointsDraw: 1,
                        win: 3,
                        loss: 0,
                        draw: 1,
                        setsPerMatch: 1
                    }
                }
            });
        }

        //console.log(`✅ Found league config: categoryId=${data.category_id}, participants=${data.participants?.length || 0}`);
        
        return res.json({
            success: true,
            league: {
                format: "LEAGUE",
                participants: Array.isArray(data.participants) ? data.participants : [],
                rules: data.rules || {
                    pointsWin: 3,
                    pointsLoss: 0,
                    pointsDraw: 1,
                    win: 3,
                    loss: 0,
                    draw: 1,
                    setsPerMatch: 1
                }
            }
        });
    } catch (err) {
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

        //console.log(`💾 Saving league config: eventId=${eventId}, categoryId=${categoryId}, categoryLabel=${categoryLabel}, participants=${participants?.length || 0}`);

        if (!Array.isArray(participants) || participants.length === 0) {
            return res.status(400).json({ success: false, message: "At least one participant is required" });
        }

        // Clean and deduplicate participants
        // IMPORTANT: preserve group assignment (p.group) so group mode survives reloads
        // Also preserve team league fields: isTeam, isBye, members, captainName, teamId
        const participantMap = new Map();
        participants.forEach((p) => {
            if (p && p.id && p.name) {
                const id = String(p.id);
                const name = String(p.name);
                const group = p.group || p.group_id || p.groupLabel || null;
                // Only keep first occurrence if duplicate IDs exist
                if (!participantMap.has(id)) {
                    const entry = { id, name, ...(group ? { group: String(group) } : {}) };
                    // Preserve team league fields if present
                    if (p.isTeam) entry.isTeam = true;
                    if (p.isBye) entry.isBye = true;
                    if (p.teamId) entry.teamId = String(p.teamId);
                    if (p.captainName) entry.captainName = String(p.captainName);
                    if (Array.isArray(p.members) && p.members.length > 0) entry.members = p.members;
                    participantMap.set(id, entry);
                }
            }
        });

        const cleanedParticipants = Array.from(participantMap.values());

        if (cleanedParticipants.length === 0) {
            return res.status(400).json({ success: false, message: "Participants must have id and name" });
        }

        const defaultRules = {
            pointsWin: 3,
            pointsLoss: 0,
            pointsDraw: 1,
            setsPerMatch: 1
        };

        // Preserve all rule fields sent from frontend (win, loss, draw, setsPerMatch)
        // Also support backend format (pointsWin, pointsLoss, pointsDraw)
        const cleanedRules = {
            // Support both frontend format (win/loss/draw) and backend format (pointsWin/pointsLoss/pointsDraw)
            win: typeof rules?.win === "number" ? rules.win : (typeof rules?.pointsWin === "number" ? rules.pointsWin : defaultRules.pointsWin),
            loss: typeof rules?.loss === "number" ? rules.loss : (typeof rules?.pointsLoss === "number" ? rules.pointsLoss : defaultRules.pointsLoss),
            draw: typeof rules?.draw === "number" ? rules.draw : (typeof rules?.pointsDraw === "number" ? rules.pointsDraw : defaultRules.pointsDraw),
            // Also preserve setsPerMatch if provided
            setsPerMatch: typeof rules?.setsPerMatch === "number" ? rules.setsPerMatch : defaultRules.setsPerMatch,
            // Preserve winner mode (set_based, score_based, or match_based)
            ...(rules?.winnerMode && ['set_based', 'score_based', 'match_based'].includes(rules.winnerMode) ? { winnerMode: rules.winnerMode } : {}),
            // Preserve league mode (regular or team)
            ...(rules?.leagueMode ? { leagueMode: String(rules.leagueMode) } : {}),
            // Keep backend format fields for backward compatibility
            pointsWin: typeof rules?.pointsWin === "number" ? rules.pointsWin : (typeof rules?.win === "number" ? rules.win : defaultRules.pointsWin),
            pointsLoss: typeof rules?.pointsLoss === "number" ? rules.pointsLoss : (typeof rules?.loss === "number" ? rules.loss : defaultRules.pointsLoss),
            pointsDraw: typeof rules?.pointsDraw === "number" ? rules.pointsDraw : (typeof rules?.draw === "number" ? rules.draw : defaultRules.pointsDraw),
            // Preserve team league definitions if provided
            ...(Array.isArray(rules?.teams) && rules.teams.length > 0 ? { teams: rules.teams } : {}),
            // Preserve directKnockout flag (teams sent straight to knockout, no league rounds)
            ...(rules?.directKnockout === true ? { directKnockout: true } : {}),
            // Preserve player ranks assigned by admin in league tab
            ...(rules?.playerRanks && typeof rules.playerRanks === 'object' && Object.keys(rules.playerRanks).length > 0 ? { playerRanks: rules.playerRanks } : {})
        };

        // Determine category_id and category_label
        // category_id can be UUID or string/number ID (like "1767354643599")
        // Store the categoryId as-is if provided (leagues.category_id is TEXT, so accepts any string)
        const categoryIdValue = categoryId ? String(categoryId) : null;
        let categoryLabelValue = categoryLabel || categoryId || "Unknown";

        // FIX: If we already have a record for this category_id, use ITS category_label
        // to prevent creating duplicate rows when categoryLabel differs between calls
        if (categoryIdValue) {
            const { data: existing } = await supabaseAdmin
                .from("leagues")
                .select("category_label")
                .eq("event_id", eventId)
                .eq("category_id", categoryIdValue)
                .maybeSingle();
            if (existing && existing.category_label) {
                categoryLabelValue = existing.category_label;
            }
        }

        //console.log(`📝 UPSERT VALUES: eventId=${eventId}, categoryId=${categoryIdValue}, categoryLabel=${categoryLabelValue} (will be used in UNIQUE constraint)`);

        // UPSERT: Use atomic insert-or-update to avoid race conditions
        // This handles concurrent requests to create the same (event_id, category_label) pair
       // console.log(`📝 Upserting league for categoryId=${categoryId}, categoryLabel=${categoryLabelValue}`);
        
        const upsertPayload = {
            event_id: eventId,
            category_id: categoryIdValue,
            category_label: categoryLabelValue,
            participants: cleanedParticipants,
            rules: cleanedRules,
            updated_at: new Date().toISOString()
        };

        const { data, error } = await supabaseAdmin
            .from("leagues")
            .upsert(upsertPayload, {
                // The database has a unique constraint on (event_id, category_label)
                // Pass the column names that make up the constraint
                onConflict: "event_id,category_label"
            })
            .select()
            .maybeSingle();

        if (error) {
            console.error(`❌ Upsert failed for categoryId=${categoryId}: ${error.code} - ${error.message}`);
            throw error;
        }

        console.log(`✅ League saved successfully for categoryId=${categoryId}`);

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
        console.error(`🚨 SaveLeagueConfig ERROR: ${err.message || err.code || err}`);
        return res.status(500).json({ success: false, message: err.message || "Failed to save league config", errorCode: err.code });
    }
};

/**
 * Send league promotion notifications to promoted players/team members.
 * POST /api/admin/events/:id/categories/:categoryId/league/notify-promotions
 */
export const notifyLeaguePromotions = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const {
            categoryLabel,
            completedRoundName,
            nextRoundName,
            promotionType,
            promotions,
        } = req.body || {};

        if (!eventId) {
            return res.status(400).json({ success: false, message: "Event ID required" });
        }

        if (!Array.isArray(promotions) || promotions.length === 0) {
            return res.json({ success: true, notified: 0, duplicates: 0 });
        }

        const categoryKey = String(categoryId || categoryLabel || "unknown-category").trim();
        const safeCompletedRound = String(completedRoundName || "League Stage").trim();
        const safeNextRound = String(nextRoundName || "Next Round").trim();
        const safePromotionType = promotionType === "knockout" ? "knockout" : "next-round";

        const formatSummary = (promotion) => {
            const segments = [];
            const points = Number(promotion?.points);
            const played = Number(promotion?.played);
            const wins = Number(promotion?.wins);
            const draws = Number(promotion?.draws);
            const losses = Number(promotion?.losses);
            const totalScore = Number(promotion?.totalScore);
            const matchWins = Number(promotion?.matchWins);

            if (Number.isFinite(points)) segments.push(`${points} pts`);
            if (Number.isFinite(played) || Number.isFinite(wins) || Number.isFinite(draws) || Number.isFinite(losses)) {
                segments.push(`P${Number.isFinite(played) ? played : 0} W${Number.isFinite(wins) ? wins : 0} D${Number.isFinite(draws) ? draws : 0} L${Number.isFinite(losses) ? losses : 0}`);
            }
            if (Number.isFinite(totalScore) && totalScore > 0) segments.push(`Score ${totalScore}`);
            if (Number.isFinite(matchWins) && matchWins > 0) segments.push(`Match wins ${matchWins}`);
            return segments.join(" | ");
        };

        const truncateMembers = (memberNames) => {
            if (!Array.isArray(memberNames) || memberNames.length === 0) return "";
            const names = memberNames.map((name) => String(name || "").trim()).filter(Boolean);
            if (names.length === 0) return "";
            if (names.length <= 3) return names.join(", ");
            return `${names.slice(0, 3).join(", ")} +${names.length - 3} more`;
        };

        const resolveNotificationUserId = async (rawRecipientId) => {
            const normalizedId = String(rawRecipientId || "").trim();
            if (!normalizedId) return null;
            if (isUuid(normalizedId)) return normalizedId;

            const { data: userByPlayerCode, error: playerCodeError } = await supabaseAdmin
                .from("users")
                .select("id")
                .eq("player_id", normalizedId)
                .limit(1)
                .maybeSingle();

            if (playerCodeError) {
                console.error("[notifyLeaguePromotions] User lookup by player_id failed:", playerCodeError);
            }
            if (userByPlayerCode?.id && isUuid(String(userByPlayerCode.id))) {
                return String(userByPlayerCode.id);
            }

            return null;
        };

        const results = await Promise.allSettled(
            promotions.map(async (promotion) => {
                const entityId = String(promotion?.entityId || promotion?.playerId || "").trim();
                const entityName = String(promotion?.entityName || promotion?.playerName || "Player").trim();
                const sourceGroup = String(promotion?.sourceGroup || "").trim();
                const destinationGroup = String(promotion?.destinationGroup || "").trim();
                const sourcePosition = Number(promotion?.sourcePosition);
                const memberNames = Array.isArray(promotion?.memberNames) ? promotion.memberNames : [];
                const explicitRecipients = Array.isArray(promotion?.recipientIds)
                    ? promotion.recipientIds.map((id) => String(id || "").trim()).filter(Boolean)
                    : [];

                let recipientIds = explicitRecipients;
                if (recipientIds.length === 0 && entityId) {
                    recipientIds = [entityId];
                }
                if (recipientIds.length === 0) {
                    return { status: "skipped" };
                }

                const dedupeLink = `league-promotion:${eventId}:${categoryKey}:${safeCompletedRound}:${safeNextRound}:${safePromotionType}:${entityId || recipientIds.join(",")}`;
                const summary = formatSummary(promotion);
                const placeText = Number.isFinite(sourcePosition) ? `#${sourcePosition}` : "qualified";
                const groupText = sourceGroup ? `Group ${sourceGroup}` : "the league stage";
                const destinationText = safePromotionType === "knockout"
                    ? `the knockout bracket${destinationGroup ? ` (${destinationGroup})` : ""}`
                    : `${safeNextRound}${destinationGroup ? ` in Group ${destinationGroup}` : ""}`;
                const teamDetail = truncateMembers(memberNames);

                const title = safePromotionType === "knockout"
                    ? `🏆 Promoted to Knockout Bracket`
                    : `🏆 Promoted to ${safeNextRound}`;
                const message = [
                    `You finished ${placeText} in ${groupText} and have been promoted to ${destinationText}.`,
                    summary ? `Standing: ${summary}.` : "",
                    teamDetail ? `Team members: ${teamDetail}.` : "",
                    categoryLabel ? `Category: ${categoryLabel}.` : "",
                ].filter(Boolean).join(" ");

                let sent = 0;
                let duplicates = 0;
                for (const rawRecipientId of recipientIds) {
                    const recipientId = await resolveNotificationUserId(rawRecipientId);
                    if (!recipientId) {
                        console.warn(`[notifyLeaguePromotions] Skipping unresolved recipient: ${rawRecipientId}`);
                        continue;
                    }

                    const { data: existingRows, error: existingError } = await supabaseAdmin
                        .from("notifications")
                        .select("id")
                        .eq("user_id", recipientId)
                        .eq("link", dedupeLink)
                        .limit(1);

                    if (existingError) {
                        console.error("[notifyLeaguePromotions] Dedupe check failed:", existingError);
                    }

                    if (Array.isArray(existingRows) && existingRows.length > 0) {
                        duplicates += 1;
                        continue;
                    }

                    const created = await createNotification(recipientId, title, message, "success", dedupeLink);
                    if (created) {
                        sent += 1;
                    }
                }

                return { status: sent > 0 ? "sent" : "duplicate", sent, duplicates };
            })
        );

        const summary = results.reduce(
            (acc, result) => {
                if (result.status !== "fulfilled") return acc;
                acc.notified += result.value?.sent || 0;
                acc.duplicates += result.value?.duplicates || 0;
                return acc;
            },
            { notified: 0, duplicates: 0 }
        );

        return res.json({
            success: true,
            notified: summary.notified,
            duplicates: summary.duplicates,
        });
    } catch (err) {
        console.error("notifyLeaguePromotions error:", err);
        return res.status(500).json({ success: false, message: "Failed to send promotion notifications" });
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
        // Use category_id as PRIMARY lookup (works for both UUID and non-UUID like "1767354643599")
        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            query = query.eq("category_label", categoryLabel);
        }

        let { data: leagueRecord, error: fetchError } = await query.maybeSingle();

        // Fallback: if not found by category_id and it's non-UUID, try category_label
        if (!leagueRecord && categoryId && !isUuid(categoryId)) {
            const fallbackQuery = supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", categoryLabel || String(categoryId));
            const { data: fallbackData, error: fallbackError } = await fallbackQuery.maybeSingle();
            if (!fallbackError || fallbackError?.code === "PGRST116") {
                leagueRecord = fallbackData;
                fetchError = null;
            }
        }

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
                // Continue with league deletion even if match fetch fails
            } else {
                // Filter matches in memory to ensure exact category match
                // This is safer than database-level filtering which might fail
                const matchesToDelete = (allLeagueMatches || []).filter(m => {
                    const mCatId = m.category_id;
                    if (!mCatId) return false;

                    // Use strict string comparison only
                    if (String(mCatId) === String(categoryIdForMatches)) {
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
                        // Continue with league deletion even if match deletion fails
                    } else {
                    }
                } else {
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
        return res.status(500).json({
            success: false,
            message: "Failed to delete league configuration",
            error: err.message
        });
    }
};
