const crypto = require('crypto')
const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const {
	BloodbankStaff,
	VALID_STAFF_ROLES,
	VALID_STAFF_STATUSES,
} = require('./bloodbankStaffModel')
const { generateStaffToken } = require('./bloodbankStaffMiddleware')
const {
	emailValidate,
	passwordLengthValidate,
	passwordAndPasswordConfirmValidate,
} = require('../Common/Functions/validateInputs')

/**
 * Controlled Administrative Provisioning of Staff Accounts
 *
 * Security & Governance Invariants:
 * 1. Only the authenticated owning blood bank can provision staff accounts for its facility.
 * 2. Public self-registration is strictly forbidden.
 * 3. Role must be explicitly specified and validated against supported roles.
 * 4. Medical Officers MUST provide a non-empty medical license number and issuing council.
 * 5. Issues a one-time cryptographically secure setupToken for invitation delivery.
 * 6. mustChangePassword is forced to true for all newly provisioned accounts.
 */
const provisionStaff = catchAsync(async (req, res, next) => {
	const { fullName, email, phoneNo, role, password, medicalLicense } = req.body || {}

	// 1. Basic field presence validation
	if (!fullName || typeof fullName !== 'string' || !fullName.trim()) {
		return res.status(400).json({ message: 'Full name is required.' })
	}

	if (!email || !emailValidate(email)) {
		return res.status(400).json({ message: 'A valid email address is required.' })
	}

	if (!phoneNo || typeof phoneNo !== 'string' || !phoneNo.trim()) {
		return res.status(400).json({ message: 'Phone number is required.' })
	}

	if (!role || !VALID_STAFF_ROLES.includes(role)) {
		return res.status(400).json({
			message: `Invalid staff role '${role}'. Allowed roles: ${VALID_STAFF_ROLES.join(', ')}.`,
		})
	}

	// 2. Initial password handling (must satisfy 8 to 20 characters)
	const initialPassword = password || crypto.randomBytes(6).toString('hex') + 'A1!'
	if (!passwordLengthValidate(initialPassword)) {
		return res.status(400).json({
			message: 'Password should be at least 8 to 20 characters.',
		})
	}

	// 3. Role-specific clinical governance validation
	const formattedLicense = {
		licenseNumber: null,
		issuingCouncil: null,
		isVerified: false,
		verifiedBy: null,
		verifiedAt: null,
		verificationNotes: '',
	}

	if (role === 'Medical_Officer') {
		const licNo = medicalLicense?.licenseNumber
		const council = medicalLicense?.issuingCouncil

		if (!licNo || typeof licNo !== 'string' || !licNo.trim()) {
			return res.status(400).json({
				message: 'Medical Officer provisioning requires a valid, non-empty medical license number.',
			})
		}

		formattedLicense.licenseNumber = licNo.trim().toUpperCase()
		formattedLicense.issuingCouncil = council ? council.trim() : 'State Medical Council'
		// isVerified remains strictly FALSE until independently verified by a Global Administrator
		formattedLicense.isVerified = false
		formattedLicense.verificationNotes = 'Awaiting administrative verification by Global Administrator'
	}

	// 4. Prevent duplicate staff email
	const existingStaff = await BloodbankStaff.findOne({ email: email.toLowerCase().trim() })
	if (existingStaff) {
		return res.status(400).json({
			message: 'A staff member with this email already exists.',
		})
	}

	// 5. Create staff document and generate one-time setup token
	const newStaff = new BloodbankStaff({
		fullName: fullName.trim(),
		email: email.toLowerCase().trim(),
		phoneNo: phoneNo.trim(),
		bloodbankId: req.user._id,
		role,
		password: initialPassword,
		mustChangePassword: true,
		medicalLicense: formattedLicense,
		createdBy: req.user._id,
		status: 'Active',
	})

	const rawSetupToken = newStaff.createSetupToken()
	await newStaff.save()

	return res.status(201).json({
		message: 'Staff account provisioned successfully.',
		setupToken: rawSetupToken,
		staff: {
			_id: newStaff._id,
			fullName: newStaff.fullName,
			email: newStaff.email,
			phoneNo: newStaff.phoneNo,
			role: newStaff.role,
			bloodbankId: newStaff.bloodbankId,
			status: newStaff.status,
			mustChangePassword: newStaff.mustChangePassword,
			medicalLicense: newStaff.medicalLicense,
			createdAt: newStaff.createdAt,
		},
	})
})

/**
 * Staff Login Endpoint
 */
const loginStaff = catchAsync(async (req, res, next) => {
	const { email, password } = req.body || {}

	if (!email || !password) {
		return res.status(400).json({
			message: 'Email and password are required for staff login.',
		})
	}

	const staff = await BloodbankStaff.findOne({
		email: email.toLowerCase().trim(),
	}).select('+password')

	if (!staff || !(await staff.correctPassword(password, staff.password))) {
		return res.status(401).json({
			message: 'Email or password incorrect. Check your login credentials.',
		})
	}

	// Status and revocation check
	if (staff.status === 'Suspended') {
		return res.status(401).json({
			message: 'Your staff account is suspended. Contact your blood bank administrator.',
		})
	}

	if (staff.status === 'Revoked') {
		return res.status(401).json({
			message: 'Your staff account has been revoked. Contact your blood bank administrator.',
		})
	}

	if (staff.status !== 'Active') {
		return res.status(401).json({
			message: 'Your staff account is inactive. Contact your blood bank administrator.',
		})
	}

	const token = generateStaffToken(staff)

	return res.status(200).json({
		message: 'Staff login successful.',
		token,
		staff: {
			_id: staff._id,
			fullName: staff.fullName,
			email: staff.email,
			role: staff.role,
			bloodbankId: staff.bloodbankId,
			mustChangePassword: staff.mustChangePassword,
			medicalLicense: staff.medicalLicense,
		},
	})
})

/**
 * One-Time Setup Credential Password Initialization
 */
const setupStaffPassword = catchAsync(async (req, res, next) => {
	const { token, password, passwordConfirm } = req.body || {}

	if (!token || typeof token !== 'string') {
		return res.status(400).json({ message: 'Setup token is required.' })
	}

	if (!password || !passwordLengthValidate(password)) {
		return res.status(400).json({
			message: 'Password should be at least 8 to 20 characters.',
		})
	}

	if (!passwordAndPasswordConfirmValidate(password, passwordConfirm)) {
		return res.status(400).json({
			message: 'Password and Password Confirm do not match.',
		})
	}

	const hashedToken = crypto
		.createHash('sha256')
		.update(token.trim())
		.digest('hex')

	// Atomic consumption guard: Match and unset token in one operation to prevent concurrent double-consumption
	const staff = await BloodbankStaff.findOneAndUpdate(
		{
			setupToken: hashedToken,
			setupExpires: { $gt: Date.now() },
		},
		{
			$unset: { setupToken: 1, setupExpires: 1 },
		},
		{ new: true }
	)

	if (!staff) {
		return res.status(400).json({
			message: 'Setup token is invalid or has expired. Please request a new invitation.',
		})
	}

	staff.password = password
	staff.mustChangePassword = false
	staff.tokenVersion = (staff.tokenVersion || 0) + 1

	await staff.save()

	return res.status(200).json({
		message: 'Staff password set successfully. You can now log in with your credentials.',
	})
})

/**
 * Authenticated Staff Password Change
 */
const changeStaffPassword = catchAsync(async (req, res, next) => {
	const { currentPassword, newPassword, newPasswordConfirm } = req.body || {}

	if (!currentPassword) {
		return res.status(400).json({ message: 'Current password is required.' })
	}

	if (!newPassword || !passwordLengthValidate(newPassword)) {
		return res.status(400).json({
			message: 'New password should be at least 8 to 20 characters.',
		})
	}

	if (!passwordAndPasswordConfirmValidate(newPassword, newPasswordConfirm)) {
		return res.status(400).json({
			message: 'New password and confirm password do not match.',
		})
	}

	const staff = await BloodbankStaff.findById(req.staff._id).select('+password')
	if (!staff) {
		return res.status(404).json({ message: 'Staff member not found.' })
	}

	if (!(await staff.correctPassword(currentPassword, staff.password))) {
		return res.status(401).json({ message: 'Current password is incorrect.' })
	}

	staff.password = newPassword
	staff.mustChangePassword = false
	staff.tokenVersion = (staff.tokenVersion || 0) + 1

	await staff.save()

	const token = generateStaffToken(staff)

	return res.status(200).json({
		message: 'Password updated successfully.',
		token,
	})
})

/**
 * Retrieves all staff members belonging to the authenticated blood bank.
 */
const getStaffList = catchAsync(async (req, res, next) => {
	const staffMembers = await BloodbankStaff.find(
		{ bloodbankId: req.user._id },
		'-password'
	).sort({ createdAt: -1 })

	return res.status(200).json({
		count: staffMembers.length,
		staff: staffMembers,
	})
})

/**
 * Updates staff account status (Active, Suspended, Revoked).
 */
const updateStaffStatus = catchAsync(async (req, res, next) => {
	const { staffId } = req.params
	const { status } = req.body || {}

	if (!staffId || !mongoose.Types.ObjectId.isValid(staffId)) {
		return res.status(400).json({ message: 'Valid staff ID is required.' })
	}

	if (!status || !VALID_STAFF_STATUSES.includes(status)) {
		return res.status(400).json({
			message: `Invalid status '${status}'. Allowed: ${VALID_STAFF_STATUSES.join(', ')}.`,
		})
	}

	const staff = await BloodbankStaff.findOne({
		_id: staffId,
		bloodbankId: req.user._id,
	})

	if (!staff) {
		return res.status(404).json({
			message: 'Staff member not found or does not belong to your blood bank.',
		})
	}

	staff.status = status
	staff.tokenVersion = (staff.tokenVersion || 0) + 1
	await staff.save()

	return res.status(200).json({
		message: `Staff account status updated to '${status}'. Any active sessions have been invalidated.`,
		staff: {
			_id: staff._id,
			fullName: staff.fullName,
			email: staff.email,
			role: staff.role,
			status: staff.status,
			tokenVersion: staff.tokenVersion,
		},
	})
})

/**
 * Returns authenticated staff member's profile.
 */
const getStaffProfile = catchAsync(async (req, res, next) => {
	return res.status(200).json({
		staff: {
			_id: req.staff._id,
			fullName: req.staff.fullName,
			email: req.staff.email,
			phoneNo: req.staff.phoneNo,
			role: req.staff.role,
			bloodbankId: req.staff.bloodbankId,
			medicalLicense: req.staff.medicalLicense,
			status: req.staff.status,
			mustChangePassword: req.staff.mustChangePassword,
		},
	})
})

module.exports = {
	provisionStaff,
	loginStaff,
	setupStaffPassword,
	changeStaffPassword,
	getStaffList,
	updateStaffStatus,
	getStaffProfile,
}
