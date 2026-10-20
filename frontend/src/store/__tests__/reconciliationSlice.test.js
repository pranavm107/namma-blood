import reconciliationReducer, {
	fetchReconciliationReport,
	executeReconciliationMigration,
	fetchReconciliationHistory,
	clearMigrationResult,
	clearReconciliationError,
	clearReconciliationSuccessMessage,
} from '../reconciliationSlice'

describe('reconciliationSlice', () => {
	const initialState = {
		report: null,
		migrationResult: null,
		history: [],
		historyTotal: 0,
		isReportLoading: false,
		isMigrationSubmitting: false,
		isHistoryLoading: false,
		error: null,
		successMessage: null,
	}

	it('returns initial state for unknown action', () => {
		expect(reconciliationReducer(undefined, { type: undefined })).toEqual(initialState)
	})

	describe('clear reducers', () => {
		it('clears migration result', () => {
			const state = { ...initialState, migrationResult: { mode: 'DRY_RUN' } }
			const nextState = reconciliationReducer(state, clearMigrationResult())
			expect(nextState.migrationResult).toBeNull()
		})

		it('clears error', () => {
			const state = { ...initialState, error: 'Reconciliation failed' }
			const nextState = reconciliationReducer(state, clearReconciliationError())
			expect(nextState.error).toBeNull()
		})

		it('clears success message', () => {
			const state = { ...initialState, successMessage: 'Dry run completed' }
			const nextState = reconciliationReducer(state, clearReconciliationSuccessMessage())
			expect(nextState.successMessage).toBeNull()
		})
	})

	describe('fetchReconciliationReport async lifecycle', () => {
		it('sets isReportLoading on pending', () => {
			const nextState = reconciliationReducer(initialState, {
				type: fetchReconciliationReport.pending.type,
			})
			expect(nextState.isReportLoading).toBe(true)
			expect(nextState.error).toBeNull()
		})

		it('stores report on fulfilled', () => {
			const payload = {
				batchId: 'REC-AUDIT-123',
				isClean: true,
				summary: { legacyTotal: 20, traceableTotal: 15 },
				perGroupDetails: [],
				discrepancies: [],
			}
			const nextState = reconciliationReducer(
				{ ...initialState, isReportLoading: true },
				{ type: fetchReconciliationReport.fulfilled.type, payload }
			)
			expect(nextState.isReportLoading).toBe(false)
			expect(nextState.report).toEqual(payload)
		})

		it('sets error on rejected', () => {
			const nextState = reconciliationReducer(
				{ ...initialState, isReportLoading: true },
				{
					type: fetchReconciliationReport.rejected.type,
					payload: { message: 'Database connection failed' },
				}
			)
			expect(nextState.isReportLoading).toBe(false)
			expect(nextState.error).toBe('Database connection failed')
		})
	})

	describe('executeReconciliationMigration async lifecycle', () => {
		it('sets isMigrationSubmitting on pending', () => {
			const nextState = reconciliationReducer(initialState, {
				type: executeReconciliationMigration.pending.type,
			})
			expect(nextState.isMigrationSubmitting).toBe(true)
			expect(nextState.error).toBeNull()
		})

		it('handles successful DRY_RUN simulation without claiming live migration', () => {
			const payload = {
				batchId: 'MIG-DRY-456',
				mode: 'DRY_RUN',
				status: 'COMPLETED',
				isExecutable: true,
				summary: { validToMigrate: 5, failedValidationCount: 0 },
			}
			const nextState = reconciliationReducer(
				{ ...initialState, isMigrationSubmitting: true },
				{ type: executeReconciliationMigration.fulfilled.type, payload }
			)
			expect(nextState.isMigrationSubmitting).toBe(false)
			expect(nextState.migrationResult).toEqual(payload)
			expect(nextState.successMessage).toBe('Dry-run validation completed successfully.')
		})

		it('handles successful EXECUTE live migration', () => {
			const payload = {
				batchId: 'MIG-EXEC-789',
				mode: 'EXECUTE',
				status: 'COMPLETED',
				migratedCount: 5,
			}
			const nextState = reconciliationReducer(
				{ ...initialState, isMigrationSubmitting: true },
				{ type: executeReconciliationMigration.fulfilled.type, payload }
			)
			expect(nextState.isMigrationSubmitting).toBe(false)
			expect(nextState.migrationResult).toEqual(payload)
			expect(nextState.successMessage).toBe('Successfully migrated 5 unit(s).')
		})
	})

	describe('fetchReconciliationHistory async lifecycle', () => {
		it('sets isHistoryLoading on pending', () => {
			const nextState = reconciliationReducer(initialState, {
				type: fetchReconciliationHistory.pending.type,
			})
			expect(nextState.isHistoryLoading).toBe(true)
		})

		it('stores history records on fulfilled', () => {
			const payload = {
				records: [{ _id: 'rec-1', batchId: 'REC-001', mode: 'EXECUTE' }],
				total: 1,
			}
			const nextState = reconciliationReducer(
				{ ...initialState, isHistoryLoading: true },
				{ type: fetchReconciliationHistory.fulfilled.type, payload }
			)
			expect(nextState.isHistoryLoading).toBe(false)
			expect(nextState.history).toEqual(payload.records)
			expect(nextState.historyTotal).toBe(1)
		})
	})
})
