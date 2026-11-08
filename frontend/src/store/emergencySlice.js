/**
 * Emergency Blood Connection Redux Slice
 * Manages Donor Discovery, Blood Bank Discovery, Emergency Requests, and Dual-Stream Matching
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import axiosClient from '../api/axiosClient'

const initialState = {
	// Donor Discovery Stream
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

	// Blood Bank Discovery Stream
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

	// Dual-Stream Candidate Matching Dashboard
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

	// Emergency Request Creation & Tracking
	creation: {
		isLoading: false,
		error: null,
		createdTicket: null,
		success: false,
	},

	// Shared Active Search Filters
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

/**
 * 1. Discover Compatible Nearby Donors
 * GET /api/emergency/discover/donors
 */
export const discoverEmergencyDonors = createAsyncThunk(
	'emergency/discoverDonors',
	async (params = {}, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams()
			if (params.bloodGroup) queryParams.set('bloodGroup', params.bloodGroup)
			if (params.componentType) queryParams.set('componentType', params.componentType)
			if (params.radiusKm) queryParams.set('radiusKm', String(params.radiusKm))
			if (params.page) queryParams.set('page', String(params.page))
			if (params.limit) queryParams.set('limit', String(params.limit))

			if (params.latitude !== undefined && params.latitude !== null && params.longitude !== undefined && params.longitude !== null) {
				queryParams.set('latitude', String(params.latitude))
				queryParams.set('longitude', String(params.longitude))
			} else {
				if (params.city) queryParams.set('city', params.city.trim())
				if (params.state) queryParams.set('state', params.state.trim())
			}

			const res = await axiosClient.get(`/emergency/discover/donors?${queryParams.toString()}`)
			return res.data
		} catch (err) {
			return rejectWithValue(err.response?.data || { message: err.message || 'Failed to discover donors.' })
		}
	}
)

/**
 * 2. Discover Verified Nearby Blood Banks with Traceable Inventory
 * GET /api/emergency/discover/bloodbanks
 */
export const discoverEmergencyBloodbanks = createAsyncThunk(
	'emergency/discoverBloodbanks',
	async (params = {}, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams()
			if (params.bloodGroup) queryParams.set('bloodGroup', params.bloodGroup)
			if (params.componentType) queryParams.set('componentType', params.componentType)
			if (params.radiusKm) queryParams.set('radiusKm', String(params.radiusKm))
			if (params.page) queryParams.set('page', String(params.page))
			if (params.limit) queryParams.set('limit', String(params.limit))

			if (params.latitude !== undefined && params.latitude !== null && params.longitude !== undefined && params.longitude !== null) {
				queryParams.set('latitude', String(params.latitude))
				queryParams.set('longitude', String(params.longitude))
			} else {
				if (params.city) queryParams.set('city', params.city.trim())
				if (params.state) queryParams.set('state', params.state.trim())
			}

			const res = await axiosClient.get(`/emergency/discover/bloodbanks?${queryParams.toString()}`)
			return res.data
		} catch (err) {
			return rejectWithValue(err.response?.data || { message: err.message || 'Failed to discover blood banks.' })
		}
	}
)

/**
 * 3. Dual-Stream Candidate Matching Engine Integration
 * GET /api/emergency/requests/:id/matches
 */
export const getEmergencyRequestMatches = createAsyncThunk(
	'emergency/getRequestMatches',
	async ({ requestId, donorPage = 1, donorLimit = 10, bankPage = 1, bankLimit = 10, radiusKm = 15 }, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams({
				donorPage: String(donorPage),
				donorLimit: String(donorLimit),
				bankPage: String(bankPage),
				bankLimit: String(bankLimit),
				radiusKm: String(radiusKm),
			})

			const cleanId = encodeURIComponent(String(requestId).trim())
			const res = await axiosClient.get(`/emergency/requests/${cleanId}/matches?${queryParams.toString()}`)
			return res.data
		} catch (err) {
			return rejectWithValue(err.response?.data || { message: err.message || 'Emergency request not found or unauthorized.' })
		}
	}
)

/**
 * 4. Create Emergency Blood Request
 * Handles ticket initiation with client validation & API integration
 */
export const submitEmergencyBloodRequest = createAsyncThunk(
	'emergency/createRequest',
	async (formData, { rejectWithValue }) => {
		try {
			const res = await axiosClient.post('/emergency/requests', formData)
			return res.data
		} catch (err) {
			// If backend endpoint is not yet mounted (Phase 4.4 planned), fail safely with descriptive status
			const message = err.response?.data?.message || 'Emergency request submission endpoint is pending Phase 4.4 backend activation.'
			return rejectWithValue({
				status: 'fail',
				message,
				code: err.response?.data?.code || 'ENDPOINT_NOT_AVAILABLE',
			})
		}
	}
)

const emergencySlice = createSlice({
	name: 'emergency',
	initialState,
	reducers: {
		setEmergencyFilters: (state, action) => {
			state.filters = { ...state.filters, ...action.payload }
		},
		resetEmergencyFilters: (state) => {
			state.filters = initialState.filters
		},
		clearMatchingData: (state) => {
			state.matching = initialState.matching
		},
		clearCreationState: (state) => {
			state.creation = initialState.creation
		},
	},
	extraReducers: (builder) => {
		// Donor Discovery
		builder
			.addCase(discoverEmergencyDonors.pending, (state) => {
				state.donorDiscovery.isLoading = true
				state.donorDiscovery.error = null
			})
			.addCase(discoverEmergencyDonors.fulfilled, (state, action) => {
				state.donorDiscovery.isLoading = false
				state.donorDiscovery.data = action.payload?.data || []
				state.donorDiscovery.pagination = action.payload?.pagination || initialState.donorDiscovery.pagination
				state.donorDiscovery.clinicalNotice = action.payload?.clinicalNotice || ''
				state.donorDiscovery.error = null
			})
			.addCase(discoverEmergencyDonors.rejected, (state, action) => {
				state.donorDiscovery.isLoading = false
				state.donorDiscovery.error = action.payload?.message || 'Failed to retrieve donors.'
				state.donorDiscovery.data = []
			})

		// Blood Bank Discovery
		builder
			.addCase(discoverEmergencyBloodbanks.pending, (state) => {
				state.bloodbankDiscovery.isLoading = true
				state.bloodbankDiscovery.error = null
			})
			.addCase(discoverEmergencyBloodbanks.fulfilled, (state, action) => {
				state.bloodbankDiscovery.isLoading = false
				state.bloodbankDiscovery.data = action.payload?.data || []
				state.bloodbankDiscovery.pagination = action.payload?.pagination || initialState.bloodbankDiscovery.pagination
				state.bloodbankDiscovery.governanceNotice = action.payload?.clinicalGovernanceNotice || ''
				state.bloodbankDiscovery.error = null
			})
			.addCase(discoverEmergencyBloodbanks.rejected, (state, action) => {
				state.bloodbankDiscovery.isLoading = false
				state.bloodbankDiscovery.error = action.payload?.message || 'Failed to retrieve blood banks.'
				state.bloodbankDiscovery.data = []
			})

		// Request Matching
		builder
			.addCase(getEmergencyRequestMatches.pending, (state) => {
				state.matching.isLoading = true
				state.matching.error = null
			})
			.addCase(getEmergencyRequestMatches.fulfilled, (state, action) => {
				state.matching.isLoading = false
				const payload = action.payload?.data || action.payload || {}
				const emgReq = payload.emergencyRequest || payload.requestDetails || {}

				state.matching.requestId = payload.requestId || emgReq._id || null
				state.matching.requestNumber = payload.requestNumber || emgReq.requestNumber || null
				state.matching.requestDetails = emgReq
				state.matching.unmetUnits = payload.unmetUnits ?? emgReq.unitsUnmet ?? null
				state.matching.matchingSummary = payload.matchingSummary || null
				state.matching.governanceNotice =
					payload.governance?.clinicalSafetyNotice ||
					payload.governanceNotice ||
					''

				// Independent Stream Ingestion (supports both donors/bloodBanks and donorStream/bankStream)
				const donorList =
					payload.donors?.data ||
					payload.donorStream?.candidates ||
					[]
				const donorPag =
					payload.donors?.pagination ||
					payload.donorStream?.pagination ||
					initialState.matching.donorStream.pagination

				const bankList =
					payload.bloodBanks?.data ||
					payload.bankStream?.candidates ||
					[]
				const bankPag =
					payload.bloodBanks?.pagination ||
					payload.bankStream?.pagination ||
					initialState.matching.bankStream.pagination

				state.matching.donorStream.candidates = donorList
				state.matching.donorStream.pagination = donorPag
				state.matching.bankStream.candidates = bankList
				state.matching.bankStream.pagination = bankPag
				state.matching.error = null
			})
			.addCase(getEmergencyRequestMatches.rejected, (state, action) => {
				state.matching.isLoading = false
				state.matching.error = action.payload?.message || 'Emergency request was not found or access was denied.'
				state.matching.donorStream.candidates = []
				state.matching.bankStream.candidates = []
			})

		// Emergency Request Creation
		builder
			.addCase(submitEmergencyBloodRequest.pending, (state) => {
				state.creation.isLoading = true
				state.creation.error = null
				state.creation.success = false
			})
			.addCase(submitEmergencyBloodRequest.fulfilled, (state, action) => {
				state.creation.isLoading = false
				state.creation.success = true
				state.creation.createdTicket = action.payload?.data || action.payload
				state.creation.error = null
			})
			.addCase(submitEmergencyBloodRequest.rejected, (state, action) => {
				state.creation.isLoading = false
				state.creation.success = false
				state.creation.error = action.payload?.message || 'Emergency request creation failed.'
			})
	},
})

export const {
	setEmergencyFilters,
	resetEmergencyFilters,
	clearMatchingData,
	clearCreationState,
} = emergencySlice.actions

export default emergencySlice.reducer
