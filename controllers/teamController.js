import { supabaseAdmin } from "../config/supabaseClient.js";

export const getMyTeams = async (req, res) => {
    try {
        const userId = req.user.id;
        const { data, error } = await supabaseAdmin.from('player_teams').select('*').eq('captain_id', userId).order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ success: true, teams: data });
    } catch (err) {
        console.error("Get Teams Error:", err);
        res.status(500).json({ message: "Failed to fetch teams" });
    }
};

export const lookupPlayer = async (req, res) => {
    try {
        const { playerId } = req.params;
        const { data: player, error } = await supabaseAdmin.from('users').select('id, first_name, last_name, dob, mobile, player_id, aadhaar').ilike('player_id', playerId).maybeSingle();
        if (error || !player) return res.status(404).json({ success: false, message: "Player ID not found" });

        let age = "";
        if (player.dob) {
            const ageDt = new Date(Date.now() - new Date(player.dob).getTime());
            age = Math.abs(ageDt.getUTCFullYear() - 1970).toString();
        }

        res.json({
            success: true,
            player: {
                id: player.id,
                player_id: player.player_id,
                name: `${player.first_name} ${player.last_name}`,
                age, mobile: player.mobile, aadhaar: player.aadhaar
            }
        });
    } catch (err) {
        console.error("Player Lookup Error:", err);
        res.status(500).json({ success: false, message: "Lookup failed" });
    }
};

export const createTeam = async (req, res) => {
    try {
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        const { data: profile } = await supabaseAdmin.from('users').select('first_name, last_name, mobile').eq('id', userId).maybeSingle();
        const captainName = profile ? `${profile.first_name} ${profile.last_name}`.trim() : "Unknown";
        const captainMobile = profile?.mobile || "";

        const { data, error } = await supabaseAdmin.from('player_teams').insert([{ team_name, sport, captain_id: userId, captain_name: captainName, captain_mobile: captainMobile, members: members || [] }]).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, team: data });
    } catch (err) {
        console.error("Create Team Error:", err);
        res.status(500).json({ message: "Failed to create team" });
    }
};

export const updateTeam = async (req, res) => {
    try {
        const { id } = req.params;
        const { team_name, sport, members } = req.body;
        const userId = req.user.id;

        const { data: team, error: fetchError } = await supabaseAdmin.from('player_teams').select('*').eq('id', id).maybeSingle();
        if (fetchError || !team) return res.status(404).json({ message: "Team not found" });
        if (team.captain_id !== userId) return res.status(403).json({ message: "Unauthorized" });

        const { data: updatedTeam, error } = await supabaseAdmin.from('player_teams').update({ team_name, sport, members: members || [] }).eq('id', id).select().maybeSingle();
        if (error) throw error;
        res.json({ success: true, team: updatedTeam });
    } catch (err) {
        console.error("Update Team Error:", err);
        res.status(500).json({ message: "Failed to update team" });
    }
};

export const deleteTeam = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { data: team, error: fetchError } = await supabaseAdmin.from('player_teams').select('*').eq('id', id).maybeSingle();
        if (fetchError || !team) return res.status(404).json({ message: "Team not found" });
        if (team.captain_id !== userId) return res.status(403).json({ message: "Unauthorized" });

        const { error } = await supabaseAdmin.from('player_teams').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true, message: "Team deleted successfully" });
    } catch (err) {
        console.error("Delete Team Error:", err);
        res.status(500).json({ message: "Failed to delete team" });
    }
};
