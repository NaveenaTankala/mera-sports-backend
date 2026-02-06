import { supabaseAdmin } from "../config/supabaseClient.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// GET /api/admin/list-admins
export const listAdmins = async (req, res) => {
    try {
        // Fetch both admin and superadmin roles
        const { data: admins, error } = await supabaseAdmin
            .from("users")
            .select("id, name, email, role, verification, created_at")
            .in("role", ["admin", "superadmin"]);
        if (error) throw error;
        res.json({ success: true, admins });
    } catch (err) {
        console.error("FETCH ADMINS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch admins" });
    }
};

// POST /api/admin/approve-admin/:id
export const approveAdmin = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("users").update({ verification: "verified" }).eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "Admin approved successfully" });
    } catch (err) {
        console.error("APPROVE ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to approve admin" });
    }
};

// POST /api/admin/reject-admin/:id
export const rejectAdmin = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("users").update({ verification: "rejected" }).eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "Admin application rejected" });
    } catch (err) {
        console.error("REJECT ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to reject admin" });
    }
};

// DELETE /api/admin/delete-admin/:id
export const deleteAdmin = async (req, res) => {
    try {
        const targetAdminId = req.params.id;
        const superAdminId = req.user.id;

        // 1. Unassign events
        const { error: unassignError } = await supabaseAdmin.from('events').update({ assigned_to: null }).eq('assigned_to', targetAdminId);
        if (unassignError) throw unassignError;

        // 2. Transfer events
        const { error: transferError } = await supabaseAdmin.from('events').update({ created_by: superAdminId }).eq('created_by', targetAdminId);
        if (transferError) throw transferError;

        // 3. Delete user
        await supabaseAdmin.auth.admin.deleteUser(targetAdminId).catch(console.warn);
        const { error: deletePublicError } = await supabaseAdmin.from('users').delete().eq('id', targetAdminId);
        if (deletePublicError) throw deletePublicError;

        res.json({ success: true, message: "Admin deleted and events re-organized." });
    } catch (err) {
        console.error("DELETE ADMIN ERROR:", err);
        res.status(500).json({ message: "Failed to delete admin: " + err.message });
    }
};

// GET /api/admin/dashboard-stats
export const getDashboardStats = async (req, res) => {
    try {
        // Player Counts
        const { count: totalPlayers } = await supabaseAdmin.from("users").select("*", { count: 'exact', head: true }).eq("role", "player");
        const { count: verifiedPlayers } = await supabaseAdmin.from("users").select("*", { count: 'exact', head: true }).eq("role", "player").eq("verification", "verified");
        const { count: pendingPlayers } = await supabaseAdmin.from("users").select("*", { count: 'exact', head: true }).eq("role", "player").eq("verification", "pending");
        const { count: rejectedPlayersCount } = await supabaseAdmin.from("users").select("*", { count: 'exact', head: true }).eq("role", "player").eq("verification", "rejected");

        // Lists
        const { data: recentPlayers } = await supabaseAdmin.from("users").select("*").eq("role", "player").order("created_at", { ascending: false }).limit(6);
        const { data: rejectedPlayersList } = await supabaseAdmin.from("users").select("*").eq("role", "player").eq("verification", "rejected").order("created_at", { ascending: false }).limit(5);

        // Transactions
        const { data: rejectedTransactions } = await supabaseAdmin
            .from("event_registrations")
            .select(`*, events(name), users:player_id(first_name, last_name, player_id)`)
            .eq("status", "rejected")
            .order("created_at", { ascending: false })
            .limit(5);

        // Revenue
        const { data: approvedTxns } = await supabaseAdmin.from("event_registrations").select("amount_paid").eq("status", "verified");
        const totalRevenue = approvedTxns?.reduce((sum, txn) => sum + (Number(txn.amount_paid) || 0), 0) || 0;
        const totalTransactionsCount = approvedTxns?.length || 0;

        res.json({
            success: true,
            stats: {
                totalPlayers: totalPlayers || 0,
                verifiedPlayers: verifiedPlayers || 0,
                pendingPlayers: pendingPlayers || 0,
                rejectedPlayers: rejectedPlayersCount || 0,
                totalRevenue,
                totalTransactionsCount
            },
            recentPlayers: recentPlayers || [],
            rejectedPlayersList: rejectedPlayersList || [],
            rejectedTransactions: rejectedTransactions || []
        });
    } catch (err) {
        console.error("DASHBOARD STATS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch dashboard stats" });
    }
};

// POST /api/admin/update-admin-role/:id
export const updateAdminRole = async (req, res) => {
    try {
        // Only superadmins can update roles
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({ message: "Only superadmins can update admin roles" });
        }

        const { role } = req.body;
        const targetAdminId = req.params.id;
        const currentUserId = req.user.id;

        // Validate role
        if (role !== 'admin' && role !== 'superadmin') {
            return res.status(400).json({ message: "Invalid role. Must be 'admin' or 'superadmin'" });
        }

        // Prevent self-demotion (superadmin cannot demote themselves)
        if (targetAdminId === currentUserId && role === 'admin') {
            return res.status(400).json({ message: "You cannot demote yourself" });
        }

        // Update role
        const { error } = await supabaseAdmin
            .from("users")
            .update({ role })
            .eq("id", targetAdminId);

        if (error) throw error;

        res.json({ success: true, message: `Admin role updated to ${role}` });
    } catch (err) {
        console.error("UPDATE ADMIN ROLE ERROR:", err);
        res.status(500).json({ message: "Failed to update admin role" });
    }
};

// POST /api/admin/upload
export const uploadAsset = async (req, res) => {
    try {
        const { image, folder } = req.body;
        if (!image) return res.status(400).json({ message: "No image data provided" });

        const url = await uploadBase64(image, 'admin-assets', folder || 'misc');
        if (url) res.json({ success: true, url });
        else res.status(400).json({ message: "Upload failed" });

    } catch (err) {
        console.error("UPLOAD ENDPOINT ERROR:", err);
        res.status(500).json({ message: "Server error during upload" });
    }
};
