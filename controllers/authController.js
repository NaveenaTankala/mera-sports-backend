import crypto from "crypto";
import jwt from "jsonwebtoken";
import { supabaseAdmin } from "../config/supabaseClient.js";
import { createNotification } from "../services/notificationService.js";
import {
    sendEmailOtp,
    sendMobileOtp,
    verifyEmailOtp,
    verifyMobileOtp
} from "../services/otpService.js";
import { sendRegistrationSuccessEmail } from "../utils/mailer.js";
import { uploadBase64 } from "../utils/uploadHelper.js";

/* ================= SECURITY VERIFICATION (PROFILE UPDATE / PASSWORD CHANGE) ================= */

export const sendVerificationOtp = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const { method } = req.body; // 'email' or 'mobile'

        const { data: user, error } = await supabaseAdmin
            .from("users")
            .select("email, mobile")
            .eq("id", userId)
            .maybeSingle();

        if (error || !user) return res.status(404).json({ message: "User not found" });

        if (method === 'mobile') {
            if (!user.mobile) return res.status(400).json({ message: "No mobile number registered" });

            const result = await sendMobileOtp(user.mobile);
            res.json({ success: true, method: 'mobile', sessionId: result.sessionId });

        } else if (method === 'email') {
            if (!user.email) return res.status(400).json({ message: "No email registered" });

            // Use Supabase Auth logic directly for existing users or our service
            // The service tries to Create, which might not be needed here if they already exist,
            // but signInWithOtp works for existing users too.
            // Let's use the service but wrap error handling if specialized.
            await sendEmailOtp(user.email);
            res.json({ success: true, method: 'email' });
        } else {
            res.status(400).json({ message: "Invalid verification method" });
        }

    } catch (err) {
        console.error("SEND VERIFICATION OTP ERROR:", err.message);
        res.status(500).json({ message: "Failed to send verification OTP" });
    }
};

export const verifyVerificationOtp = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const userId = decoded.id;

        const { method, otp, sessionId } = req.body;

        const { data: user } = await supabaseAdmin
            .from("users")
            .select("email")
            .eq("id", userId)
            .maybeSingle();

        let verified = false;

        if (method === 'mobile') {
            verified = await verifyMobileOtp(sessionId, otp);
        } else if (method === 'email') {
            verified = await verifyEmailOtp(user.email, otp);
        }

        if (verified) {
            // Generate SHORT-LIVED Verification Token (5 Minutes)
            const verificationToken = jwt.sign(
                { id: userId, type: 'verification' },
                process.env.JWT_SECRET,
                { expiresIn: "5m" }
            );
            res.json({ success: true, verificationToken });
        } else {
            res.status(400).json({ message: "Invalid OTP" });
        }

    } catch (err) {
        console.error("VERIFY VERIFICATION OTP ERROR:", err);
        res.status(500).json({ message: "Verification failed" });
    }
};

/* ================= OTP ROUTES (REGISTRATION) ================= */

export const sendRegistrationOtp = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: "Email is required" });

        await sendEmailOtp(email);
        res.json({ success: true, message: "OTP sent to email" });

    } catch (err) {
        console.error("SEND OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send OTP: " + err.message });
    }
};

export const verifyRegistrationOtp = async (req, res) => {
    try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ message: "Email and OTP are required" });

        const verified = await verifyEmailOtp(email, otp);

        if (verified) {
            res.json({ success: true, message: "OTP Verified Successfully" });
        } else {
            res.status(400).json({ success: false, message: "Invalid OTP or Session Expired" });
        }
    } catch (err) {
        console.error("VERIFY OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Server error during verification" });
    }
};

export const sendMobileRegistrationOtp = async (req, res) => {
    try {
        const { mobile } = req.body;
        const result = await sendMobileOtp(mobile);
        res.json({ success: true, sessionId: result.sessionId, message: "OTP sent to mobile" });
    } catch (err) {
        console.error("SEND MOBILE OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Failed to send Mobile OTP" });
    }
};

export const verifyMobileRegistrationOtp = async (req, res) => {
    try {
        const { mobile, otp, sessionId } = req.body;
        const verified = await verifyMobileOtp(sessionId, otp);

        if (verified) {
            res.json({ success: true, message: "Mobile OTP Verified Successfully" });
        } else {
            res.status(400).json({ success: false, message: "Invalid Mobile OTP" });
        }
    } catch (err) {
        console.error("VERIFY MOBILE OTP ERROR:", err.message);
        res.status(500).json({ success: false, message: "Verification failed" });
    }
};

/* ================= CHECK CONFLICT ================= */

export const checkUserConflict = async (req, res) => {
    try {
        const { mobile, email, aadhaar } = req.body;
        if (!mobile || !email) {
            return res.status(400).json({ message: "Mobile and Email are required for check." });
        }

        let query;
        if (aadhaar) {
            query = supabaseAdmin
                .from("users")
                .select("mobile, email, aadhaar")
                .or(`mobile.eq.${mobile},email.eq.${email},aadhaar.eq.${aadhaar}`);
        } else {
            query = supabaseAdmin
                .from("users")
                .select("mobile, email, aadhaar")
                .or(`mobile.eq.${mobile},email.eq.${email}`);
        }

        const { data: existingUsers, error } = await query;
        if (error) throw error;

        if (existingUsers && existingUsers.length > 0) {
            const conflicts = new Set();
            existingUsers.forEach(user => {
                if (user.mobile == mobile) conflicts.add("Mobile");
                if (user.email == email) conflicts.add("Email");
                if (aadhaar && user.aadhaar == aadhaar) conflicts.add("Aadhaar");
            });

            const conflictList = Array.from(conflicts);
            const fieldStr = conflictList.length > 0 ? conflictList.join(' / ') : "Details";
            return res.json({
                conflict: true,
                conflicts: conflictList, // Send raw array for frontend
                message: `${fieldStr} already exists.` // Fallback message
            });
        }

        res.json({ conflict: false });

    } catch (err) {
        console.error("CHECK CONFLICT ERROR:", err);
        res.status(500).json({ message: "Server error checking conflicts" });
    }
};

/* ================= REGISTER PLAYER ================= */

export const registerPlayer = async (req, res) => {
    try {
        const {
            firstName, lastName, mobile, email, dob,
            apartment, street, city, state, pincode, country,
            aadhaar, schoolDetails, photos, isVerified, gender, familyMembers
        } = req.body;

        const missing = [];
        if (!firstName) missing.push("First Name");
        if (!lastName) missing.push("Last Name");
        if (!mobile) missing.push("Mobile");
        if (!dob) missing.push("Date of Birth");
        if (!email) missing.push("Email");

        if (missing.length > 0) {
            return res.status(400).json({ message: `Missing required fields: ${missing.join(', ')}` });
        }

        // 1. Calculate Age
        const calculateAge = (dob) => {
            const birth = new Date(dob);
            const today = new Date();
            let age = today.getFullYear() - birth.getFullYear();
            const m = today.getMonth() - birth.getMonth();
            if (m < 0 || (m === 0 && today.getDate() < birth.getDate())) age--;
            return age;
        };
        const age = calculateAge(dob);

        // 2. Generate Password (DDMMYYYY)
        const [year, month, day] = dob.split("-");
        const password = `${day}${month}${year}`;

        // 3. Duplicate Check
        const { data: existing } = await supabaseAdmin
            .from("users")
            .select("id")
            .or(`mobile.eq.${mobile},aadhaar.eq.${aadhaar},email.eq.${email}`)
            .maybeSingle();

        if (existing) {
            return res.status(400).json({ message: "User with this Mobile, Email, or Aadhaar already exists." });
        }

        // 4. Upload Image (Using Unified Helper)
        let photoUrl = await uploadBase64(photos, 'player-photos', 'profiles');

        // 5. Generate Player ID
        const { data: newPlayerId, error: idError } = await supabaseAdmin.rpc('get_next_player_id');
        if (idError || !newPlayerId) {
            console.error("RPC Error:", idError);
            throw new Error("Failed to generate Player ID.");
        }

        // 6. Insert into USERS table
        const newUserId = crypto.randomUUID();
        const { data: user, error } = await supabaseAdmin
            .from("users")
            .insert({
                id: newUserId,
                player_id: newPlayerId,
                first_name: firstName,
                last_name: lastName,
                name: `${firstName} ${lastName}`.trim(),
                email,
                mobile,
                dob,
                age,
                apartment,
                street,
                city,
                state,
                country,
                pincode,
                aadhaar,
                photos: photoUrl,
                password: password,
                role: 'player',
                verification: isVerified ? 'verified' : 'pending',
                gender: gender || null
            })
            .select()
            .maybeSingle();

        if (error) throw error;

        // 7. Insert School Details
        if (schoolDetails) {
            try {
                await supabaseAdmin.from("player_school_details").insert({
                    player_id: user.id,
                    school_name: schoolDetails.name,
                    school_address: schoolDetails.address,
                    school_city: schoolDetails.city,
                    school_pincode: schoolDetails.pincode,
                });
            } catch (schoolEx) { console.error("School Details Error:", schoolEx); }
        }

        // 8. Insert Family Members
        if (familyMembers && Array.isArray(familyMembers) && familyMembers.length > 0) {
            const familyData = familyMembers.map(member => ({
                user_id: user.id,
                name: member.name,
                relation: member.relation || 'Child',
                gender: member.gender,
                age: member.dob ? Math.floor((new Date() - new Date(member.dob)) / 31557600000) : null
            }));
            await supabaseAdmin.from("family_members").insert(familyData);
        }

        // 9. Generate Token
        const token = jwt.sign(
            { id: user.id, role: 'player' },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // 10. Send Welcome Email
        try {
            await sendRegistrationSuccessEmail(user.email, {
                name: user.name,
                playerId: user.player_id,
                password: password
            });
        } catch (emailErr) { console.error("Welcome Email Error:", emailErr.message); }

        res.json({
            success: true,
            token,
            playerId: user.player_id,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                age: user.age
            },
        });
    } catch (err) {
        console.error("REGISTER ERROR:", err);
        res.status(400).json({ message: err.message });
    }
};

/* ================= LOGIN PLAYER ================= */

export const loginPlayer = async (req, res) => {
    try {
        const { playerIdOrAadhaar, password } = req.body;
        if (!playerIdOrAadhaar || !password) return res.status(400).json({ message: "Missing credentials" });

        let query = supabaseAdmin.from("users").select("*").or(`mobile.eq.${playerIdOrAadhaar},aadhaar.eq.${playerIdOrAadhaar}`);

        const input = playerIdOrAadhaar.toString().trim();
        if (input.toUpperCase().startsWith('P')) {
            query = supabaseAdmin.from("users").select("*").eq('player_id', input);
        } else if (!isNaN(input)) {
            query = supabaseAdmin.from("users").select("*").or(`mobile.eq.${input},aadhaar.eq.${input},player_id.eq.${input}`);
        }

        const { data: user, error } = await query.maybeSingle();

        if (error || !user) return res.status(401).json({ message: "Invalid credentials" });
        if (user.role !== 'player') return res.status(403).json({ message: "This account is for Admins." });
        
        // Plain text password comparison
        if (user.password !== password) return res.status(401).json({ message: "Invalid credentials" });

        const token = jwt.sign({ id: user.id, role: 'player' }, process.env.JWT_SECRET, { expiresIn: "7d" });

        res.json({
            success: true,
            token,
            user: {
                id: user.id,
                firstName: user.first_name,
                lastName: user.last_name,
                role: 'player',
                photos: user.photos,
                age: user.age
            },
        });
    } catch (err) {
        console.error("LOGIN ERROR:", err);
        res.status(500).json({ message: err.message });
    }
};

/* ================= ADMIN AUTH ================= */

export const registerAdmin = async (req, res) => {
    try {
        const { name, email, mobile, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ message: "Missing required fields" });

        const { data: existing } = await supabaseAdmin.from("users").select("id").eq("email", email).maybeSingle();
        if (existing) return res.status(400).json({ message: "Admin already exists." });

        const newUserId = crypto.randomUUID();
        const { error } = await supabaseAdmin.from("users").insert({
            id: newUserId,
            name,
            email,
            mobile,
            password: password,
            role: 'admin',
            verification: 'pending'
        });

        if (error) throw error;
        res.json({ success: true, message: "Registration successful. Wait for approval." });

    } catch (err) {
        console.error("ADMIN REGISTER ERROR:", err);
        res.status(500).json({ message: "Registration failed: " + err.message });
    }
};

export const loginAdmin = async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) return res.status(400).json({ message: "Missing credentials" });

        const { data: user, error } = await supabaseAdmin.from("users").select("*").eq("email", email).maybeSingle();

        if (error || !user) return res.status(401).json({ message: "Invalid credentials" });
        if (user.role !== 'admin' && user.role !== 'superadmin') return res.status(403).json({ message: "Access Denied." });
        
        // Plain text password comparison
        if (user.password !== password) return res.status(401).json({ message: "Invalid credentials" });

        // Verification Checks — block only rejected admins
        // Pending admins get a token so frontend can show PendingApproval page
        if (user.role === 'admin' && user.verification === 'rejected') {
            return res.status(403).json({ success: false, code: 'ADMIN_REJECTED', message: "Application rejected." });
        }

        // Admin tokens last 30 days for convenience (user can still logout manually)
        const token = jwt.sign({ id: user.id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "30d" });

        // NOTIFICATION
        createNotification(user.id, "Welcome Back!", "Administrator login successful.", "info");

        res.json({
            success: true,
            token,
            user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar: user.photos, verification: user.verification },
        });

    } catch (err) {
        console.error("ADMIN LOGIN ERROR:", err);
        res.status(500).json({ message: "Server error during login" });
    }
};

export const getCurrentUser = async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader) return res.status(401).json({ message: "No token provided" });
        const token = authHeader.split(" ")[1];
        if (!token) return res.status(401).json({ message: "No token provided" }); // Double check

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const { data: user, error } = await supabaseAdmin.from("users").select("id, name, email, role, photos, verification").eq("id", decoded.id).maybeSingle();

        if (error || !user) return res.status(404).json({ message: "User not found" });

        res.json({
            success: true,
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                avatar: user.photos,
                verification: user.verification
            }
        });
    } catch (err) {
        console.error("SESSION RESTORE ERROR:", err.message);
        res.status(401).json({ message: "Invalid or expired token" });
    }
};

export const reapplyGoogleAdmin = async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: "No token provided" });

    try {
        const { data: { user: authUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !authUser) return res.status(401).json({ message: "Invalid Google Session" });

        const { data: user } = await supabaseAdmin.from("users").select("*").eq("email", authUser.email).maybeSingle();
        if (!user) return res.status(404).json({ message: "User not found" });

        if (user.verification !== 'rejected') return res.status(400).json({ message: "Account is not in rejected state." });

        await supabaseAdmin.from("users").update({ verification: 'pending' }).eq("id", user.id);
        res.json({ success: true, message: "Re-application submitted successfully." });
    } catch (err) {
        console.error("Re-apply Error:", err);
        res.status(500).json({ message: "Server error" });
    }
};
