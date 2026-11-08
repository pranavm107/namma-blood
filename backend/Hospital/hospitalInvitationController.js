/**
 * Hospital Representative Invitation Controller
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Stage B3.1)
 *
 * Implements:
 * 1. Platform Admin Hospital Representative Invitation Issuance: POST /api/admin/hospital-invitations
 * 2. Hospital Representative Invitation Acceptance: POST /api/invitations/accept-hospital-representative
 *
 * Security Invariants:
 * - ADMIN authentication required for issuance (protectEmergencyAuth + requireAdmin).
 * - Hospital must be Verified and active.
 * - Raw token is NEVER stored in database (only SHA-256 hash).
 * - Outbox body stores only authenticated encrypted token (AES-256-GCM), never plaintext token.
 * - Expiration strictly 48 hours.
 * - Single-use token: compare-and-swap atomic transition prevents double redemption.
 * - Transactional consistency across Invitation, User, and NotificationOutbox.
 * - Prevents silent conversion of existing USER or other accounts.
 * - Zero client trust for role or hospitalId assignment.
 */

const crypto = require('crypto')
const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const AppError = require('../Utils/appError')
const userModel = require('../User/userModel')
const { Hospital } = require('./hospitalModel')
const { Invitation } = require('./invitationModel')
const { NotificationOutbox } = require('./notificationOutboxModel')
const { MedicalOfficerHospital } = require('./medicalOfficerHospitalModel')
const { withTransaction } = require('../Utils/transactionHelper')
const { encryptInvitationToken } = require('../Utils/tokenEncryption')
const {
	emailValidate,
	phoneNumberValidate,
} = require('../Common/Functions/validateInputs')

/**
 * 1. Invitation Issuance Endpoint
 * POST /api/admin/hospital-invitations
 *
 * Access: Platform ADMIN only
 */
exports.issueHospitalRepresentativeInvitation = catchAsync(async (req, res, next) => {
	// Guard: Platform Admin authorization
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}

	if (!req.user || !req.user._id) {
		return res.status(401).json({
			status: 'fail',
			message: 'Authentication required. Admin account not found.',
		})
	}

	// 1. Input Extraction & Validation
	const { hospitalId } = req.body
	if (!hospitalId || !mongoose.Types.ObjectId.isValid(hospitalId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Valid Hospital ID is required.',
		})
	}

	const recipientName = (req.body.recipientName || req.body.name || '').trim()
	if (!recipientName) {
		return res.status(400).json({
			status: 'fail',
			message: 'Recipient name is required.',
		})
	}

	const rawEmail = (req.body.recipientEmail || req.body.email || '').trim()
	if (!rawEmail || !emailValidate(rawEmail)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Valid recipient email address is required.',
		})
	}
	const normalizedEmail = rawEmail.toLowerCase()

	const rawPhone =
		req.body.recipientPhone !== undefined
			? req.body.recipientPhone
			: req.body.phone !== undefined
			? req.body.phone
			: req.body.phoneNo

	const parsedPhone = Number(rawPhone)
	if (!rawPhone || isNaN(parsedPhone) || !phoneNumberValidate(parsedPhone)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Valid 10-digit recipient phone number is required.',
		})
	}

	// Reject attempts to request unsupported invitation types via this endpoint
	if (req.body.invitationType && req.body.invitationType !== 'HOSPITAL_REPRESENTATIVE') {
		return res.status(400).json({
			status: 'fail',
			message:
				'Invalid invitation type. This endpoint only issues HOSPITAL_REPRESENTATIVE invitations.',
		})
	}

	// 2. Hospital Verification
	const hospital = await Hospital.findById(hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital not found.',
		})
	}

	if (hospital.verificationStatus !== 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: 'Cannot issue invitation: Hospital verification status is not Verified.',
		})
	}

	if (!hospital.isActive) {
		return res.status(400).json({
			status: 'fail',
			message: 'Cannot issue invitation: Hospital is inactive.',
		})
	}

	// 3. Pre-flight Account Conflict Check
	const existingUser = await userModel.findOne({ email: normalizedEmail })
	if (existingUser) {
		return res.status(409).json({
			status: 'fail',
			message:
				'An account with this email address already exists. Existing accounts cannot be converted to Hospital Representative.',
		})
	}

	// 4. Pre-flight Pending Invitation Duplicate Check (Stage B1 partial unique constraint)
	const existingPending = await Invitation.findOne({
		hospitalId: hospital._id,
		invitationType: 'HOSPITAL_REPRESENTATIVE',
		recipientEmail: normalizedEmail,
		status: 'Pending',
	})
	if (existingPending) {
		return res.status(409).json({
			status: 'fail',
			message:
				'An active pending invitation already exists for this recipient at this hospital.',
		})
	}

	// 5. Generate Invitation & Secure Token
	const invitation = new Invitation({
		invitationType: 'HOSPITAL_REPRESENTATIVE',
		hospitalId: hospital._id,
		invitedByUserId: req.user._id,
		invitedByRole: 'ADMIN',
		recipientName,
		recipientEmail: normalizedEmail,
		recipientPhone: parsedPhone,
	})

	// Cryptographically secure token generation (48h expiry, SHA-256 hash stored on doc)
	const rawToken = invitation.createInvitationToken(48)

	// 6. Encrypt Token for Asynchronous Notification Dispatch (Authenticated AES-256-GCM)
	// Fails closed if encryption key is missing or invalid.
	const encryptedPayload = encryptInvitationToken(rawToken)

	const eventId = `evt_rep_inv_${invitation._id.toString()}_${Date.now()}`
	const outboxRecord = new NotificationOutbox({
		eventId,
		eventType: 'REPRESENTATIVE_INVITED',
		hospitalId: hospital._id,
		recipientKey: `email:${normalizedEmail}`,
		recipientUserId: null,
		recipientEmail: normalizedEmail,
		recipientRole: 'HOSPITAL_ADMIN',
		channel: 'EMAIL',
		deliveryStatus: 'Pending',
		subject: `Invitation to manage ${hospital.hospitalName} as Hospital Representative`,
		sanitizedBody: JSON.stringify({
			message: `You have been invited to manage ${hospital.hospitalName} as Hospital Representative.`,
			hospitalName: hospital.hospitalName,
			hospitalCode: hospital.hospitalCode,
			invitationId: invitation._id.toString(),
			expiresAt: invitation.tokenExpiresAt.toISOString(),
			encryptedToken: encryptedPayload,
		}),
	})

	// 7. Atomic Transactional Persistence
	try {
		await withTransaction(async (session) => {
			const saveOpts = session ? { session } : {}
			await invitation.save(saveOpts)
			await outboxRecord.save(saveOpts)
		}, req._transactionOptions || {})
	} catch (err) {
		if (err.code === 11000) {
			return res.status(409).json({
				status: 'fail',
				message:
					'An active pending invitation already exists for this recipient at this hospital.',
			})
		}
		throw err
	}

	// 8. Return response: Raw token is ONLY returned in this initial creation response
	return res.status(201).json({
		status: 'success',
		message: 'Hospital Representative invitation issued successfully.',
		data: {
			invitation: {
				id: invitation._id,
				invitationType: invitation.invitationType,
				hospitalId: invitation.hospitalId,
				hospitalName: hospital.hospitalName,
				hospitalCode: hospital.hospitalCode,
				recipientName: invitation.recipientName,
				recipientEmail: invitation.recipientEmail,
				recipientPhone: invitation.recipientPhone,
				status: invitation.status,
				tokenExpiresAt: invitation.tokenExpiresAt,
				createdAt: invitation.createdAt,
			},
			invitationToken: rawToken,
		},
	})
})

/**
 * 2. Invitation Acceptance Endpoint
 * POST /api/invitations/accept-hospital-representative
 *
 * Access: Public bearer redemption endpoint
 */
exports.acceptHospitalRepresentativeInvitation = catchAsync(async (req, res, next) => {
	// 1. Input Validation
	const rawToken = (req.body.token || req.body.invitationToken || '').trim()
	if (!rawToken) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation token is required.',
		})
	}

	const password = req.body.password
	if (!password || typeof password !== 'string') {
		return res.status(400).json({
			status: 'fail',
			message: 'Password is required.',
		})
	}

	if (/\s/.test(password)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Password cannot contain spaces.',
		})
	}

	if (password.length < 8 || password.length > 20) {
		return res.status(400).json({
			status: 'fail',
			message: 'Password should be at least 8 to 20 characters.',
		})
	}

	if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Password too weak: must contain at least one letter and one number.',
		})
	}

	// Acceptance declarations validation
	const termsAccepted =
		req.body.termsAccepted === true ||
		req.body.declarationsAccepted === true ||
		req.body.acceptedTerms === true

	const confidentialityAccepted =
		req.body.confidentialityAccepted === true ||
		req.body.declarationsAccepted === true ||
		req.body.acceptedConfidentiality === true

	if (!termsAccepted || !confidentialityAccepted) {
		return res.status(400).json({
			status: 'fail',
			message:
				'You must accept the confidentiality agreement and platform terms to activate your representative account.',
		})
	}

	// 2. Token Hash Calculation
	const tokenHash = Invitation.hashToken(rawToken)
	if (!tokenHash) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid invitation token format.',
		})
	}

	// 3. Pre-transaction Lookup & Invariant Validations
	const invitation = await Invitation.findOne({ invitationTokenHash: tokenHash })
	if (!invitation) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid or unissued invitation token.',
		})
	}

	// Constant-time hash comparison
	const expectedBuf = Buffer.from(invitation.invitationTokenHash, 'hex')
	const actualBuf = Buffer.from(tokenHash, 'hex')
	if (
		expectedBuf.length !== actualBuf.length ||
		!crypto.timingSafeEqual(expectedBuf, actualBuf)
	) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid invitation token.',
		})
	}

	// Invariant Checks: Type & Lifecycle Status
	if (invitation.invitationType !== 'HOSPITAL_REPRESENTATIVE') {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid invitation type '${invitation.invitationType}'. This token cannot be used for hospital representative acceptance.`,
		})
	}

	if (invitation.status === 'Accepted') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has already been accepted and cannot be reused.',
		})
	}

	if (invitation.status === 'Revoked') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has been revoked and cannot be accepted.',
		})
	}

	if (invitation.status === 'Expired') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has expired.',
		})
	}

	if (invitation.status !== 'Pending') {
		return res.status(400).json({
			status: 'fail',
			message: `Invitation is not pending (status: ${invitation.status}).`,
		})
	}

	// Expiry Check & Lifecycle Persistence
	// Persist Expired state permanently in MongoDB outside the redemption transaction
	if (new Date() > new Date(invitation.tokenExpiresAt)) {
		await Invitation.updateOne(
			{ _id: invitation._id, status: 'Pending' },
			{ $set: { status: 'Expired' } }
		)
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation token has expired.',
		})
	}

	// Confirm Hospital Facility Registry State
	const hospital = await Hospital.findById(invitation.hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Associated hospital facility no longer exists.',
		})
	}

	if (hospital.verificationStatus !== 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: 'Cannot accept invitation: Associated hospital is no longer verified.',
		})
	}

	if (!hospital.isActive) {
		return res.status(400).json({
			status: 'fail',
			message: 'Cannot accept invitation: Associated hospital is inactive.',
		})
	}

	// Duplicate Account Conflict Check & Prevent Silent Role Conversion
	const existingAccount = await userModel.findOne({ email: invitation.recipientEmail })
	if (existingAccount) {
		return res.status(409).json({
			status: 'fail',
			message: `An account with email '${invitation.recipientEmail}' already exists. Existing accounts cannot be converted to Hospital Representative.`,
		})
	}

	const existingPhone = await userModel.findOne({ phoneNo1: invitation.recipientPhone })
	if (existingPhone) {
		return res.status(409).json({
			status: 'fail',
			message: `An account with phone number '${invitation.recipientPhone}' already exists.`,
		})
	}

	// 4. Create Authoritative Hospital Representative Account & Outbox Models
	let fName = (req.body.firstName || '').trim()
	let lName = (req.body.lastName || '').trim()
	if (!fName || !lName) {
		const parts = (invitation.recipientName || 'Hospital Representative')
			.trim()
			.split(/\s+/)
		fName = fName || parts[0] || 'Hospital'
		lName = lName || (parts.length > 1 ? parts.slice(1).join(' ') : 'Representative')
	}

	// Zero client trust: strictly enforce authoritative role, lifecycle, and hospitalId
	const newUser = new userModel({
		firstName: fName,
		lastName: lName,
		email: invitation.recipientEmail,
		phoneNo1: invitation.recipientPhone,
		password, // Hashed by userModel pre('save') bcrypt hook
		role: 'HOSPITAL_ADMIN',
		accountStatus: 'Active',
		representativeStatus: 'Active',
		hospitalId: hospital._id,
		status: true,
		tokenVersion: 0,
	})

	const eventId = `evt_rep_acc_${invitation._id.toString()}_${Date.now()}`
	const outboxRecord = new NotificationOutbox({
		eventId,
		eventType: 'INVITATION_ACCEPTED',
		hospitalId: hospital._id,
		recipientKey: `user:${newUser._id.toString()}`,
		recipientUserId: newUser._id,
		recipientEmail: newUser.email,
		recipientRole: 'HOSPITAL_ADMIN',
		channel: 'EMAIL',
		deliveryStatus: 'Pending',
		subject: `Hospital Representative Account Activated - ${hospital.hospitalName}`,
		sanitizedBody: JSON.stringify({
			message: `Hospital Representative account for ${newUser.email} at ${hospital.hospitalName} has been successfully activated.`,
			userId: newUser._id.toString(),
			hospitalId: hospital._id.toString(),
			hospitalCode: hospital.hospitalCode,
			acceptedAt: new Date().toISOString(),
		}),
	})

	let createdUser = null

	// 5. Atomic Multi-Document Transaction: User Creation, Invitation CAS, and Outbox Insertion
	try {
		await withTransaction(async (session) => {
			const saveOpts = session ? { session } : {}

			// 1. Persist User Account within Transaction Session
			await newUser.save(saveOpts)

			// 2. Atomic State Transition: Compare-and-swap within Transaction Session
			// Ensures only one concurrent request can successfully transition from Pending -> Accepted
			const updateResult = await Invitation.findOneAndUpdate(
				{
					_id: invitation._id,
					status: 'Pending',
				},
				{
					$set: {
						status: 'Accepted',
						acceptedAt: new Date(),
						'metadata.acceptedByUserId': newUser._id,
						'metadata.acceptedAt': new Date(),
						'metadata.termsAcceptedAt': new Date(),
						'metadata.confidentialityAcceptedAt': new Date(),
					},
				},
				{ new: true, session: session || undefined }
			)

			if (!updateResult) {
				throw new AppError(
					'Invitation redemption conflict: Invitation is no longer pending or was redeemed by a concurrent request.',
					409
				)
			}

			// 3. Persist Notification Outbox Entry within Transaction Session
			await outboxRecord.save(saveOpts)

			createdUser = newUser
		}, req._transactionOptions || {})
	} catch (err) {
		const statusCode = err.statusCode || (err.code === 11000 ? 409 : 400)
		return res.status(statusCode).json({
			status: statusCode >= 500 ? 'error' : 'fail',
			message: err.message,
		})
	}

	// 6. Return Clean Response (Never return or log raw invitation tokens)
	return res.status(200).json({
		status: 'success',
		message: 'Hospital Representative account successfully created and activated.',
		data: {
			user: {
				id: createdUser._id,
				firstName: createdUser.firstName,
				lastName: createdUser.lastName,
				email: createdUser.email,
				phoneNo1: createdUser.phoneNo1,
				role: createdUser.role,
				accountStatus: createdUser.accountStatus,
				representativeStatus: createdUser.representativeStatus,
				hospitalId: createdUser.hospitalId,
			},
			hospital: {
				id: hospital._id,
				hospitalName: hospital.hospitalName,
				hospitalCode: hospital.hospitalCode,
			},
		},
	})
})

/**
 * 3. Doctor Nomination Issuance Endpoint (Stage B3.2)
 * POST /api/hospital/doctors/nominate & POST /api/hospitals/doctors/nominate
 *
 * Access: Authenticated HOSPITAL_ADMIN only
 */
exports.nominateDoctorInvitation = catchAsync(async (req, res, next) => {
	// Guard 1: Platform Role Guard
	if (req.userRole !== 'HOSPITAL_ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Hospital Representative privileges required.',
		})
	}

	if (!req.user || !req.user._id) {
		return res.status(401).json({
			status: 'fail',
			message: 'Authentication required. Hospital Representative account not found.',
		})
	}

	// Guard 2: Representative Account Lifecycle
	if (req.user.accountStatus && req.user.accountStatus !== 'Active') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Hospital Representative account is ${req.user.accountStatus.toLowerCase()}.`,
		})
	}

	if (req.user.status === false) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Representative account is deactivated or suspended.',
		})
	}

	if (req.user.representativeStatus && req.user.representativeStatus !== 'Active') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Representative authorization status is '${req.user.representativeStatus}'.`,
		})
	}

	// Guard 3: Authoritative Hospital Binding & Anti-BOLA Defense
	const authoritativeHospitalId = req.hospitalId || req.user.hospitalId
	if (!authoritativeHospitalId) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Hospital Representative is not linked to any hospital facility.',
		})
	}

	const clientSuppliedHospitalId = req.body?.hospitalId || req.query?.hospitalId
	if (
		clientSuppliedHospitalId &&
		typeof clientSuppliedHospitalId === 'string' &&
		clientSuppliedHospitalId.trim() !== ''
	) {
		if (clientSuppliedHospitalId.trim() !== authoritativeHospitalId.toString()) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: You cannot nominate doctors for another hospital facility.',
			})
		}
	}

	// Guard 4: Hospital Registry Verification
	const hospital =
		req.hospital || (await Hospital.findById(authoritativeHospitalId))
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Associated hospital facility not found.',
		})
	}

	if (hospital.verificationStatus !== 'Verified') {
		return res.status(403).json({
			status: 'fail',
			message: `Cannot issue nomination: Hospital verification status is '${hospital.verificationStatus}'. Only Verified hospitals can nominate doctors.`,
		})
	}

	if (!hospital.isActive) {
		return res.status(403).json({
			status: 'fail',
			message: 'Cannot issue nomination: Hospital facility is inactive.',
		})
	}

	// 1. Input Validation
	const recipientName = (
		req.body.recipientName ||
		req.body.name ||
		req.body.doctorName ||
		req.body.fullName ||
		''
	).trim()
	if (!recipientName) {
		return res.status(400).json({
			status: 'fail',
			message: 'Recipient doctor name is required.',
		})
	}

	const rawEmail = (req.body.recipientEmail || req.body.email || '').trim()
	if (!rawEmail || !emailValidate(rawEmail)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Valid recipient email address is required.',
		})
	}
	const normalizedEmail = rawEmail.toLowerCase()

	const rawPhone =
		req.body.recipientPhone !== undefined
			? req.body.recipientPhone
			: req.body.phone !== undefined
			? req.body.phone
			: req.body.phoneNo

	const parsedPhone = Number(rawPhone)
	if (!rawPhone || isNaN(parsedPhone) || !phoneNumberValidate(parsedPhone)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Valid 10-digit recipient phone number is required.',
		})
	}

	if (req.body.invitationType && req.body.invitationType !== 'DOCTOR_NOMINATION') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid invitation type. This endpoint only issues DOCTOR_NOMINATION invitations.',
		})
	}

	// 2. Pre-flight Duplicate & Conflict Checks
	// A. Check for existing Pending nomination for the same recipient at this hospital
	const existingPending = await Invitation.findOne({
		hospitalId: hospital._id,
		invitationType: 'DOCTOR_NOMINATION',
		recipientEmail: normalizedEmail,
		status: 'Pending',
	})
	if (existingPending) {
		return res.status(409).json({
			status: 'fail',
			message: 'An active pending doctor nomination already exists for this recipient at this hospital.',
		})
	}

	// B. Check existing user account by email
	const existingUserByEmail = await userModel.findOne({ email: normalizedEmail })
	if (existingUserByEmail) {
		if (existingUserByEmail.role !== 'MEDICAL_OFFICER') {
			return res.status(409).json({
				status: 'fail',
				message: `An account with email '${normalizedEmail}' already exists with role '${existingUserByEmail.role}'. Non-doctor accounts cannot be nominated as Medical Officers.`,
			})
		}

		// Reject suspended, deactivated or non-active accounts
		if (
			existingUserByEmail.accountStatus !== 'Active' ||
			existingUserByEmail.status === false
		) {
			const statusLabel =
				existingUserByEmail.status === false
					? 'inactive'
					: existingUserByEmail.accountStatus
					? existingUserByEmail.accountStatus.toLowerCase()
					: 'inactive'
			return res.status(409).json({
				status: 'fail',
				message: `Cannot nominate Medical Officer: Account is ${statusLabel}. Active account required for nomination.`,
			})
		}

		// Multi-hospital association check: verify not already associated with this hospital
		const existingAssoc = await MedicalOfficerHospital.findOne({
			medicalOfficerUserId: existingUserByEmail._id,
			hospitalId: hospital._id,
		})
		if (
			existingAssoc &&
			[
				'Active',
				'Pending_Admin_Approval',
				'Pending_Hospital_Confirmation',
				'Pending',
			].includes(existingAssoc.associationStatus)
		) {
			return res.status(409).json({
				status: 'fail',
				message: `Medical Officer is already associated with or pending affiliation at this hospital with status '${existingAssoc.associationStatus}'.`,
			})
		}
	}

	// C. Check existing user account by phone
	const existingUserByPhone = await userModel.findOne({ phoneNo1: parsedPhone })
	if (existingUserByPhone) {
		if (existingUserByPhone.role !== 'MEDICAL_OFFICER') {
			return res.status(409).json({
				status: 'fail',
				message: `An account with phone number '${parsedPhone}' already exists with role '${existingUserByPhone.role}'.`,
			})
		}
		if (
			existingUserByPhone.accountStatus !== 'Active' ||
			existingUserByPhone.status === false
		) {
			const statusLabel =
				existingUserByPhone.status === false
					? 'inactive'
					: existingUserByPhone.accountStatus
					? existingUserByPhone.accountStatus.toLowerCase()
					: 'inactive'
			return res.status(409).json({
				status: 'fail',
				message: `Cannot nominate Medical Officer: Account associated with phone number is ${statusLabel}.`,
			})
		}
		if (
			existingUserByEmail &&
			existingUserByEmail._id.toString() !== existingUserByPhone._id.toString()
		) {
			return res.status(409).json({
				status: 'fail',
				message: 'Phone number belongs to a different user account.',
			})
		}
	}

	// 3. Create Invitation Document with Secure Token
	const invitation = new Invitation({
		invitationType: 'DOCTOR_NOMINATION',
		hospitalId: hospital._id,
		invitedByUserId: req.user._id,
		invitedByRole: 'HOSPITAL_ADMIN',
		recipientName,
		recipientEmail: normalizedEmail,
		recipientPhone: parsedPhone,
	})

	const rawToken = invitation.createInvitationToken(48)

	// 4. Encrypt Token for Notification Outbox
	const encryptedPayload = encryptInvitationToken(rawToken)
	const eventId = `evt_doc_nom_${invitation._id.toString()}_${Date.now()}`
	const outboxRecord = new NotificationOutbox({
		eventId,
		eventType: 'DOCTOR_NOMINATED',
		hospitalId: hospital._id,
		recipientKey: `email:${normalizedEmail}`,
		recipientUserId: existingUserByEmail ? existingUserByEmail._id : null,
		recipientEmail: normalizedEmail,
		recipientRole: 'MEDICAL_OFFICER',
		channel: 'EMAIL',
		deliveryStatus: 'Pending',
		subject: `Doctor Nomination - Invitation to join ${hospital.hospitalName}`,
		sanitizedBody: JSON.stringify({
			message: `You have been nominated as a Medical Officer for ${hospital.hospitalName}.`,
			hospitalName: hospital.hospitalName,
			hospitalCode: hospital.hospitalCode,
			invitationId: invitation._id.toString(),
			expiresAt: invitation.tokenExpiresAt.toISOString(),
			encryptedToken: encryptedPayload,
		}),
	})

	// 5. Transactional Persistence
	try {
		await withTransaction(async (session) => {
			const saveOpts = session ? { session } : {}
			await invitation.save(saveOpts)
			await outboxRecord.save(saveOpts)
		}, req._transactionOptions || {})
	} catch (err) {
		if (err.code === 11000) {
			return res.status(409).json({
				status: 'fail',
				message: 'An active pending doctor nomination already exists for this recipient at this hospital.',
			})
		}
		throw err
	}

	// 6. Return Clean Response (rawToken returned only on initial issuance)
	return res.status(201).json({
		status: 'success',
		message: 'Doctor nomination invitation issued successfully.',
		data: {
			invitation: {
				id: invitation._id,
				invitationType: invitation.invitationType,
				hospitalId: hospital._id,
				hospitalName: hospital.hospitalName,
				recipientName: invitation.recipientName,
				recipientEmail: invitation.recipientEmail,
				status: invitation.status,
				expiresAt: invitation.tokenExpiresAt,
			},
			invitationToken: rawToken,
		},
	})
})

// Alias export for nominateDoctorInvitation
exports.nominateMedicalOfficer = exports.nominateDoctorInvitation

/**
 * 4. Doctor Nomination Acceptance Endpoint (Stage B3.2)
 * POST /api/invitations/accept-doctor-nomination
 *
 * Access: Public bearer-token acceptance
 */
exports.acceptDoctorNominationInvitation = catchAsync(async (req, res, next) => {
	// 1. Input Extraction & Token Validation
	const rawToken = (req.body.token || req.body.invitationToken || '').trim()
	if (!rawToken) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation token is required.',
		})
	}

	const tokenHash = Invitation.hashToken(rawToken)
	const invitation = await Invitation.findOne({ invitationTokenHash: tokenHash })
	if (!invitation) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid or unissued invitation token.',
		})
	}

	// 2. Invitation Type & Lifecycle State Invariants
	if (invitation.invitationType !== 'DOCTOR_NOMINATION') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid invitation type. This endpoint only accepts DOCTOR_NOMINATION invitations.',
		})
	}

	if (invitation.status === 'Accepted') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has already been accepted and cannot be redeemed again.',
		})
	}

	if (invitation.status === 'Revoked') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has been revoked.',
		})
	}

	if (invitation.status === 'Expired') {
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has expired and can no longer be redeemed.',
		})
	}

	if (invitation.status !== 'Pending') {
		return res.status(400).json({
			status: 'fail',
			message: `Invitation is not pending (status: ${invitation.status}).`,
		})
	}

	// 3. Expiration Check with Permanent Lifecycle State Persistence
	if (new Date() > new Date(invitation.tokenExpiresAt)) {
		await Invitation.updateOne(
			{ _id: invitation._id, status: 'Pending' },
			{ $set: { status: 'Expired' } }
		)
		return res.status(400).json({
			status: 'fail',
			message: 'Invitation has expired and can no longer be redeemed.',
		})
	}

	// 4. Acceptance Declarations Verification
	const termsAccepted = req.body.termsAccepted === true
	const confidentialityAccepted = req.body.confidentialityAccepted === true
	if (!termsAccepted || !confidentialityAccepted) {
		return res.status(400).json({
			status: 'fail',
			message: 'You must accept the platform terms and confidentiality agreement to redeem this nomination.',
		})
	}

	// 5. Hospital Facility Verification
	const hospital = await Hospital.findById(invitation.hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Associated hospital facility not found.',
		})
	}

	if (hospital.verificationStatus !== 'Verified' || !hospital.isActive) {
		let reason = 'Associated hospital is unverified or inactive.'
		if (hospital.verificationStatus !== 'Verified') {
			reason = `Associated hospital verification status is '${hospital.verificationStatus}'. Only Verified hospitals can accept doctor affiliations.`
		} else if (!hospital.isActive) {
			reason = 'Associated hospital is currently marked inactive.'
		}
		return res.status(400).json({
			status: 'fail',
			message: `Cannot accept nomination: ${reason}`,
		})
	}

	// 6. Account Resolution: Existing Medical Officer vs. New Account Onboarding
	let existingUser = await userModel.findOne({ email: invitation.recipientEmail })
	let isNewUser = false
	let targetUserDoc = null

	if (existingUser) {
		// Prevent silent role conversion of non-doctors (e.g. USER or HOSPITAL_ADMIN)
		if (existingUser.role !== 'MEDICAL_OFFICER') {
			return res.status(409).json({
				status: 'fail',
				message: `An account with email '${invitation.recipientEmail}' already exists with role '${existingUser.role}'. Existing non-doctor accounts cannot be converted to Medical Officer.`,
			})
		}

		// Reject suspended, deactivated or non-active accounts (never reactivate)
		if (
			existingUser.accountStatus !== 'Active' ||
			existingUser.status === false
		) {
			const statusLabel =
				existingUser.status === false
					? 'inactive'
					: existingUser.accountStatus
					? existingUser.accountStatus.toLowerCase()
					: 'inactive'
			return res.status(409).json({
				status: 'fail',
				message: `Cannot accept nomination: Medical Officer account is ${statusLabel}. Active account required to accept nominations.`,
			})
		}

		// Check if already associated with this hospital
		const existingAssoc = await MedicalOfficerHospital.findOne({
			medicalOfficerUserId: existingUser._id,
			hospitalId: hospital._id,
		})
		if (
			existingAssoc &&
			[
				'Active',
				'Pending_Admin_Approval',
				'Pending_Hospital_Confirmation',
				'Pending',
			].includes(existingAssoc.associationStatus)
		) {
			return res.status(409).json({
				status: 'fail',
				message: 'Medical Officer is already associated with or pending affiliation at this hospital.',
			})
		}

		targetUserDoc = existingUser
	} else {
		isNewUser = true

		// Password validation for new account creation
		const password = req.body.password
		if (
			!password ||
			typeof password !== 'string' ||
			password.length < 8 ||
			password.length > 20
		) {
			return res.status(400).json({
				status: 'fail',
				message: 'Password is required and must be between 8 and 20 characters.',
			})
		}

		// Phone conflict check
		const phoneConflict = await userModel.findOne({
			phoneNo1: invitation.recipientPhone,
		})
		if (phoneConflict) {
			return res.status(409).json({
				status: 'fail',
				message: `An account with phone number '${invitation.recipientPhone}' already exists.`,
			})
		}

		let fName = (req.body.firstName || '').trim()
		let lName = (req.body.lastName || '').trim()
		if (!fName || !lName) {
			const parts = (invitation.recipientName || 'Medical Officer').trim().split(/\s+/)
			fName = fName || parts[0] || 'Medical'
			lName = lName || (parts.length > 1 ? parts.slice(1).join(' ') : 'Officer')
		}

		// Authoritative Account Lifecycle:
		// - role: MEDICAL_OFFICER
		// - accountStatus: Active (account registered and password set)
		// - credentialStatus: Unsubmitted (Gate 2 fails closed until Stage B3.4 verification)
		// - verificationStatus: Pending (legacy backwards compatibility)
		targetUserDoc = new userModel({
			firstName: fName,
			lastName: lName,
			email: invitation.recipientEmail,
			phoneNo1: invitation.recipientPhone,
			password,
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Unsubmitted',
			verificationStatus: 'Pending',
			status: true,
			tokenVersion: 0,
		})
	}

	// 7. Authoritative Association Lifecycle:
	// - associationStatus: Pending_Admin_Approval (Hospital rep has confirmed; pending platform Admin approval)
	// - permissions: VIEW_EMERGENCY_REQUESTS (no automatic VERIFY permission)
	// - availabilityStatus: Unavailable
	const newAssociation = new MedicalOfficerHospital({
		medicalOfficerUserId: targetUserDoc._id,
		hospitalId: hospital._id,
		associationStatus: 'Pending_Admin_Approval',
		permissions: ['VIEW_EMERGENCY_REQUESTS'],
		availabilityStatus: 'Unavailable',
		initiatedBy: 'HOSPITAL',
		hospitalConfirmedBy: invitation.invitedByUserId,
		hospitalConfirmedAt: new Date(),
		effectiveFrom: new Date(),
	})

	// 8. Notification Outbox Event Insertion
	const eventId = `evt_doc_acc_${invitation._id.toString()}_${Date.now()}`
	const outboxRecord = new NotificationOutbox({
		eventId,
		eventType: 'INVITATION_ACCEPTED',
		hospitalId: hospital._id,
		recipientKey: `user:${targetUserDoc._id.toString()}`,
		recipientUserId: targetUserDoc._id,
		recipientEmail: targetUserDoc.email,
		recipientRole: 'MEDICAL_OFFICER',
		channel: 'EMAIL',
		deliveryStatus: 'Pending',
		subject: `Medical Officer Nomination Accepted - ${hospital.hospitalName}`,
		sanitizedBody: JSON.stringify({
			message: `Medical Officer nomination for ${targetUserDoc.email} at ${hospital.hospitalName} has been accepted. Association is pending Admin approval.`,
			userId: targetUserDoc._id.toString(),
			hospitalId: hospital._id.toString(),
			hospitalCode: hospital.hospitalCode,
			associationId: newAssociation._id.toString(),
			acceptedAt: new Date().toISOString(),
		}),
	})

	// 9. Atomic Multi-Document Transaction
	try {
		await withTransaction(async (session) => {
			const saveOpts = session ? { session } : {}

			// 1. If new user, save user account within session
			if (isNewUser) {
				await targetUserDoc.save(saveOpts)
				newAssociation.medicalOfficerUserId = targetUserDoc._id
				outboxRecord.recipientUserId = targetUserDoc._id
				outboxRecord.recipientKey = `user:${targetUserDoc._id.toString()}`
			}

			// 2. Save hospital association within session
			await newAssociation.save(saveOpts)

			// 3. Atomic CAS transition on Invitation: Pending -> Accepted within session
			const updateResult = await Invitation.findOneAndUpdate(
				{
					_id: invitation._id,
					status: 'Pending',
				},
				{
					$set: {
						status: 'Accepted',
						acceptedAt: new Date(),
						'metadata.acceptedByUserId': targetUserDoc._id,
						'metadata.acceptedAt': new Date(),
						'metadata.termsAcceptedAt': new Date(),
						'metadata.confidentialityAcceptedAt': new Date(),
						'metadata.associationId': newAssociation._id,
					},
				},
				{ new: true, session: session || undefined }
			)

			if (!updateResult) {
				throw new AppError(
					'Invitation redemption conflict: Invitation is no longer pending or was redeemed by a concurrent request.',
					409
				)
			}

			// 4. Save outbox record within session
			await outboxRecord.save(saveOpts)
		}, req._transactionOptions || {})
	} catch (err) {
		const statusCode = err.statusCode || (err.code === 11000 ? 409 : 400)
		return res.status(statusCode).json({
			status: statusCode >= 500 ? 'error' : 'fail',
			message: err.message,
		})
	}

	// 10. Return Clean Response (Never return raw tokens or passwords)
	return res.status(200).json({
		status: 'success',
		message: 'Doctor nomination accepted successfully. Association is pending Admin approval.',
		data: {
			user: {
				id: targetUserDoc._id,
				firstName: targetUserDoc.firstName,
				lastName: targetUserDoc.lastName,
				email: targetUserDoc.email,
				phoneNo1: targetUserDoc.phoneNo1,
				role: targetUserDoc.role,
				accountStatus: targetUserDoc.accountStatus,
				credentialStatus: targetUserDoc.credentialStatus,
				verificationStatus: targetUserDoc.verificationStatus,
			},
			hospital: {
				id: hospital._id,
				hospitalName: hospital.hospitalName,
				hospitalCode: hospital.hospitalCode,
			},
			association: {
				id: newAssociation._id,
				associationStatus: newAssociation.associationStatus,
				permissions: newAssociation.permissions,
				availabilityStatus: newAssociation.availabilityStatus,
			},
		},
	})
})

// Alias export for acceptDoctorNominationInvitation
exports.acceptDoctorNomination = exports.acceptDoctorNominationInvitation
