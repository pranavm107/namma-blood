const express = require('express')
const { loginMiddleware, login } = require('../Login_And_Authentication/login')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	resetPassword,
	forgotPassword,
} = require('../Login_And_Authentication/forgotPassword')
const { verifyStaffLicense } = require('./adminController')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const {
	issueHospitalRepresentativeInvitation,
} = require('../Hospital/hospitalInvitationController')
const adminCredentialReviewController = require('../Hospital/adminCredentialReviewController')
const hospitalAssociationApprovalController = require('../Hospital/hospitalAssociationApprovalController')
const auditComplianceController = require('../Hospital/auditComplianceController')

const router = express.Router()

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

router.use(selectAdminModel)

router.route('/login').post(loginMiddleware, login)

router.route('/forgotpassword').post(forgotPassword)

router.route('/resetpassword/:token').patch(resetPassword)

// Global Administrator Medical Officer License Verification
router.route('/staff/:staffId/verify-license').patch(protect, verifyStaffLicense)

// Platform Administrator Hospital Representative Invitation Issuance
router
	.route('/hospital-invitations')
	.post(protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation)

// Stage B3.4.3: Administrative Medical Officer Credential Review Endpoints
// 1. Credential Review Queue (read-only)
router
	.route(['/medical-officers/credentials', '/medical-officer/credentials'])
	.get(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.getCredentialReviewQueue)

// 2. Individual Credential Dossier Details (read-only)
router
	.route(['/medical-officers/:id/credentials', '/medical-officer/:id/credentials'])
	.get(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.getDoctorCredentialDetails)

// 3. Start Credential Review (Pending_Verification -> Under_Review)
router
	.route(['/medical-officers/:id/credentials/review-start', '/medical-officer/:id/credentials/review-start'])
	.patch(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.startCredentialReview)

// 4. Request Additional Info / Clarification (Under_Review -> Pending_Verification)
router
	.route(['/medical-officers/:id/credentials/request-info', '/medical-officer/:id/credentials/request-info'])
	.patch(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.requestAdditionalInfo)

// 5. Approve Credentials (Under_Review -> Verified)
router
	.route(['/medical-officers/:id/credentials/approve', '/medical-officer/:id/credentials/approve'])
	.patch(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.approveCredentials)

// 6. Reject Credentials (Under_Review -> Rejected)
router
	.route(['/medical-officers/:id/credentials/reject', '/medical-officer/:id/credentials/reject'])
	.patch(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.rejectCredentials)

// 7. Suspend Credentials (Verified -> Suspended)
router
	.route(['/medical-officers/:id/credentials/suspend', '/medical-officer/:id/credentials/suspend'])
	.patch(protectEmergencyAuth, requireAdmin, adminCredentialReviewController.suspendCredentials)

// Stage B3.4.4: Administrative Hospital Association Review & Approval Endpoints
// 1. Association Review Queue (read-only)
router
	.route(['/medical-officers/associations', '/medical-officer/associations'])
	.get(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.getAdminAssociationQueue)

// 2. Individual Association Details (read-only)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId',
		'/medical-officer/:doctorId/associations/:associationId',
	])
	.get(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.getAdminAssociationDetails)

// 3. Approve Association (Pending_Admin_Approval -> Active)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/approve',
		'/medical-officer/:doctorId/associations/:associationId/approve',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.approveAssociation)

// 4. Reject Association (Pending_Admin_Approval -> Rejected)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/reject',
		'/medical-officer/:doctorId/associations/:associationId/reject',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.rejectAssociation)

// 5. Update Association Permissions
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/permissions',
		'/medical-officer/:doctorId/associations/:associationId/permissions',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.updateAssociationPermissions)

// 6. Suspend Association (Active -> Suspended)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/suspend',
		'/medical-officer/:doctorId/associations/:associationId/suspend',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.adminSuspendAssociation)

// 7. Reactivate Association (Suspended -> Active)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/reactivate',
		'/medical-officer/:doctorId/associations/:associationId/reactivate',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.adminReactivateAssociation)

// 8. Revoke Association (Active/Suspended -> Revoked)
router
	.route([
		'/medical-officers/:doctorId/associations/:associationId/revoke',
		'/medical-officer/:doctorId/associations/:associationId/revoke',
	])
	.patch(protectEmergencyAuth, requireAdmin, hospitalAssociationApprovalController.adminRevokeAssociation)

// Stage B3.5.4: Independent Audit Compliance Verification (read-only)
router
	.route('/audit-ledger/compliance-verification')
	.get(protectEmergencyAuth, requireAdmin, auditComplianceController.getComplianceVerification)

module.exports = router
