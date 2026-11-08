/**
 * Invitation Routes
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Stage B3.1)
 */

const express = require('express')
const router = express.Router()

const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const {
	issueHospitalRepresentativeInvitation,
	acceptHospitalRepresentativeInvitation,
	nominateDoctorInvitation,
	acceptDoctorNominationInvitation,
} = require('./hospitalInvitationController')

// Admin authorization guard
const requireAdmin = (req, res, next) => {
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}
	next()
}

// 1. Hospital Representative Invitation Acceptance (Public bearer token submission)
// POST /api/invitations/accept-hospital-representative
router.post(
	'/accept-hospital-representative',
	acceptHospitalRepresentativeInvitation
)

// 2. Hospital Representative Invitation Issuance (Admin protected)
// POST /api/invitations/hospital-representative (route alias for /api/admin/hospital-invitations)
router.post(
	'/hospital-representative',
	protectEmergencyAuth,
	requireAdmin,
	issueHospitalRepresentativeInvitation
)

// 3. Doctor Nomination Invitation Acceptance (Public bearer token submission)
// POST /api/invitations/accept-doctor-nomination
router.post(
	'/accept-doctor-nomination',
	acceptDoctorNominationInvitation
)

module.exports = router

