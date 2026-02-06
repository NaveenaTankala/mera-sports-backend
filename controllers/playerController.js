import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

// GET /api/player/dashboard
export const getPlayerDashboard = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data: player, error } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (error) throw error;
        if (!player) return res.status(404).json({ message: "Player not found" });

        const { data: schoolDetails } = await supabaseAdmin.from("player_school_details").select("*").eq("player_id", userId).maybeSingle();
        if (schoolDetails) player.schoolDetails = schoolDetails;

        // Fetch Teams
        let relevantTeamIds = [];
        const { data: captainTeams } = await supabaseAdmin.from("player_teams").select("id").eq("captain_id", userId);
        if (captainTeams) relevantTeamIds.push(...captainTeams.map(t => t.id));

        if (player.mobile) {
            const { data: memberTeams } = await supabaseAdmin.from("player_teams").select("id").contains("members", [{ mobile: player.mobile }]);
            if (memberTeams) relevantTeamIds.push(...memberTeams.map(t => t.id));
        }

        if (player.player_id) {
            const { data: allTeams } = await supabaseAdmin.from("player_teams").select("id, members");
            if (allTeams) {
                allTeams.forEach(team => {
                    if (Array.isArray(team.members) && team.members.some(m => m.player_id === player.player_id)) {
                        relevantTeamIds.push(team.id);
                    }
                });
            }
        }
        relevantTeamIds = [...new Set(relevantTeamIds)];

        // Fetch Registrations
        let query = supabaseAdmin.from("event_registrations").select(`*, events ( id, name, sport, start_date, location )`).order('created_at', { ascending: false });
        if (relevantTeamIds.length > 0) {
            query = query.or(`player_id.eq.${userId},team_id.in.(${relevantTeamIds.join(',')})`);
        } else {
            query = query.eq("player_id", userId);
        }
        const { data: registrations } = await query;

        // Fetch Transactions
        const { data: transactions } = await supabaseAdmin.from("transactions").select("*").eq("user_id", userId);

        // Fetch Family Members
        const { data: familyMembers } = await supabaseAdmin.from("family_members").select("*").eq("user_id", userId);

        // Merge Details
        const detailedRegistrations = await Promise.all((registrations || []).map(async (reg) => {
            const txn = (transactions || []).find(t => (reg.transaction_id && t.id === reg.transaction_id) || (t.event_id === reg.event_id));
            let teamDetails = null;
            if (reg.team_id) {
                const { data: team } = await supabaseAdmin.from("player_teams").select("*").eq("id", reg.team_id).maybeSingle();
                teamDetails = team;
            }
            return { ...reg, transactions: txn || null, team_details: teamDetails };
        }));

        res.json({ success: true, player, registrations: detailedRegistrations, familyMembers: familyMembers || [] });

    } catch (err) {
        console.error("DASHBOARD ERROR:", err);
        res.status(500).json({ message: "Failed to load dashboard" });
    }
};

// POST /api/player/check-conflict
export const checkConflict = async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile } = req.body;

        if (email) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("email", email).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ conflict: true, field: 'email', message: "Email already taken" });
        }
        if (mobile) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ conflict: true, field: 'mobile', message: "Mobile already taken" });
        }
        res.json({ conflict: false });
    } catch (err) { res.status(500).json({ message: "Server error" }); }
};

// POST /api/player/check-password
export const checkPassword = async (req, res) => {
    try {
        const { currentPassword } = req.body;
        if (!currentPassword) return res.status(400).json({ message: "Password required" });
        const { data: user } = await supabaseAdmin.from("users").select("password").eq("id", req.user.id).maybeSingle();
        if (!user || user.password !== currentPassword) return res.status(401).json({ correct: false, message: "Incorrect password" });
        res.json({ correct: true });
    } catch (err) { res.status(500).json({ message: "Server error" }); }
};

// PUT /api/player/update-profile
export const updateProfile = async (req, res) => {
    try {
        const userId = req.user.id;
        const { email, mobile, photos, apartment, street, city, state, pincode, country, gender } = req.body;

        const { data: currentUser, error: fetchError } = await supabaseAdmin.from("users").select("*").eq("id", userId).maybeSingle();
        if (fetchError || !currentUser) return res.status(404).json({ message: "User not found" });

        const isSensitiveChange = (email && email.toLowerCase().trim() !== currentUser.email.toLowerCase().trim()) || (mobile && mobile !== currentUser.mobile);

        if (isSensitiveChange) {
            const token = req.headers['x-verification-token'];
            if (!token) return res.status(403).json({ message: "Verification required", requiresVerification: true });
            try {
                const decoded = jwt.verify(token, process.env.JWT_SECRET);
                if (decoded.id !== userId || decoded.type !== 'verification') throw new Error("Invalid token");
            } catch (e) { return res.status(403).json({ message: "Invalid verification token" }); }
        }

        // Conflict Checks
        if (email && email !== currentUser.email) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("email", email).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ message: "Email taken" });
        }
        if (mobile && mobile !== currentUser.mobile) {
            const { data } = await supabaseAdmin.from("users").select("id").eq("mobile", mobile).neq("id", userId).maybeSingle();
            if (data) return res.status(409).json({ message: "Mobile taken" });
        }

        let photoUrl = photos;
        if (photos && photos.startsWith('data:')) {
            photoUrl = await uploadBase64(photos, 'player-photos');
        }

        const updates = {
            email: email || currentUser.email,
            mobile: mobile || currentUser.mobile,
            apartment: apartment !== undefined ? apartment : currentUser.apartment,
            street: street !== undefined ? street : currentUser.street,
            city: city !== undefined ? city : currentUser.city,
            state: state !== undefined ? state : currentUser.state,
            pincode: pincode !== undefined ? pincode : currentUser.pincode,
            country: country !== undefined ? country : currentUser.country,
            gender: gender !== undefined ? gender : currentUser.gender,
            photos: photoUrl || currentUser.photos
        };

        const { data: updatedPlayer, error } = await supabaseAdmin.from("users").update(updates).eq("id", userId).select();
        if (error) throw error;

        res.json({ success: true, player: updatedPlayer?.[0] || updates, message: "Profile updated" });

    } catch (err) {
        console.error("UPDATE ERROR:", err);
        res.status(500).json({ message: "Failed to update profile" });
    }
};

// PUT /api/player/change-password
export const changePassword = async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: "All fields required" });

        const token = req.headers['x-verification-token'];
        if (!token) return res.status(403).json({ message: "Verification required", requiresVerification: true });
        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            if (decoded.id !== req.user.id || decoded.type !== 'verification') throw new Error();
        } catch (e) { return res.status(403).json({ message: "Invalid token" }); }

        const { data: user } = await supabaseAdmin.from("users").select("password").eq("id", req.user.id).maybeSingle();
        if (user.password !== currentPassword) return res.status(401).json({ message: "Incorrect current password" });

        const { error } = await supabaseAdmin.from("users").update({ password: newPassword }).eq("id", req.user.id);
        if (error) throw error;
        res.json({ success: true, message: "Password updated" });
    } catch (err) { res.status(500).json({ message: "Failed to change password" }); }
};

// DELETE /api/player/delete-account
export const deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;
        await supabaseAdmin.from("player_school_details").delete().eq("player_id", userId);
        await supabaseAdmin.from("event_registrations").delete().eq("player_id", userId);
        await supabaseAdmin.from("transactions").delete().eq("user_id", userId);
        await supabaseAdmin.from("player_teams").delete().eq("captain_id", userId);
        const { error } = await supabaseAdmin.from("users").delete().eq("id", userId);

        if (error) throw error;
        res.json({ success: true, message: "Account deleted" });
    } catch (err) {
        console.error("DELETE ACCOUNT ERROR:", err);
        res.status(500).json({ message: "Failed to delete account" });
    }
};

/* ================= FAMILY MEMBER MANAGEMENT ================= */

export const addFamilyMember = async (req, res) => {
    try {
        const { name, relation, age, gender } = req.body;
        if (!name || !relation) return res.status(400).json({ message: "Name/Relation required" });
        const { data, error } = await supabaseAdmin.from("family_members").insert({ user_id: req.user.id, name, relation, age: age ? parseInt(age) : null, gender }).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, familyMember: data });
    } catch (err) { res.status(500).json({ message: "Failed to add family member" }); }
};

export const updateFamilyMember = async (req, res) => {
    try {
        const { name, relation, age, gender } = req.body;
        const { data, error } = await supabaseAdmin.from("family_members").update({ name, relation, age: age ? parseInt(age) : null, gender }).eq("id", req.params.id).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, familyMember: data });
    } catch (err) { res.status(500).json({ message: "Failed to update family member" }); }
};

export const deleteFamilyMember = async (req, res) => {
    try {
        const { error } = await supabaseAdmin.from("family_members").delete().eq("id", req.params.id);
        if (error) throw error;
        res.json({ success: true, message: "Family member deleted" });
    } catch (err) { res.status(500).json({ message: "Failed to delete family member" }); }
};
