import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * Helper: Create Notification within Backend
 * @param {string} userId - UUID of the user
 * @param {string} title - Title
 * @param {string} message - Message Content
 * @param {string} type - 'info' | 'success' | 'warning' | 'error'
 * @param {string} [link] - Optional link
 */
export const createNotification = async (userId, title, message, type = 'info', link = null) => {
    try {
        const { error } = await supabaseAdmin
            .from('notifications')
            .insert({
                user_id: userId,
                title,
                message,
                type,
                link,
                is_read: false
            });

        if (error) {
            console.error("Error creating notification:", error);
            return false;
        }
        return true;
    } catch (err) {
        console.error("Exception creating notification:", err);
        return false;
    }
};
