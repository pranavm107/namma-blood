import bloodUnitReducer, {
	fetchBloodUnits,
	fetchBloodUnitById,
	recordScreeningResults,
	verifyMedicalClearance,
	recordCrossmatch,
	dispatchUnits,
	discardBloodUnit,
	clearSelectedUnit,
	clearUnitError,
	clearUnitSuccessMessage,
} from '../bloodUnitSlice'

describe('bloodUnitSlice', () => {
	const initialState = {
		units: [],
		total: 0,
		page: 1,
		limit: 10,
		totalPages: 1,
		selectedUnit: null,
		isLoading: false,
		isDetailLoading: false,
		isActionSubmitting: false,
		error: null,
		actionSuccessMessage: null,
	}

	it('returns initial state when passed an empty action', () => {
		expect(bloodUnitReducer(undefined, { type: undefined })).toEqual(initialState)
	})

	describe('clear reducers', () => {
		it('clears selectedUnit', () => {
			const state = { ...initialState, selectedUnit: { _id: 'unit-123' } }
			const nextState = bloodUnitReducer(state, clearSelectedUnit())
			expect(nextState.selectedUnit).toBeNull()
		})

		it('clears error', () => {
			const state = { ...initialState, error: 'Network error' }
			const nextState = bloodUnitReducer(state, clearUnitError())
			expect(nextState.error).toBeNull()
		})

		it('clears actionSuccessMessage', () => {
			const state = { ...initialState, actionSuccessMessage: 'Screening saved' }
			const nextState = bloodUnitReducer(state, clearUnitSuccessMessage())
			expect(nextState.actionSuccessMessage).toBeNull()
		})
	})

	describe('fetchBloodUnits async lifecycle', () => {
		it('sets isLoading on pending', () => {
			const nextState = bloodUnitReducer(initialState, { type: fetchBloodUnits.pending.type })
			expect(nextState.isLoading).toBe(true)
			expect(nextState.error).toBeNull()
		})

		it('updates units and pagination on fulfilled', () => {
			const payload = {
				units: [{ _id: 'u1', unitNumber: 'DIN-001', status: 'Available' }],
				total: 1,
				page: 1,
				limit: 10,
				totalPages: 1,
			}
			const nextState = bloodUnitReducer(
				{ ...initialState, isLoading: true },
				{ type: fetchBloodUnits.fulfilled.type, payload }
			)
			expect(nextState.isLoading).toBe(false)
			expect(nextState.units).toEqual(payload.units)
			expect(nextState.total).toBe(1)
		})

		it('sets error on rejected', () => {
			const nextState = bloodUnitReducer(
				{ ...initialState, isLoading: true },
				{
					type: fetchBloodUnits.rejected.type,
					payload: { message: 'Unauthorized access' },
				}
			)
			expect(nextState.isLoading).toBe(false)
			expect(nextState.error).toBe('Unauthorized access')
		})
	})

	describe('fetchBloodUnitById async lifecycle', () => {
		it('sets isDetailLoading on pending', () => {
			const nextState = bloodUnitReducer(initialState, { type: fetchBloodUnitById.pending.type })
			expect(nextState.isDetailLoading).toBe(true)
		})

		it('stores selectedUnit on fulfilled', () => {
			const unit = { _id: 'u1', unitNumber: 'DIN-001', status: 'Quarantined', auditHistory: [] }
			const nextState = bloodUnitReducer(
				{ ...initialState, isDetailLoading: true },
				{ type: fetchBloodUnitById.fulfilled.type, payload: unit }
			)
			expect(nextState.isDetailLoading).toBe(false)
			expect(nextState.selectedUnit).toEqual(unit)
		})
	})

	describe('recordScreeningResults', () => {
		it('sets actionSuccessMessage on fulfilled', () => {
			const state = {
				...initialState,
				isActionSubmitting: true,
			}
			const payload = {
				message: 'Screening results recorded.',
			}
			const nextState = bloodUnitReducer(state, {
				type: recordScreeningResults.fulfilled.type,
				payload,
			})
			expect(nextState.isActionSubmitting).toBe(false)
			expect(nextState.actionSuccessMessage).toBe('Screening results recorded.')
		})
	})

	describe('verifyMedicalClearance', () => {
		it('sets actionSuccessMessage on fulfilled', () => {
			const state = {
				...initialState,
				isActionSubmitting: true,
			}
			const payload = {
				message: 'Unit cleared and marked Available.',
			}
			const nextState = bloodUnitReducer(state, {
				type: verifyMedicalClearance.fulfilled.type,
				payload,
			})
			expect(nextState.isActionSubmitting).toBe(false)
			expect(nextState.actionSuccessMessage).toBe('Unit cleared and marked Available.')
		})
	})

	describe('discardBloodUnit', () => {
		it('sets actionSuccessMessage on fulfilled', () => {
			const state = {
				...initialState,
				isActionSubmitting: true,
			}
			const payload = {
				message: 'Unit discarded.',
			}
			const nextState = bloodUnitReducer(state, {
				type: discardBloodUnit.fulfilled.type,
				payload,
			})
			expect(nextState.isActionSubmitting).toBe(false)
			expect(nextState.actionSuccessMessage).toBe('Unit discarded.')
		})
	})

	describe('dispatchUnits', () => {
		it('sets actionSuccessMessage on fulfilled', () => {
			const state = {
				...initialState,
				isActionSubmitting: true,
			}
			const payload = {
				message: 'Units dispatched.',
			}
			const nextState = bloodUnitReducer(state, {
				type: dispatchUnits.fulfilled.type,
				payload,
			})
			expect(nextState.isActionSubmitting).toBe(false)
			expect(nextState.actionSuccessMessage).toBe('Units dispatched.')
		})
	})
})
