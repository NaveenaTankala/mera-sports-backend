import { supabaseAdmin } from "../config/supabaseClient.js";
import { sendRegistrationEmail } from "../utils/mailer.js";
import { uploadBase64 } from "../utils/uploadHelper.js";
import { createNotification } from "../services/notificationService.js";

// POST /api/payment/submit-manual-payment
export const submitManualPayment = async (req, res) => {
    try {
        const { eventId, amount, categories, transactionId, screenshot, teamId, document } = req.body;
        const userId = req.user?.id;

        if (!userId) return res.status(401).json({ message: "Unauthorized" });
        if (!eventId || !amount || !categories || !screenshot) return res.status(400).json({ message: "Missing fields" });
        if (req.user.role === "admin") return res.status(403).json({ message: "Admins cannot register." });

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
            event_id: eventId,
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
                const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", eventId).single();
                if (user?.email) {
                    await sendRegistrationEmail(user.email, {
                        playerName: user.first_name, eventName: event?.name, registrationNo, amount, category: categories, date: new Date(), status: 'Pending Verification'
                    });
                }
            } catch (e) { console.error("Email Error:", e); }
        })();

        // 4. Notify team members about event registration (Async)
        if (teamId) {
            (async () => {
                try {
                    const { data: team } = await supabaseAdmin.from("player_teams").select("team_name, captain_name, members").eq("id", teamId).maybeSingle();
                    const { data: event } = await supabaseAdmin.from("events").select("name").eq("id", eventId).maybeSingle();
                    if (team && Array.isArray(team.members)) {
                        const eventName = event?.name || 'an event';
                        const captainName = team.captain_name || 'Your captain';
                        for (const member of team.members) {
                            let memberUserId = member.id || null;
                            if (!memberUserId && member.player_id) {
                                const { data: u } = await supabaseAdmin.from('users').select('id').ilike('player_id', member.player_id).maybeSingle();
                                if (u) memberUserId = u.id;
                            }
                            if (!memberUserId && member.mobile) {
                                const { data: u } = await supabaseAdmin.from('users').select('id').eq('mobile', member.mobile).maybeSingle();
                                if (u) memberUserId = u.id;
                            }
                            if (memberUserId) {
                                await createNotification(
                                    memberUserId,
                                    'Team Event Registration',
                                    `${captainName} registered your team "${team.team_name}" for "${eventName}".`,
                                    'info'
                                );
                            }
                        }
                    }
                } catch (e) { console.error("Team Notification Error:", e); }
            })();
        }

        res.json({ success: true, message: "Payment submitted", transactionId: transaction.id, registrationNo });

    } catch (err) {
        console.error("Manual Payment Error:", err);
        res.status(500).json({ message: "Internal Server Error" });
    }
};
