import { supabaseAdmin } from "../config/supabaseClient.js";

// Helper function to check if string is UUID
const isUuid = (str) => {
    if (!str || typeof str !== 'string') return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
};

// Generate Matches from Bracket Data (Knockout)
export const generateMatchesFromBracket = async (req, res) => {
    const { eventId, categoryId } = req.params;
    const categoryLabel = (req.query && req.query.categoryLabel) || (req.body && req.body.categoryLabel);
    const roundName = (req.query && req.query.roundName) || (req.body && req.body.roundName); // Optional: generate for specific round only

    try {
        // 1. Fetch Bracket Data with UUID-safe query
        let bracketQuery = supabaseAdmin
            .from('event_brackets')
            .select('*')
            .eq('event_id', eventId)
            .eq('mode', 'BRACKET');

        // Only filter by category_id if it's a valid UUID
        if (categoryId && isUuid(categoryId)) {
            bracketQuery = bracketQuery.eq('category_id', categoryId);
        } else if (categoryLabel) {
            // If not UUID, use categoryLabel from query/body
            bracketQuery = bracketQuery.eq('category', categoryLabel);
        } else if (categoryId && categoryId !== 'label') {
            // Fallback: try to match by categoryId as category name (for backward compatibility)
            bracketQuery = bracketQuery.eq('category', categoryId);
        }

        const { data: bracketData, error: bracketError } = await bracketQuery.maybeSingle();

        if (bracketError || !bracketData) {
            return res.status(404).json({
                success: false,
                message: `Bracket not found or not in BRACKET mode. Category: ${categoryLabel || categoryId}`,
                debug: {
                    categoryId,
                    categoryLabel,
                    error: bracketError?.message
                }
            });
        }

        const rounds = bracketData.bracket_data?.rounds || [];
        if (!rounds.length) {
            return res.status(400).json({ success: false, message: "No rounds found in bracket data" });
        }

        // If roundName is provided, only process that round
        const roundsToProcess = roundName
            ? rounds.filter(r => r.name === roundName)
            : rounds;

        if (roundName && roundsToProcess.length === 0) {
            return res.status(404).json({
                success: false,
                message: `Round "${roundName}" not found in bracket data`
            });
        }

        // Use the bracket's actual category_id for checking existing matches
        // This ensures we're checking the correct category, not a different one
        const bracketCategoryId = bracketData.category_id;
        const bracketCategoryLabel = bracketData.category;

        // NOTE: Do NOT early-return if matches already exist for a round.
        // Admin can add new bracket matches later; generation must be idempotent per match_index:
        // - insert missing matches
        // - skip existing matches

        let createdCount = 0;
        let skippedCount = 0;

        // 2. Loop through rounds and matches
        for (const round of roundsToProcess) {
            const matches = round.matches || [];

            // We use index as distinct identifier within a round
            for (let i = 0; i < matches.length; i++) {
                const matchData = matches[i];

                // Skip BYE matches (matches with only one player)
                // BYE matches are auto-won and don't need to be in scoreboard
                const hasPlayer1 = matchData.player1 && matchData.player1.id;
                const hasPlayer2 = matchData.player2 && matchData.player2.id;
                const isBye = (hasPlayer1 && !hasPlayer2) || (!hasPlayer1 && hasPlayer2);

                if (isBye) {
                    // BYE match - skip creating in matches table
                    // Winner is already marked in bracket_data and will be auto-advanced
                    skippedCount++;
                    continue;
                }

                // Skip if match has no players at all
                if (!hasPlayer1 && !hasPlayer2) {
                    skippedCount++;
                    continue;
                }

                // Only create matches with both players (non-BYE matches)
                // Use bracket's category_id to ensure consistency
                const matchCategoryId = bracketCategoryId || categoryId;

                const payload = {
                    event_id: eventId,
                    category_id: matchCategoryId, // Use bracket's category_id for consistency
                    bracket_id: bracketData.id,
                    round_name: round.name,
                    match_index: i,
                    player_a: matchData.player1 || {},
                    player_b: matchData.player2 || {},
                    // Scores are NOT copied from bracket_data - matches table is authoritative
                    // Initial generation creates empty scores - they will be set via scoreboard
                    score: null,
                    // Winner reference may exist in bracket_data for visual purposes, but
                    // authoritative winner comes from matches table after score is set
                    winner: null,
                    status: 'SCHEDULED'
                };

                // 3. Insert (Idempotent - never overwrites existing matches)
                // This function is idempotent: if a match already exists (unique constraint on
                // bracket_id + round_name + match_index), it will be skipped, preserving any
                // existing scores and results. This ensures we never overwrite live score data.
                const { error: insertError } = await supabaseAdmin
                    .from('matches')
                    .insert(payload)
                    .select()
                    .maybeSingle();

                if (insertError) {
                    // Check for unique violation (code 23505 in Postgres)
                    // This means match already exists - skip it to preserve existing scores
                    if (insertError.code === '23505') {
                        skippedCount++;
                    }
                    // Other errors are silently skipped to continue processing
                } else {
                    createdCount++;
                }
            }
        }

        return res.status(200).json({
            success: true,
            message: `Processed matches. Created: ${createdCount}, Skipped (Existing): ${skippedCount}`,
            stats: { createdCount, skippedCount }
        });

    } catch (error) {
        console.error("Generate Matches Error:", error);
        return res.status(500).json({ success: false, message: "Internal Server Error" });
    }
};

/**
 * Generate League (round-robin) matches from league blueprint
 * POST /api/admin/matches/generate-league/:eventId/:categoryId
 *
 * - Reads participants from 'leagues' table (dedicated league storage)
 * - Generates all unique pairs (each player vs every other player once)
 * - Inserts into matches table with round_name = 'LEAGUE'
 * - Idempotent: skips matches that already exist for this event/category/round
 */
export const generateLeagueMatches = async (req, res) => {
    const { eventId, categoryId } = req.params;
    const categoryLabel = (req.query && req.query.categoryLabel) || (req.body && req.body.categoryLabel);

    try {
        if (!eventId || (!categoryId && !categoryLabel)) {
            return res.status(400).json({
                success: false,
                message: "Event ID and Category are required"
            });
        }

        // 1. Fetch League config from dedicated 'leagues' table
        // Try multiple matching strategies to find the league config

        // First, fetch all leagues for this event
        const { data: allLeagues, error: fetchAllError } = await supabaseAdmin
            .from('leagues')
            .select('*')
            .eq('event_id', eventId);

        if (fetchAllError) {
            throw fetchAllError;
        }

        // Try to find matching league config using multiple strategies
        let leagueConfig = null;

        if (allLeagues && allLeagues.length > 0) {
            // Strategy 1: Exact category_id match (UUID or string)
            if (categoryId) {
                leagueConfig = allLeagues.find(l => {
                    const lCatId = l.category_id;
                    if (!lCatId) return false;
                    return String(lCatId) === String(categoryId) || lCatId == categoryId;
                });
            }

            // Strategy 2: Exact category_label match
            if (!leagueConfig && categoryLabel) {
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    // Exact match
                    if (String(lLabel).trim() === String(categoryLabel).trim()) {
                        return true;
                    }
                    // Case-insensitive match
                    if (String(lLabel).toLowerCase().trim() === String(categoryLabel).toLowerCase().trim()) {
                        return true;
                    }
                    return false;
                });
            }

            // Strategy 3: Normalized match (remove gender in parentheses, normalize spacing)
            if (!leagueConfig && categoryLabel) {
                // Normalize function: remove gender in parentheses, lowercase, trim
                const normalizeLabel = (label) => {
                    if (!label) return "";
                    return String(label)
                        .replace(/\s*\(Male|Female|Mixed\)/gi, "") // Remove (Male), (Female), (Mixed)
                        .replace(/\s*-\s*/g, " - ") // Normalize spacing around dashes
                        .toLowerCase()
                        .trim();
                };

                const normalizedSearchLabel = normalizeLabel(categoryLabel);
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    const normalizedLLabel = normalizeLabel(lLabel);
                    // Exact normalized match
                    if (normalizedLLabel === normalizedSearchLabel) {
                        return true;
                    }
                    // Check if base category name matches (before matchType)
                    const searchBase = normalizedSearchLabel.split(" - ")[0];
                    const labelBase = normalizedLLabel.split(" - ")[0];
                    if (searchBase && labelBase && searchBase === labelBase) {
                        return true;
                    }
                    return false;
                });
            }

            // Strategy 4: Partial match (fallback - most lenient)
            if (!leagueConfig && categoryLabel) {
                const normalizedLabel = String(categoryLabel).toLowerCase().trim();
                leagueConfig = allLeagues.find(l => {
                    const lLabel = l.category_label;
                    if (!lLabel) return false;
                    const normalizedLLabel = String(lLabel).toLowerCase().trim();
                    // Extract base category name (before first " - ")
                    const searchBase = normalizedLabel.split(" - ")[0];
                    const labelBase = normalizedLLabel.split(" - ")[0];
                    // Match if base names are similar
                    if (searchBase && labelBase) {
                        if (searchBase === labelBase ||
                            searchBase.includes(labelBase) ||
                            labelBase.includes(searchBase)) {
                            return true;
                        }
                    }
                    // Also try full string contains
                    return normalizedLLabel.includes(normalizedLabel) || normalizedLabel.includes(normalizedLLabel);
                });
            }
        }

        if (!leagueConfig) {
            // Provide helpful debug info
            const availableCategories = allLeagues?.map(l => ({
                category_id: l.category_id,
                category_label: l.category_label
            })) || [];

            return res.status(404).json({
                success: false,
                message: `League configuration not found. Please configure participants first. Category: ${categoryLabel || categoryId}`,
                debug: {
                    categoryId,
                    categoryLabel,
                    searchedFor: {
                        categoryId: categoryId || null,
                        categoryLabel: categoryLabel || null
                    },
                    availableLeagues: availableCategories,
                    hint: "Make sure you've saved the league configuration with participants before generating matches."
                }
            });
        }

        const participants = Array.isArray(leagueConfig.participants) ? leagueConfig.participants : [];

        if (participants.length === 0) {
            return res.status(400).json({
                success: false,
                message: `League configuration found but no participants configured. Please add participants to category "${leagueConfig.category_label || categoryLabel || categoryId}" before generating matches.`,
                debug: {
                    categoryId,
                    categoryLabel,
                    leagueConfigId: leagueConfig.id,
                    participantsCount: 0
                }
            });
        }

        if (participants.length < 2) {
            return res.status(400).json({
                success: false,
                message: `At least two participants are required to generate league matches. Currently configured: ${participants.length} participant(s).`,
                debug: {
                    categoryId,
                    categoryLabel,
                    participantsCount: participants.length,
                    participants: participants.map(p => ({ id: p.id, name: p.name }))
                }
            });
        }

        // Use category_id from league config (can be UUID or string like "1767354643599")
        // Fallback to categoryId from params if not in config
        const leagueCategoryId = leagueConfig.category_id
            ? String(leagueConfig.category_id)
            : (categoryId ? String(categoryId) : null);

        // 2. Fetch existing LEAGUE matches for this event/category
        // Use category_id from league config (can be string or UUID)
        const matchCategoryId = leagueCategoryId || (categoryId ? String(categoryId) : null);

        // First, fetch all LEAGUE matches for this event (we'll filter by category_id in memory)
        // This handles cases where category_id might be TEXT vs UUID type mismatch
        const { data: allLeagueMatches, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .eq('round_name', 'LEAGUE');

        if (fetchError) {
            throw fetchError;
        }

        // Filter by category_id in memory (handles both UUID and string IDs like "1767354643599")
        let existingMatches = allLeagueMatches || [];
        if (matchCategoryId) {
            existingMatches = existingMatches.filter(m => {
                const mCatId = m.category_id;
                if (!mCatId) return false;
                // Use == for type coercion and String() for exact match
                return String(mCatId) === String(matchCategoryId) || mCatId == matchCategoryId;
            });
        }

        // 2.5. Get or create placeholder bracket for league matches
        // League matches need a bracket_id due to NOT NULL constraint, but they don't use actual brackets
        const categoryLabelForBracket = leagueConfig.category_label || categoryLabel || `League - ${categoryId || 'Unknown'}`;

        // Check if any existing LEAGUE matches already have a bracket_id we can reuse
        let placeholderBracketId = null;
        if (existingMatches && existingMatches.length > 0) {
            const firstMatch = existingMatches[0];
            if (firstMatch.bracket_id) {
                placeholderBracketId = firstMatch.bracket_id;
            }
        }

        // If no existing bracket found, try to find or create a placeholder bracket
        if (!placeholderBracketId) {
            let bracketQuery = supabaseAdmin
                .from('event_brackets')
                .select('id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE_PLACEHOLDER');

            // Try to match by category_id first (only if it's a valid UUID)
            // For string IDs like "1767354643599", we'll match by category label instead
            if (leagueCategoryId && isUuid(leagueCategoryId)) {
                bracketQuery = bracketQuery.eq('category_id', leagueCategoryId);
            } else {
                // Fallback to category label (works for both UUID and string category IDs)
                bracketQuery = bracketQuery.eq('category', categoryLabelForBracket);
            }

            const { data: existingPlaceholder, error: bracketFetchError } = await bracketQuery.maybeSingle();

            if (bracketFetchError && bracketFetchError.code !== "PGRST116") {
                throw bracketFetchError;
            }

            if (existingPlaceholder) {
                placeholderBracketId = existingPlaceholder.id;
            } else {
                // Create placeholder bracket for league matches
                // event_brackets.category_id is UUID type, so only set it if it's a valid UUID
                // For string IDs like "1767354643599", set category_id to null
                const bracketCategoryId = leagueCategoryId && isUuid(leagueCategoryId) ? leagueCategoryId : null;

                const { data: newPlaceholder, error: createBracketError } = await supabaseAdmin
                    .from('event_brackets')
                    .insert({
                        event_id: eventId,
                        category: categoryLabelForBracket,
                        category_id: bracketCategoryId, // Only set if it's a valid UUID
                        round_name: 'LEAGUE_PLACEHOLDER',
                        mode: 'MEDIA', // Use MEDIA mode for placeholder
                        draw_type: 'bracket',
                        bracket_data: {
                            rounds: [],
                            isPlaceholder: true,
                            note: 'Placeholder bracket for league matches'
                        }
                    })
                    .select('id')
                    .single();

                if (createBracketError) {
                    throw createBracketError;
                }

                placeholderBracketId = newPlaceholder.id;
            }
        }

        // Build a set of existing unordered pairs (playerA, playerB) per group
        const existingPairs = new Set();
        (existingMatches || []).forEach((m) => {
            const aId = m.player_a && (m.player_a.id || m.player_a.player_id || m.player_a);
            const bId = m.player_b && (m.player_b.id || m.player_b.player_id || m.player_b);
            const groupKey = (m.player_a && m.player_a.group) || (m.player_b && m.player_b.group) || "A";
            if (!aId || !bId) return;
            const [id1, id2] = [String(aId), String(bId)].sort();
            const key = `${groupKey}__${id1}__${id2}`;
            existingPairs.add(key);
        });

        // 3. Generate all unique pairs i < j within each group
        const toInsert = [];
        const groupsMap = new Map();
        participants.forEach((p) => {
            const rawGroup = p.group || p.group_id || p.groupLabel || null;
            const groupKey = rawGroup ? String(rawGroup).trim().toUpperCase() : "A";
            if (!groupsMap.has(groupKey)) groupsMap.set(groupKey, []);
            groupsMap.get(groupKey).push(p);
        });

        for (const [groupKey, groupParticipants] of groupsMap.entries()) {
            const n = groupParticipants.length;
            for (let i = 0; i < n; i++) {
                const p1 = groupParticipants[i];
                const p1Id = p1 && p1.id;
                if (!p1Id) continue;

                for (let j = i + 1; j < n; j++) {
                    const p2 = groupParticipants[j];
                    const p2Id = p2 && p2.id;
                    if (!p2Id) continue;

                    const [id1, id2] = [String(p1Id), String(p2Id)].sort();
                    const key = `${groupKey}__${id1}__${id2}`;

                    if (existingPairs.has(key)) {
                        continue; // Already have this pairing in this group
                    }

                    // Use category_id from league config (ensures consistency)
                    // category_id can be string like "1767354643599" or UUID
                    const matchCategoryId = leagueCategoryId || (categoryId ? String(categoryId) : null);

                    toInsert.push({
                        event_id: eventId,
                        category_id: matchCategoryId,
                        bracket_id: placeholderBracketId, // Use placeholder bracket (required by NOT NULL constraint)
                        round_name: 'LEAGUE',
                        player_a: { id: String(p1Id), name: p1.name, group: groupKey },
                        player_b: { id: String(p2Id), name: p2.name, group: groupKey },
                        status: 'SCHEDULED',
                        score: null,
                        winner: null
                    });

                    existingPairs.add(key);
                }
            }
        }

        if (toInsert.length === 0) {
            return res.status(200).json({
                success: true,
                message: "League matches already generated for all participant pairs",
                createdCount: 0,
                skippedCount: existingMatches ? existingMatches.length : 0
            });
        }

        // 4. Determine starting match_index to append new matches
        // CRITICAL FIX: Filter by category_id to prevent conflicts with other league categories
        let startIndex = 0;

        // Use existingMatches (already filtered by category) to get max index
        // This is more efficient and ensures we only look at matches for this category
        if (existingMatches && existingMatches.length > 0) {
            const maxIndex = Math.max(...existingMatches.map(m => m.match_index || 0));
            startIndex = maxIndex + 1;
        } else {
            // No existing matches, check database with category filter as fallback
            // This handles edge case where existingMatches might be empty but matches exist
            let maxIndexQuery = supabaseAdmin
                .from('matches')
                .select('match_index, category_id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE');

            const { data: allLeagueMatchesForIndex } = await maxIndexQuery;

            if (allLeagueMatchesForIndex && matchCategoryId) {
                // Filter by category_id in memory
                const categoryMatches = allLeagueMatchesForIndex.filter(m => {
                    const mCatId = m.category_id;
                    if (!mCatId) return false;
                    return String(mCatId) === String(matchCategoryId) || mCatId == matchCategoryId;
                });

                if (categoryMatches.length > 0) {
                    const maxIndex = Math.max(...categoryMatches.map(m => m.match_index || 0));
                    startIndex = maxIndex + 1;
                }
            } else if (allLeagueMatchesForIndex && allLeagueMatchesForIndex.length > 0) {
                // No category filter available, use all matches (fallback)
                const maxIndex = Math.max(...allLeagueMatchesForIndex.map(m => m.match_index || 0));
                startIndex = maxIndex + 1;
            }
        }

        const payloadWithIndex = toInsert.map((m, idx) => ({
            ...m,
            match_index: startIndex + idx
        }));

        const { error: insertError } = await supabaseAdmin
            .from('matches')
            .insert(payloadWithIndex);

        if (insertError) {
            throw insertError;
        }

        return res.status(201).json({
            success: true,
            message: `League matches generated. Created: ${payloadWithIndex.length}`,
            createdCount: payloadWithIndex.length
        });
    } catch (error) {
        console.error("Generate League Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate league matches"
        });
    }
};

// Create Single Match Manually
export const createMatch = async (req, res) => {
    const { event_id, category_id, category_name, round_name, player_a, player_b, bracket_id: providedBracketId } = req.body;

    if (!event_id || !category_id || !round_name) {
        return res.status(400).json({ success: false, message: "Missing required fields" });
    }

    try {
        let bracket_id = providedBracketId;

        // Lookup bracket_id if not provided
        // For manual matches, we can create matches even without a bracket
        // We'll use the first available bracket or create a placeholder reference
        if (!bracket_id) {
            let bracketData = null;
            let bracketError = null;

            if (isUuid(category_id)) {
                // Query by UUID category_id - get all brackets for this category
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category_id', category_id)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    // Prefer BRACKET mode, but accept any bracket
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                } else {
                    bracketError = error;
                }
            } else if (category_name) {
                // Query by category label/name - get all brackets for this category
                const { data, error } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id, mode')
                    .eq('event_id', event_id)
                    .eq('category', category_name)
                    .order('created_at', { ascending: false });

                if (!error && data && data.length > 0) {
                    // Prefer BRACKET mode, but accept any bracket
                    bracketData = data.find(b => b.mode === 'BRACKET') || data[0];
                } else {
                    bracketError = error;
                }
            } else {
                return res.status(400).json({
                    success: false,
                    message: "Non-UUID Category ID requires 'category_name' field"
                });
            }

            // If no bracket found, try to find ANY bracket for this event (even different category)
            // This is needed because bracket_id has NOT NULL constraint
            if (bracketData) {
                bracket_id = bracketData.id;
            } else {
                // Try to find any bracket for this event to use as reference
                const { data: anyBrackets, error: anyBracketError } = await supabaseAdmin
                    .from('event_brackets')
                    .select('id')
                    .eq('event_id', event_id)
                    .limit(1);

                if (!anyBracketError && anyBrackets && anyBrackets.length > 0) {
                    bracket_id = anyBrackets[0].id;
                } else {
                    // Last resort: Create a minimal placeholder bracket for manual matches
                    const { data: placeholderBracket, error: placeholderError } = await supabaseAdmin
                        .from('event_brackets')
                        .insert({
                            event_id: event_id,
                            category: category_name || `Manual Scoreboard - ${category_id}`,
                            category_id: isUuid(category_id) ? category_id : null,
                            mode: 'MEDIA', // Use MEDIA mode for placeholder
                            draw_type: 'bracket',
                            bracket_data: { rounds: [] },
                            round_name: 'Manual'
                        })
                        .select('id')
                        .single();

                    if (!placeholderError && placeholderBracket) {
                        bracket_id = placeholderBracket.id;
                    } else {
                        return res.status(500).json({
                            success: false,
                            message: "Could not create match. No bracket found and failed to create placeholder."
                        });
                    }
                }
            }
        }

        // Get Max Index for this round
        // If no bracket_id, we'll use event_id + category_id + round_name to get max index
        let nextIndex = 0;
        if (bracket_id) {
            const { data: maxIndexData } = await supabaseAdmin
                .from('matches')
                .select('match_index')
                .eq('bracket_id', bracket_id)
                .eq('round_name', round_name)
                .order('match_index', { ascending: false })
                .limit(1);
            nextIndex = (maxIndexData && maxIndexData.length > 0) ? maxIndexData[0].match_index + 1 : 0;
        } else {
            // For matches without bracket_id, get max index by event + category + round
            const { data: maxIndexData } = await supabaseAdmin
                .from('matches')
                .select('match_index')
                .eq('event_id', event_id)
                .eq('category_id', category_id)
                .eq('round_name', round_name)
                .order('match_index', { ascending: false })
                .limit(1);
            nextIndex = (maxIndexData && maxIndexData.length > 0) ? maxIndexData[0].match_index + 1 : 0;
        }

        const insertPayload = {
            event_id,
            category_id,
            round_name,
            match_index: nextIndex,
            player_a: player_a || {},
            player_b: player_b || {},
            status: 'SCHEDULED'
        };

        // Only include bracket_id if it exists (allows manual matches without brackets)
        if (bracket_id) {
            insertPayload.bracket_id = bracket_id;
        }

        const { data, error } = await supabaseAdmin
            .from('matches')
            .insert(insertPayload)
            .select()
            .single();

        if (error) {
            console.error("Create Match Insert Error:", error);
            throw error;
        }

        return res.status(201).json({ success: true, match: data });

    } catch (error) {
        console.error("Create Match Error:", error);
        return res.status(500).json({ success: false, message: "Failed to create match" });
    }
};

// Update Match Score & Status
export const updateMatchScore = async (req, res) => {
    const { matchId } = req.params;
    const { score, status, winner } = req.body;

    try {
        // Fetch current match to get player data
        const { data: currentMatch } = await supabaseAdmin.from('matches').select('*').eq('id', matchId).single();

        if (!currentMatch) {
            return res.status(404).json({ success: false, message: "Match not found" });
        }

        const updatePayload = {
            updated_at: new Date().toISOString()
        };

        if (score) updatePayload.score = score;
        if (status) updatePayload.status = status;
        if (winner !== undefined) updatePayload.winner = winner;

        // IMPORTANT: Do NOT auto-calculate winner or auto-set status on score update
        // Winners are calculated ONLY during finalization (finalizeRoundMatches endpoint)
        // This allows admin to freely edit scores without premature locking

        // Only calculate winner if status is explicitly set to COMPLETED (for backward compatibility)
        if (status === 'COMPLETED' && !updatePayload.winner) {
            const finalScore = score || currentMatch.score;
            if (finalScore) {
                // Check if score uses sets format
                if (Array.isArray(finalScore.sets) && finalScore.sets.length > 0) {
                    // Sets-based scoring - get category's setsPerMatch
                    let categorySetsPerMatch = 1;
                    try {
                        const { data: eventData } = await supabaseAdmin
                            .from('events')
                            .select('categories')
                            .eq('id', currentMatch.event_id)
                            .single();
                        
                        if (eventData && eventData.categories && Array.isArray(eventData.categories)) {
                            const category = eventData.categories.find((c) => {
                                const catId = c.id || c.category_id;
                                return catId && (String(catId) === String(currentMatch.category_id) || catId === currentMatch.category_id);
                            });
                            
                            if (category) {
                                const setsValue = category.setsPerMatch || category.sets_per_match || "";
                                categorySetsPerMatch = setsValue === "" ? 1 : parseInt(setsValue, 10);
                                if (isNaN(categorySetsPerMatch) || categorySetsPerMatch < 1) {
                                    categorySetsPerMatch = 1;
                                }
                            }
                        }
                    } catch (err) {
                        console.error("Failed to fetch category setsPerMatch:", err);
                    }

                    // Calculate winner based on best-of-N sets
                    let player1SetsWon = 0;
                    let player2SetsWon = 0;
                    const setsToWin = Math.ceil(categorySetsPerMatch / 2);

                    for (const set of finalScore.sets) {
                        const p1Score = parseInt(set.player1 || 0);
                        const p2Score = parseInt(set.player2 || 0);
                        
                        if (p1Score > p2Score) {
                            player1SetsWon++;
                        } else if (p2Score > p1Score) {
                            player2SetsWon++;
                        }
                    }

                    if (player1SetsWon >= setsToWin) {
                        updatePayload.winner = currentMatch.player_a?.id || currentMatch.player_a;
                    } else if (player2SetsWon >= setsToWin) {
                        updatePayload.winner = currentMatch.player_b?.id || currentMatch.player_b;
                    } else {
                        // No clear winner - default based on more sets won
                        if (player1SetsWon > player2SetsWon) {
                            updatePayload.winner = currentMatch.player_a?.id || currentMatch.player_a;
                        } else if (player2SetsWon > player1SetsWon) {
                            updatePayload.winner = currentMatch.player_b?.id || currentMatch.player_b;
                        } else {
                            const isLeagueMatch = currentMatch.round_name === 'LEAGUE';
                            updatePayload.winner = isLeagueMatch ? null : (currentMatch.player_a?.id || currentMatch.player_a);
                        }
                    }
                } else {
                    // Legacy format: { player1: X, player2: Y }
                    const p1Score = parseInt(finalScore.player1 || finalScore.player_a || 0);
                    const p2Score = parseInt(finalScore.player2 || finalScore.player_b || 0);

                    if (p1Score > p2Score) {
                        updatePayload.winner = currentMatch.player_a?.id || currentMatch.player_a;
                    } else if (p2Score > p1Score) {
                        updatePayload.winner = currentMatch.player_b?.id || currentMatch.player_b;
                    } else {
                        // Draw - set winner to null (or keep as player_a for backward compatibility with knockout)
                        // For league matches, null indicates a draw
                        // For knockout matches, we default to player_a (first player advances)
                        const isLeagueMatch = currentMatch.round_name === 'LEAGUE';
                        updatePayload.winner = isLeagueMatch ? null : (currentMatch.player_a?.id || currentMatch.player_a);
                    }
                }
            }
        }

        const { data, error } = await supabaseAdmin
            .from('matches')
            .update(updatePayload)
            .eq('id', matchId)
            .select()
            .single();

        if (error) throw error;

        return res.status(200).json({ success: true, match: data });

    } catch (error) {
        console.error("Update Score Error:", error);
        return res.status(500).json({ success: false, message: "Failed to update score" });
    }
};

// Finalize all matches in a round (calculate winners and set status to COMPLETED)
export const finalizeRoundMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName, matches } = req.body;

    if (!eventId || !roundName || !matches || !Array.isArray(matches) || matches.length === 0) {
        return res.status(400).json({
            success: false,
            message: "Event ID, round name, and matches array are required"
        });
    }

    try {
        // Validate all matches exist and belong to this event/category/round
        // CRITICAL: Filter by event_id, category_id, and round_name to ensure proper isolation
        const matchIds = matches.map(m => m.matchId);
        let validationQuery = supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .eq('round_name', roundName)
            .in('id', matchIds);

        // Filter by categoryId if provided (CRITICAL for multi-category events)
        if (categoryId) {
            if (isUuid(categoryId)) {
                validationQuery = validationQuery.eq('category_id', categoryId);
            } else {
                validationQuery = validationQuery.eq('category_id', categoryId);
            }
        }

        const { data: existingMatches, error: fetchError } = await validationQuery;

        if (fetchError) {
            throw fetchError;
        }

        if (!existingMatches || existingMatches.length !== matchIds.length) {
            return res.status(400).json({
                success: false,
                message: "Some matches not found or don't belong to this event/category/round"
            });
        }

        // Additional validation: Ensure all matches belong to the correct category
        if (categoryId && existingMatches.length > 0) {
            const mismatchedMatches = existingMatches.filter(m => {
                const matchCategoryId = m.category_id;
                return matchCategoryId != categoryId && String(matchCategoryId) !== String(categoryId);
            });

            if (mismatchedMatches.length > 0) {
                return res.status(400).json({
                    success: false,
                    message: `Some matches belong to a different category. Expected: ${categoryId}`
                });
            }
        }

        // Get category's setsPerMatch from event
        let categorySetsPerMatch = 1; // Default to 1 set
        try {
            const { data: eventData } = await supabaseAdmin
                .from('events')
                .select('categories')
                .eq('id', eventId)
                .single();
            
            if (eventData && eventData.categories && Array.isArray(eventData.categories)) {
                const category = eventData.categories.find((c) => {
                    const catId = c.id || c.category_id;
                    return catId && (String(catId) === String(categoryId) || catId === categoryId);
                });
                
                if (category) {
                    const setsValue = category.setsPerMatch || category.sets_per_match || "";
                    categorySetsPerMatch = setsValue === "" ? 1 : parseInt(setsValue, 10);
                    if (isNaN(categorySetsPerMatch) || categorySetsPerMatch < 1) {
                        categorySetsPerMatch = 1;
                    }
                }
            }
        } catch (err) {
            console.error("Failed to fetch category setsPerMatch:", err);
            // Continue with default value of 1
        }

        // Process all matches in a transaction-like manner
        const updates = [];
        for (const matchData of matches) {
            const existingMatch = existingMatches.find(m => m.id === matchData.matchId);
            if (!existingMatch) continue;

            const score = matchData.score;
            let finalScore;
            let winner = null;

            // Check if score uses sets format
            if (score && Array.isArray(score.sets) && score.sets.length > 0) {
                // Sets-based scoring
                const sets = score.sets;
                const isLeagueMatch = String(existingMatch.round_name || "").trim().toUpperCase() === "LEAGUE";
                
                // Validate all sets have valid scores
                for (let i = 0; i < sets.length; i++) {
                    const set = sets[i];
                    const p1Score = parseInt(set.player1 || 0);
                    const p2Score = parseInt(set.player2 || 0);
                    
                    if (isNaN(p1Score) || isNaN(p2Score) || p1Score < 0 || p2Score < 0) {
                        return res.status(400).json({
                            success: false,
                            message: `Invalid scores in set ${i + 1} for match ${matchData.matchId}`
                        });
                    }
                }

                // Calculate winner based on best-of-N sets
                let player1SetsWon = 0;
                let player2SetsWon = 0;
                const setsToWin = Math.ceil(categorySetsPerMatch / 2); // e.g., for best of 3, need 2 sets to win

                for (const set of sets) {
                    const p1Score = parseInt(set.player1 || 0);
                    const p2Score = parseInt(set.player2 || 0);
                    
                    if (p1Score > p2Score) {
                        player1SetsWon++;
                    } else if (p2Score > p1Score) {
                        player2SetsWon++;
                    }
                    // If equal, neither wins the set (rare but possible)
                }

                // Determine winner: first to win required sets
                if (player1SetsWon >= setsToWin) {
                    winner = existingMatch.player_a?.id || existingMatch.player_a;
                } else if (player2SetsWon >= setsToWin) {
                    winner = existingMatch.player_b?.id || existingMatch.player_b;
                } else {
                    // No clear winner (usually caused by tied sets). Handle by match type:
                    // - LEAGUE: allow draw (winner = null)
                    // - KNOCKOUT/BRACKET: draw is invalid; admin must correct scores
                    if (player1SetsWon === player2SetsWon) {
                        if (isLeagueMatch) {
                            winner = null;
                        } else {
                            return res.status(400).json({
                                success: false,
                                message: `Draw is not allowed for knockout matches. Please correct the set scores for match ${matchData.matchId}.`
                            });
                        }
                    } else if (player1SetsWon > player2SetsWon) {
                        winner = existingMatch.player_a?.id || existingMatch.player_a;
                    } else {
                        winner = existingMatch.player_b?.id || existingMatch.player_b;
                    }
                }

                finalScore = { sets: sets };
            } else {
                // Legacy format: { player1: X, player2: Y } - convert to sets format for consistency
                const p1Score = parseInt(score.player1 || score.player_a || 0);
                const p2Score = parseInt(score.player2 || score.player_b || 0);
                const isLeagueMatch = String(existingMatch.round_name || "").trim().toUpperCase() === "LEAGUE";

                // Validate scores
                if (isNaN(p1Score) || isNaN(p2Score) || p1Score < 0 || p2Score < 0) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid scores for match ${matchData.matchId}`
                    });
                }

                // Convert to sets format (single set)
                finalScore = { sets: [{ player1: p1Score, player2: p2Score }] };

                // Calculate winner (simple comparison for single set)
                if (p1Score > p2Score) {
                    winner = existingMatch.player_a?.id || existingMatch.player_a;
                } else if (p2Score > p1Score) {
                    winner = existingMatch.player_b?.id || existingMatch.player_b;
                } else {
                    if (isLeagueMatch) {
                        winner = null;
                    } else {
                        return res.status(400).json({
                            success: false,
                            message: `Draw is not allowed for knockout matches. Please correct the score for match ${matchData.matchId}.`
                        });
                    }
                }
            }

            updates.push({
                id: matchData.matchId,
                score: finalScore,
                winner: winner,
                status: 'COMPLETED',
                updated_at: new Date().toISOString()
            });
        }

        // Update all matches
        const updatePromises = updates.map(update =>
            supabaseAdmin
                .from('matches')
                .update({
                    score: update.score,
                    winner: update.winner,
                    status: update.status,
                    updated_at: update.updated_at
                })
                .eq('id', update.id)
                .select()
                .single()
        );

        const results = await Promise.all(updatePromises);
        const errors = results.filter(r => r.error);

        if (errors.length > 0) {
            console.error("Finalize matches errors:", errors);
            return res.status(500).json({
                success: false,
                message: "Failed to finalize some matches",
                errors: errors.map(e => e.error?.message)
            });
        }

        return res.status(200).json({
            success: true,
            message: `Successfully finalized ${updates.length} match(es)`,
            finalizedCount: updates.length,
            matches: results.map(r => r.data).filter(Boolean)
        });

    } catch (error) {
        console.error("Finalize Round Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to finalize matches",
            error: error.message
        });
    }
};

// Delete Match
export const deleteMatch = async (req, res) => {
    const { matchId } = req.params;

    if (!matchId) {
        return res.status(400).json({ success: false, message: "Match ID is required" });
    }

    try {
        // First, verify the match exists
        const { data: existingMatch, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('id')
            .eq('id', matchId)
            .single();

        if (fetchError || !existingMatch) {
            return res.status(404).json({
                success: false,
                message: "Match not found"
            });
        }

        // Delete the match
        const { data, error } = await supabaseAdmin
            .from('matches')
            .delete()
            .eq('id', matchId)
            .select();

        if (error) {
            console.error("Delete Match Error:", error);
            throw error;
        }

        // Verify deletion
        if (!data || data.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Match not found or already deleted"
            });
        }

        return res.status(200).json({
            success: true,
            message: "Match deleted successfully",
            deletedMatch: data[0]
        });
    } catch (error) {
        console.error("Delete Match Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete match",
            error: error.message
        });
    }
};

// Delete All Matches for a Category
export const deleteCategoryMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName, round_name } = req.query;
    const effectiveRoundName = (roundName || round_name) ? String(roundName || round_name).trim() : null;

    if (!eventId) {
        return res.status(400).json({ success: false, message: "Event ID is required" });
    }

    if (!categoryId && !categoryName) {
        return res.status(400).json({ success: false, message: "Category ID or Category Name is required" });
    }

    try {
        // First, get all matches for this event to see what we're working with
        const { data: allMatches, error: fetchError } = await supabaseAdmin
            .from('matches')
            .select('id, category_id, event_id')
            .eq('event_id', eventId);

        if (fetchError) {
            console.error("Fetch matches error:", fetchError);
            throw fetchError;
        }

        if (!allMatches || allMatches.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found for this category",
                deletedCount: 0
            });
        }

        // Filter matches by category (and optional round) - try multiple matching strategies
        // CRITICAL: Use exact matching to avoid deleting matches from other categories
        let matchesToDelete = allMatches.filter(match => {
            const matchCategoryId = match.category_id;
            if (!matchCategoryId) return false;

            // Strategy 1: Exact UUID match (most reliable)
            if (categoryId && isUuid(categoryId)) {
                return String(matchCategoryId) === String(categoryId);
            }

            // Strategy 2: Exact text/numeric match (categoryId as text or number)
            if (categoryId) {
                // Use == for type coercion (handles number vs string)
                if (matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId)) {
                    return true;
                }
            }

            // Strategy 3: Category name exact match (if category_id stores the full label)
            if (categoryName && (matchCategoryId === categoryName || String(matchCategoryId) === String(categoryName))) {
                return true;
            }

            return false;
        });

        // Optional: filter by roundName if provided (e.g., LEAGUE only)
        if (effectiveRoundName) {
            // Need to refetch with round_name for filtering, since initial select didn't include it
            const { data: matchesWithRounds, error: roundsFetchError } = await supabaseAdmin
                .from('matches')
                .select('id, round_name')
                .eq('event_id', eventId)
                .in('id', matchesToDelete.map(m => m.id));

            if (roundsFetchError) {
                throw roundsFetchError;
            }

            const roundById = new Map((matchesWithRounds || []).map(m => [m.id, m.round_name]));
            matchesToDelete = matchesToDelete.filter(m => String(roundById.get(m.id) || "").trim() === effectiveRoundName);
        }

        if (matchesToDelete.length === 0) {
            return res.status(200).json({
                success: true,
                message: "No matches found matching the specified category",
                deletedCount: 0
            });
        }

        // Delete all matching matches
        const matchIds = matchesToDelete.map(m => m.id);
        const { data: deletedData, error: deleteError } = await supabaseAdmin
            .from('matches')
            .delete()
            .in('id', matchIds)
            .select();

        if (deleteError) {
            console.error("Delete Category Matches Error:", deleteError);
            throw deleteError;
        }

        const deletedCount = deletedData?.length || 0;

        return res.status(200).json({
            success: true,
            message: `Deleted ${deletedCount} match(es) for this category`,
            deletedCount: deletedCount
        });
    } catch (error) {
        console.error("Delete Category Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete category matches",
            error: error.message
        });
    }
};

// Get Matches (Scoreboard) - Public version (no auth required)
export const getPublicMatches = async (req, res) => {
    const eventId = req.params.id || req.params.eventId; // Support both :id and :eventId routes
    const { categoryId, categoryName, roundName, round_name } = req.query;

    if (!eventId) {
        return res.status(400).json({
            success: false,
            message: "Event ID is required",
            debug: { params: req.params, query: req.query }
        });
    }

    // 🔒 LEAGUE GOLDEN RULE: For LEAGUE matches, category_id is mandatory and exact
    // No bracket lookup. No label guessing. No partial matching.
    const isLeagueRequest = roundName === 'LEAGUE' || round_name === 'LEAGUE';

    try {
        // 🔒 LEAGUE MODE: HARD-ISOLATE AT QUERY LEVEL (CRITICAL)
        // Query Supabase directly with exact filters - DO NOT fetch all matches first
        // This eliminates all contamination from matches with wrong/null category_id
        if (isLeagueRequest && categoryId) {
            const { data: leagueMatches, error: leagueError } = await supabaseAdmin
                .from('matches')
                .select('id, round_name, player_a, player_b, score, status, winner, updated_at, category_id, event_id')
                .eq('event_id', eventId)
                .eq('round_name', 'LEAGUE')
                .eq('category_id', categoryId)
                .order('match_index', { ascending: true });

            if (leagueError) {
                throw leagueError;
            }

            return res.status(200).json({
                success: true,
                matches: leagueMatches || []
            });
        }

        // For non-LEAGUE requests, fetch all matches (existing logic for knockout brackets)
        let query = supabaseAdmin
            .from('matches')
            .select('id, round_name, player_a, player_b, score, status, winner, updated_at, category_id, event_id')
            .eq('event_id', eventId)
            .order('round_name', { ascending: true })
            .order('match_index', { ascending: true });

        const { data: allMatches, error: queryError } = await query;

        if (queryError) {
            throw queryError;
        }

        // If no category filter, return all matches
        if (!categoryId && !categoryName) {
            return res.status(200).json({ success: true, matches: allMatches || [] });
        }

        // Try to find matching category IDs from event_brackets
        // This handles cases where category_id in matches might differ from what frontend sends
        let matchingCategoryIds = new Set();

        if (categoryId) {
            matchingCategoryIds.add(categoryId);
        }

        // Also check event_brackets to find what category_id was used when creating matches
        if (categoryName || categoryId) {
            // Try to match by category name/label
            if (categoryName) {
                // Try exact match
                const { data: exactBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .eq('category', categoryName);

                if (exactBrackets && exactBrackets.length > 0) {
                    exactBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }

                // Try partial match (in case categoryName is a full label like "U-11 - Male - Singles")
                const baseCategoryName = categoryName.split(' - ')[0]; // Get "U-11" from "U-11 - Male - Singles"
                const { data: partialBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .ilike('category', `%${baseCategoryName}%`);

                if (partialBrackets && partialBrackets.length > 0) {
                    partialBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }
            }

            // If categoryId provided, check brackets by category_id
            if (categoryId) {
                const { data: idBrackets } = await supabaseAdmin
                    .from('event_brackets')
                    .select('category_id, category')
                    .eq('event_id', eventId)
                    .eq('category_id', categoryId);

                if (idBrackets && idBrackets.length > 0) {
                    idBrackets.forEach(b => {
                        if (b.category_id) matchingCategoryIds.add(b.category_id);
                        if (b.category) matchingCategoryIds.add(b.category);
                    });
                }

                // If categoryId is not a UUID, also try matching as category name
                if (!isUuid(categoryId)) {
                    const { data: nameBrackets } = await supabaseAdmin
                        .from('event_brackets')
                        .select('category_id, category')
                        .eq('event_id', eventId)
                        .eq('category', categoryId);

                    if (nameBrackets && nameBrackets.length > 0) {
                        nameBrackets.forEach(b => {
                            if (b.category_id) matchingCategoryIds.add(b.category_id);
                            if (b.category) matchingCategoryIds.add(b.category);
                        });
                    }
                }
            }
        }

        // Also check event categories to find matching IDs
        if (categoryId || categoryName) {
            const { data: eventData } = await supabaseAdmin
                .from('events')
                .select('categories')
                .eq('id', eventId)
                .single();

            if (eventData && eventData.categories) {
                const categories = Array.isArray(eventData.categories)
                    ? eventData.categories
                    : (typeof eventData.categories === 'string' ? JSON.parse(eventData.categories) : []);

                categories.forEach(cat => {
                    if (typeof cat === 'object' && cat !== null) {
                        const catId = cat.id || cat.category_id;
                        const catName = cat.category || cat.name || cat.rawName;

                        // If categoryId matches
                        if (categoryId && (catId === categoryId || catName === categoryId)) {
                            if (catId) matchingCategoryIds.add(catId);
                            if (catName) matchingCategoryIds.add(catName);
                        }

                        // If categoryName matches - use EXACT match only to avoid cross-category issues
                        if (categoryName) {
                            const fullLabel = catName + (cat.gender ? ` - ${cat.gender}` : '') + (cat.match_type ? ` - ${cat.match_type}` : '');
                            // Only exact match - don't use includes() as it causes U-15 Male to match U-15 Female
                            if (fullLabel === categoryName || categoryName === fullLabel) {
                                if (catId) matchingCategoryIds.add(catId);
                            }
                        }
                    } else if (typeof cat === 'string') {
                        // Exact match only for string categories
                        if (categoryId === cat || categoryName === cat) {
                            matchingCategoryIds.add(cat);
                        }
                    }
                });
            }
        }

        // CRITICAL: Only use exact categoryId match to prevent cross-category matches
        // The problem: Adding base names like "U-15" causes all U-15 variants to match
        // Solution: Only match the exact categoryId that was selected
        if (categoryId) {
            // Always prioritize exact categoryId - this is the most reliable
            matchingCategoryIds.add(categoryId);
        }

        // Add exact categoryName as well (in case category_id stores the name)
        if (categoryName) {
            matchingCategoryIds.add(categoryName);
        }

        // Filter out any matches that don't match the exact categoryId
        // This prevents showing matches from other categories (e.g., U-15 Female when selecting U-15 Male)
        if (categoryId) {
            const filteredSet = new Set();

            // Keep exact categoryId
            if (matchingCategoryIds.has(categoryId)) {
                filteredSet.add(categoryId);
            }

            // Keep exact categoryName
            if (categoryName && matchingCategoryIds.has(categoryName)) {
                filteredSet.add(categoryName);
            }

            // Keep bracket category_ids that match exactly
            matchingCategoryIds.forEach(id => {
                // Only keep if it's the exact categoryId or exact categoryName
                if (id === categoryId || id === categoryName) {
                    filteredSet.add(id);
                }
            });

            // Only replace if we have matches (don't empty the set if we found some)
            if (filteredSet.size > 0) {
                matchingCategoryIds = filteredSet;
            }
        }

        // Filter matches by any of the matching category IDs
        // CRITICAL: Only show matches that exactly match the selected categoryId
        const filteredMatches = (allMatches || []).filter(match => {
            if (!match.category_id) {
                return false;
            }

            // Primary check: exact categoryId match
            const exactMatch = match.category_id === categoryId;

            // Secondary check: check if it's in our matching set (from brackets/events)
            const inMatchingSet = matchingCategoryIds.has(match.category_id);

            // Only include if it's an exact match OR it's in our validated matching set
            return exactMatch || inMatchingSet;
        });

        return res.status(200).json({ success: true, matches: filteredMatches });

    } catch (error) {
        console.error("Get Public Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch matches",
            error: error.message
        });
    }
};

// Get Matches (Scoreboard)
export const getMatches = async (req, res) => {
    const { eventId } = req.params;
    const { categoryId, categoryName, roundName } = req.query;

    try {
        // Start with base query - fetch all matches for event first
        let query = supabaseAdmin
            .from('matches')
            .select('*')
            .eq('event_id', eventId)
            .order('created_at', { ascending: true });

        // Try to filter by category_id, but if it fails (UUID type mismatch), we'll filter in memory
        let categoryFilterApplied = false;
        if (categoryId) {
            try {
                if (isUuid(categoryId)) {
                    query = query.eq('category_id', categoryId);
                    categoryFilterApplied = true;
                } else {
                    // Non-UUID - try to filter (might fail if column is UUID type)
                    query = query.eq('category_id', categoryId);
                    categoryFilterApplied = true;
                }
            } catch (e) {
                // Filter will be applied in memory if query fails
            }
        }

        // Filter by roundName if provided (do this first as it's most specific)
        if (roundName) {
            query = query.eq('round_name', roundName);
        }

        // Also try categoryName if provided (treat as category_id)
        if (categoryName && !categoryFilterApplied) {
            try {
                query = query.eq('category_id', categoryName);
                categoryFilterApplied = true;
            } catch (e) {
                // Filter will be applied in memory if query fails
            }
        }

        const { data, error } = await query;

        // If error occurs, retry and filter in memory (handles UUID type mismatches)
        if (error) {
            const retryQuery = supabaseAdmin
                .from('matches')
                .select('*')
                .eq('event_id', eventId)
                .order('created_at', { ascending: true });

            const { data: retryData, error: retryError } = await retryQuery;

            if (retryError) {
                throw retryError;
            }

            // Filter in memory (handles all cases including UUID/string mismatches)
            let filteredMatches = retryData || [];

            // Filter by categoryId (exact match)
            if (categoryId) {
                filteredMatches = filteredMatches.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Use == for type coercion (handles number vs string)
                    return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                });
            }

            // Filter by categoryName if provided (treat as category_id)
            if (categoryName) {
                filteredMatches = filteredMatches.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Exact match with type coercion
                    return matchCategoryId == categoryName || String(matchCategoryId) === String(categoryName);
                });
            }

            // Filter by roundName (exact match or trimmed match)
            if (roundName) {
                filteredMatches = filteredMatches.filter(m => {
                    const matchRoundName = m.round_name;
                    if (!matchRoundName) return false;
                    return String(matchRoundName).trim() === String(roundName).trim();
                });
            }

            return res.status(200).json({ success: true, matches: filteredMatches });
        }

        if (error) throw error;

        // Always do in-memory filtering as fallback to ensure we catch all matches
        // This handles cases where categoryId is stored as number vs string, or UUID vs label
        let finalMatches = data || [];

        if (finalMatches.length > 0 && (categoryId || categoryName)) {
            let filtered = finalMatches;
            const originalCount = finalMatches.length;

            // Try categoryId first (exact match with type coercion)
            if (categoryId) {
                filtered = filtered.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Use == for type coercion (handles number vs string)
                    return matchCategoryId == categoryId || String(matchCategoryId) === String(categoryId);
                });
            }

            // If categoryId filter returned 0 matches, try categoryName as fallback
            if (categoryName && filtered.length === 0 && originalCount > 0) {
                // Reset to original matches for categoryName filtering
                filtered = finalMatches;

                filtered = filtered.filter(m => {
                    const matchCategoryId = m.category_id;
                    if (!matchCategoryId) return false;
                    // Exact match with type coercion
                    return matchCategoryId == categoryName || String(matchCategoryId) === String(categoryName);
                });
            }

            finalMatches = filtered;
        }

        return res.status(200).json({ success: true, matches: finalMatches });

    } catch (error) {
        console.error("Get Matches Error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to fetch matches",
            error: error.message
        });
    }
};
