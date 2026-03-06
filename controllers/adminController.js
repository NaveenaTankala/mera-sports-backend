import { supabaseAdmin } from "../config/supabaseClient.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// GET /api/admin/list-admins
export const listAdmins = async (req, res) => {
    try {
        // Fetch both admin and superadmin roles
        const { data: admins, error } = await supabaseAdmin
            .from("users")
            .select("id, name, email, role, verification, created_at")
            .in("role", ["admin", "superadmin", "institutehead"]);
        if (error) throw error;
        res.json({ success: true, admins });
    } catch (err) {
        res.status(500).json({ message: "Failed to fetch admins" });
    }
};

// GET /api/admin/institutes/pending
export const getPendingInstitutes = async (req, res) => {
    try {
        const { data: institutes, error } = await supabaseAdmin
            .from("users")
            .select("id, first_name, last_name, name, institute_name, email, mobile, website, city, state, country, role, verification, created_at")
            .eq("role", "institutehead")
            .eq("verification", "pending");

        if (error) throw error;

        // Map data to match frontend expectations
        const mappedData = institutes.map(inst => ({
            id: inst.id,
            first_name: inst.first_name,
            last_name: inst.last_name,
            organization_name: inst.institute_name || inst.name || `${inst.first_name || ''} ${inst.last_name || ''}`.trim() || 'Unknown Institute',
            email: inst.email,
            mobile: inst.mobile,
            website: inst.website,
            city: inst.city,
            state: inst.state,
            country: inst.country,
            role: inst.role,
            verification: inst.verification,
            created_at: inst.created_at
        }));

        res.json({ success: true, data: mappedData });
    } catch (err) {
        console.error("FETCH PENDING INSTITUTES ERROR:", err);
        res.status(500).json({ message: "Failed to fetch pending institutes" });
    }
};

// GET /api/admin/institutes/imports/pending
export const getPendingStudentImports = async (req, res) => {
    try {
        const { data: approvals, error } = await supabaseAdmin
            .from("institute_approvals")
            .select("id, institute_id, institute_name, student_count, is_approved, created_at")
            .eq("is_approved", false)
            .order("created_at", { ascending: false });

        if (error) throw error;

        res.json({ success: true, data: approvals });
    } catch (err) {
        console.error("FETCH PENDING STUDENT IMPORTS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch pending student import approvals" });
    }
};

// GET /api/admin/institutes/imports/approved
export const getApprovedStudentImports = async (req, res) => {
    try {
        const { data: approvals, error } = await supabaseAdmin
            .from("institute_approvals")
            .select("id, institute_id, institute_name, student_count, is_approved, created_at")
            .eq("is_approved", true)
            .order("created_at", { ascending: false });

        if (error) throw error;

        res.json({ success: true, data: approvals });
    } catch (err) {
        console.error("FETCH APPROVED STUDENT IMPORTS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch approved student import approvals" });
    }
};

// PUT /api/admin/institutes/imports/:id/approve
export const approveStudentImport = async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Mark the bulk approval record as approved
        const { data: approval, error: approvalError } = await supabaseAdmin
            .from("institute_approvals")
            .update({ is_approved: true })
            .eq("id", id)
            .select()
            .single();

        if (approvalError || !approval) throw approvalError || new Error("Approval record not found");

        res.json({ success: true, message: "Bulk import request approved successfully. The Institute can now finalize the import." });
    } catch (err) {
        console.error("APPROVE STUDENT IMPORT ERROR:", err);
        res.status(500).json({ message: "Failed to approve bulk student import" });
    }
};

// GET /api/admin/institutes/verified
export const getVerifiedInstitutes = async (req, res) => {
    try {
        const { data: institutes, error } = await supabaseAdmin
            .from("users")
            .select("id, first_name, last_name, name, institute_name, email, mobile, website, city, state, country, role, verification, created_at")
            .eq("role", "institutehead")
            .eq("verification", "verified");

        if (error) throw error;

        const mappedData = institutes.map(inst => ({
            id: inst.id,
            first_name: inst.first_name,
            last_name: inst.last_name,
            organization_name: inst.institute_name || inst.name || `${inst.first_name || ''} ${inst.last_name || ''}`.trim() || 'Unknown Institute',
            email: inst.email,
            mobile: inst.mobile,
            website: inst.website,
            city: inst.city,
            state: inst.state,
            country: inst.country,
            role: inst.role,
            verification: inst.verification,
            created_at: inst.created_at
        }));

        res.json({ success: true, data: mappedData });
    } catch (err) {
        console.error("FETCH VERIFIED INSTITUTES ERROR:", err);
        res.status(500).json({ message: "Failed to fetch verified institutes" });
    }
};

// PUT /api/admin/institutes/:id/approve
export const approveInstitute = async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabaseAdmin
            .from("users")
            .update({ verification: "verified" })
            .eq("id", id);

        if (error) throw error;
        res.json({ success: true, message: "Institute approved successfully" });
    } catch (err) {
        console.error("APPROVE INSTITUTE ERROR:", err);
        res.status(500).json({ message: "Failed to approve institute" });
    }
};

// PUT /api/admin/institutes/:id/reject
export const rejectInstitute = async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabaseAdmin
            .from("users")
            .update({ verification: "rejected" })
            .eq("id", id);

        if (error) throw error;
        res.json({ success: true, message: "Institute rejected successfully" });
    } catch (err) {
        console.error("REJECT INSTITUTE ERROR:", err);
        res.status(500).json({ message: "Failed to reject institute" });
    }
};

// POST /api/admin/approve-admin/:id
export const approveAdmin = async (req, res) => {
    try {
        const adminId = req.params.id;

        // 1. Mark admin as verified
        const { error } = await supabaseAdmin
            .from("users")
            .update({ verification: "verified" })
            .eq("id", adminId);
        if (error) throw error;

        // 2. Auto-insert default permissions row for this admin (safe upsert)
        await supabaseAdmin
            .from("admin_permissions")
            .upsert({
                admin_id: adminId,
                permit: true,
                apartments: true,
                advertisements: true,
                broadcast: true,
                reports: true
            }, { onConflict: "admin_id", ignoreDuplicates: true });

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
        // Fetch the CURRENT role from DB (JWT token may have stale role after promotion)
        const { data: currentUser, error: fetchError } = await supabaseAdmin
            .from("users")
            .select("role")
            .eq("id", req.user.id)
            .maybeSingle();

        if (fetchError || !currentUser) {
            return res.status(401).json({ message: "Could not verify your account" });
        }

        // Only superadmins can update roles
        if (currentUser.role !== 'superadmin') {
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

/* ================= ADMIN PERMISSIONS ================= */

// GET /api/admin/permissions — Superadmin only: list all admins + their permissions
export const getAllPermissions = async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: "Access denied. Only superadmins can view all permissions." });
        }

        // Fetch all admins
        const { data: admins, error: adminsError } = await supabaseAdmin
            .from("users")
            .select("id, name, email, role")
            .eq("role", "admin");

        if (adminsError) throw adminsError;

        // Fetch all permission rows
        const { data: perms, error: permsError } = await supabaseAdmin
            .from("admin_permissions")
            .select("admin_id, permit, apartments, advertisements, broadcast, reports");

        if (permsError) throw permsError;

        // Left join: merge permissions into each admin; default to true for missing rows
        const permMap = {};
        (perms || []).forEach(p => { permMap[p.admin_id] = p; });

        const data = (admins || []).map(admin => {
            const perm = permMap[admin.id];
            return {
                admin_id: admin.id,
                name: admin.name,
                email: admin.email,
                permit: perm ? perm.permit : true,
                apartments: perm ? perm.apartments : true,
                advertisements: perm ? perm.advertisements : true,
                broadcast: perm ? perm.broadcast : true,
                reports: perm ? perm.reports : true
            };
        });

        res.json({ success: true, data });
    } catch (err) {
        console.error("GET ALL PERMISSIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch permissions" });
    }
};

// PUT /api/admin/permissions/:adminId — Superadmin only: update permissions for one admin
export const updatePermissions = async (req, res) => {
    try {
        if (req.user.role !== 'superadmin') {
            return res.status(403).json({ success: false, message: "Access denied. Only superadmins can change permissions." });
        }

        const { adminId } = req.params;
        const { permit, apartments, advertisements, broadcast, reports } = req.body;

        // Build only the fields that were sent
        const updates = { updated_at: new Date().toISOString(), updated_by: req.user.id };
        if (permit !== undefined) updates.permit = permit;
        if (apartments !== undefined) updates.apartments = apartments;
        if (advertisements !== undefined) updates.advertisements = advertisements;
        if (broadcast !== undefined) updates.broadcast = broadcast;
        if (reports !== undefined) updates.reports = reports;

        // Upsert: insert if no row, update if one exists
        const { error } = await supabaseAdmin
            .from("admin_permissions")
            .upsert({ admin_id: adminId, ...updates }, { onConflict: "admin_id" });

        if (error) throw error;

        res.json({ success: true, message: "Permissions updated successfully." });
    } catch (err) {
        console.error("UPDATE PERMISSIONS ERROR:", err);
        res.status(500).json({ message: "Failed to update permissions" });
    }
};

// GET /api/admin/my-permissions — Any admin: get their own permissions
export const getMyPermissions = async (req, res) => {
    try {
        // Superadmins always have full access — no DB lookup needed
        if (req.user.role === 'superadmin') {
            return res.json({
                success: true,
                permissions: { permit: true, apartments: true, advertisements: true, broadcast: true, reports: true }
            });
        }

        const { data: perm, error } = await supabaseAdmin
            .from("admin_permissions")
            .select("permit, apartments, advertisements, broadcast, reports")
            .eq("admin_id", req.user.id)
            .maybeSingle();

        if (error) throw error;

        // If no row exists yet, return all true as safe default
        const permissions = perm || { permit: true, apartments: true, advertisements: true, broadcast: true, reports: true };

        res.json({ success: true, permissions });
    } catch (err) {
        console.error("GET MY PERMISSIONS ERROR:", err);
        res.status(500).json({ message: "Failed to fetch own permissions" });
    }
};

// GET /api/admin/assignments
export const getAssignments = async (req, res) => {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ success: false, message: 'Superadmin only.' });
    }
    try {
        // Fetch all events with an assignment using select("*") to be safe against missing columns
        const { data: eventsData, error } = await supabaseAdmin
            .from('events')
            .select('*')
            .not('assigned_to', 'is', null);

        if (error) throw error;

        // Collect all distinct user IDs needed (both assigned_to and assigned_by)
        const userIds = new Set();
        (eventsData || []).forEach(event => {
            if (event.assigned_to) userIds.add(event.assigned_to);
            if (event.assigned_by) userIds.add(event.assigned_by);
        });

        // Fetch those users in one batch
        const usersMap = {};
        if (userIds.size > 0) {
            const { data: usersData, error: usersError } = await supabaseAdmin
                .from('users')
                .select('id, name, email, photos, mobile, role')
                .in('id', Array.from(userIds));

            if (!usersError && usersData) {
                usersData.forEach(u => {
                    usersMap[u.id] = u;
                });
            }
        }

        // Map data to the exact schema the Frontend relies on
        const formattedData = (eventsData || []).map(event => {
            const assignedToUser = usersMap[event.assigned_to] || {};
            const assignedByUser = usersMap[event.assigned_by] || {};

            return {
                id: event.id,
                admin_id: event.assigned_to || null,
                admin_name: assignedToUser.name || "Unknown",
                admin_email: assignedToUser.email || "Unknown",
                admin_details: {
                    id: event.assigned_to || null,
                    name: assignedToUser.name || "Unknown",
                    email: assignedToUser.email || "Unknown",
                    mobile: assignedToUser.mobile || null,
                    photos: assignedToUser.photos || null,
                    role: assignedToUser.role || "unknown"
                },
                event_name: event.name || "Untitled Event",
                assigned_by_name: assignedByUser.name || "System",
                assigned_at: event.updated_at || event.created_at || new Date().toISOString()
            };
        });

        return res.json({ success: true, data: formattedData });
    } catch (err) {
        console.error("GET ASSIGNMENTS ERROR:", err);
        return res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
};

