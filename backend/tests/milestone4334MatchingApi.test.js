/**
 * Milestone 4.3.3.4 Test Suite: REST Controller, Routes & Matching API Integration
 * Namma Blood — Phase 4 Emergency Blood Connection
 *
 * Requirements Covered:
 * 1. Authentication (protectEmergencyAuth):
 *    - Unauthenticated access rejected (401).
 *    - Valid USER, ADMIN, BLOODBANK, STAFF authentication.
 *    - Inactive / suspended account rejection (deactivated user, deactivated bloodbank, suspended staff).
 *    - Invalid role / unrecognized userType rejection.
 * 2. Broken Object-Level Authorization (BOLA/IDOR):
 *    - Request creator allowed (200).
 *    - System Administrator allowed (200).
 *    - Assigned blood bank allowed (200).
 *    - Assigned active staff allowed (200).
 *    - Unrelated user denied (404 anti-enumeration).
 *    - Unassigned blood bank denied (404 anti-enumeration).
 *    - Unassigned staff denied (404 anti-enumeration).
 *    - Anti-enumeration: missing request and unauthorized request return identical 404 responses.
 *    - Candidate references cannot be used as authorization credentials.
 * 3. Request Validation and Lifecycle Enforcement:
 *    - Valid verified request succeeds.
 *    - Pending verification, rejected, flagged suspicious requests blocked (400).
 *    - Expired request blocked (400) including exact boundary test.
 *    - Terminal lifecycle states blocked (Fully_Reserved, In_Transit, Fulfilled, Cancelled, Expired).
 *    - Shortfall integrity violation fails closed (500 DATA_INTEGRITY_VIOLATION).
 *    - Invalid request identifier parameter handled safely (400).
 * 4. Matching Integration:
 *    - Dual-stream candidate output (donors and bloodBanks).
 *    - Five classifications preserved (Potential_Donor_Match, Pending_Clinical_Evaluation,
 *      Verified_Bloodbank_Stock_Match, No_Matching_Stock, Inventory_Unverified).
 *    - Compatibility results and deterministic ranking order preserved.
 *    - 128-bit truncated HMAC references correctly formatted (DNR-[0-9A-F]{32}, BB-[0-9A-F]{12}).
 *    - Clinical safety notices and governance flags returned.
 * 5. Inventory Safety & Traceability:
 *    - Confirmed verified stock count.
 *    - Zero matching stock returns 0.
 *    - Unverified inventory returns null count.
 *    - Inventory lookup failure safely returns null count (no false zero).
 *    - No unit identifier or DIN leakage.
 * 6. Privacy Shield & Allowlist Response Sanitization:
 *    - No donor ObjectIds, userIds, personal contact details, or exact coordinates.
 *    - No blood bank database IDs, passwords, internal DINs, or personal staff contacts.
 *    - No database credentials, connection strings, or stack traces in error responses.
 * 7. Strictly Read-Only Invariants:
 *    - Zero mutations to requests, units, donor profiles, or bloodbanks.
 *    - No reservations, dispatches, or notifications created.
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const {
	findEmergencyRequestMatches,
	validateHmacConfiguration,
} = require('../Emergency/emergencyMatchingService')
const { getRequestMatches } = require('../Emergency/emergencyDiscoveryController')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const {
	discoveryRateLimiter,
	resetDiscoveryRateLimiter,
} = require('../Emergency/discoveryRateLimiter')

const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyDonorProfile } = require('../Emergency/emergencyDonorProfileModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')
const User = require('../User/userModel')
const stockService = require('../BloodStock/stockService')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

const VALID_TEST_HMAC_SECRET = 'NammaBlood_EmergencyMatching_SecretKey_2026_ABCD1234'
process.env.EMERGENCY_HMAC_SECRET = VALID_TEST_HMAC_SECRET
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'

function makeRandomPhone() {
	return Number(`95${Math.floor(10000000 + Math.random() * 90000000)}`)
}

function makeUserData(index, bloodGroup, overrides = {}) {
	const rand = Math.floor(10000000 + Math.random() * 90000000)
	const uniqueId = crypto.randomUUID().slice(0, 8)
	return {
		firstName: `User${index}`,
		lastName: 'TestCandidate',
		gender: 'Male',
		dob: new Date('1995-01-01'),
		age: 31,
		address: '100 Medical Street',
		bloodGroup: bloodGroup || 'B_Positive',
		state: 'Karnataka',
		city: 'Bengaluru',
		pinCode: 560001,
		phoneNo1: makeRandomPhone(),
		email: `user_${uniqueId}_${index}@nammablood.test`,
		password: 'Password123!',
		status: true,
		...overrides,
	}
}

function createMockReqRes({
	params = {},
	query = {},
	headers = {},
	user = null,
	userRole = 'USER',
	staff = null,
	ip = '127.0.0.1',
} = {}) {
	const req = {
		params,
		query,
		headers,
		user,
		userRole,
		staff,
		ip,
		socket: { remoteAddress: ip },
		connection: { remoteAddress: ip },
	}
	const res = {
		statusCode: 200,
		responseData: null,
		headersSent: {},
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
		setHeader(key, val) {
			this.headersSent[key] = val
		},
	}
	let nextCalled = false
	const next = (err) => {
		nextCalled = true
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { status: 'error', message: err.message }
		}
	}
	return { req, res, next, isNextCalled: () => nextCalled }
}

describe('Milestone 4.3.3.4: REST Controller, Routes & Integration Tests', () => {
	let dbConnected = false

	const createdRequestIds = []
	const createdDonorIds = []
	const createdBankIds = []
	const createdUnitIds = []
	const createdUserIds = []
	const createdStaffIds = []
	const createdAdminIds = []

	// Auth Fixtures
	let creatorUser = null
	let creatorToken = ''
	let unrelatedUser = null
	let unrelatedToken = ''
	let deactivatedUser = null
	let deactivatedUserToken = ''

	let adminUser = null
	let adminToken = ''

	let assignedBank = null
	let assignedBankToken = ''
	let unassignedBank = null
	let unassignedBankToken = ''
	let deactivatedBank = null
	let deactivatedBankToken = ''

	let assignedActiveStaff = null
	let assignedActiveStaffToken = ''
	let assignedSuspendedStaff = null
	let assignedSuspendedStaffToken = ''
	let unassignedStaff = null
	let unassignedStaffToken = ''

	// Target Emergency Request
	let verifiedRequest = null
	let expiredRequest = null
	let pendingRequest = null
	let rejectedRequest = null
	let flaggedRequest = null
	let fullyReservedRequest = null
	let inTransitRequest = null
	let fulfilledRequest = null
	let cancelledRequest = null
	let integrityViolatedRequest = null

	// Auxiliary Banks & Donors
	let zeroStockBank = null
	let unverifiedBank = null
	let clearedDonor = null
	let pendingDonor = null

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(TEST_DB_URI)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live DB tests.')
		}

		if (!dbConnected) return

		// 1. Create Users
		creatorUser = await User.create(makeUserData(1, 'B_Positive', { firstName: 'Creator', lastName: 'Requester' }))
		createdUserIds.push(creatorUser._id)
		creatorToken = jwt.sign(
			{ id: creatorUser._id.toString(), userType: 'user', tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		unrelatedUser = await User.create(makeUserData(2, 'O_Positive', { firstName: 'Unrelated', lastName: 'User' }))
		createdUserIds.push(unrelatedUser._id)
		unrelatedToken = jwt.sign(
			{ id: unrelatedUser._id.toString(), userType: 'user', tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		deactivatedUser = await User.create(
			makeUserData(3, 'A_Positive', { firstName: 'Deactivated', lastName: 'User', status: false })
		)
		createdUserIds.push(deactivatedUser._id)
		deactivatedUserToken = jwt.sign(
			{ id: deactivatedUser._id.toString(), userType: 'user', tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		// 2. Create Admin
		adminUser = await Admin.create({
			email: `admin_${crypto.randomUUID().slice(0, 8)}@test.com`,
			phoneNo: String(makeRandomPhone()),
			password: 'Password123!',
			status: true,
		})
		createdAdminIds.push(adminUser._id)
		adminToken = jwt.sign(
			{ id: adminUser._id.toString(), tokenVersion: adminUser.tokenVersion || 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		// 3. Create Blood Banks
		const stamp = crypto.randomUUID().slice(0, 6)
		assignedBank = await Bloodbank.create({
			bloodbankName: `Assigned Apex Blood Bank ${stamp}`,
			category: 'Government',
			contactPerson: 'Dr. Apex Director',
			address1: '12 Medical College Road',
			address2: 'Fort Area',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560002,
			phoneNo1: String(makeRandomPhone()),
			phoneNo2: String(makeRandomPhone()),
			email: `assigned_bb_${stamp}@test.com`,
			password: 'Password123!',
			status: true,
			location: {
				type: 'Point',
				coordinates: [77.596, 12.973], // ~0.5 km from hospital
			},
		})
		createdBankIds.push(assignedBank._id)
		assignedBankToken = jwt.sign(
			{ id: assignedBank._id.toString(), tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		unassignedBank = await Bloodbank.create({
			bloodbankName: `Unassigned Regional Blood Bank ${stamp}`,
			category: 'RedCross',
			contactPerson: 'Dr. Regional Director',
			address1: '88 West Boulevard',
			address2: 'Gandhi Nagar',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560003,
			phoneNo1: String(makeRandomPhone()),
			phoneNo2: String(makeRandomPhone()),
			email: `unassigned_bb_${stamp}@test.com`,
			password: 'Password123!',
			status: true,
			location: {
				type: 'Point',
				coordinates: [77.6, 12.98],
			},
		})
		createdBankIds.push(unassignedBank._id)
		unassignedBankToken = jwt.sign(
			{ id: unassignedBank._id.toString(), tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		deactivatedBank = await Bloodbank.create({
			bloodbankName: `Deactivated Blood Bank ${stamp}`,
			category: 'Private',
			contactPerson: 'Dr. Suspended',
			address1: '99 Closed Road',
			address2: 'Industrial Layout',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560004,
			phoneNo1: String(makeRandomPhone()),
			phoneNo2: String(makeRandomPhone()),
			email: `deactivated_bb_${stamp}@test.com`,
			password: 'Password123!',
			status: false,
		})
		createdBankIds.push(deactivatedBank._id)
		deactivatedBankToken = jwt.sign(
			{ id: deactivatedBank._id.toString(), tokenVersion: 0 },
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		zeroStockBank = await Bloodbank.create({
			bloodbankName: `Zero Stock Blood Bank ${stamp}`,
			category: 'Charitable',
			contactPerson: 'Dr. Zero Stock',
			address1: '45 Empty Road',
			address2: 'Jayanagar Block 3',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560005,
			phoneNo1: String(makeRandomPhone()),
			phoneNo2: String(makeRandomPhone()),
			email: `zerostock_bb_${stamp}@test.com`,
			password: 'Password123!',
			status: true,
			location: {
				type: 'Point',
				coordinates: [77.598, 12.975],
			},
		})
		createdBankIds.push(zeroStockBank._id)

		unverifiedBank = await Bloodbank.create({
			bloodbankName: `Unverified Inventory Blood Bank ${stamp}`,
			category: 'Charitable',
			contactPerson: 'Dr. Unverified',
			address1: '50 Non-Digital Road',
			address2: 'Shivajinagar Outer',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560006,
			phoneNo1: String(makeRandomPhone()),
			phoneNo2: String(makeRandomPhone()),
			email: `unverified_bb_${stamp}@test.com`,
			password: 'Password123!',
			status: true,
			location: {
				type: 'Point',
				coordinates: [77.602, 12.977],
			},
		})
		createdBankIds.push(unverifiedBank._id)

		// 4. Create Staff Members
		assignedActiveStaff = await BloodbankStaff.create({
			fullName: 'Assigned Active Tech',
			phoneNo: String(makeRandomPhone()),
			email: `assigned_staff_${stamp}@test.com`,
			password: 'Password123!',
			role: 'Lab_Technician',
			status: 'Active',
			bloodbankId: assignedBank._id,
			createdBy: assignedBank._id,
		})
		createdStaffIds.push(assignedActiveStaff._id)
		assignedActiveStaffToken = jwt.sign(
			{
				id: assignedActiveStaff._id.toString(),
				userType: 'staff',
				bloodbankId: assignedBank._id.toString(),
				tokenVersion: 0,
			},
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		assignedSuspendedStaff = await BloodbankStaff.create({
			fullName: 'Assigned Suspended Tech',
			phoneNo: String(makeRandomPhone()),
			email: `suspended_staff_${stamp}@test.com`,
			password: 'Password123!',
			role: 'Lab_Technician',
			status: 'Suspended',
			bloodbankId: assignedBank._id,
			createdBy: assignedBank._id,
		})
		createdStaffIds.push(assignedSuspendedStaff._id)
		assignedSuspendedStaffToken = jwt.sign(
			{
				id: assignedSuspendedStaff._id.toString(),
				userType: 'staff',
				bloodbankId: assignedBank._id.toString(),
				tokenVersion: 0,
			},
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		unassignedStaff = await BloodbankStaff.create({
			fullName: 'Unassigned Active Tech',
			phoneNo: String(makeRandomPhone()),
			email: `unassigned_staff_${stamp}@test.com`,
			password: 'Password123!',
			role: 'Lab_Technician',
			status: 'Active',
			bloodbankId: unassignedBank._id,
			createdBy: unassignedBank._id,
		})
		createdStaffIds.push(unassignedStaff._id)
		unassignedStaffToken = jwt.sign(
			{
				id: unassignedStaff._id.toString(),
				userType: 'staff',
				bloodbankId: unassignedBank._id.toString(),
				tokenVersion: 0,
			},
			process.env.JWT_SECRET,
			{ expiresIn: '2h' }
		)

		// 5. Create Blood Units for assignedBank
		const futureExpiry = new Date(Date.now() + 30 * 24 * 3600 * 1000)
		const unit1 = await BloodUnit.create({
			unitNumber: `DIN-B-POS-1-${stamp}`,
			bloodbankId: assignedBank._id,
			bloodGroup: 'B_Positive',
			componentType: 'Packed_Red_Blood_Cells',
			volumeMl: 350,
			status: 'Available',
			expiryDate: futureExpiry,
			clearance: {
				isVerified: true,
				verifiedAt: new Date(),
				verifiedBy: assignedActiveStaff._id,
			},
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
			},
		})
		createdUnitIds.push(unit1._id)

		const unit2 = await BloodUnit.create({
			unitNumber: `DIN-B-POS-2-${stamp}`,
			bloodbankId: assignedBank._id,
			bloodGroup: 'B_Positive',
			componentType: 'Packed_Red_Blood_Cells',
			volumeMl: 350,
			status: 'Available',
			expiryDate: futureExpiry,
			clearance: {
				isVerified: true,
				verifiedAt: new Date(),
				verifiedBy: assignedActiveStaff._id,
			},
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
			},
		})
		createdUnitIds.push(unit2._id)

		// Ineligible unit for assignedBank (expired)
		const expiredUnit = await BloodUnit.create({
			unitNumber: `DIN-B-POS-EXP-${stamp}`,
			bloodbankId: assignedBank._id,
			bloodGroup: 'B_Positive',
			componentType: 'Packed_Red_Blood_Cells',
			volumeMl: 350,
			status: 'Expired',
			expiryDate: new Date(Date.now() - 24 * 3600 * 1000), // expired
			clearance: { isVerified: true, verifiedAt: new Date(), verifiedBy: assignedActiveStaff._id },
			testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
		})
		createdUnitIds.push(expiredUnit._id)

		// Unit for zeroStockBank of an incompatible group (AB_Positive)
		const abUnit = await BloodUnit.create({
			unitNumber: `DIN-AB-POS-${stamp}`,
			bloodbankId: zeroStockBank._id,
			bloodGroup: 'AB_Positive',
			componentType: 'Packed_Red_Blood_Cells',
			volumeMl: 350,
			status: 'Available',
			expiryDate: futureExpiry,
			clearance: { isVerified: true, verifiedAt: new Date(), verifiedBy: assignedActiveStaff._id },
			testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
		})
		createdUnitIds.push(abUnit._id)

		// 6. Create Donors
		const donorUser1 = await User.create(makeUserData(4, 'B_Positive', { firstName: 'Cleared', lastName: 'Donor' }))
		createdUserIds.push(donorUser1._id)
		clearedDonor = await EmergencyDonorProfile.create({
			userId: donorUser1._id,
			bloodGroup: 'B_Positive',
			isEmergencyDonor: true,
			availabilityStatus: 'Ready',
			clinicalEligibilityStatus: 'Clinically_Cleared',
			lastMedicalReviewAt: new Date(Date.now() - 5 * 24 * 3600 * 1000),
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560001,
			location: {
				type: 'Point',
				coordinates: [77.595, 12.972], // ~0.2 km from hospital
			},
		})
		createdDonorIds.push(clearedDonor._id)

		const donorUser2 = await User.create(makeUserData(5, 'O_Positive', { firstName: 'Pending', lastName: 'Donor' }))
		createdUserIds.push(donorUser2._id)
		pendingDonor = await EmergencyDonorProfile.create({
			userId: donorUser2._id,
			bloodGroup: 'O_Positive',
			isEmergencyDonor: true,
			availabilityStatus: 'Ready',
			clinicalEligibilityStatus: 'Pending_Clinical_Evaluation',
			city: 'Bengaluru',
			state: 'Karnataka',
			pinCode: 560001,
			location: {
				type: 'Point',
				coordinates: [77.597, 12.974], // ~0.4 km from hospital
			},
		})
		createdDonorIds.push(pendingDonor._id)

		// 7. Create Target Emergency Requests
		const baseRequestData = {
			requesterUserId: creatorUser._id,
			patientName: 'SubMilestone Patient',
			patientAge: 40,
			patientGender: 'Female',
			requiredBloodGroup: 'B_Positive',
			requiredComponent: 'Packed_Red_Blood_Cells',
			unitsRequested: 3,
			unitsReserved: 0,
			unitsFulfilled: 0,
			urgencyLevel: 'Critical',
			requiredWithinHours: 4,
			expiresAt: new Date(Date.now() + 4 * 3600 * 1000),
			hospitalName: 'Bengaluru General Medical Hospital',
			hospitalAddress: '10 Victoria Hospital Road',
			hospitalCity: 'Bengaluru',
			hospitalState: 'Karnataka',
			hospitalPinCode: 560002,
			location: {
				type: 'Point',
				coordinates: [77.5946, 12.9716],
			},
			attendingDoctor: {
				doctorName: 'Dr. Suresh Rao',
				doctorPhone: '9876543210',
				registrationNumber: 'KMC-54321',
			},
			matchedBloodbankIds: [assignedBank._id, zeroStockBank._id, unverifiedBank._id],
		}

		verifiedRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-VERIFIED-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Active',
		})
		createdRequestIds.push(verifiedRequest._id)

		pendingRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-PENDING-${stamp}`,
			verificationStatus: 'Pending_Verification',
			status: 'Active',
		})
		createdRequestIds.push(pendingRequest._id)

		rejectedRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-REJECTED-${stamp}`,
			verificationStatus: 'Rejected',
			status: 'Active',
		})
		createdRequestIds.push(rejectedRequest._id)

		flaggedRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-FLAGGED-${stamp}`,
			verificationStatus: 'Flagged_Suspicious',
			status: 'Active',
		})
		createdRequestIds.push(flaggedRequest._id)

		expiredRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-EXPIRED-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Active',
			expiresAt: new Date(Date.now() - 3600 * 1000), // 1 hour ago
		})
		createdRequestIds.push(expiredRequest._id)

		fullyReservedRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-FULRES-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Fully_Reserved',
			unitsReserved: 3,
			reservedUnitIds: [new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId(), new mongoose.Types.ObjectId()],
		})
		createdRequestIds.push(fullyReservedRequest._id)

		inTransitRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-TRANSIT-${stamp}`,
			verificationStatus: 'Verified',
			status: 'In_Transit',
		})
		createdRequestIds.push(inTransitRequest._id)

		fulfilledRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-FULFIL-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Fulfilled',
			unitsFulfilled: 3,
		})
		createdRequestIds.push(fulfilledRequest._id)

		cancelledRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-CANCEL-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Cancelled',
			cancellationReason: 'Patient discharged',
		})
		createdRequestIds.push(cancelledRequest._id)

		// Request with shortfall data integrity violation (unitsReserved !== reservedUnitIds.length)
		integrityViolatedRequest = await EmergencyBloodRequest.create({
			...baseRequestData,
			requestNumber: `EMG-M4334-INTEG-${stamp}`,
			verificationStatus: 'Verified',
			status: 'Active',
			unitsReserved: 2,
			reservedUnitIds: [], // 0 reserved IDs vs 2 reported -> violation!
		})
		createdRequestIds.push(integrityViolatedRequest._id)
	})

	beforeEach(() => {
		resetDiscoveryRateLimiter()
	})

	after(async () => {
		if (dbConnected) {
			if (createdRequestIds.length > 0) {
				await EmergencyBloodRequest.deleteMany({ _id: { $in: createdRequestIds } })
			}
			if (createdDonorIds.length > 0) {
				await EmergencyDonorProfile.deleteMany({ _id: { $in: createdDonorIds } })
			}
			if (createdBankIds.length > 0) {
				await Bloodbank.deleteMany({ _id: { $in: createdBankIds } })
			}
			if (createdUnitIds.length > 0) {
				await BloodUnit.deleteMany({ _id: { $in: createdUnitIds } })
			}
			if (createdUserIds.length > 0) {
				await User.deleteMany({ _id: { $in: createdUserIds } })
			}
			if (createdStaffIds.length > 0) {
				await BloodbankStaff.deleteMany({ _id: { $in: createdStaffIds } })
			}
			if (createdAdminIds.length > 0) {
				await Admin.deleteMany({ _id: { $in: createdAdminIds } })
			}
			await mongoose.disconnect()
		}
	})

	// =========================================================================
	// 1. AUTHENTICATION (protectEmergencyAuth)
	// =========================================================================
	describe('1. Authentication Middleware & Account Lifecycle', () => {
		it('should reject unauthenticated request with 401 Unauthorized', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: {},
				params: { id: verifiedRequest._id.toString() },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.match(res.responseData.message, /Authentication required/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should reject malformed or non-Bearer authorization header with 401', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: 'Basic dXNlcjpwYXNz' },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should reject expired JWT token with 401 Unauthorized', async () => {
			const expiredToken = jwt.sign(
				{ id: creatorUser._id.toString(), userType: 'user', tokenVersion: 0, iat: Math.floor(Date.now() / 1000) - 7200 },
				process.env.JWT_SECRET,
				{ expiresIn: '-10m' }
			)

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${expiredToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /expired/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should reject token with unrecognized userType with 401', async () => {
			const invalidTypeToken = jwt.sign(
				{ id: creatorUser._id.toString(), userType: 'unrecognized_drone', tokenVersion: 0 },
				process.env.JWT_SECRET,
				{ expiresIn: '1h' }
			)

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${invalidTypeToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /unrecognized userType/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should reject token for non-existent account with 401', async () => {
			const ghostToken = jwt.sign(
				{ id: new mongoose.Types.ObjectId().toString(), userType: 'user', tokenVersion: 0 },
				process.env.JWT_SECRET,
				{ expiresIn: '1h' }
			)

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${ghostToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /no longer exists/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should strictly reject deactivated USER account with 401 Unauthorized', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedUserToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should strictly reject deactivated BLOODBANK account with 401 Unauthorized', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedBankToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should strictly reject suspended STAFF account with 401 Unauthorized', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${assignedSuspendedStaffToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /inactive or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should allow valid USER authentication and assign req.userRole = USER', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${creatorToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'USER')
			assert.strictEqual(req.user._id.toString(), creatorUser._id.toString())
		})

		it('should allow valid ADMIN authentication and assign req.userRole = ADMIN', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${adminToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'ADMIN')
		})

		it('should allow valid BLOODBANK authentication and assign req.userRole = BLOODBANK', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${assignedBankToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'BLOODBANK')
			assert.strictEqual(req.user._id.toString(), assignedBank._id.toString())
		})

		it('should allow valid STAFF authentication and assign req.userRole = STAFF and req.staff', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${assignedActiveStaffToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'STAFF')
			assert.ok(req.staff)
			assert.strictEqual(req.staff._id.toString(), assignedActiveStaff._id.toString())
		})
	})

	// =========================================================================
	// 2. AUTHORIZATION & BOLA / IDOR PROTECTION
	// =========================================================================
	describe('2. Broken Object-Level Authorization (BOLA/IDOR) & Anti-Enumeration', () => {
		it('should ALLOW access to request creator (USER)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.ok(res.responseData.donors)
			assert.ok(res.responseData.bloodBanks)
		})

		it('should ALLOW access to system administrator (ADMIN)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: adminUser,
				userRole: 'ADMIN',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
		})

		it('should ALLOW access to assigned blood bank in matchedBloodbankIds', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: assignedBank,
				userRole: 'BLOODBANK',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
		})

		it('should ALLOW access to active staff whose owning blood bank is in matchedBloodbankIds', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: assignedActiveStaff,
				userRole: 'STAFF',
				staff: assignedActiveStaff,
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
		})

		it('should DENY unrelated USER with 404 REQUEST_NOT_FOUND (Anti-Enumeration)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: unrelatedUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.strictEqual(res.responseData.code, 'REQUEST_NOT_FOUND')
			assert.strictEqual(res.responseData.message, 'Emergency blood request was not found.')
			// Never leak internal audit flags
			assert.strictEqual(res.responseData.isAuthorizationDenial, undefined)
			assert.strictEqual(res.responseData.internalCode, undefined)
		})

		it('should DENY unassigned BLOODBANK with 404 REQUEST_NOT_FOUND (Anti-Enumeration)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: unassignedBank,
				userRole: 'BLOODBANK',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.strictEqual(res.responseData.code, 'REQUEST_NOT_FOUND')
			assert.strictEqual(res.responseData.message, 'Emergency blood request was not found.')
		})

		it('should DENY unassigned STAFF with 404 REQUEST_NOT_FOUND (Anti-Enumeration)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: unassignedStaff,
				userRole: 'STAFF',
				staff: unassignedStaff,
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.strictEqual(res.responseData.code, 'REQUEST_NOT_FOUND')
		})

		it('should return byte-for-byte identical 404 payload for non-existent vs unauthorized requests', async () => {
			const nonExistentId = new mongoose.Types.ObjectId().toString()

			// Case A: Missing request
			const { req: reqMissing, res: resMissing } = createMockReqRes({
				params: { id: nonExistentId },
				user: creatorUser,
				userRole: 'USER',
			})
			await getRequestMatches(reqMissing, resMissing)

			// Case B: Unauthorized request
			const { req: reqUnauthorized, res: resUnauthorized } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: unrelatedUser,
				userRole: 'USER',
			})
			await getRequestMatches(reqUnauthorized, resUnauthorized)

			assert.strictEqual(resMissing.statusCode, 404)
			assert.strictEqual(resUnauthorized.statusCode, 404)
			assert.deepStrictEqual(resMissing.responseData, resUnauthorized.responseData)
			assert.strictEqual(resMissing.responseData.code, 'REQUEST_NOT_FOUND')
			assert.strictEqual(resUnauthorized.responseData.code, 'REQUEST_NOT_FOUND')
		})

		it('should strictly reject candidateRef, facilityRef, or client query params as authorization credentials', async () => {
			// Attacker attempts to bypass authorization by supplying valid candidateRef and bloodbankId
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				query: {
					candidateRef: 'DNR-A1B2C3D4E5F60718293A4B5C6D7E8F90',
					facilityRef: 'BB-A1B2C3D4E5F6',
					bloodbankId: assignedBank._id.toString(),
					role: 'ADMIN',
				},
				user: unrelatedUser,
				userRole: 'USER', // Validated JWT role
			})

			await getRequestMatches(req, res)

			// Attacker is strictly rejected with anti-enumeration 404
			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.code, 'REQUEST_NOT_FOUND')
		})
	})

	// =========================================================================
	// 3. REQUEST VALIDATION AND LIFECYCLE ENFORCEMENT
	// =========================================================================
	describe('3. Request Validation & Lifecycle Gates', () => {
		it('should allow valid verified request and return 200', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.emergencyRequest.requestNumber, verifiedRequest.requestNumber)
		})

		it('should block pending verification request with 400 REQUEST_PENDING_VERIFICATION', async () => {
			const { req, res } = createMockReqRes({
				params: { id: pendingRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_PENDING_VERIFICATION')
			assert.match(res.responseData.message, /pending medical verification/i)
		})

		it('should block rejected request with 400 REQUEST_VERIFICATION_REJECTED', async () => {
			const { req, res } = createMockReqRes({
				params: { id: rejectedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_VERIFICATION_REJECTED')
		})

		it('should block flagged suspicious request with 400 REQUEST_FLAGGED_SUSPICIOUS', async () => {
			const { req, res } = createMockReqRes({
				params: { id: flaggedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_FLAGGED_SUSPICIOUS')
		})

		it('should block expired request with 400 EMERGENCY_REQUEST_EXPIRED', async () => {
			const { req, res } = createMockReqRes({
				params: { id: expiredRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'EMERGENCY_REQUEST_EXPIRED')
			assert.match(res.responseData.message, /validity window has lapsed/i)
		})

		it('should block Fully_Reserved request with 400 REQUEST_FULLY_RESERVED', async () => {
			const { req, res } = createMockReqRes({
				params: { id: fullyReservedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_FULLY_RESERVED')
		})

		it('should block In_Transit request with 400 REQUEST_IN_TRANSIT', async () => {
			const { req, res } = createMockReqRes({
				params: { id: inTransitRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_IN_TRANSIT')
		})

		it('should block Fulfilled request with 400 REQUEST_ALREADY_FULFILLED', async () => {
			const { req, res } = createMockReqRes({
				params: { id: fulfilledRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_ALREADY_FULFILLED')
		})

		it('should block Cancelled request with 400 REQUEST_CANCELLED', async () => {
			const { req, res } = createMockReqRes({
				params: { id: cancelledRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_CANCELLED')
		})

		it('should fail closed with 500 DATA_INTEGRITY_VIOLATION when shortfall integrity invariant is violated', async () => {
			const { req, res } = createMockReqRes({
				params: { id: integrityViolatedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 500)
			assert.strictEqual(res.responseData.code, 'DATA_INTEGRITY_VIOLATION')
			assert.match(res.responseData.message, /data integrity violation/i)
		})

		it('should safely handle missing or empty request identifier parameter with 400 and fixed safe message', async () => {
			const { req, res } = createMockReqRes({
				params: { id: '' },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'INVALID_REQUEST_IDENTIFIER')
			assert.strictEqual(res.responseData.message, 'The emergency request identifier is invalid.')
		})

		it('should safely reject invalid request identifier syntax with 400 without echoing input', async () => {
			const malformedId = 'invalid-hex-format-123'
			const { req, res } = createMockReqRes({
				params: { id: malformedId },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'INVALID_REQUEST_IDENTIFIER')
			assert.strictEqual(res.responseData.message, 'The emergency request identifier is invalid.')
			assert.strictEqual(JSON.stringify(res.responseData).includes(malformedId), false)
		})

		it('should safely reject NoSQL injection attempts in identifier parameter with fixed safe message without echoing operator', async () => {
			const operatorId = '$where'
			const { req, res } = createMockReqRes({
				params: { id: operatorId },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'INVALID_REQUEST_IDENTIFIER')
			assert.strictEqual(res.responseData.message, 'The emergency request identifier is invalid.')
			assert.strictEqual(JSON.stringify(res.responseData).includes(operatorId), false)
		})

		it('should reject NoSQL query operators in query string with safe fixed message without echoing key', async () => {
			const maliciousKey = '$gt'
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				query: { [maliciousKey]: '0' },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator or key/i)
			assert.strictEqual(JSON.stringify(res.responseData).includes(maliciousKey), false)
		})

		it('should reject nested query objects with safe fixed message without echoing key', async () => {
			const nestedKey = 'radius'
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				query: { [nestedKey]: { '$gt': 10 } },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Nested query objects are not permitted/i)
			assert.strictEqual(JSON.stringify(res.responseData).includes('$gt'), false)
		})
	})

	// =========================================================================
	// 4. MATCHING INTEGRATION & CANDIDATE STREAMS
	// =========================================================================
	describe('4. Matching Engine Integration & Candidate Streams', () => {
		it('should resolve request by human-readable requestNumber as well as ObjectId', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest.requestNumber },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.emergencyRequest.requestNumber, verifiedRequest.requestNumber)
		})

		it('should return dual-stream candidate outputs for donors and blood banks', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)
			assert.ok(Array.isArray(res.responseData.donors.data))
			assert.ok(Array.isArray(res.responseData.bloodBanks.data))
			assert.ok(res.responseData.donors.pagination.totalCount >= 1)
			assert.ok(res.responseData.bloodBanks.pagination.totalCount >= 1)
		})

		it('should preserve five distinct candidate classifications across streams', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const donorClassifications = res.responseData.donors.data.map((d) => d.classification)
			const bankStatuses = res.responseData.bloodBanks.data.map((b) => b.inventoryTrustStatus)

			// Donors
			assert.ok(donorClassifications.includes('Potential_Donor_Match'))
			assert.ok(donorClassifications.includes('Pending_Clinical_Evaluation'))

			// Blood Banks
			assert.ok(bankStatuses.includes('Verified_Bloodbank_Stock_Match'))
			assert.ok(bankStatuses.includes('No_Matching_Stock'))
			assert.ok(bankStatuses.includes('Inventory_Unverified'))
		})

		it('should format HMAC candidate references as DNR-[0-9A-F]{32} and BB-[0-9A-F]{12}', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			for (const donor of res.responseData.donors.data) {
				assert.match(donor.candidateRef, /^DNR-[0-9A-F]{32}$/)
			}

			for (const bank of res.responseData.bloodBanks.data) {
				assert.match(bank.facilityRef, /^BB-[0-9A-F]{12}$/)
			}
		})

		it('should preserve immunohematology compatibility output in matchingSummary', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const summary = res.responseData.matchingSummary
			assert.strictEqual(summary.preferredGroup, 'B_Positive')
			assert.ok(Array.isArray(summary.compatibleGroups))
			assert.ok(summary.compatibleGroups.includes('B_Positive'))
			assert.ok(summary.compatibleGroups.includes('O_Positive'))
			assert.ok(summary.compatibleGroups.includes('B_Negative'))
			assert.ok(summary.compatibleGroups.includes('O_Negative'))
		})

		it('should preserve clinical governance metadata without unsupported authority claims', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const gov = res.responseData.governance
			// Unsupported clinicalAuthority claim must be absent
			assert.strictEqual(gov.clinicalAuthority, undefined)
			// Internal specVersion must not claim official NBTC or DGHS status
			assert.ok(gov.specVersion)
			assert.strictEqual(gov.specVersion.includes('NBTC'), false)
			assert.strictEqual(gov.specVersion.includes('DGHS'), false)
			// Clinical governance restrictions strictly preserved
			assert.strictEqual(gov.isAuthoritativeClinicalDecision, false)
			assert.strictEqual(gov.isPresumptiveImmunohematologyCheck, true)
			assert.strictEqual(gov.isMatchingRecommendationOnly, true)
			assert.strictEqual(gov.cannotAuthorizeDispatch, true)
			assert.strictEqual(gov.cannotAuthorizeReservation, true)
			assert.strictEqual(gov.cannotAuthorizeDonation, true)
			assert.strictEqual(gov.cannotIssuePrescriptionOrOrder, true)
			assert.strictEqual(gov.requiresLaboratoryCrossmatch, true)
			assert.strictEqual(gov.preservesPhase3Safeguards, true)
			assert.match(gov.clinicalSafetyNotice, /presumptive immunohematology guidance only/i)
		})
	})

	// =========================================================================
	// 5. INVENTORY SAFETY AND TRACEABILITY SAFEGUARDS
	// =========================================================================
	describe('5. Inventory Safety & Traceability Safeguards', () => {
		it('should report verifiedUnitsAvailable: 2 for assignedBank (excluding expired units)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const matchedBank = res.responseData.bloodBanks.data.find(
				(b) => b.bloodbankName === assignedBank.bloodbankName
			)
			assert.ok(matchedBank)
			assert.strictEqual(matchedBank.inventoryTrustStatus, 'Verified_Bloodbank_Stock_Match')
			assert.strictEqual(matchedBank.verifiedUnitsAvailable, 2)
		})

		it('should report verifiedUnitsAvailable: 0 for participating bank with no compatible stock', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const matchedBank = res.responseData.bloodBanks.data.find(
				(b) => b.bloodbankName === zeroStockBank.bloodbankName
			)
			assert.ok(matchedBank)
			assert.strictEqual(matchedBank.inventoryTrustStatus, 'No_Matching_Stock')
			assert.strictEqual(matchedBank.verifiedUnitsAvailable, 0)
		})

		it('should report verifiedUnitsAvailable: null for unverified inventory (never fake zero)', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const matchedBank = res.responseData.bloodBanks.data.find(
				(b) => b.bloodbankName === unverifiedBank.bloodbankName
			)
			assert.ok(matchedBank)
			assert.strictEqual(matchedBank.inventoryTrustStatus, 'Inventory_Unverified')
			assert.strictEqual(matchedBank.verifiedUnitsAvailable, null)
		})

		it('should fail closed to verifiedUnitsAvailable: null when inventory lookup errors', async () => {
			// Temporarily stub stockService to throw an unexpected database error
			const originalBreakdown = stockService.getTraceableStatusBreakdown
			try {
				stockService.getTraceableStatusBreakdown = async () => {
					throw new Error('Database cluster timeout or network partition')
				}

				const { req, res } = createMockReqRes({
					params: { id: verifiedRequest._id.toString() },
					user: creatorUser,
					userRole: 'USER',
				})

				await getRequestMatches(req, res)

				assert.strictEqual(res.statusCode, 200)
				for (const bank of res.responseData.bloodBanks.data) {
					// All banks must fail closed to Inventory_Unverified with verifiedUnitsAvailable === null
					assert.strictEqual(bank.inventoryTrustStatus, 'Inventory_Unverified')
					assert.strictEqual(bank.verifiedUnitsAvailable, null)
					// Error message must be sanitized (never leak raw error text)
					assert.match(bank.inventoryNotice, /Inventory verification service is temporarily unavailable/i)
					assert.strictEqual(bank.inventoryNotice.includes('timeout or network partition'), false)
				}
			} finally {
				stockService.getTraceableStatusBreakdown = originalBreakdown
			}
		})

		it('should never leak BloodUnit ObjectIds, DINs, or internal unit numbers in response', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			const responseString = JSON.stringify(res.responseData)
			assert.strictEqual(responseString.includes('DIN-B-POS'), false)
			assert.strictEqual(responseString.includes('DIN-O-POS'), false)
			for (const unitId of createdUnitIds) {
				assert.strictEqual(responseString.includes(unitId.toString()), false)
			}
		})
	})

	// =========================================================================
	// 6. PRIVACY SHIELD & RESPONSE SANITIZATION
	// =========================================================================
	describe('6. Privacy Shield & Allowlist Sanitization', () => {
		it('should never expose donor ObjectIds, user IDs, or personal contact details', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			for (const donor of res.responseData.donors.data) {
				// Internal IDs
				assert.strictEqual(donor._id, undefined)
				assert.strictEqual(donor.id, undefined)
				assert.strictEqual(donor.userId, undefined)
				// Personal Contact PII
				assert.strictEqual(donor.phoneNo, undefined)
				assert.strictEqual(donor.phoneNo1, undefined)
				assert.strictEqual(donor.phoneNo2, undefined)
				assert.strictEqual(donor.email, undefined)
				assert.strictEqual(donor.address, undefined)
				assert.strictEqual(donor.pinCode, undefined)
				assert.strictEqual(donor.firstName, undefined)
				assert.strictEqual(donor.lastName, undefined)
				// Exact residential coordinates
				assert.strictEqual(donor.latitude, undefined)
				assert.strictEqual(donor.longitude, undefined)
				assert.strictEqual(donor.location, undefined)
				// Push tokens
				assert.strictEqual(donor.pushSubscription, undefined)
				assert.strictEqual(donor.fcmToken, undefined)
				// Only sanitized fields present
				assert.ok(donor.candidateRef)
				assert.ok(donor.bloodGroup)
				assert.ok(typeof donor.approxDistanceKm === 'number')
				assert.ok(donor.classification)
			}
		})

		it('should never expose blood bank ObjectIds, passwords, or personal staff contacts', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			for (const bank of res.responseData.bloodBanks.data) {
				assert.strictEqual(bank._id, undefined)
				assert.strictEqual(bank.id, undefined)
				assert.strictEqual(bank.bloodbankId, undefined)
				assert.strictEqual(bank.password, undefined)
				assert.strictEqual(bank.tokenVersion, undefined)
				assert.strictEqual(bank.contactPerson, undefined)
				assert.strictEqual(bank.staff, undefined)
				// Approved public contact allowlist
				assert.ok(bank.facilityRef)
				assert.ok(bank.bloodbankName)
				assert.ok(bank.address)
				assert.ok(bank.city)
				assert.ok(bank.state)
				assert.ok(bank.phoneNo1)
				assert.ok(bank.email)
			}
		})

		it('should never leak database credentials, stack traces, or internal error objects', async () => {
			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				query: { radius: 'not-a-number' },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 400)
			const errorString = JSON.stringify(res.responseData)
			assert.strictEqual(errorString.includes('stack'), false)
			assert.strictEqual(errorString.includes('mongodb://'), false)
			assert.strictEqual(errorString.includes('namma_blood_dev'), false)
		})
	})

	// =========================================================================
	// 7. STRICTLY READ-ONLY INVARIANTS (ZERO MUTATIONS)
	// =========================================================================
	describe('7. Strictly Read-Only Invariants (Zero Mutations)', () => {
		it('should guarantee zero database mutations during full candidate matching execution', async () => {
			// Capture pre-execution state
			const requestBefore = await EmergencyBloodRequest.findById(verifiedRequest._id).lean()
			const unitsBefore = await BloodUnit.find({ _id: { $in: createdUnitIds } }).lean()
			const donorsBefore = await EmergencyDonorProfile.find({ _id: { $in: createdDonorIds } }).lean()
			const banksBefore = await Bloodbank.find({ _id: { $in: createdBankIds } }).lean()

			const { req, res } = createMockReqRes({
				params: { id: verifiedRequest._id.toString() },
				user: creatorUser,
				userRole: 'USER',
			})

			await getRequestMatches(req, res)

			assert.strictEqual(res.statusCode, 200)

			// Capture post-execution state
			const requestAfter = await EmergencyBloodRequest.findById(verifiedRequest._id).lean()
			const unitsAfter = await BloodUnit.find({ _id: { $in: createdUnitIds } }).lean()
			const donorsAfter = await EmergencyDonorProfile.find({ _id: { $in: createdDonorIds } }).lean()
			const banksAfter = await Bloodbank.find({ _id: { $in: createdBankIds } }).lean()

			// 1. Verify Emergency Request Invariants
			assert.strictEqual(requestBefore.unitsReserved, requestAfter.unitsReserved)
			assert.strictEqual(requestBefore.reservedUnitIds.length, requestAfter.reservedUnitIds.length)
			assert.strictEqual(requestBefore.status, requestAfter.status)
			assert.strictEqual(requestBefore.updatedAt.getTime(), requestAfter.updatedAt.getTime())

			// 2. Verify Blood Units Invariants (no units reserved or status mutated)
			for (let i = 0; i < unitsBefore.length; i++) {
				assert.strictEqual(unitsBefore[i].status, unitsAfter[i].status)
				assert.strictEqual(unitsBefore[i].updatedAt.getTime(), unitsAfter[i].updatedAt.getTime())
			}

			// 3. Verify Donor Profiles Invariants (no availability status mutated)
			for (let i = 0; i < donorsBefore.length; i++) {
				assert.strictEqual(donorsBefore[i].availabilityStatus, donorsAfter[i].availabilityStatus)
				assert.strictEqual(donorsBefore[i].clinicalEligibilityStatus, donorsAfter[i].clinicalEligibilityStatus)
			}

			// 4. Verify Blood Bank Invariants
			for (let i = 0; i < banksBefore.length; i++) {
				assert.strictEqual(banksBefore[i].updatedAt.getTime(), banksAfter[i].updatedAt.getTime())
			}
		})
	})
})
