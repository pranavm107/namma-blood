import emergencyReducer, {
	setEmergencyFilters,
	resetEmergencyFilters,
	clearMatchingData,
	clearCreationState,
	discoverEmergencyDonors,
	discoverEmergencyBloodbanks,
	getEmergencyRequestMatches,
	submitEmergencyBloodRequest,
} from '../emergencySlice'

describe('emergencySlice', () => {
	const initialState = {
		donorDiscovery: {
			data: [],
			pagination: {
				totalCount: 0,
				page: 1,
				limit: 10,
				totalPages: 0,
				hasNextPage: false,
				hasPrevPage: false,
			},
			clinicalNotice: '',
			isLoading: false,
			error: null,
		},
		bloodbankDiscovery: {
			data: [],
			pagination: {
				totalCount: 0,
				page: 1,
				limit: 10,
				totalPages: 0,
				hasNextPage: false,
				hasPrevPage: false,
			},
			governanceNotice: '',
			isLoading: false,
			error: null,
		},
		matching: {
			requestId: null,
			requestNumber: null,
			requestDetails: null,
			unmetUnits: null,
			matchingSummary: null,
			governanceNotice: '',
			donorStream: {
				candidates: [],
				pagination: {
					totalCount: 0,
					page: 1,
					limit: 10,
					totalPages: 0,
					hasNextPage: false,
					hasPrevPage: false,
				},
				isLoading: false,
			},
			bankStream: {
				candidates: [],
				pagination: {
					totalCount: 0,
					page: 1,
					limit: 10,
					totalPages: 0,
					hasNextPage: false,
					hasPrevPage: false,
				},
				isLoading: false,
			},
			isLoading: false,
			error: null,
		},
		creation: {
			isLoading: false,
			error: null,
			createdTicket: null,
			success: false,
		},
		filters: {
			bloodGroup: 'B_Positive',
			componentType: 'Packed_Red_Blood_Cells',
			radiusKm: 15,
			latitude: null,
			longitude: null,
			city: '',
			state: 'Tamil Nadu',
			useGps: false,
		},
	}

	it('returns initial state when called with undefined state', () => {
		expect(emergencyReducer(undefined, { type: undefined })).toEqual(initialState)
	})

	describe('Synchronous Reducers', () => {
		it('updates filters with setEmergencyFilters', () => {
			const updated = emergencyReducer(
				initialState,
				setEmergencyFilters({ bloodGroup: 'O_Negative', radiusKm: 35, city: 'Madurai' })
			)
			expect(updated.filters.bloodGroup).toBe('O_Negative')
			expect(updated.filters.radiusKm).toBe(35)
			expect(updated.filters.city).toBe('Madurai')
			expect(updated.filters.state).toBe('Tamil Nadu') // preserves existing
		})

		it('resets filters with resetEmergencyFilters', () => {
			const modifiedState = {
				...initialState,
				filters: {
					...initialState.filters,
					bloodGroup: 'AB_Positive',
					radiusKm: 50,
				},
			}
			const reset = emergencyReducer(modifiedState, resetEmergencyFilters())
			expect(reset.filters).toEqual(initialState.filters)
		})

		it('clears matching state with clearMatchingData', () => {
			const activeMatchingState = {
				...initialState,
				matching: {
					...initialState.matching,
					requestId: '6aed932b2debf35b705967bd',
					requestNumber: 'EMG-20261106-QA4301',
					donorStream: {
						candidates: [{ pseudonymousDonorId: 'DNR-ABCD' }],
						pagination: { totalCount: 1, page: 1, limit: 10, totalPages: 1 },
						isLoading: false,
					},
				},
			}
			const cleared = emergencyReducer(activeMatchingState, clearMatchingData())
			expect(cleared.matching.requestId).toBeNull()
			expect(cleared.matching.requestNumber).toBeNull()
			expect(cleared.matching.donorStream.candidates).toEqual([])
		})

		it('clears creation state with clearCreationState', () => {
			const createdState = {
				...initialState,
				creation: {
					isLoading: false,
					error: 'Some error',
					createdTicket: { requestNumber: 'EMG-12345' },
					success: true,
				},
			}
			const cleared = emergencyReducer(createdState, clearCreationState())
			expect(cleared.creation.success).toBe(false)
			expect(cleared.creation.error).toBeNull()
			expect(cleared.creation.createdTicket).toBeNull()
		})
	})

	describe('Async Thunk: discoverEmergencyDonors', () => {
		it('handles discoverEmergencyDonors.pending', () => {
			const state = emergencyReducer(initialState, {
				type: discoverEmergencyDonors.pending.type,
			})
			expect(state.donorDiscovery.isLoading).toBe(true)
			expect(state.donorDiscovery.error).toBeNull()
		})

		it('handles discoverEmergencyDonors.fulfilled with candidate donors and clinical notice', () => {
			const mockPayload = {
				data: [
					{
						pseudonymousDonorId: 'DNR-A1B2C3D4E5F60718293A4B5C6D7E8F90',
						bloodGroup: 'B_Positive',
						matchQuality: 'Exact_Match',
						distanceKm: 4.82,
						clinicalEvaluationStatus: 'Pending_Clinical_Evaluation',
					},
				],
				pagination: {
					totalCount: 1,
					page: 1,
					limit: 10,
					totalPages: 1,
					hasNextPage: false,
					hasPrevPage: false,
				},
				clinicalNotice: 'Tier 3 prospective discovery. Donor contact requires clinical authorization.',
			}

			const state = emergencyReducer(initialState, {
				type: discoverEmergencyDonors.fulfilled.type,
				payload: mockPayload,
			})

			expect(state.donorDiscovery.isLoading).toBe(false)
			expect(state.donorDiscovery.data).toHaveLength(1)
			expect(state.donorDiscovery.data[0].clinicalEvaluationStatus).toBe('Pending_Clinical_Evaluation')
			expect(state.donorDiscovery.clinicalNotice).toContain('Tier 3 prospective discovery')
		})

		it('handles discoverEmergencyDonors.rejected', () => {
			const state = emergencyReducer(initialState, {
				type: discoverEmergencyDonors.rejected.type,
				payload: { message: 'Geospatial lookup failed' },
			})
			expect(state.donorDiscovery.isLoading).toBe(false)
			expect(state.donorDiscovery.error).toBe('Geospatial lookup failed')
		})
	})

	describe('Async Thunk: discoverEmergencyBloodbanks', () => {
		it('handles discoverEmergencyBloodbanks.fulfilled preserving null on Inventory_Unverified', () => {
			const mockPayload = {
				data: [
					{
						bloodBankId: '65239a0b1234567890abcdef',
						bloodBankName: 'Adayar Community Blood Bank',
						pseudonymousFacilityRef: 'BB-9876543210AB',
						distanceKm: 3.2,
						inventoryState: 'Inventory_Unverified',
						verifiedUnitsAvailable: null, // Critical: must NOT be converted to 0
					},
					{
						bloodBankId: '65239a0b1234567890abcdeg',
						bloodBankName: 'Adyar Lifeline Blood Centre',
						pseudonymousFacilityRef: 'BB-1234567890CD',
						distanceKm: 5.1,
						inventoryState: 'Verified_Bloodbank_Stock_Match',
						verifiedUnitsAvailable: 3,
					},
				],
				pagination: {
					totalCount: 2,
					page: 1,
					limit: 10,
					totalPages: 1,
					hasNextPage: false,
					hasPrevPage: false,
				},
				governanceNotice: 'Verified blood bank stock match does not constitute unit reservation.',
			}

			const state = emergencyReducer(initialState, {
				type: discoverEmergencyBloodbanks.fulfilled.type,
				payload: mockPayload,
			})

			expect(state.bloodbankDiscovery.isLoading).toBe(false)
			expect(state.bloodbankDiscovery.data).toHaveLength(2)
			expect(state.bloodbankDiscovery.data[0].inventoryState).toBe('Inventory_Unverified')
			expect(state.bloodbankDiscovery.data[0].verifiedUnitsAvailable).toBeNull()
			expect(state.bloodbankDiscovery.data[1].verifiedUnitsAvailable).toBe(3)
		})
	})

	describe('Async Thunk: getEmergencyRequestMatches (Dual Stream)', () => {
		it('handles getEmergencyRequestMatches.fulfilled with independent pagination', () => {
			const mockPayload = {
				requestId: '6aed932b2debf35b705967bd',
				requestNumber: 'EMG-20261106-QA4301',
				requestDetails: {
					patientBloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					unitsRequested: 2,
					urgencyLevel: 'Critical',
					hospitalName: 'Apollo Speciality Hospital',
				},
				unmetUnits: 2,
				matchingSummary: {
					totalDonorsAvailable: 1,
					totalBloodBankUnitsAvailable: 0,
					overallFulfillmentPossible: false,
				},
				donorStream: {
					candidates: [
						{
							pseudonymousDonorId: 'DNR-A1B2C3D4E5F60718293A4B5C6D7E8F90',
							bloodGroup: 'B_Positive',
							matchQuality: 'Exact_Match',
							distanceKm: 4.82,
							clinicalEvaluationStatus: 'Pending_Clinical_Evaluation',
						},
					],
					pagination: {
						totalCount: 1,
						page: 1,
						limit: 10,
						totalPages: 1,
						hasNextPage: false,
						hasPrevPage: false,
					},
				},
				bankStream: {
					candidates: [],
					pagination: {
						totalCount: 0,
						page: 1,
						limit: 10,
						totalPages: 0,
						hasNextPage: false,
						hasPrevPage: false,
					},
				},
				governanceNotice: 'PROSPECTIVE MATCHING ONLY: Donor prospect identification constitutes Tier 3 candidate discovery.',
			}

			const state = emergencyReducer(initialState, {
				type: getEmergencyRequestMatches.fulfilled.type,
				payload: mockPayload,
			})

			expect(state.matching.isLoading).toBe(false)
			expect(state.matching.requestId).toBe('6aed932b2debf35b705967bd')
			expect(state.matching.requestNumber).toBe('EMG-20261106-QA4301')
			expect(state.matching.donorStream.candidates).toHaveLength(1)
			expect(state.matching.donorStream.candidates[0].clinicalEvaluationStatus).toBe(
				'Pending_Clinical_Evaluation'
			)
			expect(state.matching.bankStream.candidates).toHaveLength(0)
			expect(state.matching.governanceNotice).toContain('PROSPECTIVE MATCHING ONLY')
		})

		it('handles getEmergencyRequestMatches.rejected cleanly', () => {
			const state = emergencyReducer(initialState, {
				type: getEmergencyRequestMatches.rejected.type,
				payload: { message: 'Emergency request not found' },
			})

			expect(state.matching.isLoading).toBe(false)
			expect(state.matching.error).toBe('Emergency request not found')
			expect(state.matching.donorStream.candidates).toEqual([])
			expect(state.matching.bankStream.candidates).toEqual([])
		})
	})
})

