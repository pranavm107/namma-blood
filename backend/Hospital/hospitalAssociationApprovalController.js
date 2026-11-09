/**
 * Hospital Association Approval & Lifecycle Controller
 * Namma Blood — Stage B3.4.4 Hospital Association Approval and Clinical Authorization
 *
 * Implements secure, auditable, multi-tenant APIs for managing hospital-doctor associations:
 *
 * Platform ADMIN Endpoints:
 * - GET   /api/admin/medical-officers/associations                                 (Read-only association review queue)
 * - GET   /api/admin/medical-officers/:doctorId/associations/:associationId       (Individual association details)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/approve (Pending_Admin_Approval -> Active)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/reject  (Pending_Admin_Approval -> Rejected)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/permissions (Manage explicit permissions)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/suspend (Active -> Suspended)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/reactivate (Suspended -> Active)
 * - PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/revoke (Active/Suspended -> Revoked)
 *
 * Hospital Representative (HOSPITAL_ADMIN) Endpoints:
 * - GET   /api/hospital/medical-officers/associations                              (Hospital-scoped association queue)
 * - GET   /api/hospital/medical-officers/:doctorId/associations/:associationId    (Hospital-scoped association details)
 * - PATCH /api/hospital/medical-officers/:doctorId/associations/:associationId/suspend (Hospital-scoped suspension)
 * - PATCH /api/hospital/medical-officers/:doctorId/associations/:associationId/revoke (Hospital-scoped revocation)
 *
 * Core Governance Invariants:
 * 1. Independent Gate Verification: Credential verification (Gate 2) and hospital association (Gate 3) are strictly decoupled.
 *    Approving an association requires credentialStatus === 'Verified' and accountStatus === 'Active'.
 * 2. Least-Privilege Permissions: Association approval grants VIEW_EMERGENCY_REQUESTS only.
 *    VERIFY_EMERGENCY_REQUESTS is NEVER granted automatically and requires explicit ADMIN assignment.
 * 3. Strict Institutional Multi-Tenancy: HOSPITAL_ADMIN actions are strictly scoped to req.hospitalId (no cross-hospital BOLA).
 * 4. Transactional Audit & Outbox: Every state change, SHA-256 audit entry, and notification outbox record
 *    share a single atomic MongoDB multi-document transaction boundary.
 */

const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const { Hospital } = require('./hospitalModel')
const {
	MedicalOfficerHospital,
	VALID_MO_PERMISSIONS,
	VALID_ASSOCIATION_STATUSES,
} = require('./medicalOfficerHospitalModel')
const { withTransaction } = require('../Utils/transactionHelper')
const { appendAuditRecordTransactional } = require('./auditIntegrityService')
const { NotificationOutbox } = require('./notificationOutboxModel')

// Forbidden mass-assignment fields in association administrative payloads
const FORBIDDEN_ASSOCIATION_PAYLOAD_FIELDS = [
	'medicalOfficerUserId',
	'hospitalId',
	'associationStatus',
	'availabilityStatus',
	'adminApprovedBy',
	'adminApprovedAt',
	'approvedBy',
	'approvedAt',
	'initiatedBy',
	'actorId',
	'actorModel',
	'actorRole',
	'sequenceNumber',
	'recordHash',
	'previousRecordHash',
]

/**
 * Mask sensitive medical registration numbers for privacy-preserving audit storage
 */
function maskRegistrationNumber(regNo) {
	if (!regNo || typeof regNo !== 'string') return ''
	const clean = regNo.trim()
	if (clean.length <= 4) return '***'
	const prefix = clean.slice(0, 2)
	const suffix = clean.slice(-4)
	return `${prefix}****${suffix}`
}

/**
 * Helper to validate MongoDB ObjectId
 */
function isValidObjectId(id) {
	return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id)
}

/**
 * Helper to validate request body against forbidden mass-assignment fields
 */
function checkForbiddenFields(body) {
	if (!body || typeof body !== 'object') return null
	for (const field of FORBIDDEN_ASSOCIATION_PAYLOAD_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, field)) {
			return `Mass-assignment violation: direct client modification of protected security field '${field}' is strictly prohibited.`
		}
	}
	return null
}

// =============================================================================
// PLATFORM ADMIN CONTROLLER METHODS
// =============================================================================

/**
 * 1. Admin Association Review Queue (Read-Only)
 * GET /api/admin/medical-officers/associations
 */
exports.getAdminAssociationQueue = catchAsync(async (req, res, next) => {
	const page = Math.max(1, parseInt(req.query.page, 10) || 1)
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
	const skip = (page - 1) * limit

	const query = {}

	// Association Status filter
	if (req.query.status || req.query.associationStatus) {
		const rawStatus = String(req.query.status || req.query.associationStatus).trim()
		if (rawStatus.toLowerCase() !== 'all') {
			if (rawStatus.includes(',')) {
				query.associationStatus = {
					$in: rawStatus.split(',').map((s) => s.trim()).filter(Boolean),
				}
			} else {
				query.associationStatus = rawStatus
			}
		}
	} else {
		// Default to pending review queue
		query.associationStatus = 'Pending_Admin_Approval'
	}

	// Filter by hospital
	if (req.query.hospitalId) {
		if (isValidObjectId(req.query.hospitalId)) {
			query.hospitalId = req.query.hospitalId
		}
	}

	// Filter by doctor
	if (req.query.doctorId || req.query.medicalOfficerUserId) {
		const docId = req.query.doctorId || req.query.medicalOfficerUserId
		if (isValidObjectId(docId)) {
			query.medicalOfficerUserId = docId
		}
	}

	const sort = { createdAt: -1, _id: 1 }

	const [totalRecords, associations] = await Promise.all([
		MedicalOfficerHospital.countDocuments(query),
		MedicalOfficerHospital.find(query)
			.populate('medicalOfficerUserId', 'firstName lastName name email phoneNo1 accountStatus credentialStatus verificationStatus medicalRegistrationNumber medicalCouncil registrationState registrationYear qualification specialization')
			.populate('hospitalId', 'hospitalName hospitalCode hospitalType address contactPhone contactEmail verificationStatus isActive')
			.sort(sort)
			.skip(skip)
			.limit(limit)
			.lean(),
	])

	const totalPages = Math.ceil(totalRecords / limit) || 1

	return res.status(200).json({
		status: 'success',
		data: {
			totalRecords,
			page,
			limit,
			totalPages,
			pagination: {
				page,
				limit,
				totalPages,
				totalRecords,
			},
			associations,
		},
	})
})

/**
 * 2. Admin Association Details (Read-Only)
 * GET /api/admin/medical-officers/:doctorId/associations/:associationId
 */
exports.getAdminAssociationDetails = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const association = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
		.populate('medicalOfficerUserId', 'firstName lastName name email phoneNo1 accountStatus credentialStatus verificationStatus medicalRegistrationNumber medicalCouncil registrationState registrationYear qualification specialization')
		.populate('hospitalId', 'hospitalName hospitalCode hospitalType address contactPhone contactEmail verificationStatus isActive')
		.lean()

	if (!association) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	return res.status(200).json({
		status: 'success',
		data: {
			association,
			doctor: association.medicalOfficerUserId,
			hospital: association.hospitalId,
		},
	})
})

/**
 * 3. Admin Association Approval
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/approve
 * Transition: Pending_Admin_Approval -> Active
 */
exports.approveAssociation = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// 1. Verify target Medical Officer exists and satisfies Gate 1 and Gate 2
	const doctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (doctor.accountStatus !== 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot approve association: Medical Officer account status is '${doctor.accountStatus}'. Active account required.`,
			accountStatus: doctor.accountStatus,
		})
	}

	if (doctor.credentialStatus !== 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot approve association: Medical Officer credentials must be 'Verified' before hospital association approval. Current credential status is '${doctor.credentialStatus}'.`,
			credentialStatus: doctor.credentialStatus,
		})
	}

	// 2. Verify target association exists and is in Pending_Admin_Approval status
	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	if (targetAssoc.associationStatus === 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already active.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	if (targetAssoc.associationStatus !== 'Pending_Admin_Approval') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot approve association in status '${targetAssoc.associationStatus}'. Only associations in 'Pending_Admin_Approval' can be approved.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	// 3. Verify associated hospital facility exists, is verified and active
	const hospital = await Hospital.findById(targetAssoc.hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Associated hospital facility not found.',
		})
	}

	if (hospital.verificationStatus !== 'Verified' || hospital.isActive !== true) {
		return res.status(409).json({
			status: 'fail',
			message: 'Cannot approve association: Hospital facility is unverified or inactive.',
			hospitalVerificationStatus: hospital.verificationStatus,
			hospitalIsActive: hospital.isActive,
		})
	}

	const approvalReason = (req.body && req.body.reason)
		? String(req.body.reason).trim()
		: 'Platform Administrator approved hospital association'

	let updatedAssociation = null

	// 4. Atomic Multi-Document Transaction
	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: 'Pending_Admin_Approval',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed or already approved by another administrator.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		assoc.associationStatus = 'Active'
		assoc.adminApprovedAt = new Date()
		assoc.adminApprovedBy = adminId
		assoc.approvedAt = new Date()
		assoc.approvedBy = adminId
		assoc.approvalReason = approvalReason
		// Enforce least-privilege default: VIEW_EMERGENCY_REQUESTS only
		assoc.permissions = ['VIEW_EMERGENCY_REQUESTS']

		updatedAssociation = await assoc.save({ session })

		// Append immutable audit record
		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctor._id,
			hospitalAssociationId: assoc._id,
			hospitalId: hospital._id,
			decisionType: 'ASSOCIATION_APPROVED',
			previousStatus: 'Pending_Admin_Approval',
			newStatus: 'Active',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: approvalReason,
			grantedPermissions: ['VIEW_EMERGENCY_REQUESTS'],
			metadata: {
				hospitalId: hospital._id,
				hospitalName: hospital.hospitalName,
				medicalRegistrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			},
		})

		// Enqueue notification outbox event
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-APP-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_APPROVED',
					hospitalId: hospital._id,
					recipientKey: `MO-ASSOC-APP-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Approved',
					sanitizedBody: `Your association with ${hospital.hospitalName} has been approved by the platform administration.`,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association approved successfully. Association status is now Active.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			medicalOfficerUserId: updatedAssociation.medicalOfficerUserId,
			hospitalId: updatedAssociation.hospitalId,
			associationStatus: updatedAssociation.associationStatus,
			permissions: updatedAssociation.permissions,
			adminApprovedAt: updatedAssociation.adminApprovedAt,
			adminApprovedBy: updatedAssociation.adminApprovedBy,
		},
	})
})

/**
 * 4. Admin Association Rejection
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/reject
 * Transition: Pending_Admin_Approval -> Rejected
 */
exports.rejectAssociation = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific rejection reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	if (targetAssoc.associationStatus !== 'Pending_Admin_Approval') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot reject association in status '${targetAssoc.associationStatus}'. Only associations in 'Pending_Admin_Approval' can be rejected.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: 'Pending_Admin_Approval',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while processing rejection.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		assoc.associationStatus = 'Rejected'
		assoc.rejectionReason = cleanReason
		assoc.rejectedAt = new Date()
		assoc.rejectedBy = adminId

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: assoc.hospitalId,
			decisionType: 'ASSOCIATION_REJECTED',
			previousStatus: 'Pending_Admin_Approval',
			newStatus: 'Rejected',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			metadata: {
				rejectionReason: cleanReason,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-REJ-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_REJECTED',
					hospitalId: assoc.hospitalId,
					recipientKey: `MO-ASSOC-REJ-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Request Rejected',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association rejected successfully.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			rejectionReason: updatedAssociation.rejectionReason,
		},
	})
})

/**
 * 5. Admin Association Permission Management
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/permissions
 */
exports.updateAssociationPermissions = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Validate permissions payload
	const rawPermissions = req.body.permissions
	if (
		!Array.isArray(rawPermissions) ||
		rawPermissions.length === 0 ||
		!rawPermissions.includes('VIEW_EMERGENCY_REQUESTS')
	) {
		return res.status(400).json({
			status: 'fail',
			message:
				'Permissions must be a non-empty array containing at least VIEW_EMERGENCY_REQUESTS.',
			field: 'permissions',
		})
	}

	const validPermSet = new Set(VALID_MO_PERMISSIONS)
	for (const perm of rawPermissions) {
		if (!validPermSet.has(perm)) {
			return res.status(400).json({
				status: 'fail',
				message: `Unauthorized permission '${perm}'. Allowed: ${VALID_MO_PERMISSIONS.join(', ')}.`,
				field: 'permissions',
			})
		}
	}

	// Must contain at least VIEW_EMERGENCY_REQUESTS if assigning VERIFY_EMERGENCY_REQUESTS
	const cleanedPermissions = Array.from(new Set(rawPermissions))

	// Reason check
	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific documented reason of at least 5 characters is required for permission updates.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	if (targetAssoc.associationStatus !== 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot update permissions for association in status '${targetAssoc.associationStatus}'. Association must be 'Active'.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: 'Active',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while updating permissions.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		const previousPermissions = [...assoc.permissions]
		assoc.permissions = cleanedPermissions

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: assoc.hospitalId,
			decisionType: 'ASSOCIATION_PERMISSIONS_UPDATED',
			previousStatus: 'Active',
			newStatus: 'Active',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			grantedPermissions: cleanedPermissions,
			metadata: {
				previousPermissions,
				newPermissions: cleanedPermissions,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-PERM-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_PERMISSIONS_UPDATED',
					hospitalId: assoc.hospitalId,
					recipientKey: `MO-ASSOC-PERM-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Permissions Updated',
					sanitizedBody: `Your clinical verification permissions have been updated: ${cleanedPermissions.join(', ')}. Reason: ${cleanReason}`,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Association permissions updated successfully.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			permissions: updatedAssociation.permissions,
		},
	})
})

/**
 * 6. Admin Association Suspension
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/suspend
 * Transition: Active -> Suspended
 */
exports.adminSuspendAssociation = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific suspension reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	if (targetAssoc.associationStatus === 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already suspended.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	if (targetAssoc.associationStatus !== 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot suspend association in status '${targetAssoc.associationStatus}'. Only 'Active' associations can be suspended.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: 'Active',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while executing suspension.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		assoc.associationStatus = 'Suspended'
		assoc.suspendedAt = new Date()
		assoc.suspendedBy = adminId
		assoc.suspendedByRole = 'ADMIN'
		assoc.suspensionReason = cleanReason

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: assoc.hospitalId,
			decisionType: 'ASSOCIATION_SUSPENDED',
			previousStatus: 'Active',
			newStatus: 'Suspended',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			metadata: {
				suspensionReason: cleanReason,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-SUSP-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_SUSPENDED',
					hospitalId: assoc.hospitalId,
					recipientKey: `MO-ASSOC-SUSP-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Suspended',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association suspended successfully. Clinical operations through this facility are blocked.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			suspendedAt: updatedAssociation.suspendedAt,
			suspensionReason: updatedAssociation.suspensionReason,
		},
	})
})

/**
 * 7. Admin Association Reactivation
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/reactivate
 * Transition: Suspended -> Active (ADMIN only)
 */
exports.adminReactivateAssociation = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific reactivation reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	// 1. Revalidate doctor Gate 1 and Gate 2
	const doctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (doctor.accountStatus !== 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot reactivate association: Medical Officer account status is '${doctor.accountStatus}'. Active account required.`,
			accountStatus: doctor.accountStatus,
		})
	}

	if (doctor.credentialStatus !== 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot reactivate association: Medical Officer credentials must be 'Verified'. Current credential status is '${doctor.credentialStatus}'.`,
			credentialStatus: doctor.credentialStatus,
		})
	}

	// 2. Validate association exists and is Suspended
	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	if (targetAssoc.associationStatus === 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already active.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	if (targetAssoc.associationStatus !== 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot reactivate association in status '${targetAssoc.associationStatus}'. Only 'Suspended' associations can be reactivated.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	// 3. Revalidate hospital exists, is verified and active
	const hospital = await Hospital.findById(targetAssoc.hospitalId)
	if (!hospital || hospital.verificationStatus !== 'Verified' || hospital.isActive !== true) {
		return res.status(409).json({
			status: 'fail',
			message: 'Cannot reactivate association: Associated hospital facility is unverified or inactive.',
		})
	}

	// 4. Temporal validity check
	const now = new Date()
	if (targetAssoc.expiresAt && new Date(targetAssoc.expiresAt) <= now) {
		return res.status(409).json({
			status: 'fail',
			message: 'Cannot reactivate association: Association operational timeframe has expired.',
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: 'Suspended',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while executing reactivation.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		assoc.associationStatus = 'Active'
		assoc.reactivatedAt = new Date()
		assoc.reactivatedBy = adminId
		assoc.reactivationReason = cleanReason

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: hospital._id,
			decisionType: 'ASSOCIATION_REACTIVATED',
			previousStatus: 'Suspended',
			newStatus: 'Active',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			grantedPermissions: assoc.permissions,
			metadata: {
				reactivationReason: cleanReason,
				permissions: assoc.permissions,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-REACT-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_REACTIVATED',
					hospitalId: hospital._id,
					recipientKey: `MO-ASSOC-REACT-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Reactivated',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association reactivated successfully. Association status is now Active.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			reactivatedAt: updatedAssociation.reactivatedAt,
			reactivationReason: updatedAssociation.reactivationReason,
		},
	})
})

/**
 * 8. Admin Association Revocation
 * PATCH /api/admin/medical-officers/:doctorId/associations/:associationId/revoke
 * Transition: Active/Suspended -> Revoked
 */
exports.adminRevokeAssociation = catchAsync(async (req, res, next) => {
	const { doctorId, associationId } = req.params
	const adminId = req.user._id

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific revocation reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found for the specified Medical Officer.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	if (targetAssoc.associationStatus === 'Revoked') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already permanently revoked.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	const isRevocable =
		targetAssoc.associationStatus === 'Active' ||
		targetAssoc.associationStatus === 'Suspended'

	if (!isRevocable) {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot revoke association in status '${targetAssoc.associationStatus}'. Only 'Active' or 'Suspended' associations can be revoked.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			associationStatus: { $in: ['Active', 'Suspended'] },
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while executing revocation.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		const previousStatus = assoc.associationStatus
		assoc.associationStatus = 'Revoked'
		assoc.revokedAt = new Date()
		assoc.revokedBy = adminId
		assoc.revokedByRole = 'ADMIN'
		assoc.revocationReason = cleanReason

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: assoc.hospitalId,
			decisionType: 'ASSOCIATION_REVOKED',
			previousStatus,
			newStatus: 'Revoked',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			metadata: {
				revocationReason: cleanReason,
				previousStatus,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-REV-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_REVOKED',
					hospitalId: assoc.hospitalId,
					recipientKey: `MO-ASSOC-REV-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Revoked',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association permanently revoked.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			revokedAt: updatedAssociation.revokedAt,
			revocationReason: updatedAssociation.revocationReason,
		},
	})
})

// =============================================================================
// HOSPITAL REPRESENTATIVE (HOSPITAL_ADMIN) CONTROLLER METHODS
// =============================================================================

/**
 * 9. Hospital Admin Association Queue (Hospital-Scoped Read-Only)
 * GET /api/hospital/medical-officers/associations
 */
exports.getHospitalAdminAssociationQueue = catchAsync(async (req, res, next) => {
	const hospitalId = req.hospitalId
	const page = Math.max(1, parseInt(req.query.page, 10) || 1)
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
	const skip = (page - 1) * limit

	const query = { hospitalId }

	if (req.query.status || req.query.associationStatus) {
		const rawStatus = String(req.query.status || req.query.associationStatus).trim()
		if (rawStatus.toLowerCase() !== 'all') {
			if (rawStatus.includes(',')) {
				query.associationStatus = {
					$in: rawStatus.split(',').map((s) => s.trim()).filter(Boolean),
				}
			} else {
				query.associationStatus = rawStatus
			}
		}
	}

	const [totalRecords, associations] = await Promise.all([
		MedicalOfficerHospital.countDocuments(query),
		MedicalOfficerHospital.find(query)
			.populate('medicalOfficerUserId', 'firstName lastName name email phoneNo1 accountStatus credentialStatus verificationStatus medicalRegistrationNumber medicalCouncil registrationState registrationYear qualification specialization')
			.sort({ createdAt: -1, _id: 1 })
			.skip(skip)
			.limit(limit)
			.lean(),
	])

	const totalPages = Math.ceil(totalRecords / limit) || 1

	return res.status(200).json({
		status: 'success',
		data: {
			hospitalId,
			totalRecords,
			page,
			limit,
			totalPages,
			associations,
		},
	})
})

/**
 * 10. Hospital Admin Association Details (Hospital-Scoped Read-Only)
 * GET /api/hospital/medical-officers/:doctorId/associations/:associationId
 */
exports.getHospitalAdminAssociationDetails = catchAsync(async (req, res, next) => {
	const hospitalId = req.hospitalId
	const { doctorId, associationId } = req.params

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const association = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
		.populate('medicalOfficerUserId', 'firstName lastName name email phoneNo1 accountStatus credentialStatus verificationStatus medicalRegistrationNumber medicalCouncil registrationState registrationYear qualification specialization')
		.populate('hospitalId', 'hospitalName hospitalCode hospitalType address contactPhone contactEmail verificationStatus isActive')
		.lean()

	if (!association) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found.',
		})
	}

	// Strict Tenant Isolation check
	if (association.hospitalId._id.toString() !== hospitalId.toString()) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Tenant isolation violation. You cannot view associations belonging to another hospital facility.',
		})
	}

	return res.status(200).json({
		status: 'success',
		data: {
			association,
			doctor: association.medicalOfficerUserId,
			hospital: association.hospitalId,
		},
	})
})

/**
 * 11. Hospital Admin Association Suspension
 * PATCH /api/hospital/medical-officers/:doctorId/associations/:associationId/suspend
 * Transition: Active -> Suspended (Hospital-Scoped)
 */
exports.hospitalAdminSuspendAssociation = catchAsync(async (req, res, next) => {
	const hospitalId = req.hospitalId
	const repUser = req.user
	const { doctorId, associationId } = req.params

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific suspension reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	// Strict Tenant Isolation check
	if (targetAssoc.hospitalId.toString() !== hospitalId.toString()) {
		return res.status(403).json({
			status: 'fail',
			message:
				'Access denied: Tenant isolation violation. You cannot suspend associations belonging to another hospital facility.',
		})
	}

	if (targetAssoc.associationStatus === 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already suspended.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	if (targetAssoc.associationStatus !== 'Active') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot suspend association in status '${targetAssoc.associationStatus}'. Only 'Active' associations can be suspended.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			hospitalId: hospitalId,
			associationStatus: 'Active',
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while executing suspension.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		assoc.associationStatus = 'Suspended'
		assoc.suspendedAt = new Date()
		assoc.suspendedBy = repUser._id
		assoc.suspendedByRole = 'HOSPITAL_ADMIN'
		assoc.suspensionReason = cleanReason

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: hospitalId,
			decisionType: 'ASSOCIATION_SUSPENDED',
			previousStatus: 'Active',
			newStatus: 'Suspended',
			actorId: repUser._id,
			actorModel: 'user',
			actorRole: 'HOSPITAL_ADMIN',
			reason: cleanReason,
			metadata: {
				suspensionReason: cleanReason,
				hospitalId: hospitalId.toString(),
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-SUSP-HOSP-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_SUSPENDED',
					hospitalId: hospitalId,
					recipientKey: `MO-ASSOC-SUSP-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Suspended by Facility',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association suspended successfully by hospital facility.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			suspendedAt: updatedAssociation.suspendedAt,
			suspensionReason: updatedAssociation.suspensionReason,
		},
	})
})

/**
 * 12. Hospital Admin Association Revocation
 * PATCH /api/hospital/medical-officers/:doctorId/associations/:associationId/revoke
 * Transition: Active/Suspended -> Revoked (Hospital-Scoped)
 */
exports.hospitalAdminRevokeAssociation = catchAsync(async (req, res, next) => {
	const hospitalId = req.hospitalId
	const repUser = req.user
	const { doctorId, associationId } = req.params

	if (!isValidObjectId(doctorId) || !isValidObjectId(associationId)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid Medical Officer ID or Association ID format.',
		})
	}

	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific revocation reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	const targetAssoc = await MedicalOfficerHospital.findOne({
		_id: associationId,
		medicalOfficerUserId: doctorId,
	})
	if (!targetAssoc) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association record not found.',
		})
	}

	const doctor = await userModel.findById(doctorId)
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer not found.',
		})
	}

	// Strict Tenant Isolation check
	if (targetAssoc.hospitalId.toString() !== hospitalId.toString()) {
		return res.status(403).json({
			status: 'fail',
			message:
				'Access denied: Tenant isolation violation. You cannot revoke associations belonging to another hospital facility.',
		})
	}

	if (targetAssoc.associationStatus === 'Revoked') {
		return res.status(409).json({
			status: 'fail',
			message: 'Hospital association is already permanently revoked.',
			associationStatus: targetAssoc.associationStatus,
		})
	}

	const isRevocable =
		targetAssoc.associationStatus === 'Active' ||
		targetAssoc.associationStatus === 'Suspended'

	if (!isRevocable) {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot revoke association in status '${targetAssoc.associationStatus}'. Only 'Active' or 'Suspended' associations can be revoked.`,
			associationStatus: targetAssoc.associationStatus,
		})
	}

	let updatedAssociation = null

	await withTransaction(async (session) => {
		const assoc = await MedicalOfficerHospital.findOne({
			_id: associationId,
			medicalOfficerUserId: doctorId,
			hospitalId: hospitalId,
			associationStatus: { $in: ['Active', 'Suspended'] },
		}).session(session)

		if (!assoc) {
			const conflictErr = new Error(
				'Concurrent modification conflict: association status changed while executing revocation.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		const previousStatus = assoc.associationStatus
		assoc.associationStatus = 'Revoked'
		assoc.revokedAt = new Date()
		assoc.revokedBy = repUser._id
		assoc.revokedByRole = 'HOSPITAL_ADMIN'
		assoc.revocationReason = cleanReason

		updatedAssociation = await assoc.save({ session })

		await appendAuditRecordTransactional(session, {
			entityType: 'HOSPITAL_ASSOCIATION',
			entityId: assoc._id,
			targetUserId: doctorId,
			hospitalAssociationId: assoc._id,
			hospitalId: hospitalId,
			decisionType: 'ASSOCIATION_REVOKED',
			previousStatus,
			newStatus: 'Revoked',
			actorId: repUser._id,
			actorModel: 'user',
			actorRole: 'HOSPITAL_ADMIN',
			reason: cleanReason,
			metadata: {
				revocationReason: cleanReason,
				hospitalId: hospitalId.toString(),
				previousStatus,
			},
		})

		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-ASSOC-REV-HOSP-${assoc._id}-${Date.now()}`,
					eventType: 'ASSOCIATION_REVOKED',
					hospitalId: hospitalId,
					recipientKey: `MO-ASSOC-REV-${doctorId}`,
					recipientUserId: doctorId,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Hospital Association Revoked by Facility',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Hospital association permanently revoked by facility.',
		data: {
			association: updatedAssociation,
			associationId: updatedAssociation._id,
			associationStatus: updatedAssociation.associationStatus,
			revokedAt: updatedAssociation.revokedAt,
			revocationReason: updatedAssociation.revocationReason,
		},
	})
})

// Aliases for interface flexibility and testing
exports.getAssociationReviewQueue = exports.getAdminAssociationQueue
exports.getAssociationDetails = exports.getAdminAssociationDetails
exports.suspendAssociationByAdmin = exports.adminSuspendAssociation
exports.reactivateAssociation = exports.adminReactivateAssociation
exports.revokeAssociationByAdmin = exports.adminRevokeAssociation

exports.getHospitalAssociations = exports.getHospitalAdminAssociationQueue
exports.getHospitalAssociationDetails = exports.getHospitalAdminAssociationDetails
exports.suspendHospitalAssociationByHospital = exports.hospitalAdminSuspendAssociation
exports.revokeHospitalAssociationByHospital = exports.hospitalAdminRevokeAssociation
