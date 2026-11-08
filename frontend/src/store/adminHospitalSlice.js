/**
 * Redux Slice for Admin Hospital Registry & Medical Officer Management
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit'
import axiosClient from '../api/axiosClient'

/**
 * Fetch Paginated Hospitals (Admin Only)
 * GET /api/hospitals
 */
export const fetchAdminHospitals = createAsyncThunk(
	'adminHospital/fetchAdminHospitals',
	async (params = {}, { rejectWithValue }) => {
		try {
			const { page = 1, limit = 15, verificationStatus, isActive, city, search } = params
			const queryParams = new URLSearchParams()
			queryParams.append('page', page)
			queryParams.append('limit', limit)
			if (verificationStatus) queryParams.append('verificationStatus', verificationStatus)
			if (isActive !== undefined && isActive !== '') queryParams.append('isActive', isActive)
			if (city) queryParams.append('city', city)
			if (search) queryParams.append('search', search)

			const response = await axiosClient.get(`/hospitals?${queryParams.toString()}`)
			return {
				hospitals: response.data?.data?.hospitals || [],
				pagination: response.data?.pagination || { page, limit, totalPages: 1, totalRecords: 0 },
			}
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to fetch hospital directory.'
			)
		}
	}
)

/**
 * Fetch Single Hospital Details (Authenticated)
 * GET /api/hospitals/:id
 */
export const fetchHospitalById = createAsyncThunk(
	'adminHospital/fetchHospitalById',
	async (hospitalId, { rejectWithValue }) => {
		try {
			const response = await axiosClient.get(`/hospitals/${hospitalId}`)
			return response.data?.data?.hospital
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to retrieve hospital details.'
			)
		}
	}
)

/**
 * Register New Hospital (Admin Only)
 * POST /api/hospitals
 */
export const registerHospital = createAsyncThunk(
	'adminHospital/registerHospital',
	async (hospitalPayload, { rejectWithValue }) => {
		try {
			const response = await axiosClient.post('/hospitals', hospitalPayload)
			return response.data?.data?.hospital
		} catch (err) {
			const message = err.response?.data?.message || err.message || 'Failed to register hospital.'
			return rejectWithValue({
				status: err.response?.status,
				message,
				field: err.response?.data?.field,
				fields: err.response?.data?.fields,
			})
		}
	}
)

/**
 * Verify / Reject / Activate Hospital (Admin Only)
 * PATCH /api/hospitals/:id/verify
 */
export const verifyHospital = createAsyncThunk(
	'adminHospital/verifyHospital',
	async ({ hospitalId, verificationStatus, isActive }, { rejectWithValue }) => {
		try {
			const response = await axiosClient.patch(`/hospitals/${hospitalId}/verify`, {
				verificationStatus,
				isActive,
			})
			return {
				hospital: response.data?.data?.hospital,
				message: response.data?.message,
			}
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to update hospital verification status.'
			)
		}
	}
)

/**
 * Fetch Medical Officer Hospital Associations (Admin Only)
 * GET /api/hospitals/medical-officers/associations
 */
export const fetchMoAssociations = createAsyncThunk(
	'adminHospital/fetchMoAssociations',
	async (params = {}, { rejectWithValue }) => {
		try {
			const { hospitalId, medicalOfficerUserId, associationStatus } = params
			const queryParams = new URLSearchParams()
			if (hospitalId) queryParams.append('hospitalId', hospitalId)
			if (medicalOfficerUserId) queryParams.append('medicalOfficerUserId', medicalOfficerUserId)
			if (associationStatus) queryParams.append('associationStatus', associationStatus)

			const response = await axiosClient.get(
				`/hospitals/medical-officers/associations?${queryParams.toString()}`
			)
			return response.data?.data?.associations || []
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to fetch Medical Officer associations.'
			)
		}
	}
)

/**
 * Assign Medical Officer to Hospital (Admin Only)
 * POST /api/hospitals/medical-officers/assign
 */
export const assignMedicalOfficer = createAsyncThunk(
	'adminHospital/assignMedicalOfficer',
	async (assignmentPayload, { rejectWithValue }) => {
		try {
			const response = await axiosClient.post(
				'/hospitals/medical-officers/assign',
				assignmentPayload
			)
			return {
				association: response.data?.data?.association,
				message: response.data?.message,
			}
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to assign Medical Officer.'
			return rejectWithValue({
				status: err.response?.status,
				message,
			})
		}
	}
)

/**
 * Update Medical Officer Association Status & Permissions (Admin Only)
 * PATCH /api/hospitals/medical-officers/association/:id/status
 */
export const updateAssociationStatus = createAsyncThunk(
	'adminHospital/updateAssociationStatus',
	async ({ associationId, associationStatus, permissions, expiresAt }, { rejectWithValue }) => {
		try {
			const payload = {}
			if (associationStatus) payload.associationStatus = associationStatus
			if (permissions) payload.permissions = permissions
			if (expiresAt !== undefined) payload.expiresAt = expiresAt

			const response = await axiosClient.patch(
				`/hospitals/medical-officers/association/${associationId}/status`,
				payload
			)
			return {
				association: response.data?.data?.association,
				message: response.data?.message,
			}
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to update association status.'
			)
		}
	}
)

/**
 * Fetch Accredited Medical Officers for Searchable Assignment (Admin Only)
 * GET /api/hospitals/medical-officers
 */
export const fetchMedicalOfficersList = createAsyncThunk(
	'adminHospital/fetchMedicalOfficersList',
	async (params = {}, { rejectWithValue }) => {
		try {
			const { search = '' } = params
			const queryParams = new URLSearchParams()
			if (search) queryParams.append('search', search)

			const response = await axiosClient.get(
				`/hospitals/medical-officers?${queryParams.toString()}`
			)
			return response.data?.data?.medicalOfficers || []
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to fetch medical officers list.'
			)
		}
	}
)

/**
 * Fetch Complete Medical Officer Directory with Lifecycle Statuses (Admin Only)
 * GET /api/hospitals/medical-officers/directory
 */
export const fetchMoDirectory = createAsyncThunk(
	'adminHospital/fetchMoDirectory',
	async (params = {}, { rejectWithValue }) => {
		try {
			const { page = 1, limit = 20, verificationStatus, search } = params
			const queryParams = new URLSearchParams()
			queryParams.append('page', page)
			queryParams.append('limit', limit)
			if (verificationStatus) queryParams.append('verificationStatus', verificationStatus)
			if (search) queryParams.append('search', search)

			const response = await axiosClient.get(
				`/hospitals/medical-officers/directory?${queryParams.toString()}`
			)
			return {
				medicalOfficers: response.data?.data?.medicalOfficers || [],
				pagination: response.data?.pagination || { page, limit, totalPages: 1, totalRecords: 0 },
			}
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to fetch Medical Officer directory.'
			)
		}
	}
)

/**
 * Onboard / Register New Medical Officer (Admin Only)
 * POST /api/hospitals/medical-officers/onboard
 */
export const onboardMedicalOfficer = createAsyncThunk(
	'adminHospital/onboardMedicalOfficer',
	async (payload, { rejectWithValue }) => {
		try {
			const response = await axiosClient.post('/hospitals/medical-officers/onboard', payload)
			return {
				medicalOfficer: response.data?.data?.medicalOfficer,
				message: response.data?.message,
			}
		} catch (err) {
			const message = err.response?.data?.message || err.message || 'Failed to onboard Medical Officer.'
			return rejectWithValue({
				status: err.response?.status,
				message,
				field: err.response?.data?.field,
				fields: err.response?.data?.fields,
			})
		}
	}
)

/**
 * Verify / Approve / Reject / Suspend Medical Officer Account (Admin Only)
 * PATCH /api/hospitals/medical-officers/:id/verify
 */
export const verifyMedicalOfficerAccount = createAsyncThunk(
	'adminHospital/verifyMedicalOfficerAccount',
	async ({ id, verificationStatus, rejectionReason, isActive }, { rejectWithValue }) => {
		try {
			const response = await axiosClient.patch(`/hospitals/medical-officers/${id}/verify`, {
				verificationStatus,
				rejectionReason,
				isActive,
			})
			return {
				medicalOfficer: response.data?.data?.medicalOfficer,
				message: response.data?.message,
			}
		} catch (err) {
			const message =
				err.response?.data?.message || err.message || 'Failed to update Medical Officer verification status.'
			return rejectWithValue({
				status: err.response?.status,
				message,
			})
		}
	}
)

/**
 * Nominate Medical Officer for a Hospital
 * POST /api/hospitals/medical-officers/nominate
 */
export const nominateMedicalOfficer = createAsyncThunk(
	'adminHospital/nominateMedicalOfficer',
	async ({ hospitalId, medicalOfficerUserId }, { rejectWithValue }) => {
		try {
			const response = await axiosClient.post('/hospitals/medical-officers/nominate', {
				hospitalId,
				medicalOfficerUserId,
			})
			return response.data
		} catch (err) {
			return rejectWithValue(
				err.response?.data?.message || err.message || 'Failed to nominate Medical Officer.'
			)
		}
	}
)

const initialState = {
	hospitals: {
		items: [],
		pagination: {
			page: 1,
			limit: 15,
			totalPages: 1,
			totalRecords: 0,
		},
		filters: {
			verificationStatus: '',
			isActive: '',
			city: '',
			search: '',
		},
		isLoading: false,
		error: null,
	},
	currentHospital: {
		data: null,
		isLoading: false,
		error: null,
		verifyLoading: false,
		verifyError: null,
		verifySuccess: false,
	},
	registration: {
		isLoading: false,
		error: null,
		success: false,
		createdHospital: null,
	},
	associations: {
		items: [],
		isLoading: false,
		error: null,
		filters: {
			hospitalId: '',
			associationStatus: '',
		},
		actionLoading: false,
		actionError: null,
		actionSuccess: false,
	},
	availableMedicalOfficers: {
		items: [],
		isLoading: false,
		error: null,
	},
	medicalOfficerDirectory: {
		items: [],
		pagination: {
			page: 1,
			limit: 20,
			totalPages: 1,
			totalRecords: 0,
		},
		filters: {
			verificationStatus: '',
			search: '',
		},
		isLoading: false,
		error: null,
		actionLoading: false,
		actionError: null,
		actionSuccess: false,
	},
}

const adminHospitalSlice = createSlice({
	name: 'adminHospital',
	initialState,
	reducers: {
		setHospitalFilters(state, action) {
			state.hospitals.filters = {
				...state.hospitals.filters,
				...action.payload,
			}
			state.hospitals.pagination.page = 1
		},
		setHospitalPage(state, action) {
			state.hospitals.pagination.page = action.payload
		},
		clearHospitalFilters(state) {
			state.hospitals.filters = {
				verificationStatus: '',
				isActive: '',
				city: '',
				search: '',
			}
			state.hospitals.pagination.page = 1
		},
		resetRegistrationState(state) {
			state.registration = {
				isLoading: false,
				error: null,
				success: false,
				createdHospital: null,
			}
		},
		resetCurrentHospital(state) {
			state.currentHospital = {
				data: null,
				isLoading: false,
				error: null,
				verifyLoading: false,
				verifyError: null,
				verifySuccess: false,
			}
		},
		setAssociationFilters(state, action) {
			state.associations.filters = {
				...state.associations.filters,
				...action.payload,
			}
		},
		clearAssociationActionStatus(state) {
			state.associations.actionLoading = false
			state.associations.actionError = null
			state.associations.actionSuccess = false
		},
		setMoDirectoryFilters(state, action) {
			state.medicalOfficerDirectory.filters = {
				...state.medicalOfficerDirectory.filters,
				...action.payload,
			}
			state.medicalOfficerDirectory.pagination.page = 1
		},
		setMoDirectoryPage(state, action) {
			state.medicalOfficerDirectory.pagination.page = action.payload
		},
		clearMoDirectoryActionStatus(state) {
			state.medicalOfficerDirectory.actionLoading = false
			state.medicalOfficerDirectory.actionError = null
			state.medicalOfficerDirectory.actionSuccess = false
		},
	},
	extraReducers: (builder) => {
		builder
			// Fetch Admin Hospitals
			.addCase(fetchAdminHospitals.pending, (state) => {
				state.hospitals.isLoading = true
				state.hospitals.error = null
			})
			.addCase(fetchAdminHospitals.fulfilled, (state, action) => {
				state.hospitals.isLoading = false
				state.hospitals.items = action.payload.hospitals
				state.hospitals.pagination = action.payload.pagination
			})
			.addCase(fetchAdminHospitals.rejected, (state, action) => {
				state.hospitals.isLoading = false
				state.hospitals.error = action.payload
			})

			// Fetch Hospital By ID
			.addCase(fetchHospitalById.pending, (state) => {
				state.currentHospital.isLoading = true
				state.currentHospital.error = null
			})
			.addCase(fetchHospitalById.fulfilled, (state, action) => {
				state.currentHospital.isLoading = false
				state.currentHospital.data = action.payload
			})
			.addCase(fetchHospitalById.rejected, (state, action) => {
				state.currentHospital.isLoading = false
				state.currentHospital.error = action.payload
			})

			// Register Hospital
			.addCase(registerHospital.pending, (state) => {
				state.registration.isLoading = true
				state.registration.error = null
				state.registration.success = false
			})
			.addCase(registerHospital.fulfilled, (state, action) => {
				state.registration.isLoading = false
				state.registration.success = true
				state.registration.createdHospital = action.payload
			})
			.addCase(registerHospital.rejected, (state, action) => {
				state.registration.isLoading = false
				state.registration.error = action.payload?.message || action.payload
			})

			// Verify Hospital
			.addCase(verifyHospital.pending, (state) => {
				state.currentHospital.verifyLoading = true
				state.currentHospital.verifyError = null
				state.currentHospital.verifySuccess = false
			})
			.addCase(verifyHospital.fulfilled, (state, action) => {
				state.currentHospital.verifyLoading = false
				state.currentHospital.verifySuccess = true
				state.currentHospital.data = action.payload.hospital
				// Update in list if present
				state.hospitals.items = state.hospitals.items.map((h) =>
					h._id === action.payload.hospital._id ? action.payload.hospital : h
				)
			})
			.addCase(verifyHospital.rejected, (state, action) => {
				state.currentHospital.verifyLoading = false
				state.currentHospital.verifyError = action.payload
			})

			// Fetch MO Associations
			.addCase(fetchMoAssociations.pending, (state) => {
				state.associations.isLoading = true
				state.associations.error = null
			})
			.addCase(fetchMoAssociations.fulfilled, (state, action) => {
				state.associations.isLoading = false
				state.associations.items = action.payload
			})
			.addCase(fetchMoAssociations.rejected, (state, action) => {
				state.associations.isLoading = false
				state.associations.error = action.payload
			})

			// Assign Medical Officer
			.addCase(assignMedicalOfficer.pending, (state) => {
				state.associations.actionLoading = true
				state.associations.actionError = null
				state.associations.actionSuccess = false
			})
			.addCase(assignMedicalOfficer.fulfilled, (state, action) => {
				state.associations.actionLoading = false
				state.associations.actionSuccess = true
				state.associations.items = [
					action.payload.association,
					...state.associations.items.filter((a) => a._id !== action.payload.association._id),
				]
			})
			.addCase(assignMedicalOfficer.rejected, (state, action) => {
				state.associations.actionLoading = false
				state.associations.actionError = action.payload?.message || action.payload
			})

			// Update Association Status
			.addCase(updateAssociationStatus.pending, (state) => {
				state.associations.actionLoading = true
				state.associations.actionError = null
				state.associations.actionSuccess = false
			})
			.addCase(updateAssociationStatus.fulfilled, (state, action) => {
				state.associations.actionLoading = false
				state.associations.actionSuccess = true
				state.associations.items = state.associations.items.map((a) =>
					a._id === action.payload.association._id ? action.payload.association : a
				)
			})
			.addCase(updateAssociationStatus.rejected, (state, action) => {
				state.associations.actionLoading = false
				state.associations.actionError = action.payload
			})

			// Fetch Accredited Medical Officers List (Active/Verified for Selector)
			.addCase(fetchMedicalOfficersList.pending, (state) => {
				state.availableMedicalOfficers.isLoading = true
				state.availableMedicalOfficers.error = null
			})
			.addCase(fetchMedicalOfficersList.fulfilled, (state, action) => {
				state.availableMedicalOfficers.isLoading = false
				state.availableMedicalOfficers.items = action.payload
			})
			.addCase(fetchMedicalOfficersList.rejected, (state, action) => {
				state.availableMedicalOfficers.isLoading = false
				state.availableMedicalOfficers.error = action.payload
			})

			// Fetch Complete Medical Officer Directory
			.addCase(fetchMoDirectory.pending, (state) => {
				state.medicalOfficerDirectory.isLoading = true
				state.medicalOfficerDirectory.error = null
			})
			.addCase(fetchMoDirectory.fulfilled, (state, action) => {
				state.medicalOfficerDirectory.isLoading = false
				state.medicalOfficerDirectory.items = action.payload.medicalOfficers
				state.medicalOfficerDirectory.pagination = action.payload.pagination
			})
			.addCase(fetchMoDirectory.rejected, (state, action) => {
				state.medicalOfficerDirectory.isLoading = false
				state.medicalOfficerDirectory.error = action.payload
			})

			// Onboard Medical Officer
			.addCase(onboardMedicalOfficer.pending, (state) => {
				state.medicalOfficerDirectory.actionLoading = true
				state.medicalOfficerDirectory.actionError = null
				state.medicalOfficerDirectory.actionSuccess = false
			})
			.addCase(onboardMedicalOfficer.fulfilled, (state, action) => {
				state.medicalOfficerDirectory.actionLoading = false
				state.medicalOfficerDirectory.actionSuccess = true
				state.medicalOfficerDirectory.items = [
					action.payload.medicalOfficer,
					...state.medicalOfficerDirectory.items,
				]
			})
			.addCase(onboardMedicalOfficer.rejected, (state, action) => {
				state.medicalOfficerDirectory.actionLoading = false
				state.medicalOfficerDirectory.actionError = action.payload?.message || action.payload
			})

			// Verify Medical Officer Account
			.addCase(verifyMedicalOfficerAccount.pending, (state) => {
				state.medicalOfficerDirectory.actionLoading = true
				state.medicalOfficerDirectory.actionError = null
				state.medicalOfficerDirectory.actionSuccess = false
			})
			.addCase(verifyMedicalOfficerAccount.fulfilled, (state, action) => {
				state.medicalOfficerDirectory.actionLoading = false
				state.medicalOfficerDirectory.actionSuccess = true
				const updated = action.payload.medicalOfficer
				state.medicalOfficerDirectory.items = state.medicalOfficerDirectory.items.map((doc) =>
					doc._id === updated._id ? { ...doc, ...updated } : doc
				)
				// If verified and active, add/update in availableMedicalOfficers
				if (updated.verificationStatus === 'Verified' && updated.status === true) {
					const exists = state.availableMedicalOfficers.items.some((d) => d._id === updated._id)
					if (!exists) {
						state.availableMedicalOfficers.items.push(updated)
					}
				} else {
					state.availableMedicalOfficers.items = state.availableMedicalOfficers.items.filter(
						(d) => d._id !== updated._id
					)
				}
			})
			.addCase(verifyMedicalOfficerAccount.rejected, (state, action) => {
				state.medicalOfficerDirectory.actionLoading = false
				state.medicalOfficerDirectory.actionError = action.payload?.message || action.payload
			})
	},
})

export const {
	setHospitalFilters,
	setHospitalPage,
	clearHospitalFilters,
	resetRegistrationState,
	resetCurrentHospital,
	setAssociationFilters,
	clearAssociationActionStatus,
	setMoDirectoryFilters,
	setMoDirectoryPage,
	clearMoDirectoryActionStatus,
} = adminHospitalSlice.actions

export default adminHospitalSlice.reducer

