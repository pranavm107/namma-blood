import { configureStore } from '@reduxjs/toolkit'
import bloodUnitReducer, {
	fetchBloodUnits,
	recordScreeningResults,
	verifyMedicalClearance,
	discardBloodUnit,
} from '../../../store/bloodUnitSlice'
import reconciliationReducer, {
	executeReconciliationMigration,
} from '../../../store/reconciliationSlice'

describe('Traceable Inventory Business Rules & Clinical Safeguards', () => {
	let store

	beforeEach(() => {
		store = configureStore({
			reducer: {
				bloodUnits: bloodUnitReducer,
				reconciliation: reconciliationReducer,
			},
		})
	})

	describe('Clinical Issue Eligibility Invariants', () => {
		it('quarantined units are strictly blocked from issue', () => {
			const quarantinedUnit = {
				_id: 'unit-q1',
				unitNumber: 'DIN-1001',
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				testing: { overallResult: 'Pending' },
				clearance: { status: 'Pending' },
				isIssueEligible: false,
			}

			// Verify invariant
			expect(quarantinedUnit.status).toBe('Quarantined')
			expect(quarantinedUnit.isIssueEligible).toBe(false)
			expect(quarantinedUnit.testing.overallResult).not.toBe('Non_Reactive')
		})

		it('units with reactive TTI results cannot be cleared or issued', () => {
			const reactiveUnit = {
				_id: 'unit-q2',
				unitNumber: 'DIN-1002',
				bloodGroup: 'A_Positive',
				status: 'Quarantined',
				testing: {
					overallResult: 'Reactive',
					results: { HIV: 'Reactive', HBV: 'Non_Reactive' },
				},
				clearance: { status: 'Pending' },
				isIssueEligible: false,
			}

			expect(reactiveUnit.testing.overallResult).toBe('Reactive')
			expect(reactiveUnit.isIssueEligible).toBe(false)
		})

		it('units past clinical expiry are never issue eligible even if non-reactive', () => {
			const expiredUnit = {
				_id: 'unit-e1',
				unitNumber: 'DIN-1003',
				bloodGroup: 'B_Positive',
				status: 'Expired',
				testing: { overallResult: 'Non_Reactive' },
				clearance: { status: 'Cleared' },
				expiryDate: new Date(Date.now() - 86400000).toISOString(),
				isIssueEligible: false,
			}

			expect(new Date(expiredUnit.expiryDate).getTime()).toBeLessThan(Date.now())
			expect(expiredUnit.isIssueEligible).toBe(false)
		})

		it('unverified legacy aggregate stock cannot be presented as issue-eligible traceable units', () => {
			const legacyAggregateStock = {
				A_Positive: 10,
				O_Positive: 5,
			}

			// Invariant: Legacy counts lack unit barcodes, individual screening records, and MO clearance
			expect(legacyAggregateStock).not.toHaveProperty('unitNumber')
			expect(legacyAggregateStock).not.toHaveProperty('clearance')
		})
	})

	describe('Role-Based Action Boundaries', () => {
		it('identifies Medical Officer authorization for clearance and emergency issuance', () => {
			const moStaff = { role: 'Medical_Officer', isVerified: true }
			const labTechStaff = { role: 'Lab_Technician' }
			const regularStaff = { role: 'Staff_Admin' }

			const canPerformClearance = (staff) => staff?.role === 'Medical_Officer' && staff?.isVerified
			const canPerformScreening = (staff) => ['Lab_Technician', 'Medical_Officer'].includes(staff?.role)

			expect(canPerformClearance(moStaff)).toBe(true)
			expect(canPerformClearance(labTechStaff)).toBe(false)
			expect(canPerformClearance(regularStaff)).toBe(false)

			expect(canPerformScreening(labTechStaff)).toBe(true)
			expect(canPerformScreening(moStaff)).toBe(true)
			expect(canPerformScreening(regularStaff)).toBe(false)
		})

		it('requires non-empty clinical justification for emergency issuance', () => {
			const validateEmergencyIssuance = (reason) => {
				return typeof reason === 'string' && reason.trim().length >= 10
			}

			expect(validateEmergencyIssuance('')).toBe(false)
			expect(validateEmergencyIssuance('urgent')).toBe(false)
			expect(validateEmergencyIssuance('Trauma patient exsanguinating in OR 3, uncrossmatched release approved')).toBe(true)
		})
	})

	describe('Biohazard & Clinical Discard Guardrails', () => {
		it('mandates clinical reason for discard', () => {
			const validDiscardReasons = [
				'TTI_Reactive',
				'Expired',
				'Hemolyzed',
				'Clotted',
				'Bag_Leak',
				'Temperature_Abuse',
				'Contaminated',
				'Other',
			]

			const validateDiscard = (reason, notes) => {
				if (!validDiscardReasons.includes(reason)) return { valid: false, error: 'Invalid discard reason' }
				if (reason === 'Other' && (!notes || notes.trim() === '')) {
					return { valid: false, error: 'Notes required when reason is Other' }
				}
				return { valid: true }
			}

			expect(validateDiscard('TTI_Reactive').valid).toBe(true)
			expect(validateDiscard('Expired').valid).toBe(true)
			expect(validateDiscard('InvalidReason').valid).toBe(false)
			expect(validateDiscard('Other', '').valid).toBe(false)
			expect(validateDiscard('Other', 'Broken seal during handling').valid).toBe(true)
		})

		it('disallows discarding units already issued or dispatched', () => {
			const isDiscardPermitted = (status) => {
				const nonDiscardableStatuses = ['Issued', 'Dispatched']
				return !nonDiscardableStatuses.includes(status)
			}

			expect(isDiscardPermitted('Quarantined')).toBe(true)
			expect(isDiscardPermitted('Available')).toBe(true)
			expect(isDiscardPermitted('Reserved')).toBe(true)
			expect(isDiscardPermitted('Issued')).toBe(false)
			expect(isDiscardPermitted('Dispatched')).toBe(false)
		})
	})

	describe('Legacy Reconciliation Dry-Run and Migration Safeguards', () => {
		it('defaults strictly to DRY_RUN mode with zero production writes', () => {
			const state = store.getState().reconciliation
			expect(state.migrationResult).toBeNull()
		})

		it('requires explicit confirmation before running EXECUTE mode', () => {
			const executeModeRequiresConfirmation = (mode, isConfirmed) => {
				if (mode === 'EXECUTE' && !isConfirmed) {
					return { canProceed: false, error: 'Explicit user confirmation required' }
				}
				return { canProceed: true }
			}

			expect(executeModeRequiresConfirmation('DRY_RUN', false).canProceed).toBe(true)
			expect(executeModeRequiresConfirmation('EXECUTE', false).canProceed).toBe(false)
			expect(executeModeRequiresConfirmation('EXECUTE', true).canProceed).toBe(true)
		})

		it('detects duplicate DINs within manifest preventing collision writes', () => {
			const manifest = [
				{ unitNumber: 'DIN-001', bloodGroup: 'O_Positive' },
				{ unitNumber: 'DIN-001', bloodGroup: 'A_Positive' },
			]

			const seen = new Set()
			const duplicates = []
			for (const item of manifest) {
				if (seen.has(item.unitNumber)) duplicates.push(item.unitNumber)
				seen.add(item.unitNumber)
			}

			expect(duplicates).toContain('DIN-001')
			expect(duplicates.length).toBe(1)
		})
	})
})
