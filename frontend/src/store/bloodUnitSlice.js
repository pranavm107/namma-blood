import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import axios from 'axios'

const BASE_URL = process.env.REACT_APP_BASEURL

function getAuthHeader() {
	const userData = JSON.parse(localStorage.getItem('loginData'))
	const token = userData?.token
	return token ? { Authorization: `Bearer ${token}` } : {}
}

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

export const fetchBloodUnits = createAsyncThunk(
	'bloodUnit/fetchBloodUnits',
	async (params = {}, { rejectWithValue }) => {
		try {
			const queryParams = new URLSearchParams()
			if (params.q) queryParams.append('q', params.q)
			if (params.search) queryParams.append('search', params.search)
			if (params.bloodGroup && params.bloodGroup !== 'All') queryParams.append('bloodGroup', params.bloodGroup)
			if (params.status && params.status !== 'All') queryParams.append('status', params.status)
			if (params.componentType && params.componentType !== 'All') queryParams.append('componentType', params.componentType)
			if (params.screeningStatus && params.screeningStatus !== 'All') queryParams.append('screeningStatus', params.screeningStatus)
			if (params.isExpired) queryParams.append('isExpired', params.isExpired)
			if (params.page) queryParams.append('page', params.page)
			if (params.limit) queryParams.append('limit', params.limit)
			if (params.sortBy) queryParams.append('sortBy', params.sortBy)
			if (params.sortOrder) queryParams.append('sortOrder', params.sortOrder)

			const response = await axios.get(
				`${BASE_URL}/bloodunit?${queryParams.toString()}`,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const fetchBloodUnitById = createAsyncThunk(
	'bloodUnit/fetchBloodUnitById',
	async (id, { rejectWithValue }) => {
		try {
			const response = await axios.get(
				`${BASE_URL}/bloodunit/${id}`,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const recordScreeningResults = createAsyncThunk(
	'bloodUnit/recordScreeningResults',
	async ({ unitId, tests, testBatchId, testedAt, notes }, { rejectWithValue }) => {
		try {
			const payload = { tests }
			if (testBatchId) payload.testBatchId = testBatchId
			if (testedAt) payload.testedAt = testedAt
			if (notes) payload.notes = notes

			const response = await axios.post(
				`${BASE_URL}/bloodunit/${unitId}/tests`,
				payload,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const verifyMedicalClearance = createAsyncThunk(
	'bloodUnit/verifyMedicalClearance',
	async ({ unitId, notes }, { rejectWithValue }) => {
		try {
			const response = await axios.post(
				`${BASE_URL}/bloodunit/${unitId}/verify`,
				{ notes: notes || '' },
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const recordCrossmatch = createAsyncThunk(
	'bloodUnit/recordCrossmatch',
	async ({ unitId, crossmatchResult, receiveRequestId, notes }, { rejectWithValue }) => {
		try {
			const response = await axios.post(
				`${BASE_URL}/bloodunit/${unitId}/crossmatch`,
				{ crossmatchResult, receiveRequestId, notes: notes || '' },
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const reserveUnits = createAsyncThunk(
	'bloodUnit/reserveUnits',
	async ({ requestId, componentType, holdHours }, { rejectWithValue }) => {
		try {
			const payload = { requestId }
			if (componentType) payload.componentType = componentType
			if (holdHours) payload.holdHours = Number(holdHours)

			const response = await axios.post(
				`${BASE_URL}/bloodunit/reserve`,
				payload,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const releaseReservation = createAsyncThunk(
	'bloodUnit/releaseReservation',
	async ({ requestId, reason }, { rejectWithValue }) => {
		try {
			const response = await axios.post(
				`${BASE_URL}/bloodunit/release-reservation`,
				{ requestId, reason: reason || 'Manual release' },
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const issueUnits = createAsyncThunk(
	'bloodUnit/issueUnits',
	async (
		{
			requestId,
			recipientPatientName,
			hospitalName,
			crossmatchResult,
			isEmergency,
			emergencyReason,
			dispatchNotes,
		},
		{ rejectWithValue }
	) => {
		try {
			const payload = {
				requestId,
				recipientPatientName: recipientPatientName || '',
				hospitalName: hospitalName || '',
				dispatchNotes: dispatchNotes || '',
			}
			if (crossmatchResult) payload.crossmatchResult = crossmatchResult
			if (isEmergency) {
				payload.isEmergency = true
				payload.emergencyReason = emergencyReason || ''
			}

			const response = await axios.post(
				`${BASE_URL}/bloodunit/issue`,
				payload,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const dispatchUnits = createAsyncThunk(
	'bloodUnit/dispatchUnits',
	async (
		{ requestId, unitIds, dispatchedToRecipient, transportBoxId, dispatchNotes },
		{ rejectWithValue }
	) => {
		try {
			const payload = {
				dispatchedToRecipient: dispatchedToRecipient || '',
				transportBoxId: transportBoxId || '',
				dispatchNotes: dispatchNotes || '',
			}
			if (requestId) payload.requestId = requestId
			if (unitIds) payload.unitIds = unitIds

			const response = await axios.post(
				`${BASE_URL}/bloodunit/dispatch`,
				payload,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const discardBloodUnit = createAsyncThunk(
	'bloodUnit/discardBloodUnit',
	async ({ unitIds, reason, wasteManifestNumber, notes }, { rejectWithValue }) => {
		try {
			const payload = {
				unitIds,
				reason,
				wasteManifestNumber: wasteManifestNumber || '',
				notes: notes || '',
			}
			const response = await axios.post(
				`${BASE_URL}/bloodunit/discard`,
				payload,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

const bloodUnitSlice = createSlice({
	name: 'bloodUnit',
	initialState,
	reducers: {
		clearSelectedUnit: (state) => {
			state.selectedUnit = null
		},
		clearUnitError: (state) => {
			state.error = null
		},
		clearUnitSuccessMessage: (state) => {
			state.actionSuccessMessage = null
		},
	},
	extraReducers(builder) {
		builder
			// Fetch List
			.addCase(fetchBloodUnits.pending, (state) => {
				state.isLoading = true
				state.error = null
			})
			.addCase(fetchBloodUnits.fulfilled, (state, action) => {
				state.isLoading = false
				state.units = action.payload?.units || []
				state.total = action.payload?.total || 0
				state.page = action.payload?.page || 1
				state.limit = action.payload?.limit || 10
				state.totalPages = action.payload?.totalPages || 1
			})
			.addCase(fetchBloodUnits.rejected, (state, action) => {
				state.isLoading = false
				state.error = action.payload?.message || 'Failed to fetch blood units.'
			})

			// Fetch Detail
			.addCase(fetchBloodUnitById.pending, (state) => {
				state.isDetailLoading = true
				state.error = null
			})
			.addCase(fetchBloodUnitById.fulfilled, (state, action) => {
				state.isDetailLoading = false
				state.selectedUnit = action.payload
			})
			.addCase(fetchBloodUnitById.rejected, (state, action) => {
				state.isDetailLoading = false
				state.error = action.payload?.message || 'Failed to fetch blood unit details.'
			})

			// Actions (Screening, Clearance, Crossmatch, Issuance, Dispatch, Discard)
			.addCase(recordScreeningResults.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(recordScreeningResults.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Screening results recorded.'
			})
			.addCase(recordScreeningResults.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to record screening results.'
			})

			.addCase(verifyMedicalClearance.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(verifyMedicalClearance.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Unit cleared and marked Available.'
			})
			.addCase(verifyMedicalClearance.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to clear unit.'
			})

			.addCase(discardBloodUnit.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(discardBloodUnit.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Unit discarded.'
			})
			.addCase(discardBloodUnit.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to discard unit.'
			})

			.addCase(recordCrossmatch.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(recordCrossmatch.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Crossmatch recorded.'
			})
			.addCase(recordCrossmatch.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to record crossmatch.'
			})

			.addCase(issueUnits.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(issueUnits.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Units issued.'
			})
			.addCase(issueUnits.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to issue units.'
			})

			.addCase(dispatchUnits.pending, (state) => {
				state.isActionSubmitting = true
				state.error = null
			})
			.addCase(dispatchUnits.fulfilled, (state, action) => {
				state.isActionSubmitting = false
				state.actionSuccessMessage = action.payload?.message || 'Units dispatched.'
			})
			.addCase(dispatchUnits.rejected, (state, action) => {
				state.isActionSubmitting = false
				state.error = action.payload?.message || 'Failed to dispatch units.'
			})
	},
})

export const { clearSelectedUnit, clearUnitError, clearUnitSuccessMessage } =
	bloodUnitSlice.actions
export default bloodUnitSlice.reducer
