import { supabaseAdmin } from "../config/supabaseClient.js";

/**
 * Helper: Create Notification within Backend
 * @param {string} userId - UUID of the user
 * @param {string} title - Title
 * @param {string} message - Message Content
 * @param {string} type - 'info' | 'success' | 'warning' | 'error'
 * @param {string} [link] - Optional deduplication/navigation link
 * @returns {Promise<boolean>} true if the notification was created successfully, false on any error.
 *                             Callers should check the return value when notification delivery is critical.
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

        // Explicitly broadcast the event to the frontend for immediate realtime updates
        // This is safer than relying on postgres_changes if the table lacks publication configs
        await supabaseAdmin.channel(`system-notifications`).send({
            type: 'broadcast',
            event: 'new_notification',
            payload: { user_id: userId }
        }).catch(err => console.warn("Broadcast failed, but notification saved:", err));

        return true;
    } catch (err) {
        console.error("Exception creating notification:", err);
        return false;
    }
};
