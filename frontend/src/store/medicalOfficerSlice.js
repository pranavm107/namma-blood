/**
 * Medical Officer Redux Slice
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Manages Medical Officer dashboards, hospital queues, verification reviews,
 * audit history timelines, and original requester clarification submissions.
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import axiosClient from '../api/axiosClient'

const initialState = {
	// 1. Dashboard Metrics & Scopes
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
		selectedHospitalId: '', // Empty means all authorized hospitals; never silently defaults to an arbitrary single facility
		isLoading: false,
		error: null,
	},

	// 2. Assigned Requests Queue
	requests: {
		items: [],
		pagination: {
			page: 1,
			limit: 15,
			totalPages: 1,
			totalRecords: 0,
		},
		filters: {
			status: 'Pending_Verification', // Default view
			urgencyLevel: '',
			requiredBloodGroup: '',
			search: '',
			hospitalId: '',
		},
		isLoading: false,
		error: null,
	},

	// 3. Single Request Review & Verification
	activeRequest: {
		data: null,
		verificationHistory: [],
		isLoading: false,
		historyLoading: false,
		actionLoading: false,
		error: null,
		actionError: null,
		concurrencyConflict: false, // Set to true on HTTP 409
	},

	// 4. Public / Authenticated Verified Hospital Registry
	verifiedHospitals: {
		items: [],
		isLoading: false,
		error: null,
	},

	// 5. Requester-Side Clarification Resubmission
	requesterAction: {
		isLoading: false,
		error: null,
		success: false,
	},

	// 6. Independent Self-Registration (Stage B3.3)
	registration: {
		isLoading: false,
		success: false,
		error: null,
		registeredOfficer: null,
	},
}

/**
 * Independent Medical Officer Self-Registration (Stage B3.3)
 * POST /api/medical-officers/register
 */
export const registerMedicalOfficerAsync = createAsyncThunk(
	'medicalOfficer/register',
	async (formData, { rejectWithValue }) => {
		try {
			const response = await axiosClient.post('/medical-officers/register', formData)
			return response.data
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Medical Officer registration failed.'
			return rejectWithValue({
				message,
				field: err.response?.data?.field,
				fields: err.response?.data?.fields,
				status: err.response?.status,
			})
		}
	}
)

/**
 * Fetch Verified & Active Hospitals for Requester Dropdown Selection
 * GET /api/hospitals/verified
 */
export const fetchVerifiedHospitals = createAsyncThunk(
	'medicalOfficer/fetchVerifiedHospitals',
	async (params = {}, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams()
			if (params.city) queryParams.append('city', params.city)
			if (params.state) queryParams.append('state', params.state)
			if (params.search) queryParams.append('search', params.search)

			const url = `/hospitals/verified${queryParams.toString() ? `?${queryParams.toString()}` : ''}`
			const response = await axiosClient.get(url)
			return response.data?.data?.hospitals || []
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to fetch verified hospitals.'
			return rejectWithValue(message)
		}
	}
)

/**
 * Fetch Medical Officer Dashboard Metrics & Hospital Breakdown
 * GET /api/medical-officer/dashboard
 */
export const fetchMedicalOfficerDashboard = createAsyncThunk(
	'medicalOfficer/fetchDashboard',
	async (hospitalId = '', { rejectWithValue }) => {
		try {
			const query = hospitalId ? `?hospitalId=${encodeURIComponent(hospitalId)}` : ''
			const response = await axiosClient.get(`/medical-officer/dashboard${query}`)
			return response.data?.data || {}
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to load Medical Officer dashboard.'
			return rejectWithValue(message)
		}
	}
)

/**
 * Fetch Assigned Emergency Blood Requests (Queue & Filters)
 * GET /api/medical-officer/requests
 */
export const fetchAssignedRequests = createAsyncThunk(
	'medicalOfficer/fetchAssignedRequests',
	async (params = {}, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams()
			if (params.page) queryParams.append('page', params.page)
			if (params.limit) queryParams.append('limit', params.limit)
			if (params.status) queryParams.append('status', params.status)
			if (params.urgencyLevel) queryParams.append('urgencyLevel', params.urgencyLevel)
			if (params.requiredBloodGroup) queryParams.append('requiredBloodGroup', params.requiredBloodGroup)
			if (params.search) queryParams.append('search', params.search)
			if (params.hospitalId) queryParams.append('hospitalId', params.hospitalId)

			const response = await axiosClient.get(`/medical-officer/requests?${queryParams.toString()}`)
			return {
				requests: response.data?.data?.requests || [],
				pagination: response.data?.pagination || {
					page: params.page || 1,
					limit: params.limit || 15,
					totalPages: 1,
					totalRecords: 0,
				},
			}
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to load assigned emergency requests.'
			return rejectWithValue(message)
		}
	}
)

/**
 * Fetch Detailed Request for Clinical Review
 * GET /api/medical-officer/requests/:id
 */
export const fetchRequestDetails = createAsyncThunk(
	'medicalOfficer/fetchRequestDetails',
	async (requestId, { rejectWithValue }) => {
		try {
			const response = await axiosClient.get(`/medical-officer/requests/${requestId}`)
			return response.data?.data?.request || null
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to retrieve request details.'
			return rejectWithValue(message)
		}
	}
)

/**
 * Fetch Chronological Verification Audit History
 * GET /api/medical-officer/requests/:id/verification-history
 */
export const fetchVerificationHistory = createAsyncThunk(
	'medicalOfficer/fetchVerificationHistory',
	async (requestId, { rejectWithValue }) => {
		try {
			const response = await axiosClient.get(
				`/medical-officer/requests/${requestId}/verification-history`
			)
			return response.data?.data?.history || []
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to retrieve verification history.'
			return rejectWithValue(message)
		}
	}
)

/**
 * Approve Emergency Blood Request
 * PATCH /api/medical-officer/requests/:id/verify
 */
export const approveEmergencyRequest = createAsyncThunk(
	'medicalOfficer/approveRequest',
	async ({ requestId, remarks, verificationVersion, hospitalId }, { rejectWithValue }) => {
		try {
			const body = {
				remarks,
				...(verificationVersion !== undefined ? { verificationVersion } : {}),
				...(hospitalId ? { hospitalId } : {}),
			}
			const response = await axiosClient.patch(`/medical-officer/requests/${requestId}/verify`, body)
			return response.data?.data?.request
		} catch (err) {
			const status = err.response?.status
			const data = err.response?.data || {}
			return rejectWithValue({
				status,
				code: data.code || (status === 409 ? 'CONCURRENCY_CONFLICT' : 'ACTION_FAILED'),
				message:
					data.message ||
					(status === 409
						? 'The request was updated by another session and must be refreshed before a decision can be submitted.'
						: 'Failed to approve emergency blood request.'),
			})
		}
	}
)

/**
 * Reject Emergency Blood Request
 * PATCH /api/medical-officer/requests/:id/reject
 */
export const rejectEmergencyRequest = createAsyncThunk(
	'medicalOfficer/rejectRequest',
	async (
		{ requestId, rejectionReason, remarks, verificationVersion, hospitalId },
		{ rejectWithValue }
	) => {
		try {
			const body = {
				rejectionReason,
				remarks,
				...(verificationVersion !== undefined ? { verificationVersion } : {}),
				...(hospitalId ? { hospitalId } : {}),
			}
			const response = await axiosClient.patch(`/medical-officer/requests/${requestId}/reject`, body)
			return response.data?.data?.request
		} catch (err) {
			const status = err.response?.status
			const data = err.response?.data || {}
			return rejectWithValue({
				status,
				code: data.code || (status === 409 ? 'CONCURRENCY_CONFLICT' : 'ACTION_FAILED'),
				message:
					data.message ||
					(status === 409
						? 'The request was updated by another session and must be refreshed before a decision can be submitted.'
						: 'Failed to reject emergency blood request.'),
			})
		}
	}
)

/**
 * Request Additional Clinical Information
 * PATCH /api/medical-officer/requests/:id/request-information
 */
export const requestAdditionalInformation = createAsyncThunk(
	'medicalOfficer/requestInformation',
	async (
		{ requestId, requiredInformation, remarks, verificationVersion, hospitalId },
		{ rejectWithValue }
	) => {
		try {
			const body = {
				requiredInformation,
				remarks,
				...(verificationVersion !== undefined ? { verificationVersion } : {}),
				...(hospitalId ? { hospitalId } : {}),
			}
			const response = await axiosClient.patch(
				`/medical-officer/requests/${requestId}/request-information`,
				body
			)
			return response.data?.data?.request
		} catch (err) {
			const status = err.response?.status
			const data = err.response?.data || {}
			return rejectWithValue({
				status,
				code: data.code || (status === 409 ? 'CONCURRENCY_CONFLICT' : 'ACTION_FAILED'),
				message:
					data.message ||
					(status === 409
						? 'The request was updated by another session and must be refreshed before a decision can be submitted.'
						: 'Failed to request additional clinical information.'),
			})
		}
	}
)

/**
 * Requester Action: Provide Requested Clinical Clarification
 * PATCH /api/emergency/requests/:id/provide-information
 */
export const provideAdditionalInformation = createAsyncThunk(
	'medicalOfficer/provideInformation',
	async ({ requestId, informationProvided }, { rejectWithValue }) => {
		try {
			const response = await axiosClient.patch(
				`/emergency/requests/${requestId}/provide-information`,
				{ informationProvided }
			)
			return response.data?.data?.request
		} catch (err) {
			const status = err.response?.status
			const data = err.response?.data || {}
			return rejectWithValue({
				status,
				code: data.code,
				message: data.message || 'Failed to submit additional information.',
			})
		}
	}
)

const medicalOfficerSlice = createSlice({
	name: 'medicalOfficer',
	initialState,
	reducers: {
		setSelectedHospital(state, action) {
			state.dashboard.selectedHospitalId = action.payload || ''
			state.requests.filters.hospitalId = action.payload || ''
		},
		setRequestFilters(state, action) {
			state.requests.filters = {
				...state.requests.filters,
				...action.payload,
			}
		},
		resetActiveRequest(state) {
			state.activeRequest = {
				data: null,
				verificationHistory: [],
				isLoading: false,
				historyLoading: false,
				actionLoading: false,
				error: null,
				actionError: null,
				concurrencyConflict: false,
			}
		},
		clearConcurrencyConflict(state) {
			state.activeRequest.concurrencyConflict = false
			state.activeRequest.actionError = null
		},
		clearRequesterAction(state) {
			state.requesterAction = {
				isLoading: false,
				error: null,
				success: false,
			}
		},
	},
	extraReducers: (builder) => {
		builder
			// Verified Hospitals
			.addCase(fetchVerifiedHospitals.pending, (state) => {
				state.verifiedHospitals.isLoading = true
				state.verifiedHospitals.error = null
			})
			.addCase(fetchVerifiedHospitals.fulfilled, (state, action) => {
				state.verifiedHospitals.isLoading = false
				state.verifiedHospitals.items = action.payload
			})
			.addCase(fetchVerifiedHospitals.rejected, (state, action) => {
				state.verifiedHospitals.isLoading = false
				state.verifiedHospitals.error = action.payload
			})

			// Dashboard Metrics
			.addCase(fetchMedicalOfficerDashboard.pending, (state) => {
				state.dashboard.isLoading = true
				state.dashboard.error = null
			})
			.addCase(fetchMedicalOfficerDashboard.fulfilled, (state, action) => {
				state.dashboard.isLoading = false
				state.dashboard.metrics = action.payload.metrics || initialState.dashboard.metrics
				state.dashboard.authorizedHospitals = action.payload.authorizedHospitals || []
				state.dashboard.hospitalBreakdown = action.payload.hospitalBreakdown || []
			})
			.addCase(fetchMedicalOfficerDashboard.rejected, (state, action) => {
				state.dashboard.isLoading = false
				state.dashboard.error = action.payload
			})

			// Assigned Requests Queue
			.addCase(fetchAssignedRequests.pending, (state) => {
				state.requests.isLoading = true
				state.requests.error = null
			})
			.addCase(fetchAssignedRequests.fulfilled, (state, action) => {
				state.requests.isLoading = false
				state.requests.items = action.payload.requests
				state.requests.pagination = action.payload.pagination
			})
			.addCase(fetchAssignedRequests.rejected, (state, action) => {
				state.requests.isLoading = false
				state.requests.error = action.payload
			})

			// Detailed Request Review
			.addCase(fetchRequestDetails.pending, (state) => {
				state.activeRequest.isLoading = true
				state.activeRequest.error = null
				state.activeRequest.concurrencyConflict = false
			})
			.addCase(fetchRequestDetails.fulfilled, (state, action) => {
				state.activeRequest.isLoading = false
				state.activeRequest.data = action.payload
			})
			.addCase(fetchRequestDetails.rejected, (state, action) => {
				state.activeRequest.isLoading = false
				state.activeRequest.error = action.payload
			})

			// Verification History
			.addCase(fetchVerificationHistory.pending, (state) => {
				state.activeRequest.historyLoading = true
			})
			.addCase(fetchVerificationHistory.fulfilled, (state, action) => {
				state.activeRequest.historyLoading = false
				state.activeRequest.verificationHistory = action.payload
			})
			.addCase(fetchVerificationHistory.rejected, (state) => {
				state.activeRequest.historyLoading = false
			})

			// Actions: Approve
			.addCase(approveEmergencyRequest.pending, (state) => {
				state.activeRequest.actionLoading = true
				state.activeRequest.actionError = null
				state.activeRequest.concurrencyConflict = false
			})
			.addCase(approveEmergencyRequest.fulfilled, (state, action) => {
				state.activeRequest.actionLoading = false
				if (action.payload) {
					state.activeRequest.data = action.payload
				}
			})
			.addCase(approveEmergencyRequest.rejected, (state, action) => {
				state.activeRequest.actionLoading = false
				state.activeRequest.actionError = action.payload?.message || 'Approval failed.'
				if (action.payload?.status === 409) {
					state.activeRequest.concurrencyConflict = true
				}
			})

			// Actions: Reject
			.addCase(rejectEmergencyRequest.pending, (state) => {
				state.activeRequest.actionLoading = true
				state.activeRequest.actionError = null
				state.activeRequest.concurrencyConflict = false
			})
			.addCase(rejectEmergencyRequest.fulfilled, (state, action) => {
				state.activeRequest.actionLoading = false
				if (action.payload) {
					state.activeRequest.data = action.payload
				}
			})
			.addCase(rejectEmergencyRequest.rejected, (state, action) => {
				state.activeRequest.actionLoading = false
				state.activeRequest.actionError = action.payload?.message || 'Rejection failed.'
				if (action.payload?.status === 409) {
					state.activeRequest.concurrencyConflict = true
				}
			})

			// Actions: Request Information
			.addCase(requestAdditionalInformation.pending, (state) => {
				state.activeRequest.actionLoading = true
				state.activeRequest.actionError = null
				state.activeRequest.concurrencyConflict = false
			})
			.addCase(requestAdditionalInformation.fulfilled, (state, action) => {
				state.activeRequest.actionLoading = false
				if (action.payload) {
					state.activeRequest.data = action.payload
				}
			})
			.addCase(requestAdditionalInformation.rejected, (state, action) => {
				state.activeRequest.actionLoading = false
				state.activeRequest.actionError =
					action.payload?.message || 'Request for information failed.'
				if (action.payload?.status === 409) {
					state.activeRequest.concurrencyConflict = true
				}
			})

			// Requester Action: Provide Information
			.addCase(provideAdditionalInformation.pending, (state) => {
				state.requesterAction.isLoading = true
				state.requesterAction.error = null
				state.requesterAction.success = false
			})
			.addCase(provideAdditionalInformation.fulfilled, (state, action) => {
				state.requesterAction.isLoading = false
				state.requesterAction.success = true
			})
			.addCase(provideAdditionalInformation.rejected, (state, action) => {
				state.requesterAction.isLoading = false
				state.requesterAction.error = action.payload?.message || 'Submission failed.'
			})

			// Independent Self-Registration (Stage B3.3)
			.addCase(registerMedicalOfficerAsync.pending, (state) => {
				state.registration.isLoading = true
				state.registration.error = null
				state.registration.success = false
			})
			.addCase(registerMedicalOfficerAsync.fulfilled, (state, action) => {
				state.registration.isLoading = false
				state.registration.success = true
				state.registration.registeredOfficer = action.payload?.data?.medicalOfficer || null
			})
			.addCase(registerMedicalOfficerAsync.rejected, (state, action) => {
				state.registration.isLoading = false
				state.registration.error = action.payload?.message || 'Registration failed.'
			})
	},
})

export const {
	setSelectedHospital,
	setRequestFilters,
	resetActiveRequest,
	clearConcurrencyConflict,
	clearRequesterAction,
	resetRegistrationState,
} = medicalOfficerSlice.actions

export default medicalOfficerSlice.reducer

