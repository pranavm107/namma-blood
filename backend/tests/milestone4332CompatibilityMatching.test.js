/**
 * Milestone 4.3.3.2 Test Suite: Immunohematology Matching and Component Integration
 * Namma Blood — Phase 4 Emergency Blood Connection
 *
 * Requirements Covered:
 * 1. Whole Blood: Strictly ABO and Rh(D) identical requirement; broader component rules excluded.
 * 2. PRBC: Standard reciprocal antibody matching (anti-A, anti-B) and Rh(D) concordance.
 * 3. FFP: Acellular product; inverse ABO matching; Rh non-immunogenic.
 * 4. Platelets: ABO-identical preferred; out-of-group isohemagglutinin & Rh cautions for Rh-negative recipients.
 * 5. Cryoprecipitate: Low plasma volume; ABO-identical preferred; MO review required for non-identical.
 * 6. Input Validation & Fail-Closed Guards: Missing/invalid blood groups, unsupported components, malformed inputs.
 * 7. Clinical Governance Flags: Presumptive check only, cannot authorize dispatch/orders, laboratory crossmatch mandatory.
 * 8. End-to-End Composite Pipeline Integration & Read-Only Invariants.
 * 9. Request-Existence & Unauthorized-Access Indistinguishable 404 Anti-Enumeration Response Consistency.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const {
	resolveEmergencyRequest,
	authorizeRequestAccess,
	validateRequestLifecycle,
	validateShortfallIntegrity,
	deriveRequestCompatibility,
	validateAndAuthorizeEmergencyRequest,
} = require('../Emergency/emergencyMatchingService')

const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const User = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

describe('Milestone 4.3.3.2: Immunohematology Matching and Component Integration', () => {
	let dbConnected = false
	const createdRequestIds = []
	const createdUserIds = []
	const createdBankIds = []
	const createdStaffIds = []

	let creatorUser = null
	let thirdPartyUser = null
	let assignedBank = null
	let validVerifiedRequest = null

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
				email: `creator_m4332_${stamp}@test.com`,
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
				email: `thirdparty_m4332_${stamp}@test.com`,
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(thirdPartyUser._id)

			assignedBank = await Bloodbank.create({
				bloodbankName: 'Assigned Hospital Blood Bank',
				category: 'Charitable',
				state: 'Karnataka',
				city: 'Bengaluru',
				address1: '100 Medical Road',
				address2: 'Near Metro',
				pinCode: 560001,
				phoneNo1: `080-77${stamp.toString().slice(-6)}1`,
				phoneNo2: `080-77${stamp.toString().slice(-6)}2`,
				email: `assigned_bank_m4332_${stamp}@test.com`,
				contactPerson: 'Dr. Ramesh',
				password: 'Password123!',
				status: true,
			})
			createdBankIds.push(assignedBank._id)

			validVerifiedRequest = await EmergencyBloodRequest.create({
				requestNumber: `EMG-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-COMP01`,
				requesterUserId: creatorUser._id,
				patientName: 'Compatibility Patient',
				patientAge: 40,
				patientGender: 'Male',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				unitsReserved: 0,
				unitsFulfilled: 0,
				reservedUnitIds: [],
				matchedBloodbankIds: [assignedBank._id],
				urgencyLevel: 'Critical',
				requiredWithinHours: 4,
				expiresAt: new Date(Date.now() + 4 * 60 * 60 * 1000),
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
				await mongoose.disconnect()
			} catch (err) {
				console.error('Cleanup error in milestone 4.3.3.2 test suite:', err)
			}
		}
	})

	describe('1. Whole Blood Immunohematology Matching', () => {
		it('should require strictly ABO and Rh identical donor group for B_Positive Whole Blood request', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Whole_Blood',
			})

			assert.strictEqual(res.recipientGroup, 'B_Positive')
			assert.strictEqual(res.componentType, 'Whole_Blood')
			assert.strictEqual(res.preferredGroup, 'B_Positive')
			assert.deepStrictEqual(res.compatibleGroups, ['B_Positive'])
			assert.deepStrictEqual(res.alternateGroups, [])
			assert.strictEqual(res.hasCompatibleAlternatives, false)
			assert.strictEqual(res.requiresMedicalOfficerApproval, false)
			assert.ok(res.warnings.some((w) => w.includes('Whole Blood: Strictly ABO and Rh(D) identical')))
		})

		it('should require strictly ABO and Rh identical donor group for O_Negative Whole Blood request', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Whole_Blood',
			})

			assert.strictEqual(res.preferredGroup, 'O_Negative')
			assert.deepStrictEqual(res.compatibleGroups, ['O_Negative'])
			assert.deepStrictEqual(res.alternateGroups, [])
			assert.strictEqual(res.hasCompatibleAlternatives, false)
		})

		it('should never treat broader red cell compatibility as permission for Whole Blood (AB_Positive recipient receives ONLY AB_Positive Whole Blood)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'AB_Positive',
				requiredComponent: 'Whole_Blood',
			})

			// AB_Positive is universal recipient for PRBC, but strictly identical only for Whole Blood
			assert.strictEqual(res.preferredGroup, 'AB_Positive')
			assert.deepStrictEqual(res.compatibleGroups, ['AB_Positive'])
			assert.deepStrictEqual(res.alternateGroups, [])
			assert.strictEqual(res.hasCompatibleAlternatives, false)
		})
	})

	describe('2. Packed Red Blood Cells (PRBC) Immunohematology Matching', () => {
		it('should derive reciprocal antibody compatible donor groups for B_Positive PRBC request', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
			})

			assert.strictEqual(res.recipientGroup, 'B_Positive')
			assert.strictEqual(res.componentType, 'Packed_Red_Blood_Cells')
			assert.strictEqual(res.preferredGroup, 'B_Positive')
			assert.deepStrictEqual(res.compatibleGroups, [
				'B_Positive',
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])
			assert.deepStrictEqual(res.alternateGroups, [
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])
			assert.strictEqual(res.hasCompatibleAlternatives, true)
			assert.strictEqual(res.requiresMedicalOfficerApproval, false)
			assert.match(res.clinicalRationale, /anti-A/i)
		})

		it('should derive only O_Negative for O_Negative PRBC request (universal red cell donor)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
			})

			assert.strictEqual(res.preferredGroup, 'O_Negative')
			assert.deepStrictEqual(res.compatibleGroups, ['O_Negative'])
			assert.deepStrictEqual(res.alternateGroups, [])
			assert.strictEqual(res.hasCompatibleAlternatives, false)
		})

		it('should derive all 8 blood groups for AB_Positive PRBC request (universal red cell recipient)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'AB_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
			})

			assert.strictEqual(res.preferredGroup, 'AB_Positive')
			assert.strictEqual(res.compatibleGroups.length, 8)
			assert.strictEqual(res.alternateGroups.length, 7)
			assert.ok(res.compatibleGroups.includes('O_Negative'))
			assert.ok(res.compatibleGroups.includes('A_Positive'))
		})
	})

	describe('3. Fresh Frozen Plasma (FFP) Immunohematology Matching', () => {
		it('should apply inverse plasma rules for B_Positive FFP request (donor plasma lacking anti-B)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Fresh_Frozen_Plasma',
			})

			assert.strictEqual(res.recipientGroup, 'B_Positive')
			assert.strictEqual(res.componentType, 'Fresh_Frozen_Plasma')
			assert.strictEqual(res.preferredGroup, 'B_Positive')
			assert.deepStrictEqual(res.compatibleGroups, [
				'B_Positive',
				'B_Negative',
				'AB_Positive',
				'AB_Negative',
			])
			assert.deepStrictEqual(res.alternateGroups, [
				'B_Negative',
				'AB_Positive',
				'AB_Negative',
			])
			assert.match(res.clinicalRationale, /plasma/i)
		})

		it('should allow all 8 donor groups for O_Negative FFP request (O red cells lack A and B antigens)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Fresh_Frozen_Plasma',
			})

			assert.strictEqual(res.preferredGroup, 'O_Negative')
			assert.strictEqual(res.compatibleGroups.length, 8)
		})

		it('should allow only AB plasma for AB_Positive FFP request (universal plasma donor)', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'AB_Positive',
				requiredComponent: 'Fresh_Frozen_Plasma',
			})

			assert.strictEqual(res.preferredGroup, 'AB_Positive')
			assert.deepStrictEqual(res.compatibleGroups, ['AB_Positive', 'AB_Negative'])
		})
	})

	describe('4. Platelet Concentrate Immunohematology Matching & Governance Advisories', () => {
		it('should strongly prefer ABO-identical platelets and flag Medical Officer approval for alternatives', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Platelet_Concentrate',
			})

			assert.strictEqual(res.recipientGroup, 'B_Positive')
			assert.strictEqual(res.componentType, 'Platelet_Concentrate')
			assert.strictEqual(res.preferredGroup, 'B_Positive')
			assert.ok(res.compatibleGroups.length > 1)
			assert.strictEqual(res.hasCompatibleAlternatives, true)
			assert.strictEqual(res.requiresMedicalOfficerApproval, true)
			assert.ok(res.warnings.some((w) => w.includes('Platelets: ABO-identical is clinically preferred')))
		})

		it('should attach specific Rh Cautious Notice warning when recipient is Rh-Negative for platelets', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'A_Negative',
				requiredComponent: 'Platelet_Concentrate',
			})

			assert.strictEqual(res.recipientGroup, 'A_Negative')
			assert.ok(
				res.warnings.some(
					(w) =>
						w.includes('Rh Cautious Notice') &&
						w.includes('anti-D immunoglobulin prophylaxis')
				)
			)
		})

		it('should NOT attach Rh Cautious Notice when recipient is Rh-Positive for platelets', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'A_Positive',
				requiredComponent: 'Platelet_Concentrate',
			})

			assert.ok(!res.warnings.some((w) => w.includes('Rh Cautious Notice')))
		})
	})

	describe('5. Cryoprecipitate Immunohematology Matching & Governance Advisories', () => {
		it('should designate ABO-identical as preferred and flag Medical Officer review for alternatives', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Cryoprecipitate',
			})

			assert.strictEqual(res.recipientGroup, 'B_Positive')
			assert.strictEqual(res.componentType, 'Cryoprecipitate')
			assert.strictEqual(res.preferredGroup, 'B_Positive')
			assert.strictEqual(res.hasCompatibleAlternatives, true)
			assert.strictEqual(res.requiresMedicalOfficerApproval, true)
			assert.ok(
				res.warnings.some(
					(w) =>
						w.includes('Cryoprecipitate') &&
						w.includes('Medical Officer review per NBTC Sec. G-4.1')
				)
			)
			assert.ok(res.unresolvedInstitutionalDecision)
		})
	})

	describe('6. Input Validation, Missing Clinical Specs & Malformed Inputs (Fail-Closed)', () => {
		it('should fail closed with 400 INVALID_BLOOD_GROUP when requiredBloodGroup is missing or empty', () => {
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredComponent: 'Packed_Red_Blood_Cells',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_BLOOD_GROUP')
					assert.match(err.message, /missing mandatory requiredBloodGroup/i)
					return true
				}
			)
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredBloodGroup: '   ',
						requiredComponent: 'Packed_Red_Blood_Cells',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_BLOOD_GROUP')
					return true
				}
			)
		})

		it('should fail closed with 400 UNRECOGNIZED_BLOOD_GROUP on invalid blood group', () => {
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredBloodGroup: 'Z_Positive',
						requiredComponent: 'Packed_Red_Blood_Cells',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'UNRECOGNIZED_BLOOD_GROUP')
					return true
				}
			)
		})

		it('should fail closed with 400 UNSUPPORTED_COMPONENT_TYPE when requiredComponent is missing or empty', () => {
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredBloodGroup: 'B_Positive',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'UNSUPPORTED_COMPONENT_TYPE')
					assert.match(err.message, /missing mandatory requiredComponent/i)
					return true
				}
			)
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredBloodGroup: 'B_Positive',
						requiredComponent: '  ',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'UNSUPPORTED_COMPONENT_TYPE')
					return true
				}
			)
		})

		it('should fail closed with 400 UNSUPPORTED_COMPONENT_TYPE on illegal component type', () => {
			assert.throws(
				() =>
					deriveRequestCompatibility({
						requiredBloodGroup: 'B_Positive',
						requiredComponent: 'Granulocytes',
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'UNSUPPORTED_COMPONENT_TYPE')
					return true
				}
			)
		})

		it('should fail closed with 400 INVALID_REQUEST_OBJECT when request is null or non-object', () => {
			assert.throws(
				() => deriveRequestCompatibility(null),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_OBJECT')
					return true
				}
			)
			assert.throws(
				() => deriveRequestCompatibility('not-an-object'),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.strictEqual(err.code, 'INVALID_REQUEST_OBJECT')
					return true
				}
			)
		})
	})

	describe('7. Preservation of Mandatory Clinical Governance Flags', () => {
		it('should preserve all clinical governance restrictions on compatibility result', () => {
			const res = deriveRequestCompatibility({
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
			})

			assert.strictEqual(res.governance.isAuthoritativeClinicalDecision, false)
			assert.strictEqual(res.governance.isPresumptiveImmunohematologyCheck, true)
			assert.strictEqual(res.governance.cannotAuthorizeDispatch, true)
			assert.strictEqual(res.governance.cannotIssuePrescriptionOrOrder, true)
			assert.strictEqual(res.governance.requiresLaboratoryCrossmatch, true)
			assert.strictEqual(res.governance.ruleVersion, '1.0.0-NBTC-DGHS')
			assert.ok(res.governance.clinicalAuthority.includes('National Blood Transfusion Council'))
			assert.ok(res.governance.statutoryNotice.includes('algorithmic presumptive guide only'))
		})
	})

	describe('8. End-to-End Composite Integration & Read-Only Invariants', () => {
		it('should return complete compatibility descriptor inside validateAndAuthorizeEmergencyRequest', async () => {
			if (!dbConnected) return

			const res = await validateAndAuthorizeEmergencyRequest(
				validVerifiedRequest._id.toString(),
				{ user: creatorUser, userRole: 'USER' }
			)

			assert.ok(res)
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
			assert.strictEqual(res.compatibility.governance.cannotAuthorizeDispatch, true)
			assert.strictEqual(res.compatibility.governance.requiresLaboratoryCrossmatch, true)
		})

		it('should preserve zero database mutations during compatibility derivation and validation', async () => {
			if (!dbConnected) return

			const beforeDoc = await EmergencyBloodRequest.findById(validVerifiedRequest._id).lean()

			await validateAndAuthorizeEmergencyRequest(
				validVerifiedRequest._id.toString(),
				{ user: creatorUser, userRole: 'USER' }
			)

			const afterDoc = await EmergencyBloodRequest.findById(validVerifiedRequest._id).lean()

			assert.strictEqual(beforeDoc.updatedAt.getTime(), afterDoc.updatedAt.getTime())
			assert.strictEqual(beforeDoc.unitsReserved, afterDoc.unitsReserved)
			assert.strictEqual(beforeDoc.unitsFulfilled, afterDoc.unitsFulfilled)
			assert.strictEqual(beforeDoc.status, afterDoc.status)
			assert.strictEqual(beforeDoc.verificationStatus, afterDoc.verificationStatus)
		})
	})

	describe('9. Request-Existence & Unauthorized-Access Response Consistency (Anti-Enumeration 404)', () => {
		it('should return indistinguishable 404 REQUEST_NOT_FOUND for non-existent request vs unauthorized request', async () => {
			if (!dbConnected) return

			const nonExistentId = new mongoose.Types.ObjectId().toString()

			// 1. Missing request: returns 404 REQUEST_NOT_FOUND
			let missingErr = null
			try {
				await resolveEmergencyRequest(nonExistentId)
			} catch (err) {
				missingErr = err
			}
			assert.ok(missingErr)
			assert.strictEqual(missingErr.statusCode, 404)
			assert.strictEqual(missingErr.code, 'REQUEST_NOT_FOUND')
			assert.strictEqual(missingErr.message, 'Emergency blood request was not found.')

			// 2. Existing request accessed by unauthorized third-party: returns indistinguishable 404 REQUEST_NOT_FOUND
			let unauthorizedErr = null
			try {
				await validateAndAuthorizeEmergencyRequest(validVerifiedRequest._id.toString(), {
					user: thirdPartyUser,
					userRole: 'USER',
				})
			} catch (err) {
				unauthorizedErr = err
			}
			assert.ok(unauthorizedErr)
			assert.strictEqual(unauthorizedErr.statusCode, 404)
			assert.strictEqual(unauthorizedErr.code, 'REQUEST_NOT_FOUND')
			assert.strictEqual(unauthorizedErr.message, 'Emergency blood request was not found.')

			// 3. Status code, error code, and error message must be strictly indistinguishable to prevent enumeration
			assert.strictEqual(unauthorizedErr.statusCode, missingErr.statusCode)
			assert.strictEqual(unauthorizedErr.code, missingErr.code)
			assert.strictEqual(unauthorizedErr.message, missingErr.message)

			// 4. Internal authorization denial metadata is preserved for security audit logging
			assert.strictEqual(unauthorizedErr.isAuthorizationDenial, true)
			assert.strictEqual(unauthorizedErr.internalCode, 'ACCESS_DENIED')
		})
	})
})
