import { supabaseAdmin } from "../config/supabaseClient.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// Simple UUID v4 validator (relaxed - checks standard 36-char UUID format)
const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

// Backward-compat: legacy schema has round_name NOT NULL. Our v2 is per-category,
// so we store a stable value in round_name to satisfy the constraint.
const LEGACY_ROUND_NAME_MEDIA = "Draws";
const LEGACY_ROUND_NAME_BRACKET = "Bracket";

const inferRoundLabelFromMatchCount = (matchCount, fallbackIndex) => {
    if (matchCount === 1) return "Final";
    if (matchCount === 2) return "Semifinal";
    if (matchCount === 4) return "Quarterfinal";
    return `Round ${fallbackIndex + 1}`;
};

// Helper to create empty match structure for bracket visualization
// NOTE: score: null is for structure only - authoritative scores are in matches table
const makeEmptyMatch = () => ({
    id: `match-${Date.now()}-${Math.random()}`,
    player1: null,
    player2: null,
    winner: null,
    score: null // Structure only - not authoritative
});

/**
 * Bracket Data Structure:
 * {
 *   rounds: [
 *     {
 *       name: "Round of 32",
 *       matches: [
 *         {
 *           id: "match-1",
 *           player1: { id: "user-id", name: "Player Name", seed?: number },
 *           player2: { id: "user-id", name: "Player Name", seed?: number },
 *           winner?: "player1" | "player2",
 *           score?: { player1: 21, player2: 18 },
 *           scheduledAt?: "2026-01-29T12:20:00Z"
 *         }
 *       ]
 *     }
 *   ],
 *   players: [
 *     { id: "user-id", name: "Player Name", seed: 1, eliminated: false }
 *   ]
 * }
 */

/**
 * Get draw/bracket for a specific category
 * GET /api/admin/events/:id/categories/:categoryId/draw
 */
export const getCategoryDraw = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId) return res.status(400).json({ message: "Event ID required" });

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            // Try exact match first
            query = query.eq("category", categoryLabel);
        } else {
            return res.status(400).json({ message: "Category ID or label required" });
        }

        let { data, error } = await query.order("created_at", { ascending: true });

        // If no exact match and categoryLabel provided, try partial matching
        if ((!data || data.length === 0) && categoryLabel && !categoryId) {
            // Try to find brackets where category contains parts of the label
            const labelParts = categoryLabel.split(" - ").filter(p => p.trim());
            if (labelParts.length > 0) {
                const baseCategory = labelParts[0]; // e.g., "U-11 (Male)" or "U-11"
                const { data: partialData, error: partialError } = await supabaseAdmin
                    .from("event_brackets")
                    .select("*")
                    .eq("event_id", eventId)
                    .ilike("category", `%${baseCategory}%`)
                    .order("created_at", { ascending: true });

                if (!partialError && partialData && partialData.length > 0) {
                    data = partialData;
                    error = null;
                }
            }
        }

        if (error) throw error;


        // Group by mode - prioritize BRACKET over MEDIA if both exist
        const mediaDraw = data.find(b => b.mode === 'MEDIA');
        const bracketDraw = data.find(b => b.mode === 'BRACKET');

        // Determine mode: BRACKET takes priority if it exists
        const mode = bracketDraw ? 'BRACKET' : (mediaDraw ? 'MEDIA' : null);

        res.json({
            success: true,
            draw: {
                categoryId: categoryId || null,
                categoryLabel: categoryLabel || data[0]?.category,
                mode: mode,
                media: mediaDraw ? {
                    id: mediaDraw.id,
                    urls: mediaDraw.media_urls || [],
                    pdfUrl: mediaDraw.pdf_url,
                    published: mediaDraw.published
                } : null,
                bracket: bracketDraw ? {
                    id: bracketDraw.id,
                    roundStructure: bracketDraw.round_structure || [],
                    bracketData: bracketDraw.bracket_data || {},
                    published: bracketDraw.published
                } : null
            }
        });
    } catch (err) {
        console.error("GET CATEGORY DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to fetch category draw", error: err.message });
    }
};

/**
 * Initialize bracket mode for a category
 * POST /api/admin/events/:id/categories/:categoryId/bracket/init
 */
export const initBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundStructure } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Check if category already has a draw
        let checkQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category_id", categoryId);
        } else {
            checkQuery = checkQuery.eq("category", categoryLabel);
        }

        const { data: existing } = await checkQuery;

        if (existing && existing.length > 0) {
            const hasMedia = existing.some(b => b.mode === 'MEDIA' &&
                ((b.media_urls && b.media_urls.length > 0) || b.pdf_url));
            const hasBracket = existing.some(b => b.mode === 'BRACKET');

            if (hasMedia) {
                return res.status(400).json({
                    message: "Category already has media uploads. Cannot create bracket. Delete all media first.",
                    code: "MODE_CONFLICT"
                });
            }

            if (hasBracket) {
                return res.status(400).json({
                    message: "Bracket already exists for this category",
                    code: "BRACKET_EXISTS"
                });
            }

            // If there's a record with mode = null (cleared media), we can reuse it or create new
            // The code below will handle this by creating a new bracket record
        }

        // Dynamic rounds: start with NO rounds. Admin will click "Add Round" to create Round 1, etc.
        const defaultRounds =
            roundStructure && Array.isArray(roundStructure) ? roundStructure : [];

        const bracketData = {
            rounds: [],
            players: []
        };

        const insertData = {
            event_id: eventId,
            category: categoryLabel,
            category_id: categoryId && isUuid(categoryId) ? categoryId : null,
            // legacy required column
            round_name: LEGACY_ROUND_NAME_BRACKET,
            // legacy compatibility
            draw_type: "bracket",
            draw_data: bracketData,
            mode: 'BRACKET',
            round_structure: defaultRounds,
            bracket_data: bracketData,
            published: false
        };

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .insert(insertData)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Bracket initialized successfully"
        });
    } catch (err) {
        console.error("INIT BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to initialize bracket", error: err.message });
    }
};

/**
 * Upload media for a category (Image/PDF)
 * POST /api/admin/events/:id/categories/:categoryId/media
 */
export const uploadCategoryMedia = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, files, pdfFile } = req.body;
        const hasPdfField = Object.prototype.hasOwnProperty.call(req.body || {}, "pdfFile");

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Check if bracket exists
        let checkQuery = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            checkQuery = checkQuery.eq("category_id", categoryId);
        } else {
            checkQuery = checkQuery.eq("category", categoryLabel);
        }

        const { data: existing } = await checkQuery;

        if (existing && existing.length > 0) {
            const hasBracket = existing.some(b => b.mode === 'BRACKET');
            if (hasBracket) {
                return res.status(400).json({
                    message: "Category already has bracket. Cannot upload media. Delete bracket first.",
                    code: "MODE_CONFLICT"
                });
            }
        }

        // Upload files
        const uploadedMedia = [];

        if (files && Array.isArray(files)) {
            for (const file of files) {
                if (file.url && file.url.startsWith('data:')) {
                    const uploadedUrl = await uploadBase64(file.url, 'event-assets', 'draws');
                    uploadedMedia.push({
                        id: file.id || `img-${Date.now()}-${Math.random()}`,
                        url: uploadedUrl,
                        type: 'image',
                        description: file.description || ''
                    });
                } else if (file.url) {
                    uploadedMedia.push({
                        id: file.id || `img-${Date.now()}-${Math.random()}`,
                        url: file.url,
                        type: 'image',
                        description: file.description || ''
                    });
                }
            }
        }

        // pdfFile semantics:
        // - if pdfFile field is omitted => do not change existing pdf_url
        // - if pdfFile is null => clear pdf_url
        // - if pdfFile is a string => upload (data:) or store as url
        let pdfUrl = null;
        if (typeof pdfFile === "string" && pdfFile.length > 0) {
            if (pdfFile.startsWith("data:")) {
                pdfUrl = await uploadBase64(pdfFile, "event-assets", "draws");
            } else {
                pdfUrl = pdfFile;
            }
        } else if (pdfFile === null) {
            pdfUrl = null;
        }

        // Get existing media or create new
        const existingMedia = existing?.find(b => b.mode === 'MEDIA');

        if (existingMedia) {
            // Update existing
            const existingUrls = existingMedia.media_urls || [];
            const newUrls = [...existingUrls, ...uploadedMedia];
            const finalPdfUrl = hasPdfField ? pdfUrl : existingMedia.pdf_url;

            // Check if all media is deleted (no media URLs and no PDF)
            const hasNoMedia = (!newUrls || newUrls.length === 0) && !finalPdfUrl;

            const updatePayload = {
                updated_at: new Date().toISOString()
            };

            if (hasNoMedia) {
                // Clear mode and all media-related fields to allow bracket creation
                updatePayload.mode = null;
                updatePayload.media_urls = null;
                updatePayload.pdf_url = null;
                updatePayload.draw_data = null;
                updatePayload.draw_type = null;
            } else {
                // Update with media
                updatePayload.round_name = existingMedia.round_name || LEGACY_ROUND_NAME_MEDIA;
                updatePayload.draw_type = "image";
                updatePayload.draw_data = { images: newUrls.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) };
                updatePayload.media_urls = newUrls;
                updatePayload.pdf_url = finalPdfUrl;
            }

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update(updatePayload)
                .eq("id", existingMedia.id)
                .select()
                .maybeSingle();

            if (error) throw error;
            res.json({
                success: true,
                draw: data,
                modeCleared: hasNoMedia
            });
        } else {
            // Create new
            const insertData = {
                event_id: eventId,
                category: categoryLabel,
                category_id: categoryId && isUuid(categoryId) ? categoryId : null,
                // legacy required column
                round_name: LEGACY_ROUND_NAME_MEDIA,
                // legacy compatibility
                draw_type: "image",
                draw_data: { images: uploadedMedia.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) },
                mode: 'MEDIA',
                media_urls: uploadedMedia,
                pdf_url: hasPdfField ? pdfUrl : null,
                published: false
            };

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .insert(insertData)
                .select()
                .maybeSingle();

            if (error) throw error;
            res.json({ success: true, draw: data });
        }
    } catch (err) {
        console.error("UPLOAD MEDIA ERROR:", err);
        res.status(500).json({ message: "Failed to upload media", error: err.message });
    }
};

/**
 * Add/Update match in bracket
 * POST /api/admin/events/:id/categories/:categoryId/bracket/match
 */
export const updateBracketMatch = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const {
            categoryLabel,
            roundName,
            matchId,
            player1,
            player2,
            matchIndex,
            deleteMatch,
            updatePlayerRanks,
            // Legacy flat rankings (pre per-round)
            playerRanks,
            enableRanking,
            // New per-round ranking maps
            playerRanksByRound,
            player_ranks_by_round,
            enableRankingByRound,
            enable_ranking_by_round
        } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        // Get bracket
        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found. Initialize bracket first." });
        }

        const bracket = brackets[0];
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };

        // Handle player ranks update
        if (updatePlayerRanks === true) {
            // --- Per-round ranking (new structure) ---
            const incomingByRound =
                playerRanksByRound ||
                player_ranks_by_round ||
                null;

            if (incomingByRound && typeof incomingByRound === "object") {
                // Overwrite per-round map with payload
                bracketData.playerRanksByRound = incomingByRound;
                bracketData.player_ranks_by_round = incomingByRound;
            }

            const incomingToggleByRound =
                enableRankingByRound ||
                enable_ranking_by_round ||
                null;

            if (incomingToggleByRound && typeof incomingToggleByRound === "object") {
                bracketData.enableRankingByRound = incomingToggleByRound;
                bracketData.enable_ranking_by_round = incomingToggleByRound;
            }

            // --- Legacy flat fields (backwards compatibility) ---
            if (playerRanks !== undefined) {
                bracketData.playerRanks = playerRanks;
            }

            if (enableRanking !== undefined) {
                bracketData.enableRanking = enableRanking;
                bracketData.enable_ranking = enableRanking;
            }
            
            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                    draw_type: "bracket",
                    draw_data: bracketData,
                    bracket_data: bracketData,
                    updated_at: new Date().toISOString()
                })
                .eq("id", bracket.id)
                .select()
                .maybeSingle();

            if (error) throw error;

            return res.json({
                success: true,
                bracket: data,
                message: "Player ranks updated successfully"
            });
        }

        // Find round
        let roundIndex = bracketData.rounds.findIndex(r => r.name === roundName);
        if (roundIndex === -1) {
            return res.status(400).json({ message: `Round "${roundName}" not found` });
        }

        const round = bracketData.rounds[roundIndex];

        // Find or create match
        let foundMatchIndex = -1;
        if (matchId) {
            foundMatchIndex = round.matches.findIndex(m => m.id === matchId);
        } else if (typeof matchIndex === 'number' && matchIndex >= 0) {
            foundMatchIndex = matchIndex;
        }

        // Delete match if requested
        if (deleteMatch === true) {
            if (foundMatchIndex === -1) {
                return res.status(400).json({ message: "Match not found", code: "MATCH_NOT_FOUND" });
            }
            
            // Delete the match from matches table if it exists
            // Match might be identified by matchId or by player combination + round
            try {
                const matchToDelete = round.matches[foundMatchIndex];
                const matchIdToDelete = matchToDelete?.id || matchId;
                
                // Try to find and delete the match from matches table
                // First, try by match ID if it's a UUID or stored reference
                if (matchIdToDelete) {
                    // Check if matchId looks like a UUID (from matches table)
                    if (isUuid(matchIdToDelete)) {
                        const { error: deleteMatchError } = await supabaseAdmin
                            .from('matches')
                            .delete()
                            .eq('id', matchIdToDelete);
                        
                        if (deleteMatchError) {
                            console.error("Error deleting match from matches table:", deleteMatchError);
                        }
                    } else {
                        // Match ID is a bracket structure ID, try to find by round + players
                        // Fetch matches for this round and category
                        let matchQuery = supabaseAdmin
                            .from('matches')
                            .select('id, player_a, player_b, round_name')
                            .eq('event_id', eventId)
                            .eq('round_name', roundName);
                        
                        if (categoryId && isUuid(categoryId)) {
                            matchQuery = matchQuery.eq('category_id', categoryId);
                        } else if (categoryLabel) {
                            // Try to match by categoryLabel if categoryId not available
                            matchQuery = matchQuery.eq('category_id', categoryLabel);
                        }
                        
                        const { data: matchesInRound, error: fetchMatchesError } = await matchQuery;
                        
                        if (!fetchMatchesError && matchesInRound && matchesInRound.length > 0) {
                            // Try to match by player IDs
                            const p1Id = matchToDelete?.player1?.id || matchToDelete?.player1;
                            const p2Id = matchToDelete?.player2?.id || matchToDelete?.player2;
                            
                            const matchingMatch = matchesInRound.find(m => {
                                const ma = m.player_a?.id || m.player_a;
                                const mb = m.player_b?.id || m.player_b;
                                return (ma === p1Id && mb === p2Id) || (ma === p2Id && mb === p1Id);
                            });
                            
                            if (matchingMatch) {
                                const { error: deleteMatchError } = await supabaseAdmin
                                    .from('matches')
                                    .delete()
                                    .eq('id', matchingMatch.id);
                                
                                if (deleteMatchError) {
                                    console.error("Error deleting match from matches table:", deleteMatchError);
                                }
                            }
                        }
                    }
                }
            } catch (matchDeleteErr) {
                console.error("Error during match deletion:", matchDeleteErr);
                // Continue with bracket match deletion even if matches table deletion fails
            }
            
            round.matches.splice(foundMatchIndex, 1);
            bracketData.rounds[roundIndex] = round;

            const { data, error } = await supabaseAdmin
                .from("event_brackets")
                .update({
                    // legacy compatibility
                    round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                    draw_type: "bracket",
                    draw_data: bracketData,
                    bracket_data: bracketData,
                    updated_at: new Date().toISOString()
                })
                .eq("id", bracket.id)
                .select()
                .maybeSingle();

            if (error) throw error;

            return res.json({
                success: true,
                bracket: data,
                message: "Match deleted successfully"
            });
        }

        if (foundMatchIndex === -1) {
            // Create new match structure in bracket_data
            // NOTE: score: null is for structure only - authoritative scores are in matches table
            const newMatch = {
                id: matchId || `match-${Date.now()}-${Math.random()}`,
                player1: player1 || null,
                player2: player2 || null,
                winner: null,
                score: null // Structure only - not authoritative
            };
            round.matches.push(newMatch);
        } else {
            // Update existing match
            const match = round.matches[foundMatchIndex];

            // Validate: Player cannot appear twice in same round
            if (player1) {
                const player1Id = typeof player1 === 'object' ? player1.id : player1;
                const duplicate = round.matches.some((m, idx) =>
                    idx !== foundMatchIndex && (
                        (m.player1 && (typeof m.player1 === 'object' ? m.player1.id : m.player1) === player1Id) ||
                        (m.player2 && (typeof m.player2 === 'object' ? m.player2.id : m.player2) === player1Id)
                    )
                );
                if (duplicate) {
                    return res.status(400).json({
                        message: "Player already assigned to another match in this round",
                        code: "DUPLICATE_PLAYER"
                    });
                }
            }

            if (player2) {
                const player2Id = typeof player2 === 'object' ? player2.id : player2;
                const duplicate = round.matches.some((m, idx) =>
                    idx !== foundMatchIndex && (
                        (m.player1 && (typeof m.player1 === 'object' ? m.player1.id : m.player1) === player2Id) ||
                        (m.player2 && (typeof m.player2 === 'object' ? m.player2.id : m.player2) === player2Id)
                    )
                );
                if (duplicate) {
                    return res.status(400).json({
                        message: "Player already assigned to another match in this round",
                        code: "DUPLICATE_PLAYER"
                    });
                }
            }

            if (player1 !== undefined) match.player1 = player1;
            if (player2 !== undefined) match.player2 = player2;

            // If a player is cleared/changed, clear winner to avoid stale results
            // NOTE: Scores are NOT stored in bracket_data - they belong in matches table only
            if ((player1 === null || player2 === null) && match.winner) {
                match.winner = null;
            }
        }

        // Update bracket data
        bracketData.rounds[roundIndex] = round;

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Match updated successfully"
        });
    } catch (err) {
        console.error("UPDATE MATCH ERROR:", err);
        res.status(500).json({ message: "Failed to update match", error: err.message });
    }
};

/**
 * Set match result and advance winner
 * POST /api/admin/events/:id/categories/:categoryId/bracket/result
 */
export const setMatchResult = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundName, matchId, winner, score } = req.body;

        if (!eventId || !roundName || !matchId || !winner) {
            return res.status(400).json({ message: "Missing required fields" });
        }

        // Get bracket
        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        const bracketData = bracket.bracket_data || { rounds: [], players: [] };

        // Find round and match
        const roundIndex = bracketData.rounds.findIndex(r => r.name === roundName);
        if (roundIndex === -1) {
            return res.status(400).json({ message: `Round "${roundName}" not found` });
        }

        const round = bracketData.rounds[roundIndex];
        const matchIndex = round.matches.findIndex(m => m.id === matchId);
        if (matchIndex === -1) {
            return res.status(400).json({ message: "Match not found" });
        }

        const match = round.matches[matchIndex];

        // Validate winner
        if (winner !== 'player1' && winner !== 'player2') {
            return res.status(400).json({ message: "Winner must be 'player1' or 'player2'" });
        }

        const winnerPlayer = match[winner];
        if (!winnerPlayer) {
            return res.status(400).json({ message: "Winner player not found in match" });
        }

        // Update match
        // NOTE: Winner reference stored in bracket_data for visual purposes only
        // Scores are NOT stored here - they belong exclusively in matches table
        match.winner = winner;
        // Score removed - scores are authoritative only in matches table

        // Advance winner to next round ONLY if next round already exists.
        // (Admin controls rounds via "Add Round". This avoids creating infinite rounds.)
        if (roundIndex < bracketData.rounds.length - 1) {
            const nextRound = bracketData.rounds[roundIndex + 1];

            // Winner goes to deterministic slot based on match index (bracket-style)
            const nextMatchIndex = Math.floor(matchIndex / 2);
            if (!nextRound.matches[nextMatchIndex]) {
                nextRound.matches[nextMatchIndex] = makeEmptyMatch();
            }

            const nextMatch = nextRound.matches[nextMatchIndex];

            // Determine which slot (player1 or player2) based on match position
            if (matchIndex % 2 === 0) {
                nextMatch.player1 = winnerPlayer;
            } else {
                nextMatch.player2 = winnerPlayer;
            }

            bracketData.rounds[roundIndex + 1] = nextRound;
        }

        bracketData.rounds[roundIndex] = round;

        // Update bracket
        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: bracket.round_structure || bracket.round_structure,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Match result saved and winner advanced"
        });
    } catch (err) {
        console.error("SET MATCH RESULT ERROR:", err);
        res.status(500).json({ message: "Failed to set match result", error: err.message });
    }
};

/**
 * Add a new round to a bracket (dynamic rounds)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/add
 */
export const addBracketRound = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, autoSeed = true, roundName } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found. Initialize bracket first." });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({ message: "Cannot modify a published bracket. Unpublish first.", code: "BRACKET_PUBLISHED" });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const currentRounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];

        // Helper: choose the effective name for the new round.
        // - If admin provided `roundName` from UI, prefer that.
        // - Otherwise fall back to inferred label based on match count (existing behavior).
        const getNextRoundName = (nextMatchCount, fallbackIndex) => {
            if (roundName && typeof roundName === "string" && roundName.trim()) {
                return roundName.trim();
            }
            return inferRoundLabelFromMatchCount(nextMatchCount, fallbackIndex);
        };

        // If no rounds exist, create first round with explicit/derived name
        if (currentRounds.length === 0) {
            const initialName = getNextRoundName(0, 0) || "Round 1";
            currentRounds.push({ name: initialName, matches: [] });
        } else {
            const prevRound = currentRounds[currentRounds.length - 1];
            const prevMatches = Array.isArray(prevRound.matches) ? prevRound.matches : [];

            // Check if all matches have winners in bracket_data
            // Also check matches table for completed matches as fallback
            const allHaveWinnersInBracket = prevMatches.length > 0 && prevMatches.every((m) => m && m.winner && m[m.winner]);

            // If bracket_data doesn't have all winners, check matches table
            if (!allHaveWinnersInBracket && prevRound.name) {
                try {
                    // Fetch completed matches for the previous round from matches table
                    let completedMatchesQuery = supabaseAdmin
                        .from('matches')
                        .select('*')
                        .eq('event_id', eventId)
                        .eq('round_name', prevRound.name)
                        .eq('status', 'COMPLETED');

                    // Filter by categoryId if available (to avoid cross-category matches)
                    if (categoryId && isUuid(categoryId)) {
                        completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                    } else if (categoryId) {
                        completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                    }

                    const { data: completedMatches } = await completedMatchesQuery;

                    // Check if all non-BYE matches have winners in matches table
                    const nonByeMatches = prevMatches.filter(m => {
                        const hasPlayer1 = m.player1 && (m.player1.id || m.player1);
                        const hasPlayer2 = m.player2 && (m.player2.id || m.player2);
                        return hasPlayer1 && hasPlayer2; // Non-BYE matches have both players
                    });

                    if (completedMatches && completedMatches.length >= nonByeMatches.length) {
                        // All matches are completed in matches table, allow adding next round
                        // Winners will be synced from matches table during auto-seed
                    } else {
                        return res.status(400).json({
                            message: "Finish all match winners in the previous round before adding a new round.",
                            code: "PREV_ROUND_INCOMPLETE"
                        });
                    }
                } catch (err) {
                    // Fall back to bracket_data check if matches table check fails
                    if (!allHaveWinnersInBracket) {
                        return res.status(400).json({
                            message: "Finish all match winners in the previous round before adding a new round.",
                            code: "PREV_ROUND_INCOMPLETE"
                        });
                    }
                }
            } else if (!allHaveWinnersInBracket) {
                return res.status(400).json({
                    message: "Finish all match winners in the previous round before adding a new round.",
                    code: "PREV_ROUND_INCOMPLETE"
                });
            }

            // If previous round already produced a single champion, do not allow another round
            const winners = prevMatches
                .map((m) => (m && m.winner ? m[m.winner] : null))
                .filter(Boolean);
            if (winners.length === 1) {
                return res.status(400).json({
                    message: "Final round is already completed. Champion is decided.",
                    code: "CHAMPION_DECIDED"
                });
            }

            const nextMatchCount = Math.max(1, Math.ceil(prevMatches.length / 2));
            const nextName = getNextRoundName(nextMatchCount, currentRounds.length);

            // If autoSeed is false, create a completely empty round (no matches yet).
            // Admin will add matches manually from the UI. This avoids showing
            // placeholder "TBD vs TBD" matches when the intent is a blank round.
            const nextRound = {
                name: nextName,
                matches: autoSeed ? Array.from({ length: nextMatchCount }, () => makeEmptyMatch()) : []
            };

            if (autoSeed) {
                // Auto-fill next round from previous round winners
                // First, ensure we have winners from matches table if bracket_data doesn't have them
                let winnersToUse = [];

                // Collect winners from bracket_data
                for (let i = 0; i < prevMatches.length; i++) {
                    const m = prevMatches[i];
                    const winnerPlayer = m && m.winner ? m[m.winner] : null;
                    if (winnerPlayer) {
                        winnersToUse.push(winnerPlayer);
                    }
                }

                // If bracket_data doesn't have all winners, fetch from matches table
                if (winnersToUse.length < prevMatches.length && prevRound.name) {
                    try {
                        let completedMatchesQuery = supabaseAdmin
                            .from('matches')
                            .select('*')
                            .eq('event_id', eventId)
                            .eq('round_name', prevRound.name)
                            .eq('status', 'COMPLETED')
                            .order('match_index', { ascending: true });

                        // Filter by categoryId if available (to avoid cross-category matches)
                        if (categoryId && isUuid(categoryId)) {
                            completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                        } else if (categoryId) {
                            completedMatchesQuery = completedMatchesQuery.eq('category_id', categoryId);
                        }

                        const { data: completedMatches } = await completedMatchesQuery;

                        if (completedMatches && completedMatches.length > 0) {
                            // Rebuild winners list from matches table
                            winnersToUse = [];
                            for (let i = 0; i < prevMatches.length; i++) {
                                const bracketMatch = prevMatches[i];
                                const matchIndex = i;

                                // Find corresponding match in matches table
                                const matchData = completedMatches.find(m => m.match_index === matchIndex);

                                if (matchData && matchData.winner) {
                                    // Extract winner player from matches table
                                    const winnerId = typeof matchData.winner === 'object'
                                        ? (matchData.winner.id || matchData.winner.player_id || matchData.winner)
                                        : matchData.winner;

                                    // Find winner in bracket match players
                                    const bracketPlayer1Id = bracketMatch.player1?.id || bracketMatch.player1;
                                    const bracketPlayer2Id = bracketMatch.player2?.id || bracketMatch.player2;

                                    let winnerPlayer = null;
                                    if (String(bracketPlayer1Id) === String(winnerId)) {
                                        winnerPlayer = bracketMatch.player1;
                                    } else if (String(bracketPlayer2Id) === String(winnerId)) {
                                        winnerPlayer = bracketMatch.player2;
                                    } else if (matchData.winner && typeof matchData.winner === 'object') {
                                        // Use winner object directly from matches table
                                        winnerPlayer = matchData.winner;
                                    }

                                    if (winnerPlayer) {
                                        winnersToUse.push(winnerPlayer);
                                    } else {
                                        // Fallback: use winner from bracket_data if available
                                        const bracketWinner = bracketMatch.winner ? bracketMatch[bracketMatch.winner] : null;
                                        if (bracketWinner) winnersToUse.push(bracketWinner);
                                    }
                                } else {
                                    // No match data found, use bracket_data winner if available
                                    const bracketWinner = bracketMatch.winner ? bracketMatch[bracketMatch.winner] : null;
                                    if (bracketWinner) winnersToUse.push(bracketWinner);
                                }
                            }
                        }
                    } catch (err) {
                        // If matches table fetch fails, use bracket_data winners
                    }
                }

                // Populate next round with winners
                for (let i = 0; i < winnersToUse.length; i++) {
                    const winnerPlayer = winnersToUse[i];
                    if (!winnerPlayer) continue;

                    const idx = Math.floor(i / 2);
                    if (!nextRound.matches[idx]) nextRound.matches[idx] = makeEmptyMatch();
                    if (i % 2 === 0) nextRound.matches[idx].player1 = winnerPlayer;
                    else nextRound.matches[idx].player2 = winnerPlayer;
                }

                // Auto-mark BYE winners in the new round (single-player match)
                // NOTE: score: null is for structure only - authoritative scores are in matches table
                for (const nm of nextRound.matches) {
                    if (nm.player1 && !nm.player2) {
                        nm.winner = "player1";
                        nm.score = null; // Structure only - BYEs don't have scores
                    } else if (!nm.player1 && nm.player2) {
                        // normalize: prefer player1 slot
                        nm.player1 = nm.player2;
                        nm.player2 = null;
                        nm.winner = "player1";
                        nm.score = null; // Structure only - BYEs don't have scores
                    }
                }
            }

            currentRounds.push(nextRound);
        }

        bracketData.rounds = currentRounds;

        const roundStructure = Array.isArray(bracket.round_structure) ? bracket.round_structure : [];
        const lastRound = currentRounds[currentRounds.length - 1];
        if (!roundStructure.find((r) => r?.name === lastRound.name)) {
            roundStructure.push({ name: lastRound.name, slots: (lastRound.matches?.length || 0) * 2 });
        }

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: roundStructure,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        return res.json({ success: true, bracket: data, message: "Round added successfully" });
    } catch (err) {
        console.error("ADD ROUND ERROR:", err);
        res.status(500).json({ message: "Failed to add round", error: err.message });
    }
};

/**
 * Publish/Unpublish draw
 * POST /api/admin/events/:id/categories/:categoryId/publish
 */
export const publishCategoryDraw = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, published } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        if (typeof published !== 'boolean') {
            return res.status(400).json({ message: "Published must be boolean" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .update({ published, updated_at: new Date().toISOString() })
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data, error } = await query.select();

        if (error) throw error;

        res.json({
            success: true,
            message: published ? "Draw published successfully" : "Draw unpublished",
            draws: data
        });
    } catch (err) {
        console.error("PUBLISH DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to publish draw", error: err.message });
    }
};

/**
 * Delete media from category
 * DELETE /api/admin/events/:id/categories/:categoryId/media/:mediaId
 */
export const deleteCategoryMedia = async (req, res) => {
    try {
        const { id: eventId, categoryId, mediaId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || !mediaId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Missing required parameters" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "MEDIA");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: draws, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!draws || draws.length === 0) {
            return res.status(404).json({ message: "Media draw not found" });
        }

        const draw = draws[0];
        const mediaUrls = draw.media_urls || [];
        const filteredMedia = mediaUrls.filter(m => m.id !== mediaId);
        const pdfUrl = draw.pdf_url;

        // Check if all media is deleted (no media URLs and no PDF)
        const hasNoMedia = (!filteredMedia || filteredMedia.length === 0) && !pdfUrl;

        // If all media is deleted, clear the mode to allow switching to BRACKET mode
        const updatePayload = {
            updated_at: new Date().toISOString()
        };

        if (hasNoMedia) {
            // Clear mode and all media-related fields to allow bracket creation
            updatePayload.mode = null;
            updatePayload.media_urls = null;
            updatePayload.pdf_url = null;
            updatePayload.draw_data = null;
            updatePayload.draw_type = null;
        } else {
            // Update with remaining media
            updatePayload.draw_type = "image";
            updatePayload.draw_data = { images: filteredMedia.map((m) => ({ id: m.id, url: m.url, description: m.description || "" })) };
            updatePayload.media_urls = filteredMedia;
        }

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update(updatePayload)
            .eq("id", draw.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            draw: data,
            message: hasNoMedia
                ? "All media deleted. You can now create brackets for this category."
                : "Media deleted successfully",
            modeCleared: hasNoMedia
        });
    } catch (err) {
        console.error("DELETE MEDIA ERROR:", err);
        res.status(500).json({ message: "Failed to delete media", error: err.message });
    }
};

/**
 * Reset bracket (delete all matches, keep structure)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/reset
 */
export const resetBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;

        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        // Dynamic reset: clear all rounds + structure (admin will add rounds again)
        const resetBracketData = {
            rounds: [],
            players: []
        };

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                // legacy compatibility
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: resetBracketData,
                round_structure: [],
                bracket_data: resetBracketData,
                published: false,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            bracket: data,
            message: "Bracket reset successfully"
        });
    } catch (err) {
        console.error("RESET BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to reset bracket", error: err.message });
    }
};

/**
 * Delete bracket for a category (hard delete the BRACKET row)
 * DELETE /api/admin/events/:id/categories/:categoryId/bracket
 */
export const deleteCategoryBracket = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const categoryLabel = req.query.categoryLabel || req.query.category;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({
                message: "Cannot delete a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        const { error: deleteError } = await supabaseAdmin
            .from("event_brackets")
            .delete()
            .eq("id", bracket.id);

        if (deleteError) throw deleteError;

        return res.json({ success: true, message: "Bracket deleted successfully" });
    } catch (err) {
        console.error("DELETE BRACKET ERROR:", err);
        res.status(500).json({ message: "Failed to delete bracket", error: err.message });
    }
};

/**
 * Delete a specific round from a bracket (only last round, unpublished)
 * POST /api/admin/events/:id/categories/:categoryId/bracket/round/delete
 */
export const deleteBracketRound = async (req, res) => {
    try {
        const { id: eventId, categoryId } = req.params;
        const { categoryLabel, roundName } = req.body;

        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({ message: "Event ID and Category required" });
        }

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("mode", "BRACKET");

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else {
            query = query.eq("category", categoryLabel);
        }

        const { data: brackets, error: fetchError } = await query;
        if (fetchError) throw fetchError;
        if (!brackets || brackets.length === 0) {
            return res.status(404).json({ message: "Bracket not found" });
        }

        const bracket = brackets[0];
        if (bracket.published === true) {
            return res.status(400).json({
                message: "Cannot delete round from a published bracket. Unpublish first.",
                code: "BRACKET_PUBLISHED"
            });
        }

        const bracketData = bracket.bracket_data || { rounds: [], players: [] };
        const rounds = Array.isArray(bracketData.rounds) ? bracketData.rounds : [];
        if (rounds.length === 0) {
            return res.status(400).json({ message: "No rounds to delete" });
        }

        const targetIndex = roundName
            ? rounds.findIndex((r) => r && r.name === roundName)
            : rounds.length - 1;

        if (targetIndex === -1) {
            return res.status(404).json({ message: "Round not found" });
        }

        // Only allow deleting the last round to keep bracket progression consistent
        if (targetIndex !== rounds.length - 1) {
            return res.status(400).json({
                message: "Only the last round can be deleted.",
                code: "ONLY_LAST_ROUND_DELETABLE"
            });
        }

        const deletedRound = rounds[targetIndex];
        const deletedRoundName = deletedRound?.name || roundName;
        
        // Delete all matches for this round from the matches table
        // This ensures scoreboard data is completely removed when a round is deleted
        // Admin can then regenerate matches from the bracket structure if needed
        let deletedMatchCount = 0;
        try {
            // First, fetch ALL matches for this event to filter safely in memory
            // This is more reliable than trying to match round_name exactly in the query
            const { data: allEventMatches, error: fetchAllError } = await supabaseAdmin
                .from('matches')
                .select('id, category_id, event_id, round_name')
                .eq('event_id', eventId);

            if (fetchAllError) {
                console.error("Error fetching all matches for deletion:", fetchAllError);
            } else if (allEventMatches && allEventMatches.length > 0) {
                // Filter matches in memory by category and round name (case-insensitive, trimmed)
                const normalizedDeletedRoundName = String(deletedRoundName || '').trim();
                
                const safeMatchesToDelete = allEventMatches.filter(match => {
                    const matchCategoryId = match.category_id;
                    const matchRoundName = String(match.round_name || '').trim();
                    
                    // Round name must match (case-insensitive)
                    const roundMatches = matchRoundName.toLowerCase() === normalizedDeletedRoundName.toLowerCase();
                    if (!roundMatches) {
                        return false;
                    }
                    
                    // Category must match
                    if (!matchCategoryId) {
                        return false;
                    }
                    
                    // Exact category match - try multiple strategies like deleteCategoryMatches does
                    let categoryMatches = false;
                    
                    // Strategy 1: Exact UUID match (most reliable)
                    if (categoryId && isUuid(categoryId)) {
                        categoryMatches = String(matchCategoryId) === String(categoryId);
                    }
                    // Strategy 2: Exact text/numeric match (categoryId as text or number)
                    else if (categoryId) {
                        categoryMatches = matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                    }
                    // Strategy 3: Category name exact match (if category_id stores the full label)
                    else if (categoryLabel) {
                        categoryMatches = matchCategoryId === categoryLabel || String(matchCategoryId) === String(categoryLabel);
                    }
                    
                    return categoryMatches;
                });

                // Delete matching matches
                if (safeMatchesToDelete.length > 0) {
                    const matchIds = safeMatchesToDelete.map(m => m.id);
                    const { error: deleteMatchesError, data: deletedData } = await supabaseAdmin
                        .from('matches')
                        .delete()
                        .in('id', matchIds)
                        .select();

                    if (deleteMatchesError) {
                        console.error("Error deleting matches for round:", deleteMatchesError);
                        // Don't fail the whole operation if match deletion fails, but log it
                    } else {
                        deletedMatchCount = deletedData?.length || safeMatchesToDelete.length;
                    }
                }
            }
        } catch (matchDeleteErr) {
            console.error("Error during match deletion for round:", matchDeleteErr);
            // Continue with round deletion even if match deletion fails
        }

        rounds.splice(targetIndex, 1);
        bracketData.rounds = rounds;

        const roundStructure = Array.isArray(bracket.round_structure) ? bracket.round_structure : [];
        const updatedStructure = roundStructure.filter((r) => r?.name !== deletedRound?.name);

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .update({
                round_name: bracket.round_name || LEGACY_ROUND_NAME_BRACKET,
                draw_type: "bracket",
                draw_data: bracketData,
                round_structure: updatedStructure,
                bracket_data: bracketData,
                updated_at: new Date().toISOString()
            })
            .eq("id", bracket.id)
            .select()
            .maybeSingle();

        if (error) throw error;

        // Return success with info about match deletion
        const matchDeletionMessage = deletedMatchCount > 0 
            ? `Round "${deletedRoundName}" deleted successfully. ${deletedMatchCount} match(es) removed from scoreboard.`
            : `Round "${deletedRoundName}" deleted successfully. No matches found for this round.`;
        
        return res.json({
            success: true,
            bracket: data,
            deletedMatchCount,
            message: matchDeletionMessage
        });
    } catch (err) {
        console.error("DELETE ROUND ERROR:", err);
        res.status(500).json({ message: "Failed to delete round", error: err.message });
    }
};
