import { supabaseAdmin } from "../config/supabaseClient.js";

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
