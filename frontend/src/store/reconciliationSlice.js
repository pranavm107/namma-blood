import { createAsyncThunk, createSlice } from '@reduxjs/toolkit'
import axios from 'axios'

const BASE_URL = process.env.REACT_APP_BASEURL

function getAuthHeader() {
	const userData = JSON.parse(localStorage.getItem('loginData'))
	const token = userData?.token
	return token ? { Authorization: `Bearer ${token}` } : {}
}

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

export const fetchReconciliationReport = createAsyncThunk(
	'reconciliation/fetchReconciliationReport',
	async ({ recordAudit = false } = {}, { rejectWithValue }) => {
		try {
			const response = await axios.get(
				`${BASE_URL}/bloodstock/reconciliation?recordAudit=${recordAudit}`,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const executeReconciliationMigration = createAsyncThunk(
	'reconciliation/executeReconciliationMigration',
	async ({ mode = 'DRY_RUN', migrationManifest = [], batchId, notes = '' }, { rejectWithValue }) => {
		try {
			const response = await axios.post(
				`${BASE_URL}/bloodstock/reconcile`,
				{ mode, migrationManifest, batchId, notes },
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

export const fetchReconciliationHistory = createAsyncThunk(
	'reconciliation/fetchReconciliationHistory',
	async ({ limit = 20, skip = 0 } = {}, { rejectWithValue }) => {
		try {
			const response = await axios.get(
				`${BASE_URL}/bloodstock/reconciliation/history?limit=${limit}&skip=${skip}`,
				{ headers: getAuthHeader() }
			)
			return response?.data
		} catch (error) {
			return rejectWithValue(error?.response?.data || { message: error.message })
		}
	}
)

const reconciliationSlice = createSlice({
	name: 'reconciliation',
	initialState,
	reducers: {
		clearMigrationResult: (state) => {
			state.migrationResult = null
		},
		clearReconciliationError: (state) => {
			state.error = null
		},
		clearReconciliationSuccessMessage: (state) => {
			state.successMessage = null
		},
	},
	extraReducers(builder) {
		builder
			// Fetch Report
			.addCase(fetchReconciliationReport.pending, (state) => {
				state.isReportLoading = true
				state.error = null
			})
			.addCase(fetchReconciliationReport.fulfilled, (state, action) => {
				state.isReportLoading = false
				state.report = action.payload
			})
			.addCase(fetchReconciliationReport.rejected, (state, action) => {
				state.isReportLoading = false
				state.error = action.payload?.message || 'Failed to fetch reconciliation report.'
			})

			// Execute / Dry-Run Migration
			.addCase(executeReconciliationMigration.pending, (state) => {
				state.isMigrationSubmitting = true
				state.error = null
				state.migrationResult = null
			})
			.addCase(executeReconciliationMigration.fulfilled, (state, action) => {
				state.isMigrationSubmitting = false
				state.migrationResult = action.payload
				state.successMessage =
					action.payload?.mode === 'EXECUTE'
						? `Successfully migrated ${action.payload?.migratedCount || 0} unit(s).`
						: 'Dry-run validation completed successfully.'
			})
			.addCase(executeReconciliationMigration.rejected, (state, action) => {
				state.isMigrationSubmitting = false
				state.error = action.payload?.message || 'Migration operation failed or detected conflicts.'
				state.migrationResult = action.payload
			})

			// Fetch History
			.addCase(fetchReconciliationHistory.pending, (state) => {
				state.isHistoryLoading = true
			})
			.addCase(fetchReconciliationHistory.fulfilled, (state, action) => {
				state.isHistoryLoading = false
				state.history = action.payload?.records || []
				state.historyTotal = action.payload?.total || 0
			})
			.addCase(fetchReconciliationHistory.rejected, (state, action) => {
				state.isHistoryLoading = false
				state.error = action.payload?.message || 'Failed to fetch reconciliation history.'
			})
	},
})

export const {
	clearMigrationResult,
	clearReconciliationError,
	clearReconciliationSuccessMessage,
} = reconciliationSlice.actions

export default reconciliationSlice.reducer
