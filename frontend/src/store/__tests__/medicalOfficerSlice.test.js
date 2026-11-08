/**
 * Medical Officer Redux Slice Tests
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import medicalOfficerReducer, {
	setSelectedHospital,
	setRequestFilters,
	resetActiveRequest,
	clearConcurrencyConflict,
	clearRequesterAction,
	fetchVerifiedHospitals,
	fetchMedicalOfficerDashboard,
	fetchAssignedRequests,
	fetchRequestDetails,
	fetchVerificationHistory,
	approveEmergencyRequest,
	rejectEmergencyRequest,
	requestAdditionalInformation,
	provideAdditionalInformation,
} from '../medicalOfficerSlice'

describe('medicalOfficerSlice Reducer & Actions', () => {
	const initialState = {
		dashboard: {
			metrics: {
				pendingCount: 0,
				moreInfoCount: 0,
				verifiedCount: 0,
				rejectedCount: 0,
				totalCount: 0,
			},
			authorizedHospitals: [],
			hospitalBreakdown: [],
			selectedHospitalId: '',
			isLoading: false,
			error: null,
		},
		requests: {
			items: [],
			pagination: {
				page: 1,
				limit: 15,
				totalPages: 1,
				totalRecords: 0,
			},
			filters: {
				status: 'Pending_Verification',
				urgencyLevel: '',
				requiredBloodGroup: '',
				search: '',
				hospitalId: '',
			},
			isLoading: false,
			error: null,
		},
		activeRequest: {
			data: null,
			verificationHistory: [],
			isLoading: false,
			historyLoading: false,
			actionLoading: false,
			error: null,
			actionError: null,
			concurrencyConflict: false,
		},
		verifiedHospitals: {
			items: [],
			isLoading: false,
			error: null,
		},
		requesterAction: {
			isLoading: false,
			error: null,
			success: false,
		},
	}

	it('should return initial state when initialized with undefined', () => {
		const state = medicalOfficerReducer(undefined, { type: '@@INIT' })
		expect(state.dashboard.metrics.pendingCount).toBe(0)
		expect(state.dashboard.selectedHospitalId).toBe('')
		expect(state.requests.filters.status).toBe('Pending_Verification')
		expect(state.activeRequest.concurrencyConflict).toBe(false)
	})

	describe('Multi-Hospital Selection & Filtering', () => {
		it('should update selectedHospitalId explicitly and NEVER silently default to an arbitrary hospital', () => {
			const hospitalId = '6aedf1111111111111111111'
			const state = medicalOfficerReducer(initialState, setSelectedHospital(hospitalId))
			expect(state.dashboard.selectedHospitalId).toBe(hospitalId)
			expect(state.requests.filters.hospitalId).toBe(hospitalId)
		})

		it('should allow clearing hospital selection to view all authorized facilities', () => {
			const intermediateState = {
				...initialState,
				dashboard: { ...initialState.dashboard, selectedHospitalId: 'hosp-1' },
				requests: {
					...initialState.requests,
					filters: { ...initialState.requests.filters, hospitalId: 'hosp-1' },
				},
			}
			const state = medicalOfficerReducer(intermediateState, setSelectedHospital(''))
			expect(state.dashboard.selectedHospitalId).toBe('')
			expect(state.requests.filters.hospitalId).toBe('')
		})

		it('should update request queue filters (status, urgency, bloodGroup, search)', () => {
			const newFilters = {
				status: 'More_Information_Required',
				urgencyLevel: 'Critical',
				requiredBloodGroup: 'O_Positive',
				search: 'EMG-20261106',
			}
			const state = medicalOfficerReducer(initialState, setRequestFilters(newFilters))
			expect(state.requests.filters.status).toBe('More_Information_Required')
			expect(state.requests.filters.urgencyLevel).toBe('Critical')
			expect(state.requests.filters.requiredBloodGroup).toBe('O_Positive')
			expect(state.requests.filters.search).toBe('EMG-20261106')
		})
	})

	describe('Dashboard Metrics & Breakdown (fetchMedicalOfficerDashboard)', () => {
		it('handles fetchMedicalOfficerDashboard.pending', () => {
			const action = { type: fetchMedicalOfficerDashboard.pending.type }
			const state = medicalOfficerReducer(initialState, action)
			expect(state.dashboard.isLoading).toBe(true)
			expect(state.dashboard.error).toBeNull()
		})

		it('handles fetchMedicalOfficerDashboard.fulfilled with metrics & hospital breakdown', () => {
			const mockPayload = {
				metrics: {
					pendingCount: 4,
					moreInfoCount: 2,
					verifiedCount: 10,
					rejectedCount: 1,
					totalCount: 17,
				},
				authorizedHospitals: [
					{ _id: 'hosp-1', hospitalCode: 'HOSP-1', hospitalName: 'Apollo' },
					{ _id: 'hosp-2', hospitalCode: 'HOSP-2', hospitalName: 'Fortis' },
				],
				hospitalBreakdown: [
					{ hospitalId: 'hosp-1', hospitalName: 'Apollo', counts: { pending: 2, verified: 6 } },
					{ hospitalId: 'hosp-2', hospitalName: 'Fortis', counts: { pending: 2, verified: 4 } },
				],
			}
			const action = {
				type: fetchMedicalOfficerDashboard.fulfilled.type,
				payload: mockPayload,
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.dashboard.isLoading).toBe(false)
			expect(state.dashboard.metrics.pendingCount).toBe(4)
			expect(state.dashboard.metrics.verifiedCount).toBe(10)
			expect(state.dashboard.authorizedHospitals.length).toBe(2)
			expect(state.dashboard.hospitalBreakdown.length).toBe(2)
		})

		it('handles fetchMedicalOfficerDashboard.rejected', () => {
			const action = {
				type: fetchMedicalOfficerDashboard.rejected.type,
				payload: 'Hospital scope unauthorized or network failure',
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.dashboard.isLoading).toBe(false)
			expect(state.dashboard.error).toBe('Hospital scope unauthorized or network failure')
		})
	})

	describe('Assigned Requests Queue (fetchAssignedRequests)', () => {
		it('handles fetchAssignedRequests.fulfilled', () => {
			const mockRequests = [
				{
					_id: 'req-1',
					requestNumber: 'EMG-001',
					patientName: 'Devi Prasad',
					verificationStatus: 'Pending_Verification',
				},
			]
			const action = {
				type: fetchAssignedRequests.fulfilled.type,
				payload: {
					requests: mockRequests,
					pagination: { page: 1, limit: 15, totalPages: 1, totalRecords: 1 },
				},
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.requests.isLoading).toBe(false)
			expect(state.requests.items.length).toBe(1)
			expect(state.requests.items[0].patientName).toBe('Devi Prasad')
		})
	})

	describe('Verification Actions & Concurrency Conflict (HTTP 409)', () => {
		it('sets concurrencyConflict flag on HTTP 409 error during approval', () => {
			const action = {
				type: approveEmergencyRequest.rejected.type,
				payload: {
					status: 409,
					code: 'CONCURRENCY_CONFLICT',
					message: 'The request was updated by another session and must be refreshed.',
				},
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.activeRequest.actionLoading).toBe(false)
			expect(state.activeRequest.concurrencyConflict).toBe(true)
			expect(state.activeRequest.actionError).toContain('updated by another session')
		})

		it('sets concurrencyConflict flag on HTTP 409 error during rejection', () => {
			const action = {
				type: rejectEmergencyRequest.rejected.type,
				payload: {
					status: 409,
					code: 'CONCURRENCY_CONFLICT',
					message: 'Conflict',
				},
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.activeRequest.concurrencyConflict).toBe(true)
		})

		it('sets concurrencyConflict flag on HTTP 409 error during request-information', () => {
			const action = {
				type: requestAdditionalInformation.rejected.type,
				payload: {
					status: 409,
					code: 'CONCURRENCY_CONFLICT',
					message: 'Conflict',
				},
			}
			const state = medicalOfficerReducer(initialState, action)
			expect(state.activeRequest.concurrencyConflict).toBe(true)
		})

		it('clears concurrencyConflict flag on clearConcurrencyConflict action', () => {
			const conflictState = {
				...initialState,
				activeRequest: {
					...initialState.activeRequest,
					concurrencyConflict: true,
					actionError: 'Conflict error',
				},
			}
			const state = medicalOfficerReducer(conflictState, clearConcurrencyConflict())
			expect(state.activeRequest.concurrencyConflict).toBe(false)
			expect(state.activeRequest.actionError).toBeNull()
		})
	})

	describe('Requester Clarification Resubmission (provideAdditionalInformation)', () => {
		it('handles provideAdditionalInformation.pending, fulfilled, and rejected', () => {
			const pendingState = medicalOfficerReducer(initialState, {
				type: provideAdditionalInformation.pending.type,
			})
			expect(pendingState.requesterAction.isLoading).toBe(true)
			expect(pendingState.requesterAction.success).toBe(false)

			const fulfilledState = medicalOfficerReducer(pendingState, {
				type: provideAdditionalInformation.fulfilled.type,
				payload: { _id: 'req-1', verificationStatus: 'Pending_Verification' },
			})
			expect(fulfilledState.requesterAction.isLoading).toBe(false)
			expect(fulfilledState.requesterAction.success).toBe(true)

			const rejectedState = medicalOfficerReducer(pendingState, {
				type: provideAdditionalInformation.rejected.type,
				payload: { message: 'Submission failed due to invalid status.' },
			})
			expect(rejectedState.requesterAction.isLoading).toBe(false)
			expect(rejectedState.requesterAction.error).toBe('Submission failed due to invalid status.')
		})
	})
})

