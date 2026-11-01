/**
 * Milestone 4.3.1: Donor Discovery Backend Service & APIs Test Suite
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const {
	discoverNearbyDonors,
	escapeRegex,
} = require('../Emergency/emergencyDiscoveryService')
const { getNearbyDonors } = require('../Emergency/emergencyDiscoveryController')
const {
	discoveryRateLimiter,
	resetDiscoveryRateLimiter,
	MAX_REQUESTS_PER_WINDOW,
} = require('../Emergency/discoveryRateLimiter')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { EmergencyDonorProfile } = require('../Emergency/emergencyDonorProfileModel')
const User = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function createMockReqRes({
	user = null,
	query = {},
	headers = {},
	ip = '127.0.0.1',
} = {}) {
	const req = {
		user,
		query,
		headers,
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

describe('Milestone 4.3.1: Donor Discovery Backend Service & APIs', () => {
	let dbConnected = false
	const createdDonorIds = []
	const createdUserIds = []
	const createdStaffIds = []
	const createdBankIds = []
	const createdAdminIds = []

	// Auth test fixtures
	let validUserToken = ''
	let deactivatedUserToken = ''
	let validStaffToken = ''
	let inactiveStaffToken = ''
	let validBankToken = ''
	let deactivatedBankToken = ''
	let validAdminToken = ''

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(TEST_DB_URI)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live geospatial tests.')
		}

		if (dbConnected) {
			// Ensure indexes are built
			await EmergencyDonorProfile.syncIndexes()

			const stamp = Date.now()

			// 1. Seed Accounts for Role-Based Auth Tests
			// Active User
			const activeUser = await User.create({
				firstName: 'Active',
				lastName: 'User',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				phoneNo1: Number(`91${stamp.toString().slice(-8)}`),
				email: `active_user_${stamp}@test.com`,
				state: 'Karnataka',
				city: 'Bangalore',
				address: '123 Test Street',
				pinCode: 560001,
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(activeUser._id)
			validUserToken = jwt.sign(
				{ id: activeUser._id.toString(), tokenVersion: activeUser.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Deactivated User
			const deactUser = await User.create({
				firstName: 'Deact',
				lastName: 'User',
				gender: 'Female',
				dob: new Date('1992-05-10'),
				age: 32,
				phoneNo1: Number(`92${stamp.toString().slice(-8)}`),
				email: `deact_user_${stamp}@test.com`,
				state: 'Karnataka',
				city: 'Bangalore',
				address: '456 Deact Street',
				pinCode: 560001,
				password: 'Password123!',
				status: false, // Deactivated account
			})
			createdUserIds.push(deactUser._id)
			deactivatedUserToken = jwt.sign(
				{ id: deactUser._id.toString(), tokenVersion: deactUser.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Active Blood Bank
			const activeBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Active Bank ${stamp}`,
				category: 'Government',
				contactPerson: 'Dr. Active',
				address1: 'Fort Road',
				address2: 'City Market',
				pinCode: 560002,
				phoneNo1: `9845${stamp.toString().slice(-6)}1`,
				phoneNo2: `9845${stamp.toString().slice(-6)}2`,
				email: `active_bank_${stamp}@gov.in`,
				password: 'Password123!',
				status: true,
			})
			createdBankIds.push(activeBank._id)
			validBankToken = jwt.sign(
				{ id: activeBank._id.toString(), tokenVersion: activeBank.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Deactivated Blood Bank
			const deactBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Deact Bank ${stamp}`,
				category: 'Private',
				contactPerson: 'Dr. Suspended',
				address1: 'Old Road',
				address2: 'Block B',
				pinCode: 560003,
				phoneNo1: `9846${stamp.toString().slice(-6)}1`,
				phoneNo2: `9846${stamp.toString().slice(-6)}2`,
				email: `deact_bank_${stamp}@test.com`,
				password: 'Password123!',
				status: false, // Deactivated
			})
			createdBankIds.push(deactBank._id)
			deactivatedBankToken = jwt.sign(
				{ id: deactBank._id.toString(), tokenVersion: deactBank.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Active Staff
			const activeStaff = await BloodbankStaff.create({
				bloodbankId: activeBank._id,
				fullName: 'Nurse Jane Doe',
				email: `staff_active_${stamp}@test.com`,
				phoneNo: `9847${stamp.toString().slice(-6)}1`,
				role: 'Lab_Technician',
				status: 'Active',
				password: 'Password123!',
				createdBy: activeBank._id,
			})
			createdStaffIds.push(activeStaff._id)
			validStaffToken = jwt.sign(
				{
					id: activeStaff._id.toString(),
					bloodbankId: activeBank._id.toString(),
					role: activeStaff.role,
					tokenVersion: activeStaff.tokenVersion || 0,
					userType: 'staff',
				},
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Inactive/Suspended Staff
			const inactiveStaff = await BloodbankStaff.create({
				bloodbankId: activeBank._id,
				fullName: 'Former Tech',
				email: `staff_inactive_${stamp}@test.com`,
				phoneNo: `9848${stamp.toString().slice(-6)}1`,
				role: 'Lab_Technician',
				status: 'Suspended',
				password: 'Password123!',
				createdBy: activeBank._id,
			})
			createdStaffIds.push(inactiveStaff._id)
			inactiveStaffToken = jwt.sign(
				{
					id: inactiveStaff._id.toString(),
					bloodbankId: activeBank._id.toString(),
					role: inactiveStaff.role,
					tokenVersion: inactiveStaff.tokenVersion || 0,
					userType: 'staff',
				},
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Admin Account
			const admin = await Admin.create({
				phoneNo: `99${stamp.toString().slice(-8)}`,
				email: `admin_${stamp}@test.com`,
				password: 'Password123!',
			})
			createdAdminIds.push(admin._id)
			validAdminToken = jwt.sign(
				{ id: admin._id.toString(), tokenVersion: admin.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// 2. Seed Synthetic Test Donors:
			// Donor A: Bangalore Central [77.5946, 12.9716], B_Positive, Ready, Clinically_Cleared
			const userA = new mongoose.Types.ObjectId()
			createdUserIds.push(userA)
			const donorA = await EmergencyDonorProfile.create({
				userId: userA,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5946, 12.9716],
				},
			})
			createdDonorIds.push(donorA._id)

			// Donor B: Bangalore Indiranagar [77.6412, 12.9784] (~5 km), O_Negative, Ready, Pending_Clinical_Evaluation
			const userB = new mongoose.Types.ObjectId()
			createdUserIds.push(userB)
			const donorB = await EmergencyDonorProfile.create({
				userId: userB,
				bloodGroup: 'O_Negative',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Pending_Clinical_Evaluation',
				maxTravelDistanceKm: 10,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560038,
				location: {
					type: 'Point',
					coordinates: [77.6412, 12.9784],
				},
			})
			createdDonorIds.push(donorB._id)

			// Donor C: Bangalore Whitefield [77.7499, 12.9698] (~16.8 km), B_Positive, Ready, Clinically_Cleared
			const userC = new mongoose.Types.ObjectId()
			createdUserIds.push(userC)
			const donorC = await EmergencyDonorProfile.create({
				userId: userC,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 25,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560066,
				location: {
					type: 'Point',
					coordinates: [77.7499, 12.9698],
				},
			})
			createdDonorIds.push(donorC._id)

			// Donor D: Mysore [76.6394, 12.2958] (~130 km away), B_Positive, Ready, Clinically_Cleared
			const userD = new mongoose.Types.ObjectId()
			createdUserIds.push(userD)
			const donorD = await EmergencyDonorProfile.create({
				userId: userD,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 30,
				city: 'Mysore',
				state: 'Karnataka',
				pinCode: 570001,
				location: {
					type: 'Point',
					coordinates: [76.6394, 12.2958],
				},
			})
			createdDonorIds.push(donorD._id)

			// Donor E: Bangalore Central [77.5940, 12.9720], B_Positive, Temporarily_Deferred
			const userE = new mongoose.Types.ObjectId()
			createdUserIds.push(userE)
			const donorE = await EmergencyDonorProfile.create({
				userId: userE,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Temporarily_Deferred',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.594, 12.972],
				},
			})
			createdDonorIds.push(donorE._id)

			// Donor F: Bangalore Central [77.5942, 12.9722], A_Positive (Incompatible for B+ PRBC recipient)
			const userF = new mongoose.Types.ObjectId()
			createdUserIds.push(userF)
			const donorF = await EmergencyDonorProfile.create({
				userId: userF,
				bloodGroup: 'A_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5942, 12.9722],
				},
			})
			createdDonorIds.push(donorF._id)

			// Donor G: Bangalore Central [77.5943, 12.9723], B_Positive, Permanently_Deferred
			const userG = new mongoose.Types.ObjectId()
			createdUserIds.push(userG)
			const donorG = await EmergencyDonorProfile.create({
				userId: userG,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Permanently_Deferred',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5943, 12.9723],
				},
			})
			createdDonorIds.push(donorG._id)

			// Donor H: Bangalore Central [77.5944, 12.9724], B_Positive, Busy_Temporarily (Not Ready)
			const userH = new mongoose.Types.ObjectId()
			createdUserIds.push(userH)
			const donorH = await EmergencyDonorProfile.create({
				userId: userH,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Busy_Temporarily',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5944, 12.9724],
				},
			})
			createdDonorIds.push(donorH._id)

			// Donor I: Bangalore Central [77.5945, 12.9725], B_Positive, isEmergencyDonor = false
			const userI = new mongoose.Types.ObjectId()
			createdUserIds.push(userI)
			const donorI = await EmergencyDonorProfile.create({
				userId: userI,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: false,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5945, 12.9725],
				},
			})
			createdDonorIds.push(donorI._id)

			// Donor J: Bangalore Central [77.5947, 12.9727], Active Cooldown Date in Future
			const userJ = new mongoose.Types.ObjectId()
			createdUserIds.push(userJ)
			const donorJ = await EmergencyDonorProfile.create({
				userId: userJ,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				eligibleToDonateAfter: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days in future
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.5947, 12.9727],
				},
			})
			createdDonorIds.push(donorJ._id)

			// Donor K: Legacy Donor without GPS coordinates
			const userK = new mongoose.Types.ObjectId()
			createdUserIds.push(userK)
			const donorK = await EmergencyDonorProfile.create({
				userId: userK,
				bloodGroup: 'B_Positive',
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				maxTravelDistanceKm: 15,
				city: 'Bangalore',
				state: 'Karnataka',
				pinCode: 560001,
			})
			createdDonorIds.push(donorK._id)
		}
	})

	beforeEach(() => {
		resetDiscoveryRateLimiter()
	})

	after(async () => {
		if (dbConnected) {
			try {
				if (createdDonorIds.length > 0) {
					await EmergencyDonorProfile.deleteMany({ _id: { $in: createdDonorIds } })
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

	describe('1. Geospatial Radius Filtering & Proximity Queries', () => {
		it('should discover compatible donors within 10 km radius and accurately compute distance', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			assert.strictEqual(result.searchCriteria.isGeospatial, true)
			assert.strictEqual(result.searchCriteria.radiusKm, 10)
			assert.strictEqual(result.searchCriteria.recipientBloodGroup, 'B_Positive')

			// Verify Donor A (Central ~0 km, B+) and Donor B (Indiranagar ~5 km, O-) are found
			const centralDonor = result.data.find(
				(d) => d.bloodGroup === 'B_Positive' && d.approxDistanceKm < 0.2
			)
			const indiranagarDonor = result.data.find(
				(d) => d.bloodGroup === 'O_Negative' && d.approxDistanceKm > 4.5 && d.approxDistanceKm < 6.0
			)

			assert.ok(centralDonor, 'Central B+ donor missing within 10 km')
			assert.ok(indiranagarDonor, 'Indiranagar O- donor missing within 10 km')

			// Verify donors outside 10 km (Whitefield ~16.8 km, Mysore ~130 km) are excluded
			const farWhitefield = result.data.find((d) => d.approxDistanceKm > 15)
			assert.strictEqual(farWhitefield, undefined, 'Far Whitefield donor should be outside 10 km')
		})

		it('should expand search results when radius is increased to 25 km', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 25,
				bloodGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			// Donor C (Whitefield ~16.8 km) MUST now be included
			const whitefieldDonor = result.data.find(
				(d) => d.bloodGroup === 'B_Positive' && d.approxDistanceKm > 15 && d.approxDistanceKm < 20
			)
			assert.ok(whitefieldDonor, 'Whitefield donor should be included within 25 km')

			// Mysore donor (~130 km) MUST still be excluded
			const mysoreDonor = result.data.find((d) => d.approxDistanceKm > 100)
			assert.strictEqual(mysoreDonor, undefined, 'Mysore donor should still be excluded')
		})
	})

	describe('2. Presumptive Compatibility Integration across Components', () => {
		it('PRBC: B+ recipient returns B+, B-, O+, O- and excludes incompatible A+', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			// Compatible groups must strictly match PRBC rules
			assert.deepStrictEqual(result.searchCriteria.compatibleDonorGroups, [
				'B_Positive',
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])

			// Incompatible A_Positive donor MUST NOT appear
			const incompatibleDonor = result.data.find((d) => d.bloodGroup === 'A_Positive')
			assert.strictEqual(incompatibleDonor, undefined, 'A+ donor should be excluded for B+ PRBC')
		})

		it('Match Quality: Identical (B+) vs Compatible_Alternative (O-)', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const donorA = result.data.find((d) => d.bloodGroup === 'B_Positive' && d.approxDistanceKm < 0.2)
			const donorB = result.data.find((d) => d.bloodGroup === 'O_Negative')

			assert.strictEqual(donorA.matchQuality, 'Identical')
			assert.strictEqual(donorB.matchQuality, 'Compatible_Alternative')
		})
	})

	describe('3. Clinical Safety Exclusions & Governance Transparency', () => {
		it('strictly excludes Temporarily_Deferred, Permanently_Deferred, Busy, non-emergency, and cooldown donors', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
			})

			// Excluded donor checks
			for (const d of result.data) {
				assert.notStrictEqual(d.clinicalEligibilityStatus, 'Temporarily_Deferred')
				assert.notStrictEqual(d.clinicalEligibilityStatus, 'Permanently_Deferred')
				assert.notStrictEqual(d.availabilityStatus, 'Busy_Temporarily')
				assert.notStrictEqual(d.availabilityStatus, 'Opted_Out')
			}
		})

		it('surfaces Pending_Clinical_Evaluation with prominent mandatory screening notice', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
			})

			const pendingDonor = result.data.find(
				(d) => d.clinicalEligibilityStatus === 'Pending_Clinical_Evaluation'
			)
			assert.ok(pendingDonor)
			assert.match(pendingDonor.clinicalNotice, /Clinical evaluation, TTI screening/i)
			assert.match(pendingDonor.clinicalNotice, /does not constitute clinical eligibility/i)
		})

		it('surfaces Clinically_Cleared with Medical Officer verification notice and crossmatch mandate', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
			})

			const clearedDonor = result.data.find(
				(d) => d.clinicalEligibilityStatus === 'Clinically_Cleared'
			)
			assert.ok(clearedDonor)
			assert.match(clearedDonor.clinicalNotice, /verified clinically cleared by Medical Officer/i)
			assert.match(clearedDonor.clinicalNotice, /Final laboratory crossmatching/i)
		})
	})

	describe('4. Privacy Shield & Strict Non-Enumerable Data Sanitization', () => {
		it('strictly omits profileId, database _id, userId, coordinates, and PII from discovery output', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 10,
				bloodGroup: 'B_Positive',
			})

			assert.ok(result.data.length > 0)

			for (const donor of result.data) {
				// Anti-Enumeration & Anti-Tracking Invariant:
				// Stable profile identifiers and database IDs MUST be completely omitted
				assert.strictEqual(donor.profileId, undefined, 'profileId must be omitted')
				assert.strictEqual(donor._id, undefined, '_id must be omitted')
				assert.strictEqual(donor.id, undefined, 'id must be omitted')
				assert.strictEqual(donor.userId, undefined, 'userId must be omitted')

				// Geospatial & Residential Privacy Invariant:
				assert.strictEqual(donor.location, undefined, 'location coordinates must be omitted')
				assert.strictEqual(donor.coordinates, undefined, 'coordinates must be omitted')
				assert.strictEqual(donor.address1, undefined, 'address1 must be omitted')
				assert.strictEqual(donor.address2, undefined, 'address2 must be omitted')
				assert.strictEqual(donor.pinCode, undefined, 'pinCode must be omitted')

				// Contact & Telemetry Privacy Invariant:
				assert.strictEqual(donor.phoneNo, undefined, 'phoneNo must be omitted')
				assert.strictEqual(donor.email, undefined, 'email must be omitted')
				assert.strictEqual(donor.pushSubscription, undefined, 'pushSubscription must be omitted')
				assert.strictEqual(donor.notificationPreferences, undefined, 'notificationPreferences must be omitted')

				// Permitted Non-Enumerable Public Discovery Attributes:
				assert.ok(donor.bloodGroup)
				assert.ok(donor.matchQuality)
				assert.ok(typeof donor.approxDistanceKm === 'number')
				assert.ok(typeof donor.withinDonorTravelRadius === 'boolean')
				assert.ok(donor.clinicalEligibilityStatus)
				assert.ok(donor.clinicalNotice)
				assert.ok(donor.city)
				assert.ok(donor.state)
			}
		})
	})

	describe('5. Administrative Fallback Search (City/State)', () => {
		it('allows discovery by City and State when GPS coordinates are omitted', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyDonors({
				city: 'Bangalore',
				state: 'Karnataka',
				bloodGroup: 'B_Positive',
			})

			assert.strictEqual(result.searchCriteria.isGeospatial, false)
			assert.strictEqual(result.searchCriteria.radiusKm, null)

			// Legacy Donor K (no GPS coordinates) MUST be discoverable in city fallback
			const legacyDonor = result.data.find(
				(d) => d.city === 'Bangalore' && d.approxDistanceKm === null
			)
			assert.ok(legacyDonor, 'Legacy Donor without coordinates should be found in city fallback')

			// Mysore donors must NOT appear in Bangalore city fallback
			const mysoreDonor = result.data.find((d) => d.city === 'Mysore')
			assert.strictEqual(mysoreDonor, undefined, 'Mysore donor should not appear in Bangalore search')
		})

		it('rejects excessively long city or state strings (> 100 chars) to prevent ReDoS', async () => {
			const longCity = 'A'.repeat(101)
			await assert.rejects(
				async () => {
					await discoverNearbyDonors({
						city: longCity,
						state: 'Karnataka',
						bloodGroup: 'B_Positive',
					})
				},
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.match(err.message, /must not exceed 100 characters/i)
					return true
				}
			)
		})
	})

	describe('6. Controller Input Validation & Error Handling', () => {
		it('rejects query missing mandatory blood group with 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				query: { latitude: '12.97', longitude: '77.59' },
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /blood group is mandatory/i)
		})

		it('rejects unsupported blood group with 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				query: { latitude: '12.97', longitude: '77.59', bloodGroup: 'Z_Positive' },
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid blood group/i)
		})

		it('rejects unsupported component type with 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.97',
					longitude: '77.59',
					bloodGroup: 'B_Positive',
					componentType: 'Granulocyte_Concentrate',
				},
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unsupported component type/i)
		})

		it('rejects partially supplied coordinates (latitude without longitude)', async () => {
			const { req, res } = createMockReqRes({
				query: { latitude: '12.97', bloodGroup: 'B_Positive' },
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Both latitude and longitude must be provided/i)
		})

		it('rejects out-of-bounds latitude (> 90 deg)', async () => {
			const { req, res } = createMockReqRes({
				query: { latitude: '95.0', longitude: '77.59', bloodGroup: 'B_Positive' },
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Latitude must be between -90 and \+90/i)
		})

		it('rejects out-of-bounds longitude (> 180 deg)', async () => {
			const { req, res } = createMockReqRes({
				query: { latitude: '12.97', longitude: '185.0', bloodGroup: 'B_Positive' },
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Longitude must be between -180 and \+180/i)
		})

		it('rejects search radius outside 1–50 km bounds', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.97',
					longitude: '77.59',
					bloodGroup: 'B_Positive',
					radiusKm: '75', // Exceeds 50 km max
				},
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /radius must be a numeric value between 1 and 50 km/i)
		})

		it('rejects NoSQL injection operator keys in query params', async () => {
			const { req, res } = createMockReqRes({
				query: {
					$where: 'sleep(1000)',
					bloodGroup: 'B_Positive',
					city: 'Bangalore',
				},
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator/i)
		})

		it('rejects excessively long city parameter in controller (> 100 chars)', async () => {
			const { req, res } = createMockReqRes({
				query: {
					bloodGroup: 'B_Positive',
					city: 'B'.repeat(101),
				},
			})

			await getNearbyDonors(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /must not exceed 100 characters/i)
		})
	})

	describe('7. Rate Limiting Middleware & Anti-Spoofing Security', () => {
		it('allows up to 30 requests per minute and blocks the 31st with 429 Too Many Requests', () => {
			resetDiscoveryRateLimiter()

			const testIp = '192.168.1.100'

			// First 30 requests should succeed
			for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
				const { req, res } = createMockReqRes({ ip: testIp })
				discoveryRateLimiter(req, res, () => {})
				assert.strictEqual(res.statusCode, 200)
			}

			// 31st request must be blocked
			const { req, res } = createMockReqRes({ ip: testIp })
			discoveryRateLimiter(req, res, () => {})
			assert.strictEqual(res.statusCode, 429)
			assert.match(res.responseData.message, /Too many discovery requests/i)
			assert.ok(res.responseData.retryAfter >= 1)
		})

		it('prevents rate limit bypass via X-Forwarded-For spoofing for authenticated accounts', () => {
			resetDiscoveryRateLimiter()

			const mockUser = { _id: new mongoose.Types.ObjectId() }

			// Make 30 requests rotating X-Forwarded-For spoofed IPs
			for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
				const spoofedIp = `10.0.0.${i + 1}`
				const { req, res } = createMockReqRes({
					user: mockUser,
					ip: spoofedIp,
					headers: { 'x-forwarded-for': spoofedIp },
				})
				discoveryRateLimiter(req, res, () => {})
				assert.strictEqual(res.statusCode, 200)
			}

			// 31st request with yet another new spoofed IP must STILL be blocked
			// because the quota binds to cryptographically verified user identity
			const { req, res } = createMockReqRes({
				user: mockUser,
				ip: '10.0.0.99',
				headers: { 'x-forwarded-for': '10.0.0.99' },
			})
			discoveryRateLimiter(req, res, () => {})
			assert.strictEqual(res.statusCode, 429, 'Spoofed X-Forwarded-For must not bypass authenticated rate limiter')
		})
	})

	describe('8. Role-Based Authentication & Authorization Verification', () => {
		it('rejects unauthenticated requests without Bearer token with 401 Unauthorized', async () => {
			const { req, res, isNextCalled } = createMockReqRes({ headers: {} })
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Authentication required/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('rejects requests with malformed or invalid JWT token with 401 Unauthorized', async () => {
			const { req, res, isNextCalled } = createMockReqRes({
				headers: { authorization: 'Bearer invalid.token.value' },
			})
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Invalid or expired authentication token/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('allows authenticated User account and sets req.userRole = USER', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validUserToken}` },
			})
			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(isNextCalled(), true)
			assert.ok(req.user)
			assert.strictEqual(req.userRole, 'USER')
		})

		it('allows authenticated Blood Bank Staff account and sets req.userRole = STAFF', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validStaffToken}` },
			})
			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(isNextCalled(), true)
			assert.ok(req.user)
			assert.strictEqual(req.userRole, 'STAFF')
			assert.ok(req.staff)
		})

		it('allows authenticated Blood Bank Institutional account and sets req.userRole = BLOODBANK', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validBankToken}` },
			})
			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(isNextCalled(), true)
			assert.ok(req.user)
			assert.strictEqual(req.userRole, 'BLOODBANK')
		})

		it('allows authenticated System Administrator account and sets req.userRole = ADMIN', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validAdminToken}` },
			})
			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(isNextCalled(), true)
			assert.ok(req.user)
			assert.strictEqual(req.userRole, 'ADMIN')
		})

		it('strictly rejects deactivated User account (status: false) with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedUserToken}` },
			})
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('strictly rejects deactivated Blood Bank account (status: false) with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedBankToken}` },
			})
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('strictly rejects inactive/suspended Staff account with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${inactiveStaffToken}` },
			})
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /inactive or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('strictly rejects token with tampered or unsupported userType claim with 401 Unauthorized', async () => {
			const tamperedToken = jwt.sign(
				{ id: new mongoose.Types.ObjectId().toString(), userType: 'unauthorized_attacker_role' },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			const { req, res, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${tamperedToken}` },
			})
			await protectEmergencyAuth(req, res, () => {})

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /unrecognized userType claim/i)
			assert.strictEqual(isNextCalled(), false)
		})
	})
})
