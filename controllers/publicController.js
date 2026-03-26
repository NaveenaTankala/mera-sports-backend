import { supabaseAdmin } from "../config/supabaseClient.js";
import { getPublicEventId, resolveEventIdByIdentifier } from "../utils/eventResolver.js";

// Simple UUID v4 validator
const isUuid = (value) => {
    if (!value || typeof value !== "string") return false;
    return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        value.trim()
    );
};

/**
 * Sanitize a string for safe use in Supabase ilike / eq filters.
 * Strips characters that could be used for SQL/PostgREST injection:
 *   - Removes parentheses, semicolons, single/double quotes, backslashes, commas
 *   - Escapes SQL LIKE wildcards (% and _) so they match literally
 *   - Trims and limits length to 200 chars
 */
const sanitizeFilterInput = (value) => {
    if (!value || typeof value !== 'string') return '';
    return value
        .replace(/[()';"\\,]/g, '')  // strip dangerous chars
        .replace(/%/g, '\\%')        // escape LIKE wildcard
        .replace(/_/g, '\\_')        // escape LIKE wildcard
        .trim()
        .slice(0, 200);
};

// GET /api/public/events/list
export const listPublicEvents = async (_req, res) => {
    try {
        const { data, error } = await supabaseAdmin
            .from("events")
            .select("*, event_registrations(count)")
            .order("start_date", { ascending: true });

        if (error) throw error;

        const events = (data || []).map((event) => {
            const publicId = getPublicEventId(event);
            const { id: _internalId, ...rest } = event;
            return {
                ...rest,
                id: publicId,
                public_id: publicId,
            };
        });

        return res.json({ success: true, events });
    } catch (err) {
        console.error("PUBLIC EVENTS LIST ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch public events", events: [] });
    }
};

// GET /api/public/settings
export const getPublicSettings = async (req, res) => {
    try {
        const { data: settings, error } = await supabaseAdmin
            .from("platform_settings")
            .select("platform_name, logo_url, support_email, support_phone, logo_size, registration_config")
            .eq("id", 1)
            .maybeSingle();

        if (error) throw error;

        res.json({
            success: true,
            settings: settings || { platform_name: 'Sports Paramount', logo_url: '' }
        });
    } catch (err) {
        console.error("PUBLIC SETTINGS ERROR:", err);
        res.json({
            success: true,
            settings: { platform_name: 'Sports Paramount', logo_url: '' }
        });
    }
};

/**
 * Public: Get league config (participants + rules) for a category.
 * GET /api/public/events/:id/categories/:categoryId/league
 * Query: categoryLabel or category (optional fallback when categoryId is not present)
 */
export const getPublicLeagueConfig = async (req, res) => {
    try {
        const { id: eventIdentifier, categoryId } = req.params;
        const rawCategoryLabel = req.query.categoryLabel || req.query.category;
        const categoryLabel = rawCategoryLabel ? sanitizeFilterInput(rawCategoryLabel) : null;

        if (!eventIdentifier) {
            return res.status(400).json({ success: false, message: "Event ID required" });
        }

        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) {
            return res.status(404).json({ success: false, message: "Event not found" });
        }

        if (!categoryId && !categoryLabel) {
            return res.status(400).json({ success: false, message: "Category ID or label required" });
        }

        let query = supabaseAdmin
            .from("leagues")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId) {
            query = query.eq("category_id", String(categoryId));
        } else if (categoryLabel) {
            query = query.eq("category_label", categoryLabel);
        }

        let { data, error } = await query.maybeSingle();

        if (error && error.code !== "PGRST116") {
            throw error;
        }

        if (!data && categoryId && !isUuid(categoryId)) {
            const fallback = await supabaseAdmin
                .from("leagues")
                .select("*")
                .eq("event_id", eventId)
                .eq("category_label", String(categoryId))
                .maybeSingle();

            if (!fallback.error || fallback.error.code === "PGRST116") {
                data = fallback.data;
            }
        }

        if (!data) {
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
                    },
                },
            });
        }

        const rawRules = data.rules || {};
        const pointsWin = Number(rawRules.pointsWin ?? rawRules.win ?? 3);
        const pointsLoss = Number(rawRules.pointsLoss ?? rawRules.loss ?? 0);
        const pointsDraw = Number(rawRules.pointsDraw ?? rawRules.draw ?? 1);

        return res.json({
            success: true,
            league: {
                format: rawRules.format === "HEAT" ? "HEAT" : "LEAGUE",
                participants: Array.isArray(data.participants) ? data.participants : [],
                rules: {
                    ...rawRules,
                    pointsWin: Number.isFinite(pointsWin) ? pointsWin : 3,
                    pointsLoss: Number.isFinite(pointsLoss) ? pointsLoss : 0,
                    pointsDraw: Number.isFinite(pointsDraw) ? pointsDraw : 1,
                    win: Number.isFinite(pointsWin) ? pointsWin : 3,
                    loss: Number.isFinite(pointsLoss) ? pointsLoss : 0,
                    draw: Number.isFinite(pointsDraw) ? pointsDraw : 1,
                },
            },
        });
    } catch (err) {
        console.error("PUBLIC GET LEAGUE CONFIG ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to fetch public league config" });
    }
};

/**
 * Public: Get published draw/bracket for a category
 * GET /api/public/events/:id/categories/:categoryId/draw
 * Query: categoryLabel or category (if no categoryId)
 * Only returns published draws.
 */
export const getPublicCategoryDraw = async (req, res) => {
    try {
        const { id: eventIdentifier, categoryId } = req.params;
        const rawCategoryLabel = req.query.categoryLabel || req.query.category;
        const categoryLabel = rawCategoryLabel ? sanitizeFilterInput(rawCategoryLabel) : null;

        if (!eventIdentifier) return res.status(400).json({ message: "Event ID required" });
        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) return res.status(404).json({ message: "Event not found" });

        let query = supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId);

        if (categoryId && isUuid(categoryId)) {
            query = query.eq("category_id", categoryId);
        } else if (categoryLabel) {
            query = query.eq("category", categoryLabel);
        } else {
            return res.status(400).json({ message: "Category ID or label required" });
        }

        let { data, error } = await query.order("created_at", { ascending: true });

        // Partial matching fallback when using categoryLabel
        if ((!data || data.length === 0) && categoryLabel && !categoryId) {
            const labelParts = categoryLabel.split(" - ").filter(p => p.trim()).map(p => sanitizeFilterInput(p));
            if (labelParts.length > 0) {
                const baseCategory = sanitizeFilterInput(labelParts[0]);
                const { data: partialData, error: partialError } = await supabaseAdmin
                    .from("event_brackets")
                    .select("*")
                    .eq("event_id", eventId)
                    .ilike("category", `${baseCategory}%`)
                    .order("created_at", { ascending: true });

                if (!partialError && partialData && partialData.length > 0) {
                    if (partialData.length === 1) {
                        data = partialData;
                        error = null;
                    } else {
                        const exactishMatch = partialData.filter(row => {
                            const storedLabel = (row.category || "").toLowerCase();
                            return labelParts.every(part => storedLabel.includes(part.toLowerCase()));
                        });
                        if (exactishMatch.length > 0) {
                            data = exactishMatch;
                            error = null;
                        }
                    }
                }
            }
        }

        if (error) throw error;

        // Group by mode
        const mediaDraw = data.find(b => b.mode === 'MEDIA');
        const bracketDraw = data.find(b => b.mode === 'BRACKET');

        const hasActualMedia = mediaDraw && ((mediaDraw.media_urls && mediaDraw.media_urls.length > 0) || mediaDraw.pdf_url);
        const mode = bracketDraw ? 'BRACKET' : (hasActualMedia ? 'MEDIA' : null);

        // Only return published data to the public
        const isMediaPublished = mediaDraw && hasActualMedia && mediaDraw.published;
        const isBracketPublished = bracketDraw && bracketDraw.published;

        // If nothing is published, return empty draw
        if (!isMediaPublished && !isBracketPublished) {
            return res.json({
                success: true,
                draw: {
                    categoryId: categoryId || null,
                    categoryLabel: categoryLabel || data[0]?.category || null,
                    mode: null,
                    media: null,
                    bracket: null,
                    published: false
                }
            });
        }

        res.json({
            success: true,
            draw: {
                categoryId: categoryId || null,
                categoryLabel: categoryLabel || data[0]?.category,
                mode: isBracketPublished ? 'BRACKET' : (isMediaPublished ? 'MEDIA' : null),
                media: isMediaPublished ? {
                    id: mediaDraw.id,
                    urls: mediaDraw.media_urls || [],
                    pdfUrl: mediaDraw.pdf_url,
                    published: mediaDraw.published
                } : null,
                bracket: isBracketPublished ? {
                    id: bracketDraw.id,
                    roundStructure: bracketDraw.round_structure || [],
                    bracketData: bracketDraw.bracket_data || {},
                    published: bracketDraw.published
                } : null,
                published: true
            }
        });
    } catch (err) {
        console.error("PUBLIC GET CATEGORY DRAW ERROR:", err);
        res.status(500).json({ message: "Failed to fetch category draw", error: err.message });
    }
};

/**
 * Public: Get all published draws for an event
 * GET /api/public/events/:id/draws
 * Returns all published brackets/media draws grouped by category.
 */
export const getPublicEventDraws = async (req, res) => {
    try {
        const { id: eventIdentifier } = req.params;
        if (!eventIdentifier) return res.status(400).json({ message: "Event ID required" });
        const eventId = await resolveEventIdByIdentifier(eventIdentifier);
        if (!eventId) return res.status(404).json({ message: "Event not found" });

        const { data, error } = await supabaseAdmin
            .from("event_brackets")
            .select("*")
            .eq("event_id", eventId)
            .eq("published", true)
            .order("created_at", { ascending: true });

        if (error) throw error;

        // Group by category_id or category label
        const categoryMap = {};
        for (const row of (data || [])) {
            const key = row.category_id || row.category || row.id;
            if (!categoryMap[key]) {
                categoryMap[key] = {
                    categoryId: row.category_id,
                    categoryLabel: row.category,
                    media: null,
                    bracket: null
                };
            }
            if (row.mode === 'MEDIA') {
                const hasMedia = (row.media_urls && row.media_urls.length > 0) || row.pdf_url;
                if (hasMedia) {
                    categoryMap[key].media = {
                        id: row.id,
                        urls: row.media_urls || [],
                        pdfUrl: row.pdf_url
                    };
                }
            } else if (row.mode === 'BRACKET') {
                categoryMap[key].bracket = {
                    id: row.id,
                    roundStructure: row.round_structure || [],
                    bracketData: row.bracket_data || {}
                };
            }
        }

        // Convert to array and determine mode for each
        const draws = Object.values(categoryMap).map(cat => ({
            ...cat,
            mode: cat.bracket ? 'BRACKET' : (cat.media ? 'MEDIA' : null)
        }));

        res.json({ success: true, draws });
    } catch (err) {
        console.error("PUBLIC GET EVENT DRAWS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch event draws", error: err.message });
    }
};
