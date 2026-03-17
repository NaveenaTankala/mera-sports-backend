import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import { resolveEventIdByIdentifier } from "../utils/eventResolver.js";
import { sendRegistrationEmail } from "../utils/mailer.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

/**
 * Batch-resolve team member UUIDs and notify them of event registration.
 * Uses a single prefetch query instead of sequential per-member lookups,
 * and Promise.allSettled for safe parallel notification delivery.
 */
async function notifyTeamMembersOfRegistration(teamId, eventId) {
    try {
        // Fetch team and event data in parallel
        const [teamResult, eventResult] = await Promise.all([
            supabaseAdmin.from('player_teams').select('team_name, captain_name, members').eq('id', teamId).maybeSingle(),
            supabaseAdmin.from('events').select('name').eq('id', eventId).maybeSingle()
        ]);

        const team = teamResult.data;
        const event = eventResult.data;
        if (!team || !Array.isArray(team.members) || team.members.length === 0) return;

        const eventName = event?.name || 'an event';
        const captainName = team.captain_name || 'Your captain';

        // Batch-resolve all member UUIDs in a single query
        const playerIds = [];
        const mobiles = [];
        const knownIds = [];
        for (const m of team.members) {
            if (m.id) knownIds.push(m.id);
            if (m.player_id) playerIds.push(m.player_id.toUpperCase());
            if (m.mobile) mobiles.push(m.mobile);
        }

        const orFilters = [];
        if (knownIds.length > 0) orFilters.push(`id.in.(${knownIds.join(',')})`);
        if (playerIds.length > 0) orFilters.push(`player_id.in.(${playerIds.join(',')})`);
        if (mobiles.length > 0) orFilters.push(`mobile.in.(${mobiles.join(',')})`);

        if (orFilters.length === 0) return;

        const { data: users, error } = await supabaseAdmin
            .from('users')
            .select('id, player_id, mobile')
            .or(orFilters.join(','));

        if (error || !users) {
            console.error('Batch user lookup for team notification error:', error);
            return;
        }

        // Build lookup maps
        const byId = new Map(users.map(u => [u.id, u.id]));
        const byPlayerId = new Map(users.filter(u => u.player_id).map(u => [u.player_id.toUpperCase(), u.id]));
        const byMobile = new Map(users.filter(u => u.mobile).map(u => [u.mobile, u.id]));

        // Send all notifications in parallel with safe error handling
        const promises = team.members.map(member => {
            const userId = (member.id && byId.get(member.id))
                || (member.player_id && byPlayerId.get(member.player_id.toUpperCase()))
                || (member.mobile && byMobile.get(member.mobile))
                || null;
            if (!userId) return Promise.resolve();
            return createNotification(
                userId,
                'Team Event Registration',
                `${captainName} registered your team "${team.team_name}" for "${eventName}".`,
                'info'
            );
        });

        const results = await Promise.allSettled(promises);
        results.forEach((r, i) => {
            if (r.status === 'rejected') {
                console.error(`Team reg notification ${i} failed:`, r.reason);
            }
        });
    } catch (e) {
        console.error('notifyTeamMembersOfRegistration error:', e);
    }
}

// POST /api/payment/submit-manual-payment
export const submitManualPayment = async (req, res) => {
    try {
        const { eventId, amount, categories, transactionId, screenshot, teamId, document } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!eventId || !amount || !categories || !screenshot) return res.status(400).json({ message: "Missing fields" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });

        const resolvedEventId = await resolveEventIdByIdentifier(eventId);
        if (!resolvedEventId) return res.status(404).json({ message: "Event not found" });

        const screenshotUrl = await uploadBase64(screenshot, "event-assets", "payment-proofs");
        if (!screenshotUrl) return res.status(500).json({ message: "Failed to upload screenshot" });

        const documentUrl = await uploadBase64(document, "event-documents", "user-docs");

        // 1. Create Transaction
        const { data: transaction, error: txError } = await supabaseAdmin.from("transactions").insert({
            order_id: `MANUAL_${Date.now()}`,
            manual_transaction_id: transactionId || null,
            payment_mode: "manual",
            screenshot_url: screenshotUrl,
            amount,
            currency: "INR",
            user_id: userId,
        }).select().maybeSingle();

        if (txError || !transaction) throw txError || new Error("Tx Insert Failed");

        // 2. Create Registration
        const registrationNo = `REG-${Date.now()}`;
        const { error: regError } = await supabaseAdmin.from("event_registrations").insert({
            event_id: resolvedEventId,
            player_id: userId,
            registration_no: registrationNo,
            categories,
            amount_paid: amount,
            transaction_id: transaction.id,
            screenshot_url: screenshotUrl,
            manual_transaction_id: transactionId || null,
            team_id: teamId || null,
            document_url: documentUrl,
            status: 'pending_verification'
        });

        if (regError) {
            await supabaseAdmin.from("transactions").delete().eq("id", transaction.id);
            throw regError;
        }

        // 3. Email (Async)
        (async () => {
            try {
                const { data: user } = await supabaseAdmin.from("users").select("email, first_name").eq("id", userId).single();
                const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", resolvedEventId).single();
                if (user?.email) {
                    await sendRegistrationEmail(user.email, {
                        playerName: user.first_name, eventName: event?.name, registrationNo, amount, category: categories, date: new Date(), status: 'Pending Verification'
                    });
                }
            } catch (e) { console.error("Email Error:", e); }
        })();

        // 4. Notify team members about event registration (Async, non-blocking)
        if (teamId) {
            notifyTeamMembersOfRegistration(teamId, resolvedEventId).catch(e =>
                console.error('Team registration notification error:', e)
            );
        }

        res.json({ success: true, message: "Payment submitted", transactionId: transaction.id, registrationNo });

    } catch (err) {
        console.error("Manual Payment Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};
