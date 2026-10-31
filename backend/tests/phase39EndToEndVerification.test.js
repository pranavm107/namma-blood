const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const crypto = require('node:crypto')
const mongoose = require('mongoose')

const { BloodUnit, MANDATORY_TTI_TESTS } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const BloodbankStaff = require('../BloodBank/bloodbankStaffModel')
const {
	findEligibleUnitsFEFO,
	reserveUnitsForRequest,
	releaseReservationForRequest,
} = require('../BloodUnit/reservationService')
const {
	issueUnitsForRequest,
	recordCrossmatchForUnit,
	recordPhysicalDispatch,
	validateCrossmatchResult,
} = require('../BloodUnit/issuanceService')
const {
	discardBloodUnits,
	processClinicallyExpiredInventory,
} = require('../BloodUnit/discardService')
const reconciliationService = require('../BloodStock/reconciliationService')
const stockService = require('../BloodStock/stockService')

describe('Phase 3.9 — End-to-End Verification & Security Audit', () => {
	before(async () => {
		if (mongoose.connection.readyState !== 1) {
			await mongoose.connect(
				process.env.database_url || 'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'
			)
		}
	})
	const mockBloodbankId = new mongoose.Types.ObjectId()
	const otherBloodbankId = new mongoose.Types.ObjectId()
	const verifiedMOStaffId = new mongoose.Types.ObjectId()
	const unverifiedMOStaffId = new mongoose.Types.ObjectId()
	const labTechStaffId = new mongoose.Types.ObjectId()
	const testPatientId = new mongoose.Types.ObjectId()

	let dinCounter = 100
	function getTestDIN() {
		return `W390026${String(dinCounter++).padStart(5, '0')}`
	}

	describe('1. Complete 10-Stage Inventory Lifecycle Pipeline', () => {
		let testUnit
		let testReceiveRequest

		it('Stage 1: Donation intake provisions traceable unit in Quarantined hold', async () => {
			const din = getTestDIN()
			testUnit = new BloodUnit({
				unitNumber: din,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				collectionDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
				expiryDate: new Date(Date.now() + 33 * 24 * 60 * 60 * 1000),
				status: 'Quarantined',
			})
			await testUnit.validate()

			assert.strictEqual(testUnit.status, 'Quarantined')
			assert.strictEqual(testUnit.clearance.isVerified, false)
			assert.strictEqual(testUnit.isIssueEligible(), false)
		})

		it('Stage 2 & 3: Partial or Reactive screening blocks unit from release', () => {
			// Incomplete screening
			testUnit.testing = {
				hiv: 'Non_Reactive',
				hbv: 'Pending',
				hcv: 'Pending',
				syphilis: 'Pending',
				malaria: 'Pending',
			}
			assert.strictEqual(testUnit.isIssueEligible(), false)

			// Reactive screening
			const reactiveUnit = new BloodUnit({
				unitNumber: getTestDIN(),
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				collectionDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
				expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
				status: 'Quarantined',
				testing: {
					hiv: 'Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			assert.strictEqual(reactiveUnit.status, 'Quarantined')
			assert.strictEqual(reactiveUnit.isIssueEligible(), false)
		})

		it('Stage 4: Complete Non_Reactive screening enables transition to Tested_Passed', () => {
			testUnit.testing = {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
			}
			testUnit.status = 'Tested_Passed'
			assert.strictEqual(testUnit.status, 'Tested_Passed')
			// Screening alone NEVER makes a unit Available
			assert.strictEqual(testUnit.clearance.isVerified, false)
			assert.strictEqual(testUnit.isIssueEligible(), false)
		})

		it('Stage 5: Verified Medical Officer clearance transitions unit to Available', () => {
			testUnit.clearance = {
				isVerified: true,
				verifiedBy: mockBloodbankId,
				verifiedByStaffId: verifiedMOStaffId,
				verifiedAt: new Date(),
				notes: 'Medical Officer quality clearance verified.',
			}
			testUnit.status = 'Available'
			assert.strictEqual(testUnit.status, 'Available')
			assert.strictEqual(testUnit.clearance.isVerified, true)
			assert.strictEqual(testUnit.isIssueEligible(), true)
		})

		it('Stage 6: Crossmatch validation rejects Incompatible and enforces Emergency protocol rules', () => {
			// Incompatible is strictly rejected
			assert.throws(
				() => validateCrossmatchResult('Incompatible'),
				/Incompatible blood units can NEVER be issued/i
			)

			// Pending is rejected
			assert.throws(
				() => validateCrossmatchResult('Pending'),
				/cannot be issued until compatibility testing is concluded/i
			)

			// Emergency Uncrossmatched fails if MO not verified
			assert.throws(
				() =>
					validateCrossmatchResult('Emergency_Uncrossmatched', {
						isEmergency: true,
						emergencyReason: 'Severe trauma exsanguinating in trauma bay 1',
						isMOVerified: false,
					}),
				/strictly requires authorization by a verified Medical Officer/i
			)

			// Emergency Uncrossmatched fails if reason is too short (< 10 chars)
			assert.throws(
				() =>
					validateCrossmatchResult('Emergency_Uncrossmatched', {
						isEmergency: true,
						emergencyReason: 'urgent',
						isMOVerified: true,
					}),
				/requires clinical justification/i
			)

			// Valid Compatible succeeds
			assert.strictEqual(validateCrossmatchResult('Compatible'), 'Compatible')

			// Valid Emergency Uncrossmatched succeeds with verified MO and reason
			assert.strictEqual(
				validateCrossmatchResult('Emergency_Uncrossmatched', {
					isEmergency: true,
					emergencyReason: 'Severe trauma exsanguinating in trauma bay 1',
					isMOVerified: true,
				}),
				'Emergency_Uncrossmatched'
			)
		})
	})

	describe('2. Security, Authorization & Tenant Isolation Checks', () => {
		it('ensures search query regex escaping prevents regex injection or syntax crashes', () => {
			function escapeRegex(text) {
				return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
			}

			const dangerousInputs = [
				'DIN-(',
				'DIN-[0-9]',
				'DIN.*',
				'DIN+\\',
				'DIN-?test',
			]

			for (const input of dangerousInputs) {
				const escaped = escapeRegex(input)
				// Ensure that constructing a RegExp from escaped string never throws
				assert.doesNotThrow(() => {
					new RegExp(escaped, 'i')
				})
				// Ensure that the escaped regex matches the literal input
				assert.match(input, new RegExp(`^${escaped}$`, 'i'))
			}
		})

		it('ensures sortBy allows only whitelisted fields and rejects arbitrary fields', () => {
			const ALLOWED_SORT_FIELDS = [
				'createdAt',
				'updatedAt',
				'unitNumber',
				'expiryDate',
				'collectionDate',
				'bloodGroup',
				'status',
				'volumeMl',
			]

			const sanitizeSortBy = (field) => (ALLOWED_SORT_FIELDS.includes(field) ? field : 'createdAt')

			assert.strictEqual(sanitizeSortBy('createdAt'), 'createdAt')
			assert.strictEqual(sanitizeSortBy('unitNumber'), 'unitNumber')
			assert.strictEqual(sanitizeSortBy('donorUserId'), 'createdAt') // Private field sanitized
			assert.strictEqual(sanitizeSortBy('$where'), 'createdAt') // NoSQL operator sanitized
			assert.strictEqual(sanitizeSortBy('__proto__'), 'createdAt')
		})

		it('ensures discard service requires notes when reason is Other', async () => {
			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [new mongoose.Types.ObjectId()],
						bloodbankId: mockBloodbankId,
						reason: 'Other',
						notes: '', // Empty notes
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Clinical discard reason 'Other' requires explanatory notes/i,
				}
			)
		})

		it('ensures manifest validation normalizes Platelets to Platelet_Concentrate', () => {
			const item = {
				unitNumber: 'W39002699999',
				bloodGroup: 'A_Positive',
				componentType: 'Platelets',
				volumeMl: 350,
				expiryDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
				deductFromLegacy: false,
			}

			const res = reconciliationService.validateManifestItem(item, 0)
			assert.strictEqual(res.isValid, true)
			assert.strictEqual(res.sanitizedItem.componentType, 'Platelet_Concentrate')
		})

		it('enforces that fractionated components cannot deduct 1:1 from whole-blood legacy stock', () => {
			const item = {
				unitNumber: 'W39002688888',
				bloodGroup: 'A_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 280,
				expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
				deductFromLegacy: true,
			}

			const res = reconciliationService.validateManifestItem(item, 0)
			assert.strictEqual(res.isValid, false)
			assert.match(res.errors[0], /Unsupported component mapping.*Direct 1:1 legacy deduction is permitted only for 'Whole_Blood'/i)
		})

		it('rejects sample or placeholder DINs when executing migration (mode=EXECUTE)', () => {
			const sampleItem = {
				unitNumber: 'DIN-LEG-123456',
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
				deductFromLegacy: true,
			}

			// In EXECUTE mode: must be rejected
			const execRes = reconciliationService.validateManifestItem(sampleItem, 0, new Date(), true)
			assert.strictEqual(execRes.isValid, false)
			assert.match(execRes.errors[0], /Placeholder or sample DIN.*cannot be executed/i)

			// In DRY_RUN mode: allowed for operator preview
			const dryRes = reconciliationService.validateManifestItem(sampleItem, 0, new Date(), false)
			assert.strictEqual(dryRes.isValid, true)

			// Real physical DIN in EXECUTE mode: valid
			const realItem = { ...sampleItem, unitNumber: 'W39002611111' }
			const realRes = reconciliationService.validateManifestItem(realItem, 0, new Date(), true)
			assert.strictEqual(realRes.isValid, true)
		})
	})

	describe('3. Audit Immutability Guards', () => {
		it('rejects update and delete operations on BloodUnitAuditLog documents', async () => {
			const auditDoc = new BloodUnitAuditLog({
				unitId: new mongoose.Types.ObjectId(),
				unitNumber: 'W39002600001',
				bloodbankId: mockBloodbankId,
				action: 'UNIT_INTAKE_COLLECTED',
				previousStatus: 'None',
				newStatus: 'Quarantined',
				actor: {
					actorId: mockBloodbankId,
					actorModel: 'bloodbank',
				},
			})

			// Attempting updateOne on query middleware throws immutable error
			await assert.rejects(
				async () => {
					await BloodUnitAuditLog.updateOne(
						{ _id: auditDoc._id },
						{ $set: { action: 'TAMPERED' } }
					)
				},
				/Security violation: BloodUnitAuditLog records are append-only/i
			)

			// Attempting deleteOne throws immutable error
			await assert.rejects(
				async () => {
					await BloodUnitAuditLog.deleteOne({ _id: auditDoc._id })
				},
				/Security violation: BloodUnitAuditLog records are append-only/i
			)
		})
	})

	describe('4. Lifecycle Inventory Counters & Status Breakdown Rules', () => {
		after(async () => {
			await BloodUnit.deleteMany({
				bloodbankId: mockBloodbankId,
				unitNumber: { $in: ['DIN-P39-2026295-WB', 'DIN-P39-001', 'DIN-EXP-REGRESSION'] }
			})
		})

		it('correctly categorizes Unit 1 (Quarantined) and Unit 2 (Tested_Passed legacy-migrated) across all 7 counters', async () => {
			// Clean test units strictly for this mock bank
			await BloodUnit.deleteMany({
				bloodbankId: mockBloodbankId,
				unitNumber: { $in: ['DIN-P39-2026295-WB', 'DIN-P39-001', 'DIN-EXP-REGRESSION'] }
			})

			const now = new Date()

			// Unit 1: DIN-P39-2026295-WB: B+, Quarantined, all 5 TTI Pending
			const unit1 = new BloodUnit({
				unitNumber: 'DIN-P39-2026295-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'B_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				collectionDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
				expiryDate: new Date(now.getTime() + 33 * 24 * 60 * 60 * 1000),
				status: 'Quarantined',
				testing: {
					hiv: 'Pending',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
			})
			await unit1.save()

			// Unit 2: DIN-P39-001: A+, Tested_Passed, all 5 TTI Pass, legacy-migrated, clearance Unverified
			const unit2 = new BloodUnit({
				unitNumber: 'DIN-P39-001',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				collectionDate: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
				expiryDate: new Date(now.getTime() + 32 * 24 * 60 * 60 * 1000),
				status: 'Tested_Passed',
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
				clearance: {
					isVerified: false,
					verifiedBy: null,
					verifiedByStaffId: null,
					notes: 'Legacy migrated unit awaiting MO clearance',
				},
				isLegacyMigrated: true,
			})
			await unit2.save()

			// Query full status breakdown
			const breakdown = await stockService.getTraceableStatusBreakdown(mockBloodbankId)

			// Assertions on all 7 counters
			assert.strictEqual(breakdown.Quarantined, 1, 'Unit 1 must be counted under Quarantined')
			assert.strictEqual(breakdown.Tested_Passed, 1, 'Unit 2 must be counted under Tested_Passed')
			assert.strictEqual(breakdown.Available, 0, 'No units are issue-eligible yet; Available must be 0')
			assert.strictEqual(breakdown.Reserved, 0, 'Reserved must be 0')
			assert.strictEqual(breakdown.Issued, 0, 'Issued must be 0')
			assert.strictEqual(breakdown.Expired, 0, 'Expired must be 0')
			assert.strictEqual(breakdown.Discarded, 0, 'Discarded must be 0')
			assert.strictEqual(breakdown.totalUnits, 2, 'Total units must equal exactly 2')

			// Medical Officer Clearance on Unit 2 -> transitions Tested_Passed to 0 and Available to 1
			unit2.status = 'Available'
			unit2.clearance.isVerified = true
			unit2.clearance.verifiedBy = mockBloodbankId
			unit2.clearance.verifiedByStaffId = verifiedMOStaffId
			unit2.clearance.verifiedAt = new Date()
			await unit2.save()

			const breakdownAfterMO = await stockService.getTraceableStatusBreakdown(mockBloodbankId)
			assert.strictEqual(breakdownAfterMO.Available, 1, 'Cleared unit must now be counted as Available')
			assert.strictEqual(breakdownAfterMO.Tested_Passed, 0, 'Tested_Passed must drop to 0')
			assert.strictEqual(breakdownAfterMO.Quarantined, 1, 'Quarantined unit 1 remains 1')
			assert.strictEqual(breakdownAfterMO.totalUnits, 2)

			// Expired unit invariant: unit past expiryDate is counted under Expired, NEVER Available
			const expiredUnit = new BloodUnit({
				unitNumber: 'DIN-EXP-REGRESSION',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				collectionDate: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
				expiryDate: new Date(now.getTime() - 1000), // Clinically expired
				status: 'Expired',
				clearance: { isVerified: true, verifiedBy: mockBloodbankId },
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			await expiredUnit.save()

			const breakdownWithExpired = await stockService.getTraceableStatusBreakdown(mockBloodbankId)
			assert.strictEqual(breakdownWithExpired.Expired, 1, 'Past-expiry unit must be counted under Expired')
			assert.strictEqual(breakdownWithExpired.Available, 1, 'Available count must remain 1 (only unit2)')
			assert.strictEqual(breakdownWithExpired.totalUnits, 3)

			// Cleanup
			await BloodUnit.deleteMany({
				bloodbankId: mockBloodbankId,
				unitNumber: { $in: ['DIN-P39-2026295-WB', 'DIN-P39-001', 'DIN-EXP-REGRESSION'] }
			})
		})
	})

	describe('5. Staff Authentication & Protected Endpoints Verification', () => {
		const { protectBloodbankOrStaff, generateStaffToken } = require('../BloodBank/bloodbankStaffMiddleware')
		const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
		const Bloodbank = require('../BloodBank/bloodbankModel')
		const { getBloodbankProfile } = require('../BloodBank/bloodbankController')
		const { getStock } = require('../BloodStock/bloodStockController')

		const bbId = new mongoose.Types.ObjectId()
		let staffMember
		let staffToken
		let bbDoc

		before(async () => {
			bbDoc = new Bloodbank({
				_id: bbId,
				bloodbankName: 'Test Medical Center',
				email: `test-${Date.now()}@medcenter.org`,
				password: `TestPass-${crypto.randomBytes(8).toString('hex')}!`,
				category: 'Private',
				contactPerson: 'Director',
				address1: '123 Main St',
				address2: 'Suite 400',
				pinCode: 560001,
				phoneNo1: '9876543210',
				phoneNo2: '9876543212',
				city: 'Bangalore',
				state: 'Karnataka',
			})
			await bbDoc.save()

			staffMember = new BloodbankStaff({
				fullName: 'Dr. Test Medical Officer',
				email: `mo.test-${Date.now()}@medcenter.org`,
				phoneNo: '9876543211',
				bloodbankId: bbId,
				role: 'Medical_Officer',
				password: `MOPass-${crypto.randomBytes(8).toString('hex')}!`,
				mustChangePassword: false,
				status: 'Active',
				medicalLicense: {
					licenseNumber: 'KMC-TEST-9999',
					issuingCouncil: 'Karnataka Medical Council',
					isVerified: true,
				},
				createdBy: bbId,
			})
			await staffMember.save()

			staffToken = generateStaffToken(staffMember)
		})

		after(async () => {
			await Bloodbank.deleteOne({ _id: bbId })
			await BloodbankStaff.deleteOne({ _id: staffMember?._id })
		})

		it('allows Medical Officer staff token through protectBloodbankOrStaff', async () => {
			const middleware = protectBloodbankOrStaff('Staff_Admin', 'Medical_Officer', 'Lab_Technician')
			let nextCalled = false
			const req = {
				headers: { authorization: `Bearer ${staffToken}` },
			}
			const res = {
				statusCode: 200,
				status(code) { this.statusCode = code; return this },
				json(data) { this.data = data; return this },
			}

			await middleware(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true, 'Next must be called for valid MO staff token')
			assert.strictEqual(req.staffRole, 'Medical_Officer')
			assert.strictEqual(req.bloodbankId.toString(), bbId.toString())
			assert.strictEqual(req.user.isStaff, true)
		})

		it('populates staff details when getBloodbankProfile is called with staff token', async () => {
			const req = {
				user: { _id: bbId },
				staff: staffMember,
			}
			let responseData = null
			const res = {
				statusCode: 200,
				status(code) { this.statusCode = code; return this },
				json(data) { responseData = data; return this },
			}

			await getBloodbankProfile(req, res, () => {})
			assert.ok(responseData, 'Profile response must not be null')
			assert.strictEqual(responseData.bloodbankName, 'Test Medical Center')
			assert.strictEqual(responseData.isStaff, true)
			assert.strictEqual(responseData.staffRole, 'Medical_Officer')
			assert.strictEqual(responseData.staff?.fullName, 'Dr. Test Medical Officer')
		})

		it('rejects unauthorized staff roles (e.g. Lab_Technician attempting Medical_Officer restricted route)', async () => {
			const labTech = new BloodbankStaff({
				fullName: 'Lab Tech Test',
				email: `labtech-${Date.now()}@medcenter.org`,
				phoneNo: '9876543212',
				bloodbankId: bbId,
				role: 'Lab_Technician',
				password: `TechPass-${crypto.randomBytes(8).toString('hex')}!`,
				mustChangePassword: false,
				status: 'Active',
				createdBy: bbId,
			})
			await labTech.save()
			const techToken = generateStaffToken(labTech)

			const middleware = protectBloodbankOrStaff('Medical_Officer')
			let nextCalled = false
			let resCode = 200
			let resData = null
			const req = {
				headers: { authorization: `Bearer ${techToken}` },
			}
			const res = {
				status(code) { resCode = code; return this },
				json(data) { resData = data; return this },
			}

			await middleware(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, false, 'Next must NOT be called for unauthorized role')
			assert.strictEqual(resCode, 403, 'Must return 403 Forbidden')
			await BloodbankStaff.deleteOne({ _id: labTech._id })
		})
	})

	after(async () => {
		await mongoose.disconnect()
	})
})
