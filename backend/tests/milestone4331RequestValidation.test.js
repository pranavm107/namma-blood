/**
 * Milestone 4.3.3.1: Request Validation, Shortfall Integrity & BOLA Authorization Test Suite
 * Namma Blood — Emergency Blood Connection (Sub-Milestone 4.3.3.1)
 *
 * Verifies:
 * 1. Safe Emergency Request Resolution:
 *    - ObjectId lookup
 *    - requestNumber lookup (case-insensitive)
 *    - Malformed identifier validation & NoSQL injection guards
 *    - Consistent 404 Not Found handling
 * 2. Request Verification Gate:
 *    - Acceptance of 'Verified' requests
 *    - Blocking of 'Pending_Verification', 'Rejected', and 'Flagged_Suspicious'
 * 3. Standardized Expiry Boundary:
 *    - request.expiresAt <= now is strictly expired
 *    - Exact boundary test: expiresAt === now
 * 4. Lifecycle State Validation:
 *    - Active and Partially_Reserved permitted
 *    - Terminal states blocked: Fully_Reserved, In_Transit, Fulfilled, Cancelled, Expired
 * 5. Shortfall Data Integrity:
 *    - Non-negative integer requirements
 *    - unitsReserved === reservedUnitIds.length invariant
 *    - unitsReserved + unitsFulfilled <= unitsRequested invariant
 *    - Fail-closed DATA_INTEGRITY_VIOLATION without silent clamping or substitution
 *    - Accurate shortfall computation: unmetUnits = unitsRequested - (unitsReserved + unitsFulfilled)
 * 6. Strict BOLA / IDOR Authorization:
 *    - Request creator USER permitted
 *    - Third-party USER denied (403)
 *    - System Administrator (ADMIN) permitted
 *    - Deactivated administrator denied (401)
 *    - Assigned BLOODBANK (in matchedBloodbankIds) permitted
 *    - Unassigned BLOODBANK denied (403)
 *    - Active STAFF of assigned facility permitted
 *    - Active STAFF of unassigned facility denied (403)
 *    - Suspended/inactive STAFF denied (401)
 *    - Unknown role denied (403)
 *    - Unauthenticated request denied (401)
 * 7. Read-Only Invariant: Zero database mutations during validation.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const {
	resolveEmergencyRequest,
	validateRequestLifecycle,
	validateShortfallIntegrity,
	authorizeRequestAccess,
	validateAndAuthorizeEmergencyRequest,
} = require('../Emergency/emergencyMatchingService')

const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const User = require('../User/userModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

describe('Milestone 4.3.3.1: Request Validation, Shortfall Integrity & BOLA Authorization', () => {
	let dbConnected = false
	const createdRequestIds = []
	const createdUserIds = []
	const createdBankIds = []
	const createdStaffIds = []
	const createdAdminIds = []

	// Fixture holders
	let creatorUser = null
	let thirdPartyUser = null
	let assignedBank = null
	let unassignedBank = null
	let activeAssignedStaff = null
	let activeUnassignedStaff = null
	let suspendedStaff = null
	let activeAdmin = null
	let deactivatedAdmin = null

	let validVerifiedRequest = null
	let unverifiedRequest = null
	let expiredRequest = null
	let requestNumberStr = ''

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(TEST_DB_URI)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live DB tests.')
		}

		if (dbConnected) {
			await EmergencyBloodRequest.syncIndexes()

			const stamp = Date.now()

			// 1. Seed Users
			creatorUser = await User.create({
				firstName: 'Creator',
				lastName: 'Requester',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				address: '100 Main Street',
				bloodGroup: 'B_Positive',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: 560001,
				phoneNo1: Number(`91${stamp.toString().slice(-8)}`),
				email: `creator_${stamp}@test.com`,
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(creatorUser._id)

			thirdPartyUser = await User.create({
				firstName: 'Third',
				lastName: 'Party',
				gender: 'Female',
				dob: new Date('1992-05-10'),
				age: 32,
				address: '200 Other Street',
				bloodGroup: 'O_Positive',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: 560002,
				phoneNo1: Number(`92${stamp.toString().slice(-8)}`),
				email: `thirdparty_${stamp}@test.com`,
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(thirdPartyUser._id)

			// 2. Seed Blood Banks
			assignedBank = await Bloodbank.create({
				bloodbankName: 'Assigned City Blood Bank',
				category: 'Charitable',
				state: 'Karnataka',
				city: 'Bengaluru',
				address1: '100 Medical Road',
				address2: 'Near Metro',
				pinCode: 560001,
				phoneNo1: `080-77${stamp.toString().slice(-6)}1`,
				phoneNo2: `080-77${stamp.toString().slice(-6)}2`,
				email: `assigned_bank_${stamp}@test.com`,
				contactPerson: 'Dr. Ramesh',
				password: 'Password123!',
				status: true,
			})
			createdBankIds.push(assignedBank._id)

			unassignedBank = await Bloodbank.create({
				bloodbankName: 'Unassigned Distant Blood Bank',
				category: 'Private',
				state: 'Karnataka',
				city: 'Bengaluru',
				address1: '500 Tech Road',
				address2: 'Electronic City',
				pinCode: 560100,
				phoneNo1: `080-88${stamp.toString().slice(-6)}1`,
				phoneNo2: `080-88${stamp.toString().slice(-6)}2`,
				email: `unassigned_bank_${stamp}@test.com`,
				contactPerson: 'Dr. Suresh',
				password: 'Password123!',
				status: true,
			})
			createdBankIds.push(unassignedBank._id)

			// 3. Seed Staff
			activeAssignedStaff = await BloodbankStaff.create({
				fullName: 'Assigned Active Staff',
				email: `assigned_staff_${stamp}@test.com`,
				phoneNo: `98${stamp.toString().slice(-8)}1`,
				bloodbankId: assignedBank._id,
				createdBy: assignedBank._id,
				role: 'Medical_Officer',
				medicalLicense: {
					licenseNumber: 'KMC-998877',
					issuingCouncil: 'Karnataka Medical Council',
				},
				status: 'Active',
				password: 'Password123!',
			})
			createdStaffIds.push(activeAssignedStaff._id)

			activeUnassignedStaff = await BloodbankStaff.create({
				fullName: 'Unassigned Active Staff',
				email: `unassigned_staff_${stamp}@test.com`,
				phoneNo: `98${stamp.toString().slice(-8)}2`,
				bloodbankId: unassignedBank._id,
				createdBy: unassignedBank._id,
				role: 'Lab_Technician',
				status: 'Active',
				password: 'Password123!',
			})
			createdStaffIds.push(activeUnassignedStaff._id)

			suspendedStaff = await BloodbankStaff.create({
				fullName: 'Suspended Staff',
				email: `suspended_staff_${stamp}@test.com`,
				phoneNo: `98${stamp.toString().slice(-8)}3`,
				bloodbankId: assignedBank._id,
				createdBy: assignedBank._id,
				role: 'Lab_Technician',
				status: 'Suspended',
				password: 'Password123!',
			})
			createdStaffIds.push(suspendedStaff._id)

			// 4. Seed Admins
			activeAdmin = await Admin.create({
				email: `active_admin_${stamp}@test.com`,
				phoneNo: String(stamp).slice(-10).padStart(10, '9'),
				password: 'Password123!',
				status: true,
			})
			createdAdminIds.push(activeAdmin._id)

			deactivatedAdmin = await Admin.create({
				email: `deact_admin_${stamp}@test.com`,
				phoneNo: String(stamp + 1).slice(-10).padStart(10, '8'),
				password: 'Password123!',
				status: false,
			})
			createdAdminIds.push(deactivatedAdmin._id)

			// 5. Seed Primary Verified EmergencyBloodRequest
			requestNumberStr = `EMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-A1B2C3`
			validVerifiedRequest = await EmergencyBloodRequest.create({
				requestNumber: requestNumberStr,
				requesterUserId: creatorUser._id,
				patientName: 'John Patient',
				patientAge: 45,
				patientGender: 'Male',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 3,
				unitsReserved: 0,
				unitsFulfilled: 0,
				reservedUnitIds: [],
				matchedBloodbankIds: [assignedBank._id],
				urgencyLevel: 'Critical',
				requiredWithinHours: 4,
				expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4h in future
				hospitalName: 'Victoria Hospital',
				hospitalAddress: 'Fort Road',
				hospitalCity: 'Bengaluru',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560002,
				attendingDoctor: {
					doctorName: 'Dr. Physician',
					doctorPhone: '9876543210',
				},
				verificationStatus: 'Verified',
				status: 'Active',
			})
			createdRequestIds.push(validVerifiedRequest._id)

			// 6. Seed Pending_Verification Request for Anti-Information-Disclosure Testing
			unverifiedRequest = await EmergencyBloodRequest.create({
				requestNumber: `EMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-U1V2W3`,
				requesterUserId: creatorUser._id,
				patientName: 'Jane Unverified',
				patientAge: 28,
				patientGender: 'Female',
				requiredBloodGroup: 'A_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				unitsReserved: 0,
				unitsFulfilled: 0,
				reservedUnitIds: [],
				matchedBloodbankIds: [assignedBank._id],
				urgencyLevel: 'Urgent',
				requiredWithinHours: 6,
				expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
				hospitalName: 'Bowring Hospital',
				hospitalAddress: 'Shivajinagar',
				hospitalCity: 'Bengaluru',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				attendingDoctor: {
					doctorName: 'Dr. Specialist',
					doctorPhone: '9876543211',
				},
				verificationStatus: 'Pending_Verification',
				status: 'Active',
			})
			createdRequestIds.push(unverifiedRequest._id)

			// 7. Seed Expired Request for Anti-Information-Disclosure Testing
			expiredRequest = await EmergencyBloodRequest.create({
				requestNumber: `EMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-X1Y2Z3`,
				requesterUserId: creatorUser._id,
				patientName: 'Bob Expired',
				patientAge: 50,
				patientGender: 'Male',
				requiredBloodGroup: 'O_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				unitsReserved: 0,
				unitsFulfilled: 0,
				reservedUnitIds: [],
				matchedBloodbankIds: [assignedBank._id],
				urgencyLevel: 'Urgent',
				requiredWithinHours: 1,
				expiresAt: new Date(Date.now() - 3600000), // 1 hour in the past
				hospitalName: 'Bowring Hospital',
				hospitalAddress: 'Shivajinagar',
				hospitalCity: 'Bengaluru',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				attendingDoctor: {
					doctorName: 'Dr. Specialist',
					doctorPhone: '9876543211',
				},
				verificationStatus: 'Verified',
				status: 'Expired',
			})
			createdRequestIds.push(expiredRequest._id)
		}
	})

	after(async () => {
		if (dbConnected) {
			try {
				if (createdRequestIds.length > 0) {
					await EmergencyBloodRequest.deleteMany({ _id: { $in: createdRequestIds } })
				}
				if (createdUserIds.length > 0) {
					await User.deleteMany({ _id: { $in: createdUserIds } })
				}
				if (createdBankIds.length > 0) {
					await Bloodbank.deleteMany({ _id: { $in: createdBankIds } })
				}
				if (createdStaffIds.length > 0) {
					await BloodbankStaff.deleteMany({ _id: { $in: createdStaffIds } })
				}
				if (createdAdminIds.length > 0) {
					await Admin.deleteMany({ _id: { $in: createdAdminIds } })
				}
				await mongoose.disconnect()
			} catch (err) {
				console.error('Cleanup error:', err.message)
			}
		}
	})

	describe('1. Emergency Request Resolution', () => {
		it('should resolve an emergency request by valid 24-character hexadecimal ObjectId', async () => {
			if (!dbConnected) return
			const resolved = await resolveEmergencyRequest(validVerifiedRequest._id.toString())
			assert.ok(resolved)
			assert.strictEqual(resolved._id.toString(), validVerifiedRequest._id.toString())
			assert.strictEqual(resolved.requestNumber, requestNumberStr)
		})

		it('should resolve an emergency request by ObjectId instance directly', async () => {
			if (!dbConnected) return
			const resolved = await resolveEmergencyRequest(validVerifiedRequest._id)
			assert.ok(resolved)
			assert.strictEqual(resolved._id.toString(), validVerifiedRequest._id.toString())
		})

		it('should resolve an emergency request by formatted requestNumber (case-insensitive)', async () => {
			if (!dbConnected) return
			const resolved = await resolveEmergencyRequest(requestNumberStr.toLowerCase())
			assert.ok(resolved)
			assert.strictEqual(resolved._id.toString(), validVerifiedRequest._id.toString())
			assert.strictEqual(resolved.requestNumber, requestNumberStr)
		})

		it('should reject invalid identifier format with 400 Bad Request', async () => {
			await assert.rejects(
				async () => resolveEmergencyRequest('invalid_id_format_123'),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
		})

		it('should reject empty or whitespace identifier with 400 Bad Request', async () => {
			await assert.rejects(
				async () => resolveEmergencyRequest('   '),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
		})

		it('should reject null or undefined identifier with 400 Bad Request', async () => {
			await assert.rejects(
				async () => resolveEmergencyRequest(null),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
			await assert.rejects(
				async () => resolveEmergencyRequest(undefined),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
		})

		it('should reject NoSQL operator injection in identifier with 400 Bad Request', async () => {
			await assert.rejects(
				async () => resolveEmergencyRequest('$gt'),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
			await assert.rejects(
				async () => resolveEmergencyRequest('path.to.property'),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
		})

		it('should reject query objects passed as identifier with 400 Bad Request', async () => {
			await assert.rejects(
				async () => resolveEmergencyRequest({ $ne: null }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_IDENTIFIER')
					return true
				}
			)
		})

		it('should return 404 Not Found when a valid 24-hex ObjectId is not in database', async () => {
			if (!dbConnected) return
			const nonExistentHexId = new mongoose.Types.ObjectId().toString()
			await assert.rejects(
				async () => resolveEmergencyRequest(nonExistentHexId),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					return true
				}
			)
		})

		it('should return 404 Not Found when a valid requestNumber syntax is not in database', async () => {
			if (!dbConnected) return
			await assert.rejects(
				async () => resolveEmergencyRequest('EMG-20990101-FFFFFF'),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					return true
				}
			)
		})
	})

	describe('2. Request Verification Gate', () => {
		const baseReq = {
			status: 'Active',
			expiresAt: new Date(Date.now() + 3600000),
		}

		it('should accept request with verificationStatus: Verified', () => {
			const res = validateRequestLifecycle({ ...baseReq, verificationStatus: 'Verified' })
			assert.strictEqual(res.isValid, true)
			assert.strictEqual(res.verificationStatus, 'Verified')
		})

		it('should block request with verificationStatus: Pending_Verification with 400 REQUEST_PENDING_VERIFICATION', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, verificationStatus: 'Pending_Verification' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_PENDING_VERIFICATION')
					assert.match(err.message, /pending medical verification/i)
					return true
				}
			)
		})

		it('should block request with verificationStatus: Rejected with 400 REQUEST_VERIFICATION_REJECTED', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, verificationStatus: 'Rejected' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_VERIFICATION_REJECTED')
					assert.match(err.message, /verification was rejected/i)
					return true
				}
			)
		})

		it('should block request with verificationStatus: Flagged_Suspicious with 400 REQUEST_FLAGGED_SUSPICIOUS', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, verificationStatus: 'Flagged_Suspicious' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_FLAGGED_SUSPICIOUS')
					assert.match(err.message, /flagged as suspicious/i)
					return true
				}
			)
		})

		it('should reject request with unrecognized verificationStatus with 400 REQUEST_VERIFICATION_INVALID', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, verificationStatus: 'Unknown_Status' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_VERIFICATION_INVALID')
					return true
				}
			)
		})
	})

	describe('3. Standardized Expiration Boundary (expiresAt <= now)', () => {
		const baseReq = {
			status: 'Active',
			verificationStatus: 'Verified',
		}

		it('should accept request when expiresAt is strictly in the future (expiresAt > now)', () => {
			const now = new Date('2026-11-02T12:00:00.000Z')
			const futureExpiry = new Date('2026-11-02T12:00:01.000Z')
			const res = validateRequestLifecycle({ ...baseReq, expiresAt: futureExpiry }, { now })
			assert.strictEqual(res.isValid, true)
		})

		it('should reject request when expiresAt is in the past (expiresAt < now) with 400 EMERGENCY_REQUEST_EXPIRED', () => {
			const now = new Date('2026-11-02T12:00:00.000Z')
			const pastExpiry = new Date('2026-11-02T11:59:59.000Z')
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, expiresAt: pastExpiry }, { now }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'EMERGENCY_REQUEST_EXPIRED')
					assert.match(err.message, /validity window has lapsed/i)
					return true
				}
			)
		})

		it('should strictly reject request at the exact boundary where expiresAt === now with 400 EMERGENCY_REQUEST_EXPIRED', () => {
			const exactBoundary = new Date('2026-11-02T12:00:00.000Z')
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, expiresAt: exactBoundary }, { now: exactBoundary }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'EMERGENCY_REQUEST_EXPIRED')
					assert.match(err.message, /validity window has lapsed/i)
					return true
				}
			)
		})

		it('should reject request with missing expiresAt with 400 INVALID_EXPIRY_DATA', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, expiresAt: null }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_EXPIRY_DATA')
					return true
				}
			)
		})

		it('should reject request with invalid date string in expiresAt with 400 INVALID_EXPIRY_DATA', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, expiresAt: 'not-a-date' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_EXPIRY_DATA')
					return true
				}
			)
		})
	})

	describe('4. Lifecycle State Validation', () => {
		const baseReq = {
			verificationStatus: 'Verified',
			expiresAt: new Date(Date.now() + 3600000),
		}

		it('should permit matching on request with status: Active', () => {
			const res = validateRequestLifecycle({ ...baseReq, status: 'Active' })
			assert.strictEqual(res.isValid, true)
			assert.strictEqual(res.status, 'Active')
		})

		it('should permit matching on request with status: Partially_Reserved', () => {
			const res = validateRequestLifecycle({ ...baseReq, status: 'Partially_Reserved' })
			assert.strictEqual(res.isValid, true)
			assert.strictEqual(res.status, 'Partially_Reserved')
		})

		it('should block request with status: Fully_Reserved with 400 REQUEST_FULLY_RESERVED', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'Fully_Reserved' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_FULLY_RESERVED')
					assert.match(err.message, /confirmed reservations/i)
					return true
				}
			)
		})

		it('should block request with status: In_Transit with 400 REQUEST_IN_TRANSIT', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'In_Transit' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_IN_TRANSIT')
					assert.match(err.message, /in transit/i)
					return true
				}
			)
		})

		it('should block request with status: Fulfilled with 400 REQUEST_ALREADY_FULFILLED', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'Fulfilled' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_ALREADY_FULFILLED')
					assert.match(err.message, /already fulfilled/i)
					return true
				}
			)
		})

		it('should block request with status: Cancelled with 400 REQUEST_CANCELLED', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'Cancelled' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'REQUEST_CANCELLED')
					assert.match(err.message, /has been cancelled/i)
					return true
				}
			)
		})

		it('should block request with status: Expired with 400 EMERGENCY_REQUEST_EXPIRED', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'Expired' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'EMERGENCY_REQUEST_EXPIRED')
					return true
				}
			)
		})

		it('should reject request with unrecognized lifecycle status with 400 INVALID_LIFECYCLE_STATUS', () => {
			assert.throws(
				() => validateRequestLifecycle({ ...baseReq, status: 'Non_Existent_State' }),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_LIFECYCLE_STATUS')
					return true
				}
			)
		})
	})

	describe('5. Shortfall Data Integrity & Invariants', () => {
		const dummyId1 = new mongoose.Types.ObjectId()
		const dummyId2 = new mongoose.Types.ObjectId()

		it('should calculate correct unmetUnits for Active request (unitsRequested: 4, reserved: 0, fulfilled: 0 -> unmet: 4)', () => {
			const res = validateShortfallIntegrity({
				unitsRequested: 4,
				unitsReserved: 0,
				unitsFulfilled: 0,
				reservedUnitIds: [],
			})
			assert.strictEqual(res.unitsRequested, 4)
			assert.strictEqual(res.unitsReserved, 0)
			assert.strictEqual(res.unitsFulfilled, 0)
			assert.strictEqual(res.unmetUnits, 4)
		})

		it('should calculate correct unmetUnits for Partially_Reserved request (requested: 4, reserved: 2, fulfilled: 1 -> unmet: 1)', () => {
			const res = validateShortfallIntegrity({
				unitsRequested: 4,
				unitsReserved: 2,
				unitsFulfilled: 1,
				reservedUnitIds: [dummyId1, dummyId2],
			})
			assert.strictEqual(res.unitsRequested, 4)
			assert.strictEqual(res.unitsReserved, 2)
			assert.strictEqual(res.unitsFulfilled, 1)
			assert.strictEqual(res.unmetUnits, 1)
		})

		it('should calculate zero unmetUnits when fully covered (requested: 3, reserved: 2, fulfilled: 1 -> unmet: 0)', () => {
			const res = validateShortfallIntegrity({
				unitsRequested: 3,
				unitsReserved: 2,
				unitsFulfilled: 1,
				reservedUnitIds: [dummyId1, dummyId2],
			})
			assert.strictEqual(res.unmetUnits, 0)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when unitsReserved !== reservedUnitIds.length', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 4,
						unitsReserved: 2, // Contradicts 1 id!
						unitsFulfilled: 0,
						reservedUnitIds: [dummyId1],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					assert.match(err.message, /unitsReserved \(2\) does not match reservedUnitIds count \(1\)/i)
					return true
				}
			)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when reservedUnitIds is empty but unitsReserved > 0', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 3,
						unitsReserved: 1,
						unitsFulfilled: 0,
						reservedUnitIds: [],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when reserved + fulfilled > requested', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 3,
						unitsReserved: 2,
						unitsFulfilled: 2, // 2 + 2 = 4 > 3!
						reservedUnitIds: [dummyId1, dummyId2],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					assert.match(err.message, /exceeds unitsRequested/i)
					return true
				}
			)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when unitsRequested is negative or non-integer', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: -1,
						unitsReserved: 0,
						unitsFulfilled: 0,
						reservedUnitIds: [],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 2.5,
						unitsReserved: 0,
						unitsFulfilled: 0,
						reservedUnitIds: [],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when unitsReserved or unitsFulfilled is negative or non-integer', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 3,
						unitsReserved: -1,
						unitsFulfilled: 0,
						reservedUnitIds: [],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 3,
						unitsReserved: 0,
						unitsFulfilled: -2,
						reservedUnitIds: [],
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when reservedUnitIds is not an array or null', () => {
			assert.throws(
				() =>
					validateShortfallIntegrity({
						unitsRequested: 3,
						unitsReserved: 0,
						unitsFulfilled: 0,
						reservedUnitIds: 'not-an-array',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'DATA_INTEGRITY_VIOLATION')
					return true
				}
			)
		})
	})

	describe('6. Strict BOLA / IDOR Authorization', () => {
		it('should authorize request creator (USER role with matching requesterUserId)', () => {
			const res = authorizeRequestAccess(validVerifiedRequest, {
				user: creatorUser,
				userRole: 'USER',
			})
			assert.strictEqual(res.isAuthorized, true)
			assert.strictEqual(res.authorizedRole, 'USER')
			assert.strictEqual(res.isCreator, true)
		})

		it('should strictly deny third-party USER with 404 REQUEST_NOT_FOUND (anti-enumeration security)', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: thirdPartyUser,
						userRole: 'USER',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.isAuthorizationDenial, true)
					assert.strictEqual(err.message, 'Emergency blood request was not found.')
					return true
				}
			)
		})

		it('should authorize active platform administrator (ADMIN role)', () => {
			const res = authorizeRequestAccess(validVerifiedRequest, {
				user: activeAdmin,
				userRole: 'ADMIN',
			})
			assert.strictEqual(res.isAuthorized, true)
			assert.strictEqual(res.authorizedRole, 'ADMIN')
			assert.strictEqual(res.isAdministrator, true)
		})

		it('should strictly deny deactivated administrator account with 401 ACCOUNT_DEACTIVATED', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: { ...deactivatedAdmin.toObject(), status: false },
						userRole: 'ADMIN',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 401)
					assert.strictEqual(err.code, 'ACCOUNT_DEACTIVATED')
					return true
				}
			)
		})

		it('should authorize assigned Blood Bank (BLOODBANK role present in matchedBloodbankIds)', () => {
			const res = authorizeRequestAccess(validVerifiedRequest, {
				user: assignedBank,
				userRole: 'BLOODBANK',
			})
			assert.strictEqual(res.isAuthorized, true)
			assert.strictEqual(res.authorizedRole, 'BLOODBANK')
			assert.strictEqual(res.bloodbankId, assignedBank._id.toString())
		})

		it('should strictly deny unassigned Blood Bank (BLOODBANK role NOT in matchedBloodbankIds) with 404 REQUEST_NOT_FOUND', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: unassignedBank,
						userRole: 'BLOODBANK',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.isAuthorizationDenial, true)
					return true
				}
			)
		})

		it('should authorize active staff of assigned facility (STAFF role with owning bloodbankId in matchedBloodbankIds)', () => {
			const res = authorizeRequestAccess(validVerifiedRequest, {
				user: activeAssignedStaff,
				staff: activeAssignedStaff,
				userRole: 'STAFF',
			})
			assert.strictEqual(res.isAuthorized, true)
			assert.strictEqual(res.authorizedRole, 'STAFF')
			assert.strictEqual(res.bloodbankId, assignedBank._id.toString())
		})

		it('should strictly deny active staff of unassigned facility with 404 REQUEST_NOT_FOUND', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: activeUnassignedStaff,
						staff: activeUnassignedStaff,
						userRole: 'STAFF',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.isAuthorizationDenial, true)
					return true
				}
			)
		})

		it('should strictly deny suspended staff member with 401 STAFF_INACTIVE', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: suspendedStaff,
						staff: suspendedStaff,
						userRole: 'STAFF',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 401)
					assert.strictEqual(err.code, 'STAFF_INACTIVE')
					return true
				}
			)
		})

		it('should deny unauthenticated request (missing user) with 401 AUTHENTICATION_REQUIRED', () => {
			assert.throws(
				() => authorizeRequestAccess(validVerifiedRequest, null),
				(err) => {
					assert.strictEqual(err.statusCode, 401)
					assert.strictEqual(err.code, 'AUTHENTICATION_REQUIRED')
					return true
				}
			)
			assert.throws(
				() => authorizeRequestAccess(validVerifiedRequest, { user: null }),
				(err) => {
					assert.strictEqual(err.statusCode, 401)
					assert.strictEqual(err.code, 'AUTHENTICATION_REQUIRED')
					return true
				}
			)
		})

		it('should deny unrecognized role with 404 REQUEST_NOT_FOUND', () => {
			assert.throws(
				() =>
					authorizeRequestAccess(validVerifiedRequest, {
						user: creatorUser,
						userRole: 'UNKNOWN_ROLE',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.isAuthorizationDenial, true)
					return true
				}
			)
		})
	})

	describe('7. Composite Pipeline & Read-Only Invariant', () => {
		it('should execute validateAndAuthorizeEmergencyRequest successfully for valid request', async () => {
			if (!dbConnected) return
			const res = await validateAndAuthorizeEmergencyRequest(
				validVerifiedRequest._id.toString(),
				{ user: creatorUser, userRole: 'USER' }
			)
			assert.ok(res)
			assert.ok(res.request)
			assert.strictEqual(res.shortfall.unitsRequested, 3)
			assert.strictEqual(res.shortfall.unmetUnits, 3)
			assert.strictEqual(res.authResult.isAuthorized, true)
			assert.strictEqual(res.lifecycleResult.isValid, true)
			assert.ok(res.compatibility)
			assert.strictEqual(res.compatibility.recipientGroup, 'B_Positive')
			assert.strictEqual(res.compatibility.componentType, 'Packed_Red_Blood_Cells')
			assert.strictEqual(res.compatibility.preferredGroup, 'B_Positive')
			assert.deepStrictEqual(res.compatibility.compatibleGroups, [
				'B_Positive',
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])
		})

		it('should guarantee zero database mutations during validation and authorization', async () => {
			if (!dbConnected) return
			const beforeDoc = await EmergencyBloodRequest.findById(validVerifiedRequest._id).lean()

			await validateAndAuthorizeEmergencyRequest(
				validVerifiedRequest._id.toString(),
				{ user: creatorUser, userRole: 'USER' }
			)

			const afterDoc = await EmergencyBloodRequest.findById(validVerifiedRequest._id).lean()

			// Assert identical state
			assert.strictEqual(beforeDoc.updatedAt.getTime(), afterDoc.updatedAt.getTime())
			assert.strictEqual(beforeDoc.unitsReserved, afterDoc.unitsReserved)
			assert.strictEqual(beforeDoc.unitsFulfilled, afterDoc.unitsFulfilled)
			assert.strictEqual(beforeDoc.status, afterDoc.status)
			assert.strictEqual(beforeDoc.verificationStatus, afterDoc.verificationStatus)
			assert.deepStrictEqual(beforeDoc.matchedBloodbankIds, afterDoc.matchedBloodbankIds)
		})

		it('should strictly deny unauthorized user with 404 REQUEST_NOT_FOUND on Pending_Verification request without leaking verification status', async () => {
			if (!dbConnected) return
			await assert.rejects(
				async () =>
					validateAndAuthorizeEmergencyRequest(
						unverifiedRequest._id.toString(),
						{ user: thirdPartyUser, userRole: 'USER' }
					),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.message, 'Emergency blood request was not found.')
					return true
				}
			)
		})

		it('should strictly deny unauthorized user with 404 REQUEST_NOT_FOUND on Expired request without leaking expiry status', async () => {
			if (!dbConnected) return
			await assert.rejects(
				async () =>
					validateAndAuthorizeEmergencyRequest(
						expiredRequest._id.toString(),
						{ user: thirdPartyUser, userRole: 'USER' }
					),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.message, 'Emergency blood request was not found.')
					return true
				}
			)
		})

		it('should strictly deny unassigned Blood Bank with 404 REQUEST_NOT_FOUND on Expired request without leaking expiry status', async () => {
			if (!dbConnected) return
			await assert.rejects(
				async () =>
					validateAndAuthorizeEmergencyRequest(
						expiredRequest._id.toString(),
						{ user: unassignedBank, userRole: 'BLOODBANK' }
					),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					assert.strictEqual(err.internalCode, 'ACCESS_DENIED')
					assert.strictEqual(err.message, 'Emergency blood request was not found.')
					return true
				}
			)
		})

		it('should strictly deny unauthenticated request with 401 AUTHENTICATION_REQUIRED before disclosing lifecycle state', async () => {
			if (!dbConnected) return
			await assert.rejects(
				async () =>
					validateAndAuthorizeEmergencyRequest(
						unverifiedRequest._id.toString(),
						{ user: null }
					),
				(err) => {
					assert.strictEqual(err.statusCode, 401)
					assert.strictEqual(err.code, 'AUTHENTICATION_REQUIRED')
					return true
				}
			)
		})
	})
})
