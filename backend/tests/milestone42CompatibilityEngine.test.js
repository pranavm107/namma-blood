const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const {
	COMPATIBILITY_SPEC_VERSION,
	CLINICAL_AUTHORITY,
	parseBloodGroup,
	getCompatibleDonorGroups,
	evaluateCompatibility,
	validateUnitCompatibility,
} = require('../Emergency/compatibilityEngine')
const {
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
} = require('../BloodUnit/bloodUnitModel')

describe('Milestone 4.2: Blood Component Compatibility Engine', () => {
	describe('1. Blood Group Parsing & Validation', () => {
		it('should accurately parse all 8 valid blood groups', () => {
			for (const group of VALID_BLOOD_GROUPS) {
				const parsed = parseBloodGroup(group)
				assert.strictEqual(parsed.raw, group)
				assert.ok(['A', 'B', 'AB', 'O'].includes(parsed.abo))
				assert.ok(['Positive', 'Negative'].includes(parsed.rh))
				assert.ok(typeof parsed.formatted === 'string')
			}
		})

		it('should reject missing, empty, or non-string blood groups with INVALID_BLOOD_GROUP', () => {
			assert.throws(
				() => parseBloodGroup(null),
				(err) => err.code === 'INVALID_BLOOD_GROUP'
			)
			assert.throws(
				() => parseBloodGroup(''),
				(err) => err.code === 'INVALID_BLOOD_GROUP'
			)
			assert.throws(
				() => parseBloodGroup(123),
				(err) => err.code === 'INVALID_BLOOD_GROUP'
			)
		})

		it('should reject unrecognized or illegal blood group strings', () => {
			assert.throws(
				() => parseBloodGroup('C_Positive'),
				(err) => err.code === 'UNRECOGNIZED_BLOOD_GROUP'
			)
			assert.throws(
				() => parseBloodGroup('H_Bombay'),
				(err) => err.code === 'UNRECOGNIZED_BLOOD_GROUP'
			)
			assert.throws(
				() => parseBloodGroup('O_RhNull'),
				(err) => err.code === 'UNRECOGNIZED_BLOOD_GROUP'
			)
		})
	})

	describe('2. Packed Red Blood Cells (PRBCs) Compatibility Matrix', () => {
		it('O-Negative recipient can ONLY receive O-Negative PRBCs', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'O_Negative',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, ['O_Negative'])
			assert.strictEqual(res.preferredGroup, 'O_Negative')
			assert.deepStrictEqual(res.alternateGroups, [])
		})

		it('O-Positive recipient can receive O-Positive (identical) and O-Negative (alternative)', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, ['O_Positive', 'O_Negative'])
			assert.strictEqual(res.preferredGroup, 'O_Positive')
			assert.deepStrictEqual(res.alternateGroups, ['O_Negative'])
		})

		it('A-Negative recipient can receive A-Negative and O-Negative', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'A_Negative',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, ['A_Negative', 'O_Negative'])
		})

		it('A-Positive recipient can receive A-Positive, A-Negative, O-Positive, O-Negative', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'A_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, [
				'A_Positive',
				'A_Negative',
				'O_Positive',
				'O_Negative',
			])
		})

		it('B-Negative recipient can receive B-Negative and O-Negative', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'B_Negative',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, ['B_Negative', 'O_Negative'])
		})

		it('B-Positive recipient can receive B-Positive, B-Negative, O-Positive, O-Negative', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, [
				'B_Positive',
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])
		})

		it('AB-Negative recipient can receive all Rh-Negative donor groups', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'AB_Negative',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.deepStrictEqual(res.compatibleGroups, [
				'AB_Negative',
				'A_Negative',
				'B_Negative',
				'O_Negative',
			])
		})

		it('AB-Positive recipient is Universal Red Cell Recipient (all 8 groups compatible)', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'AB_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.strictEqual(res.compatibleGroups.length, 8)
			assert.deepStrictEqual(res.compatibleGroups, [
				'AB_Positive',
				'AB_Negative',
				'A_Positive',
				'A_Negative',
				'B_Positive',
				'B_Negative',
				'O_Positive',
				'O_Negative',
			])
		})
	})

	describe('3. Whole Blood Compatibility Rules', () => {
		it('Whole Blood strictly requires group-identical ABO and Rh(D) transfusion', () => {
			for (const group of VALID_BLOOD_GROUPS) {
				const res = getCompatibleDonorGroups({
					recipientGroup: group,
					componentType: 'Whole_Blood',
				})
				// Exactly one group compatible: the identical group
				assert.deepStrictEqual(res.compatibleGroups, [group])
				assert.strictEqual(res.preferredGroup, group)
				assert.deepStrictEqual(res.alternateGroups, [])
			}
		})

		it('rejects O-Negative Whole Blood for A-Positive recipient (minor plasma incompatibility)', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'A_Positive',
				donorGroup: 'O_Negative',
				componentType: 'Whole_Blood',
			})
			assert.strictEqual(evalResult.isCompatible, false)
			assert.strictEqual(evalResult.matchQuality, 'Incompatible')
		})
	})

	describe('4. Fresh Frozen Plasma (FFP) Compatibility Rules', () => {
		it('AB-Positive recipient receives ONLY AB plasma (AB+ and AB-)', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'AB_Positive',
				componentType: 'Fresh_Frozen_Plasma',
			})
			assert.deepStrictEqual(res.compatibleGroups, ['AB_Positive', 'AB_Negative'])
		})

		it('O-Negative recipient is Universal Plasma Recipient (all plasma groups compatible)', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'O_Negative',
				componentType: 'Fresh_Frozen_Plasma',
			})
			assert.strictEqual(res.compatibleGroups.length, 8)
			assert.ok(res.compatibleGroups.includes('AB_Positive'))
			assert.ok(res.compatibleGroups.includes('O_Negative'))
		})

		it('A-Positive recipient receives A and AB plasma, but NOT B or O plasma', () => {
			const res = getCompatibleDonorGroups({
				recipientGroup: 'A_Positive',
				componentType: 'Fresh_Frozen_Plasma',
			})
			assert.deepStrictEqual(res.compatibleGroups, [
				'A_Positive',
				'A_Negative',
				'AB_Positive',
				'AB_Negative',
			])

			// Verify B plasma is incompatible for A recipient
			const bEval = evaluateCompatibility({
				recipientGroup: 'A_Positive',
				donorGroup: 'B_Positive',
				componentType: 'Fresh_Frozen_Plasma',
			})
			assert.strictEqual(bEval.isCompatible, false)
		})
	})

	describe('5. Platelet Concentrate & Cryoprecipitate Rules', () => {
		it('Platelets: identical group is always preferred for all 8 blood groups', () => {
			for (const group of VALID_BLOOD_GROUPS) {
				const res = getCompatibleDonorGroups({
					recipientGroup: group,
					componentType: 'Platelet_Concentrate',
				})
				assert.strictEqual(res.preferredGroup, group)
				assert.ok(res.compatibleGroups.includes(group))
				assert.strictEqual(res.governance.requiresMedicalOfficerApprovalForAlternatives, true)
			}
		})

		it('Platelets: flags Rh immune globulin recommendation for Rh-negative recipient receiving Rh-positive platelets', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'A_Negative',
				donorGroup: 'A_Positive',
				componentType: 'Platelet_Concentrate',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.rhRiskAssessment.hasRhMismatch, true)
			assert.strictEqual(
				evalResult.rhRiskAssessment.rhImmuneGlobulinRecommended,
				true
			)
			assert.ok(typeof evalResult.rhRiskAssessment.clinicalAdvisory === 'string')
			assert.match(
				evalResult.rhRiskAssessment.clinicalAdvisory,
				/CLINICAL ADVISORY ONLY.*Not an automated treatment instruction/i
			)
			assert.strictEqual(evalResult.requiresMedicalOfficerApproval, true)
			assert.strictEqual(evalResult.governance.requiresMedicalOfficerApproval, true)
			assert.strictEqual(evalResult.governance.cannotIssuePrescriptionOrOrder, true)
			assert.strictEqual(
				evalResult.governance.clinicalGovernance,
				'Pending_Medical_Officer_Approval'
			)
			assert.match(
				evalResult.rhRiskAssessment.riskDescription,
				/anti-D alloimmunization risk.*anti-D prophylaxis/i
			)
			assert.match(
				evalResult.governance.approvalRationale,
				/anti-D prophylaxis evaluation/i
			)
		})

		it('Platelets: out-of-group identical-Rh platelet transfusion requires MO approval for plasma antibodies', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'A_Positive',
				donorGroup: 'AB_Positive',
				componentType: 'Platelet_Concentrate',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Compatible_Alternative')
			assert.strictEqual(evalResult.governance.requiresMedicalOfficerApproval, true)
			assert.match(evalResult.governance.approvalRationale, /Out-of-group platelet transfusion/i)
		})

		it('Platelets: identical group with concordant Rh does NOT require special MO override', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'O_Positive',
				donorGroup: 'O_Positive',
				componentType: 'Platelet_Concentrate',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Identical')
			assert.strictEqual(evalResult.governance.requiresMedicalOfficerApproval, false)
		})

		it('Cryoprecipitate: identical group is always preferred and non-identical requires MO approval', () => {
			for (const group of VALID_BLOOD_GROUPS) {
				const res = getCompatibleDonorGroups({
					recipientGroup: group,
					componentType: 'Cryoprecipitate',
				})
				assert.strictEqual(res.preferredGroup, group)
				assert.strictEqual(res.governance.requiresMedicalOfficerApprovalForAlternatives, true)
				assert.ok(typeof res.unresolvedInstitutionalDecision === 'string')
			}
		})

		it('Cryoprecipitate: non-identical allocation flags requiresMedicalOfficerApproval: true and approvalRationale', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'A_Positive',
				donorGroup: 'AB_Positive',
				componentType: 'Cryoprecipitate',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Compatible_Alternative')
			assert.strictEqual(evalResult.governance.requiresMedicalOfficerApproval, true)
			assert.match(
				evalResult.governance.approvalRationale,
				/requires institutional Medical Officer approval to evaluate pediatric risk and isohemagglutinin load/i
			)
		})

		it('Cryoprecipitate: identical allocation does NOT require special MO alternative override', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'B_Positive',
				donorGroup: 'B_Positive',
				componentType: 'Cryoprecipitate',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Identical')
			assert.strictEqual(evalResult.governance.requiresMedicalOfficerApproval, false)
		})
	})

	describe('6. Comprehensive evaluateCompatibility Testing & Governance', () => {
		it('evaluates Identical match quality and detailed explanation', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'O_Positive',
				donorGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Identical')
			assert.strictEqual(evalResult.governance.ruleVersion, COMPATIBILITY_SPEC_VERSION)
			assert.strictEqual(evalResult.governance.clinicalAuthority, CLINICAL_AUTHORITY)
			assert.strictEqual(evalResult.governance.requiresLaboratoryCrossmatch, true)
			assert.strictEqual(evalResult.governance.isAuthoritativeClinicalDecision, false)
			assert.strictEqual(evalResult.governance.isPresumptiveImmunohematologyCheck, true)
			assert.strictEqual(evalResult.governance.cannotAuthorizeDispatch, true)
			assert.match(evalResult.clinicalExplanation, /exact identical match/i)
		})

		it('evaluates Compatible_Alternative match quality', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'A_Positive',
				donorGroup: 'O_Negative',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.strictEqual(evalResult.isCompatible, true)
			assert.strictEqual(evalResult.matchQuality, 'Compatible_Alternative')
			assert.match(evalResult.clinicalExplanation, /recognized compatible alternative/i)
		})

		it('evaluates Incompatible match quality with clinical warning', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'O_Negative',
				donorGroup: 'A_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.strictEqual(evalResult.isCompatible, false)
			assert.strictEqual(evalResult.matchQuality, 'Incompatible')
			assert.match(evalResult.clinicalExplanation, /clinically contraindicated/i)
		})

		it('flags severe Rh risk when transfusing Rh-positive PRBCs into Rh-negative recipient', () => {
			const evalResult = evaluateCompatibility({
				recipientGroup: 'O_Negative',
				donorGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			assert.strictEqual(evalResult.isCompatible, false)
			assert.strictEqual(evalResult.rhRiskAssessment.hasRhMismatch, true)
			assert.match(evalResult.rhRiskAssessment.riskDescription, /SEVERE RISK/i)
		})

		it('throws UNSUPPORTED_COMPONENT_TYPE on unrecognized component', () => {
			assert.throws(
				() =>
					evaluateCompatibility({
						recipientGroup: 'A_Positive',
						donorGroup: 'A_Positive',
						componentType: 'Granulocyte_Concentrate',
					}),
				(err) => err.code === 'UNSUPPORTED_COMPONENT_TYPE'
			)
		})
	})

	describe('7. validateUnitCompatibility & Phase 3 Clinical Safeguards Integration', () => {
		const mockUnitId = new mongoose.Types.ObjectId()
		const now = new Date('2026-10-31T12:00:00.000Z')

		function createTestUnit(overrides = {}) {
			return {
				_id: mockUnitId,
				unitNumber: 'W42002600001',
				bloodGroup: 'O_Negative',
				componentType: 'Packed_Red_Blood_Cells',
				status: 'Available',
				expiryDate: new Date('2026-11-30T12:00:00.000Z'), // Future
				clearance: {
					isVerified: true,
					verifiedAt: new Date('2026-10-30T10:00:00.000Z'),
					notes: 'Verified by Medical Officer',
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
				reservation: {
					receiveRequestId: null,
					reservedExpiresAt: null,
				},
				...overrides,
			}
		}

		it('valid unit passes all safety gates and is eligible for allocation', () => {
			const unit = createTestUnit()
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, true)
			assert.strictEqual(res.isImmunoCompatible, true)
			assert.strictEqual(res.hasPassedAllSafetyGates, true)
			assert.strictEqual(res.failedSafetyGates.length, 0)
			assert.strictEqual(res.matchQuality, 'Compatible_Alternative')
			assert.strictEqual(res.governance.isAuthoritativeClinicalDecision, false)
			assert.strictEqual(res.governance.isPresumptiveImmunohematologyCheck, true)
			assert.strictEqual(res.governance.cannotAuthorizeDispatch, true)
			assert.strictEqual(res.governance.cannotIssuePrescriptionOrOrder, true)
			assert.strictEqual(res.governance.requiresLaboratoryCrossmatch, true)
			assert.strictEqual(res.governance.clinicalGovernance, 'Presumptive_Check_Completed')
			assert.strictEqual(res.requiresMedicalOfficerApproval, false)
		})

		it('rejects allocation if unit status is Quarantined', () => {
			const unit = createTestUnit({ status: 'Quarantined' })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes("Unit status is 'Quarantined'")))
		})

		it('rejects allocation if Medical Officer clearance is missing or isVerified: false', () => {
			const unit = createTestUnit({ clearance: { isVerified: false } })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('Medical Officer quality verification is missing')))
		})

		it('rejects allocation if clearance object is null or missing entirely', () => {
			const unit = createTestUnit({ clearance: null })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('Medical Officer quality verification is missing')))
		})

		it('rejects allocation if unit is clinically expired', () => {
			const expiredDate = new Date('2026-10-25T12:00:00.000Z') // Past
			const unit = createTestUnit({ expiryDate: expiredDate })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('Unit is expired or expiry date is invalid')))
		})

		it('rejects allocation if expiryDate is missing or malformed', () => {
			const unit = createTestUnit({ expiryDate: 'invalid-date-string' })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('expiry date is invalid')))
		})

		it('rejects allocation if any mandatory TTI test is not Non_Reactive', () => {
			const unit = createTestUnit({
				testing: {
					hiv: 'Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(
				res.failedSafetyGates.some(
					(g) => g.includes("screening test 'hiv' is 'Reactive'")
				)
			)
		})

		it('rejects allocation if testing object is null or missing a mandatory test', () => {
			const unitNoTesting = createTestUnit({ testing: null })
			const resNoTesting = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unitNoTesting,
				now,
			})
			assert.strictEqual(resNoTesting.isEligibleForAllocation, false)
			assert.ok(resNoTesting.failedSafetyGates.some((g) => g.includes('screening panel is missing')))

			const unitIncompleteTesting = createTestUnit({
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					// malaria omitted
				},
			})
			const resIncomplete = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unitIncompleteTesting,
				now,
			})
			assert.strictEqual(resIncomplete.isEligibleForAllocation, false)
			assert.ok(resIncomplete.failedSafetyGates.some((g) => g.includes("'malaria' is 'missing'")))
		})

		it('rejects allocation if unit is currently reserved under an active hold', () => {
			const unit = createTestUnit({
				reservation: {
					receiveRequestId: new mongoose.Types.ObjectId(),
					reservedExpiresAt: new Date('2026-10-31T18:00:00.000Z'), // Active hold
				},
			})
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.hasPassedAllSafetyGates, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('reserved under an active hold')))
		})

		it('rejects allocation if unit is immunologically incompatible despite passing clearance', () => {
			const unit = createTestUnit({ bloodGroup: 'B_Positive' })
			const res = validateUnitCompatibility({
				recipientGroup: 'O_Negative',
				bloodUnit: unit,
				now,
			})

			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.isImmunoCompatible, false)
			assert.strictEqual(res.matchQuality, 'Incompatible')
			assert.ok(res.failedSafetyGates.some((g) => g.includes('Immunologically incompatible')))
		})

		it('safely rejects unit with null, undefined, or invalid bloodGroup without crashing', () => {
			const unitNullGroup = createTestUnit({ bloodGroup: null })
			const resNull = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unitNullGroup,
				now,
			})
			assert.strictEqual(resNull.isEligibleForAllocation, false)
			assert.strictEqual(resNull.isImmunoCompatible, false)
			assert.ok(resNull.failedSafetyGates.some((g) => g.includes('invalid or unrecognized blood group')))

			const unitBadGroup = createTestUnit({ bloodGroup: 'Z_Unknown' })
			const resBad = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unitBadGroup,
				now,
			})
			assert.strictEqual(resBad.isEligibleForAllocation, false)
			assert.strictEqual(resBad.isImmunoCompatible, false)
			assert.ok(resBad.failedSafetyGates.some((g) => g.includes('invalid or unrecognized blood group')))
		})

		it('safely rejects unit with unsupported componentType without crashing', () => {
			const unitBadComp = createTestUnit({ componentType: 'Granulocyte_Unit' })
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: unitBadComp,
				now,
			})
			assert.strictEqual(res.isEligibleForAllocation, false)
			assert.strictEqual(res.isImmunoCompatible, false)
			assert.ok(res.failedSafetyGates.some((g) => g.includes('unsupported component type')))
		})

		it('flags requiresMedicalOfficerApproval: true when allocating non-identical Cryoprecipitate', () => {
			const cryoUnit = createTestUnit({
				bloodGroup: 'AB_Positive',
				componentType: 'Cryoprecipitate',
			})
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Positive',
				bloodUnit: cryoUnit,
				now,
			})
			assert.strictEqual(res.isImmunoCompatible, true)
			assert.strictEqual(res.isEligibleForAllocation, true)
			assert.strictEqual(res.governance.requiresMedicalOfficerApproval, true)
		})

		it('flags requiresMedicalOfficerApproval: true when allocating Rh-positive platelets to Rh-negative recipient', () => {
			const plateletUnit = createTestUnit({
				bloodGroup: 'A_Positive',
				componentType: 'Platelet_Concentrate',
			})
			const res = validateUnitCompatibility({
				recipientGroup: 'A_Negative',
				bloodUnit: plateletUnit,
				now,
			})
			assert.strictEqual(res.isImmunoCompatible, true)
			assert.strictEqual(res.isEligibleForAllocation, true)
			assert.strictEqual(res.governance.requiresMedicalOfficerApproval, true)
		})

		it('throws INVALID_BLOOD_UNIT if bloodUnit object is missing or non-object', () => {
			assert.throws(
				() =>
					validateUnitCompatibility({
						recipientGroup: 'A_Positive',
						bloodUnit: null,
					}),
				(err) => err.code === 'INVALID_BLOOD_UNIT'
			)
			assert.throws(
				() =>
					validateUnitCompatibility({
						recipientGroup: 'A_Positive',
						bloodUnit: 'not-a-unit',
					}),
				(err) => err.code === 'INVALID_BLOOD_UNIT'
			)
		})

		it('throws INVALID_BLOOD_GROUP if recipientGroup is missing or invalid', () => {
			const unit = createTestUnit()
			assert.throws(
				() =>
					validateUnitCompatibility({
						recipientGroup: null,
						bloodUnit: unit,
					}),
				(err) => err.code === 'INVALID_BLOOD_GROUP'
			)
			assert.throws(
				() =>
					validateUnitCompatibility({
						recipientGroup: 'X_Negative',
						bloodUnit: unit,
					}),
				(err) => err.code === 'UNRECOGNIZED_BLOOD_GROUP'
			)
		})
	})
})

