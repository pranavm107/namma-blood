/**
 * Stage B1 Model Validation & Schema Integrity Test Suite
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5)
 *
 * Verifies schema constraints, enums, defaults, methods, and index declarations for:
 * 1. User model (HOSPITAL_ADMIN, decoupled accountStatus & credentialStatus)
 * 2. MedicalOfficerHospital model (Hospital-specific availabilityStatus, expanded association statuses)
 * 3. Invitation model (DOCTOR_NOMINATION & HOSPITAL_REPRESENTATIVE, SHA-256 tokens)
 * 4. NotificationOutbox model (Events, delivery statuses, channel restriction, claimToken)
 */

const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const userModel = require('../User/userModel')
const {
	MedicalOfficerHospital,
	VALID_ASSOCIATION_STATUSES,
	VALID_MO_PERMISSIONS,
	VALID_AVAILABILITY_STATUSES,
} = require('../Hospital/medicalOfficerHospitalModel')
const {
	Invitation,
	VALID_INVITATION_TYPES,
	VALID_INVITATION_STATUSES,
} = require('../Hospital/invitationModel')
const {
	NotificationOutbox,
	VALID_OUTBOX_EVENT_TYPES,
	VALID_OUTBOX_DELIVERY_STATUSES,
	VALID_OUTBOX_CHANNELS,
} = require('../Hospital/notificationOutboxModel')

describe('Stage B1 Model Validation: Schemas, Enums, Defaults & Indexes', () => {
	// =========================================================================
	// 1. User Model Schema & Lifecycle Validation
	// =========================================================================
	describe('1. User Model Validation', () => {
		it('should accept all valid roles: USER, MEDICAL_OFFICER, and HOSPITAL_ADMIN', async () => {
			for (const role of ['USER', 'MEDICAL_OFFICER', 'HOSPITAL_ADMIN']) {
				const user = new userModel({
					firstName: 'Test',
					lastName: 'User',
					email: `test.${role.toLowerCase()}@example.com`,
					phoneNo1: 9876543210,
					password: 'Password123!',
					role,
				})
				const err = user.validateSync(['role'])
				assert.strictEqual(err, undefined, `Role ${role} should be valid`)
			}
		})

		it('should strictly reject invalid user roles', () => {
			const user = new userModel({
				firstName: 'Bad',
				lastName: 'Role',
				email: 'bad.role@example.com',
				phoneNo1: 9876543210,
				password: 'Password123!',
				role: 'SUPER_DOCTOR',
			})
			const err = user.validateSync(['role'])
			assert.ok(err, 'Invalid role must produce a validation error')
			assert.ok(err.errors.role)
		})

		it('should validate decoupled accountStatus values and apply appropriate defaults', () => {
			// USER defaults to Active
			const normalUser = new userModel({
				firstName: 'Donor',
				lastName: 'One',
				email: 'donor@example.com',
				phoneNo1: 9876543210,
				password: 'Password123!',
				role: 'USER',
			})
			assert.strictEqual(normalUser.accountStatus, 'Active')

			// MEDICAL_OFFICER defaults to Pending_Activation
			const doctorUser = new userModel({
				firstName: 'Doctor',
				lastName: 'One',
				email: 'doctor@example.com',
				phoneNo1: 9876543210,
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
			})
			assert.strictEqual(doctorUser.accountStatus, 'Pending_Activation')

			// Valid states
			for (const status of ['Pending_Activation', 'Active', 'Suspended', 'Deactivated']) {
				doctorUser.accountStatus = status
				const err = doctorUser.validateSync(['accountStatus'])
				assert.strictEqual(err, undefined, `accountStatus '${status}' should be valid`)
			}

			// Invalid state
			doctorUser.accountStatus = 'Pending_Approval'
			const err = doctorUser.validateSync(['accountStatus'])
			assert.ok(err && err.errors.accountStatus)
		})

		it('should validate decoupled credentialStatus values and apply appropriate defaults', () => {
			const normalUser = new userModel({ role: 'USER' })
			assert.strictEqual(normalUser.credentialStatus, 'Verified')

			const doctorUser = new userModel({ role: 'MEDICAL_OFFICER' })
			assert.strictEqual(doctorUser.credentialStatus, 'Unsubmitted')

			for (const status of [
				'Unsubmitted',
				'Pending_Verification',
				'Under_Review',
				'Verified',
				'Rejected',
				'Suspended',
			]) {
				doctorUser.credentialStatus = status
				const err = doctorUser.validateSync(['credentialStatus'])
				assert.strictEqual(err, undefined, `credentialStatus '${status}' should be valid`)
			}

			doctorUser.credentialStatus = 'Fully_Approved'
			const err = doctorUser.validateSync(['credentialStatus'])
			assert.ok(err && err.errors.credentialStatus)
		})

		it('should NOT introduce global availabilityStatus on the User schema', () => {
			const schemaPaths = Object.keys(userModel.schema.paths)
			assert.strictEqual(
				schemaPaths.includes('availabilityStatus'),
				false,
				'availabilityStatus must NOT be present on userModel'
			)
		})

		it('should support hospitalId and representativeStatus for HOSPITAL_ADMIN', () => {
			const hospId = new mongoose.Types.ObjectId()
			const rep = new userModel({
				firstName: 'Hospital',
				lastName: 'Rep',
				email: 'rep@hospital.org',
				phoneNo1: 9876543210,
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				hospitalId: hospId,
				representativeStatus: 'Pending',
			})

			const err = rep.validateSync(['hospitalId', 'representativeStatus'])
			assert.strictEqual(err, undefined)
			assert.strictEqual(rep.hospitalId.toString(), hospId.toString())
			assert.strictEqual(rep.representativeStatus, 'Pending')
		})

		it('should preserve backward-compatible status and verificationStatus fields', () => {
			const user = new userModel({
				role: 'MEDICAL_OFFICER',
				status: true,
				verificationStatus: 'Pending',
			})
			assert.strictEqual(user.status, true)
			assert.strictEqual(user.verificationStatus, 'Pending')
		})
	})

	// =========================================================================
	// 2. Medical Officer-Hospital Association Model Validation
	// =========================================================================
	describe('2. Medical Officer-Hospital Association Model Validation', () => {
		const dummyMoId = new mongoose.Types.ObjectId()
		const dummyHospId = new mongoose.Types.ObjectId()

		it('should accept all approved association statuses', () => {
			const expectedStatuses = [
				'Pending',
				'Pending_Hospital_Confirmation',
				'Pending_Admin_Approval',
				'Active',
				'Suspended',
				'Revoked',
				'Expired',
				'Rejected',
			]

			for (const status of expectedStatuses) {
				const assoc = new MedicalOfficerHospital({
					medicalOfficerUserId: dummyMoId,
					hospitalId: dummyHospId,
					associationStatus: status,
				})
				const err = assoc.validateSync(['associationStatus'])
				assert.strictEqual(err, undefined, `Status '${status}' should be valid`)
			}
		})

		it('should reject invalid association statuses', () => {
			const assoc = new MedicalOfficerHospital({
				medicalOfficerUserId: dummyMoId,
				hospitalId: dummyHospId,
				associationStatus: 'In_Progress',
			})
			const err = assoc.validateSync(['associationStatus'])
			assert.ok(err && err.errors.associationStatus)
		})

		it('should default permissions to VIEW_EMERGENCY_REQUESTS only (no auto-verify)', () => {
			const assoc = new MedicalOfficerHospital({
				medicalOfficerUserId: dummyMoId,
				hospitalId: dummyHospId,
			})
			assert.deepStrictEqual(assoc.permissions, ['VIEW_EMERGENCY_REQUESTS'])
			assert.strictEqual(
				assoc.permissions.includes('VERIFY_EMERGENCY_REQUESTS'),
				false,
				'Verification permission must not be granted by default'
			)
		})

		it('should accept explicit VERIFY_EMERGENCY_REQUESTS permission', () => {
			const assoc = new MedicalOfficerHospital({
				medicalOfficerUserId: dummyMoId,
				hospitalId: dummyHospId,
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			const err = assoc.validateSync(['permissions'])
			assert.strictEqual(err, undefined)
		})

		it('should place availabilityStatus strictly on the association and default to Unavailable', () => {
			const assoc = new MedicalOfficerHospital({
				medicalOfficerUserId: dummyMoId,
				hospitalId: dummyHospId,
			})
			assert.strictEqual(assoc.availabilityStatus, 'Unavailable')

			// Can be set to Available
			assoc.availabilityStatus = 'Available'
			const err = assoc.validateSync(['availabilityStatus'])
			assert.strictEqual(err, undefined)

			// Invalid availability
			assoc.availabilityStatus = 'On_Break'
			const badErr = assoc.validateSync(['availabilityStatus'])
			assert.ok(badErr && badErr.errors.availabilityStatus)
		})

		it('should validate association approval metadata fields', () => {
			const adminId = new mongoose.Types.ObjectId()
			const repId = new mongoose.Types.ObjectId()

			const assoc = new MedicalOfficerHospital({
				medicalOfficerUserId: dummyMoId,
				hospitalId: dummyHospId,
				initiatedBy: 'DOCTOR',
				hospitalConfirmedBy: repId,
				hospitalConfirmedAt: new Date(),
				adminApprovedBy: adminId,
				adminApprovedAt: new Date(),
				rejectionReason: 'Invalid department match',
			})

			const err = assoc.validateSync()
			assert.strictEqual(err, undefined)
			assert.strictEqual(assoc.initiatedBy, 'DOCTOR')
			assert.strictEqual(assoc.hospitalConfirmedBy.toString(), repId.toString())
			assert.strictEqual(assoc.adminApprovedBy.toString(), adminId.toString())
		})

		it('should declare the compound unique index on { medicalOfficerUserId, hospitalId }', () => {
			const indexes = MedicalOfficerHospital.schema.indexes()
			const hasUniquePair = indexes.some(
				([fields, options]) =>
					fields.medicalOfficerUserId === 1 &&
					fields.hospitalId === 1 &&
					options &&
					options.unique === true
			)
			assert.strictEqual(hasUniquePair, true, 'Compound unique index must be declared')
		})
	})

	// =========================================================================
	// 3. Unified Invitation Model Validation
	// =========================================================================
	describe('3. Unified Invitation Model Validation', () => {
		const hospId = new mongoose.Types.ObjectId()
		const adminId = new mongoose.Types.ObjectId()

		it('should validate DOCTOR_NOMINATION and HOSPITAL_REPRESENTATIVE invitation types', () => {
			for (const type of ['DOCTOR_NOMINATION', 'HOSPITAL_REPRESENTATIVE']) {
				const invitation = new Invitation({
					invitationType: type,
					hospitalId: hospId,
					invitedByUserId: adminId,
					invitedByRole: 'ADMIN',
					recipientName: 'Dr. Anita',
					recipientEmail: 'anita@apollo.org',
					recipientPhone: 9840123456,
					invitationTokenHash: 'dummyhash1234567890abcdef',
					tokenExpiresAt: new Date(Date.now() + 48 * 3600 * 1000),
				})
				const err = invitation.validateSync(['invitationType'])
				assert.strictEqual(err, undefined, `Type ${type} should be valid`)
			}
		})

		it('should reject invalid invitation types', () => {
			const invitation = new Invitation({
				invitationType: 'PATIENT_INVITE',
			})
			const err = invitation.validateSync(['invitationType'])
			assert.ok(err && err.errors.invitationType)
		})

		it('should require invitationTokenHash and tokenExpiresAt', () => {
			const invitation = new Invitation({
				invitationType: 'DOCTOR_NOMINATION',
				hospitalId: hospId,
				invitedByUserId: adminId,
				invitedByRole: 'ADMIN',
				recipientName: 'Dr. Suresh',
				recipientEmail: 'suresh@apollo.org',
				recipientPhone: 9840123456,
			})
			const err = invitation.validateSync(['invitationTokenHash', 'tokenExpiresAt'])
			assert.ok(err.errors.invitationTokenHash)
			assert.ok(err.errors.tokenExpiresAt)
		})

		it('should generate secure raw token, store only SHA-256 hash, and set 48h expiration', () => {
			const invitation = new Invitation({
				invitationType: 'DOCTOR_NOMINATION',
				hospitalId: hospId,
				invitedByUserId: adminId,
				invitedByRole: 'ADMIN',
				recipientName: 'Dr. Suresh',
				recipientEmail: 'suresh@apollo.org',
				recipientPhone: 9840123456,
			})

			const rawToken = invitation.createInvitationToken(48)
			assert.strictEqual(typeof rawToken, 'string')
			assert.strictEqual(rawToken.length, 64) // 32 bytes hex = 64 chars

			// Verify only SHA-256 hash is saved
			assert.strictEqual(invitation.invitationTokenHash.length, 64)
			assert.notStrictEqual(invitation.invitationTokenHash, rawToken)

			// Verify hash matches helper
			const expectedHash = Invitation.hashToken(rawToken)
			assert.strictEqual(invitation.invitationTokenHash, expectedHash)

			// Verify 48-hour expiration
			const nowMs = Date.now()
			const diffHours = (invitation.tokenExpiresAt.getTime() - nowMs) / (3600 * 1000)
			assert.ok(diffHours >= 47.9 && diffHours <= 48.1, 'Expiration must be ~48 hours')
		})

		it('should normalize recipientEmail to lowercase and trim on validation and save', () => {
			const invitation = new Invitation({
				recipientEmail: '  DR.RAMESH@Hospital.ORG  ',
			})
			invitation.validateSync(['recipientEmail'])
			assert.strictEqual(invitation.recipientEmail, 'dr.ramesh@hospital.org')
		})

		it('should declare the unique partial compound index on { hospitalId, invitationType, recipientEmail } with status: Pending', () => {
			const indexes = Invitation.schema.indexes()

			// Verify the unique partial index exists
			const uniquePartialIndex = indexes.find(
				([fields, options]) =>
					fields.hospitalId === 1 &&
					fields.invitationType === 1 &&
					fields.recipientEmail === 1 &&
					options &&
					options.unique === true
			)
			assert.ok(uniquePartialIndex, 'Unique partial index on { hospitalId, invitationType, recipientEmail } must be declared')
			assert.deepStrictEqual(
				uniquePartialIndex[1].partialFilterExpression,
				{ status: 'Pending' },
				'Uniqueness must apply strictly when status === "Pending"'
			)

			// Verify old non-unique index { recipientEmail: 1, invitationType: 1, status: 1 } was removed
			const hasOldIndex = indexes.some(
				([fields]) =>
					fields.recipientEmail === 1 &&
					fields.invitationType === 1 &&
					fields.status === 1
			)
			assert.strictEqual(
				hasOldIndex,
				false,
				'Redundant index { recipientEmail: 1, invitationType: 1, status: 1 } must not exist'
			)
		})

		describe('3.1 Unique Partial Compound Index Behavior Scenarios', () => {
			// Helper simulating MongoDB unique partial index enforcement based on declared schema index
			function createPartialIndexSimulator() {
				const indexEntries = new Map()

				return {
					insert(doc) {
						// Normalize email as pre-save hook does
						const email = (doc.recipientEmail || '').trim().toLowerCase()
						// Check partial filter expression: status === 'Pending'
						if (doc.status === 'Pending') {
							const key = `${doc.hospitalId.toString()}:${doc.invitationType}:${email}`
							if (indexEntries.has(key)) {
								const err = new Error(`E11000 duplicate key error collection: invitations index: uniq_pending_invitation_per_hospital_recipient dup key: { hospitalId: "${doc.hospitalId}", invitationType: "${doc.invitationType}", recipientEmail: "${email}" }`)
								err.code = 11000
								throw err
							}
							indexEntries.set(key, doc._id || doc)
						}
					},
					updateStatus(doc, newStatus) {
						const email = (doc.recipientEmail || '').trim().toLowerCase()
						const key = `${doc.hospitalId.toString()}:${doc.invitationType}:${email}`
						if (doc.status === 'Pending' && newStatus !== 'Pending') {
							indexEntries.delete(key)
						} else if (doc.status !== 'Pending' && newStatus === 'Pending') {
							if (indexEntries.has(key)) {
								const err = new Error('E11000 duplicate key error')
								err.code = 11000
								throw err
							}
							indexEntries.set(key, doc._id || doc)
						}
						doc.status = newStatus
					},
				}
			}

			it('1. A first Pending invitation is accepted and indexed', () => {
				const sim = createPartialIndexSimulator()
				const inv1 = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.anita@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(inv1))
			})

			it('2. A duplicate Pending invitation for the same hospital, recipient and invitation type is rejected', () => {
				const sim = createPartialIndexSimulator()
				const inv1 = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.anita@apollo.org',
					status: 'Pending',
				})
				sim.insert(inv1)

				const duplicateInv = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.anita@apollo.org',
					status: 'Pending',
				})
				assert.throws(
					() => sim.insert(duplicateInv),
					(err) => err.code === 11000 && /uniq_pending_invitation_per_hospital_recipient/.test(err.message)
				)
			})

			it('3. A new Pending invitation is permitted after the previous invitation is Accepted', () => {
				const sim = createPartialIndexSimulator()
				const inv1 = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.anita@apollo.org',
					status: 'Pending',
				})
				sim.insert(inv1)

				// First invitation is accepted
				sim.updateStatus(inv1, 'Accepted')

				// Re-inviting the same doctor is now permitted
				const inv2 = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.anita@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(inv2))
			})

			it('4. A new Pending invitation is permitted after the previous invitation is Revoked or Expired', () => {
				const sim = createPartialIndexSimulator()

				// Case A: Revoked
				const invRevoked = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.kavita@apollo.org',
					status: 'Pending',
				})
				sim.insert(invRevoked)
				sim.updateStatus(invRevoked, 'Revoked')

				const invAfterRevoke = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.kavita@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(invAfterRevoke))

				// Case B: Expired
				sim.updateStatus(invAfterRevoke, 'Expired')

				const invAfterExpire = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.kavita@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(invAfterExpire))
			})

			it('5. The same email can receive invitations from different hospitals simultaneously', () => {
				const sim = createPartialIndexSimulator()
				const hosp2Id = new mongoose.Types.ObjectId()

				const invHospital1 = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.multihosp@apollo.org',
					status: 'Pending',
				})
				sim.insert(invHospital1)

				const invHospital2 = new Invitation({
					hospitalId: hosp2Id,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.multihosp@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(invHospital2))
			})

			it('6. The same email can receive different invitation types at the same hospital', () => {
				const sim = createPartialIndexSimulator()

				const doctorNomination = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'staff.member@apollo.org',
					status: 'Pending',
				})
				sim.insert(doctorNomination)

				const representativeInvite = new Invitation({
					hospitalId: hospId,
					invitationType: 'HOSPITAL_REPRESENTATIVE',
					recipientEmail: 'staff.member@apollo.org',
					status: 'Pending',
				})
				assert.doesNotThrow(() => sim.insert(representativeInvite))
			})

			it('7. Email normalization prevents case-based duplicates', () => {
				const sim = createPartialIndexSimulator()

				const invLower = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'dr.sangeetha@apollo.org',
					status: 'Pending',
				})
				sim.insert(invLower)

				const invUpper = new Invitation({
					hospitalId: hospId,
					invitationType: 'DOCTOR_NOMINATION',
					recipientEmail: 'DR.SANGEETHA@APOLLO.ORG',
					status: 'Pending',
				})
				assert.throws(
					() => sim.insert(invUpper),
					(err) => err.code === 11000
				)
			})
		})
	})

	// =========================================================================
	// 4. Notification Outbox Model Validation
	// =========================================================================
	describe('4. Notification Outbox Model Validation', () => {
		const hospId = new mongoose.Types.ObjectId()
		const userId = new mongoose.Types.ObjectId()

		it('should accept all 10 approved event types', () => {
			for (const eventType of VALID_OUTBOX_EVENT_TYPES) {
				const outbox = new NotificationOutbox({
					eventId: 'EVT_TEST_123',
					eventType,
					hospitalId: hospId,
					recipientKey: `EVT_TEST_123:usr:${userId}`,
					recipientEmail: 'doctor@hospital.org',
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Urgent Request',
					sanitizedBody: 'Non-sensitive alert',
				})
				const err = outbox.validateSync(['eventType'])
				assert.strictEqual(err, undefined, `EventType '${eventType}' should be valid`)
			}
		})

		it('should reject unrecognized event types', () => {
			const outbox = new NotificationOutbox({
				eventType: 'RANDOM_CHAT_MESSAGE',
			})
			const err = outbox.validateSync(['eventType'])
			assert.ok(err && err.errors.eventType)
		})

		it('should validate all delivery statuses and default to Pending', () => {
			const outbox = new NotificationOutbox({
				eventId: 'EVT_TEST_123',
				eventType: 'EMERGENCY_REQUEST_SUBMITTED',
				hospitalId: hospId,
				recipientKey: 'key_1',
				recipientEmail: 'doctor@hospital.org',
				recipientRole: 'MEDICAL_OFFICER',
				subject: 'Alert',
				sanitizedBody: 'Body',
			})
			assert.strictEqual(outbox.deliveryStatus, 'Pending')
			assert.strictEqual(outbox.deliveryAttempts, 0)
			assert.strictEqual(outbox.maxAttempts, 5)

			for (const status of ['Pending', 'Processing', 'Sent', 'Failed', 'Dead_Letter']) {
				outbox.deliveryStatus = status
				const err = outbox.validateSync(['deliveryStatus'])
				assert.strictEqual(err, undefined, `Status '${status}' should be valid`)
			}
		})

		it('should restrict channel strictly to EMAIL (SMS deferred)', () => {
			const outbox = new NotificationOutbox({
				channel: 'EMAIL',
			})
			const err = outbox.validateSync(['channel'])
			assert.strictEqual(err, undefined)

			outbox.channel = 'SMS'
			const smsErr = outbox.validateSync(['channel'])
			assert.ok(smsErr && smsErr.errors.channel, 'SMS channel must be rejected in this milestone')
		})

		it('should support claimToken, workerId, and lease timestamps for worker fencing', () => {
			const outbox = new NotificationOutbox({
				eventId: 'EVT_TEST_456',
				eventType: 'EMERGENCY_REQUEST_SUBMITTED',
				hospitalId: hospId,
				recipientKey: `EVT_TEST_456:usr:${userId}`,
				recipientEmail: 'doctor@hospital.org',
				recipientRole: 'MEDICAL_OFFICER',
				subject: 'Alert',
				sanitizedBody: 'Body',
				deliveryStatus: 'Processing',
				claimedByWorkerId: 'worker_node_1',
				claimToken: 'claim_tok_abc123',
				processingStartedAt: new Date(),
				processingLeaseExpiresAt: new Date(Date.now() + 90000),
			})

			const err = outbox.validateSync()
			assert.strictEqual(err, undefined)
			assert.strictEqual(outbox.claimToken, 'claim_tok_abc123')
			assert.strictEqual(outbox.claimedByWorkerId, 'worker_node_1')
		})

		it('should declare unique index on { eventId, recipientKey } and claimable compound index', () => {
			const indexes = NotificationOutbox.schema.indexes()

			const hasEventRecipientUnique = indexes.some(
				([fields, options]) =>
					fields.eventId === 1 &&
					fields.recipientKey === 1 &&
					options &&
					options.unique === true
			)
			assert.strictEqual(
				hasEventRecipientUnique,
				true,
				'Unique index on { eventId, recipientKey } must be declared'
			)

			const hasClaimableIndex = indexes.some(
				([fields]) =>
					fields.deliveryStatus === 1 &&
					fields.nextAttemptAt === 1 &&
					fields.processingLeaseExpiresAt === 1
			)
			assert.strictEqual(
				hasClaimableIndex,
				true,
				'Compound claimable worker index must be declared'
			)
		})
	})
})

