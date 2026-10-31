const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')

const adminRegister = catchAsync(async (req, res) => {
	await req.model.create(req.body)

	return res.status(201).json({
		message: 'Admin Register Successfully.',
	})
})

/**
 * Global Administrator Medical Officer License Verification
 *
 * Clinical Governance Rules:
 * 1. Only an authenticated Global Administrator can verify medical credentials.
 * 2. Verification is recorded explicitly on the staff document, never trusting client request values.
 * 3. Suspended or revoked staff cannot have credentials verified.
 * 4. Staff member must possess the role 'Medical_Officer' with a valid license number on file.
 * 5. Records admin ID and verification timestamp for regulatory auditability.
 */
const verifyStaffLicense = catchAsync(async (req, res, next) => {
	const { staffId } = req.params
	const { notes } = req.body || {}

	if (!staffId || !mongoose.Types.ObjectId.isValid(staffId)) {
		return res.status(400).json({ message: 'Valid staff ID is required.' })
	}

	const staff = await BloodbankStaff.findById(staffId)
	if (!staff) {
		return res.status(404).json({ message: 'Staff member not found.' })
	}

	if (staff.role !== 'Medical_Officer') {
		return res.status(400).json({
			message: `Cannot verify medical license for role '${staff.role}'. Only Medical Officers require license verification.`,
		})
	}

	if (staff.status === 'Suspended' || staff.status === 'Revoked') {
		return res.status(400).json({
			message: `Cannot verify credentials for staff account with status '${staff.status}'. Account must be Active.`,
		})
	}

	if (!staff.medicalLicense?.licenseNumber || !staff.medicalLicense.licenseNumber.trim()) {
		return res.status(400).json({
			message: 'Staff member does not have a medical license number on record.',
		})
	}

	// Server-side explicit administrative verification
	staff.medicalLicense.isVerified = true
	staff.medicalLicense.verifiedBy = req.user._id
	staff.medicalLicense.verifiedAt = new Date()
	staff.medicalLicense.verificationNotes = notes
		? notes.toString().trim()
		: 'Independently verified by Global Administrator upon credential review'

	await staff.save()

	return res.status(200).json({
		message: 'Medical Officer credentials verified successfully by Global Administrator.',
		staff: {
			_id: staff._id,
			fullName: staff.fullName,
			email: staff.email,
			role: staff.role,
			bloodbankId: staff.bloodbankId,
			status: staff.status,
			medicalLicense: staff.medicalLicense,
		},
	})
})

module.exports = {
	adminRegister,
	verifyStaffLicense,
}
