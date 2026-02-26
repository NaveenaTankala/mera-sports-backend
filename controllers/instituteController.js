import { supabaseAdmin } from "../config/supabaseClient.js";
import crypto from "crypto";
import * as xlsx from "xlsx";

// 1. POST /api/institute/request-bulk-approval
export const requestBulkApproval = async (req, res) => {
    try {
        const { id: institute_id } = req.user;
        const { student_count } = req.body;

        if (!student_count || student_count <= 0) {
            return res.status(400).json({ success: false, message: "Valid student_count is required." });
        }

        // Fetch institute name
        const { data: institute, error: instError } = await supabaseAdmin
            .from("users")
            .select("name, institute_name")
            .eq("id", institute_id)
            .single();

        if (instError || !institute) {
            return res.status(404).json({ success: false, message: "Institute not found." });
        }

        const resolvedInstituteName = institute.institute_name || institute.name || "Unknown Institute";

        // Create approval request
        const { error: insertError } = await supabaseAdmin
            .from("institute_approvals")
            .insert({
                institute_id,
                institute_name: resolvedInstituteName,
                student_count,
                is_approved: false
            });

        if (insertError) throw insertError;

        res.json({ success: true, message: "Approval request submitted successfully." });
    } catch (err) {
        console.error("REQUEST APPROVAL ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to request approval" });
    }
};

// 2. GET /api/institute/approval-status
export const getApprovalStatus = async (req, res) => {
    try {
        const { id: institute_id } = req.user;

        const { data: approval, error } = await supabaseAdmin
            .from("institute_approvals")
            .select("is_approved")
            .eq("institute_id", institute_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;

        // If no record exists (never requested or already finalized/deleted)
        if (!approval) {
            return res.json({ success: true, is_approved: null, message: "No pending requests found." });
        }

        res.json({ success: true, is_approved: approval.is_approved });
    } catch (err) {
        console.error("GET APPROVAL STATUS ERROR:", err);
        res.status(500).json({ success: false, message: "Failed to check approval status" });
    }
};

// 3. POST /api/institute/bulk-import-finalize
export const finalizeBulkImport = async (req, res) => {
    try {
        const { id: institute_id } = req.user;
        const { excelBase64 } = req.body;

        if (!excelBase64) {
            return res.status(400).json({ success: false, message: "No excel file provided for import." });
        }

        // CRITICAL SECURITY CHECK: Verify if this institute is approved
        const { data: approval, error: checkError } = await supabaseAdmin
            .from("institute_approvals")
            .select("id, is_approved, institute_name")
            .eq("institute_id", institute_id)
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (checkError) throw checkError;

        if (!approval) {
            return res.status(403).json({ success: false, message: "No approval request found for this institute." });
        }
        if (!approval.is_approved) {
            return res.status(403).json({ success: false, message: "Your bulk import request has not been approved yet." });
        }

        const resolvedInstituteName = approval.institute_name;

        // Decode Base64 and Parse Excel
        const base64Data = excelBase64.replace(/^data:.*,/, "");
        const buffer = Buffer.from(base64Data, "base64");
        const workbook = xlsx.read(buffer, { type: "buffer", cellDates: true });
        const worksheet = workbook.Sheets[workbook.SheetNames[0]];

        // Convert to JSON
        const rawStudents = xlsx.utils.sheet_to_json(worksheet, { defval: "" });

        if (!rawStudents || rawStudents.length === 0) {
            return res.status(400).json({ success: false, message: "The uploaded Excel sheet is empty." });
        }

        // Prepare students data
        const studentsToInsert = rawStudents.map((row) => {
            const fName = String(row.first_name || row.FirstName || row.first_name || "").trim();
            const lName = String(row.last_name || row.LastName || row.lastName || "").trim();

            let parsedDob = row.dob || row.DoB || null;
            if (parsedDob instanceof Date) {
                parsedDob = parsedDob.toISOString().split('T')[0];
            } else if (typeof parsedDob === "number") {
                const excelEpoch = new Date(Date.UTC(1899, 11, 30));
                parsedDob = new Date(excelEpoch.getTime() + parsedDob * 86400000).toISOString().split('T')[0];
            } else if (typeof parsedDob === "string" && parsedDob.trim() !== "") {
                const d = new Date(parsedDob);
                parsedDob = !isNaN(d.getTime()) ? d.toISOString().split('T')[0] : null;
            } else {
                parsedDob = null;
            }

            return {
                id: crypto.randomUUID(),
                first_name: fName || null,
                last_name: lName || null,
                name: `${fName} ${lName}`.trim() || null,
                email: row.email || row.Email || null,
                mobile: row.mobile ? String(row.mobile).replace(/\D/g, '') : null,
                aadhaar: row.aadhaar ? String(row.aadhaar).replace(/\D/g, '') : null,
                dob: parsedDob,
                gender: row.gender || row.Gender || null,
                apartment: row.apartment || row.Apartment || null,
                city: row.city || row.City || null,
                state: row.state || row.State || null,
                pincode: row.pincode ? String(row.pincode) : null,
                country: row.country || row.Country || null,
                role: 'player',
                verification: 'verified', // Natively verified since Superadmin approved it
                institute_name: resolvedInstituteName
            };
        });

        const successful = [];
        const failed = [];

        // Insert students into users table individually to catch specific errors
        for (const student of studentsToInsert) {
            const { error: insertError } = await supabaseAdmin
                .from("users")
                .insert(student);

            if (insertError) {
                let reason = insertError.message;
                let errorField = null;

                const errorMsg = insertError.message?.toLowerCase() || '';
                if (errorMsg.includes("duplicate key value") || insertError.code === '23505') {
                    if (errorMsg.includes("email")) {
                        reason = "Email already exists in the users table.";
                        errorField = "email";
                    } else if (errorMsg.includes("mobile")) {
                        reason = "Mobile number already exists in the users table.";
                        errorField = "mobile";
                    } else if (errorMsg.includes("aadhaar")) {
                        reason = "Aadhaar number already exists in the users table.";
                        errorField = "aadhaar";
                    } else {
                        reason = "Duplicate unique field already exists.";
                    }
                }

                failed.push({
                    row: {
                        first_name: student.first_name,
                        email: student.email,
                        mobile: student.mobile,
                        aadhaar: student.aadhaar
                    },
                    errorField: errorField,
                    reason: reason
                });
            } else {
                successful.push({
                    first_name: student.first_name,
                    email: student.email
                });
            }
        }

        // DELETE the approval record so they can't reuse it
        await supabaseAdmin
            .from("institute_approvals")
            .delete()
            .eq("id", approval.id);

        return res.status(200).json({
            success: true, // Returning true because the action technically completed ok
            message: failed.length > 0
                ? "Import finished. Some records require correction."
                : "Import finished successfully.",
            results: {
                successful,
                failed
            }
        });
    } catch (err) {
        console.error("FINALIZE BULK IMPORT ERROR:", err);
        return res.status(500).json({ success: false, message: "Failed to finalize bulk import: " + err.message });
    }
};
