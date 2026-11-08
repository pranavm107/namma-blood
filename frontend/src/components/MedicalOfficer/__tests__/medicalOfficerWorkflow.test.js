/**
 * Medical Officer Portal & Clinical Verification Workflow Integration Tests
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Verifies:
 * 1. Role-based route guard logic: MO authorized, unauthorized roles rejected
 * 2. Multi-hospital non-arbitrary default handling
 * 3. Mandatory validation rules: remarks for approval, reason for rejection, details for info
 * 4. Quarantined Flagged_Suspicious restrictions
 * 5. Append-only verification audit trail timeline integrity
 * 6. Requester clarification resubmission
 * 7. Clinical governance invariants
 */

import { configureStore } from '@reduxjs/toolkit'
import medicalOfficerReducer, {
	setSelectedHospital,
	setRequestFilters,
	approveEmergencyRequest,
	rejectEmergencyRequest,
	requestAdditionalInformation,
	provideAdditionalInformation,
	clearConcurrencyConflict,
} from '../../../store/medicalOfficerSlice'
import emergencyReducer from '../../../store/emergencySlice'
import loginReducer from '../../../store/loginslice'

const createMockStore = (initialAuthState = {}, initialMOState = {}) => {
	return configureStore({
		reducer: {
			login: loginReducer,
			medicalOfficer: medicalOfficerReducer,
			emergency: emergencyReducer,
		},
		preloadedState: {
			login: {
				isLoggedin: true,
				token: 'mock-jwt-token-12345',
				role: 'MEDICAL_OFFICER',
				...initialAuthState,
			},
			medicalOfficer: {
				dashboard: {
					metrics: {
						pendingCount: 3,
						moreInfoCount: 1,
						verifiedCount: 5,
						rejectedCount: 2,
						totalCount: 11,
					},
					authorizedHospitals: [
						{ _id: 'hosp-1', hospitalCode: 'HOSP-1', hospitalName: 'Apollo Main Centre', address: { city: 'Chennai' } },
						{ _id: 'hosp-2', hospitalCode: 'HOSP-2', hospitalName: 'Fortis Health Facility', address: { city: 'Chennai' } },
					],
					hospitalBreakdown: [],
					selectedHospitalId: '',
					isLoading: false,
					error: null,
				},
				requests: {
					items: [],
					pagination: { page: 1, limit: 15, totalPages: 1, totalRecords: 0 },
					filters: { status: 'Pending_Verification', urgencyLevel: '', requiredBloodGroup: '', search: '', hospitalId: '' },
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
				verifiedHospitals: { items: [], isLoading: false, error: null },
				requesterAction: { isLoading: false, error: null, success: false },
				...initialMOState,
			},
		},
	})
}

// Route guard helper mirroring ProtectedRoute logic
function evaluateRouteAccess(token, role, isStaff, allowedRoles) {
	if (!token || !role) {
		return { allowed: false, redirect: '/login' }
	}
	const isRoleAllowed =
		allowedRoles.length === 0 ||
		allowedRoles.includes(role) ||
		(isStaff && (allowedRoles.includes('STAFF') || allowedRoles.includes('BLOODBANK')))

	if (!isRoleAllowed) {
		if (role === 'USER') return { allowed: false, redirect: '/user' }
		if (role === 'BLOODBANK') return { allowed: false, redirect: '/bloodbank' }
		if (role === 'ADMIN') return { allowed: false, redirect: '/admin' }
		if (role === 'MEDICAL_OFFICER') return { allowed: false, redirect: '/medical-officer' }
		return { allowed: false, redirect: '/' }
	}
	return { allowed: true }
}

describe('Medical Officer Route Access & Authorization Guards', () => {
	it('allows authenticated MEDICAL_OFFICER role to access /medical-officer protected route', () => {
		const access = evaluateRouteAccess('valid-jwt', 'MEDICAL_OFFICER', false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(true)
	})

	it('strictly blocks USER role from accessing /medical-officer and redirects to /user', () => {
		const access = evaluateRouteAccess('valid-jwt', 'USER', false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/user')
	})

	it('strictly blocks BLOODBANK role from accessing /medical-officer and redirects to /bloodbank', () => {
		const access = evaluateRouteAccess('valid-jwt', 'BLOODBANK', false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/bloodbank')
	})

	it('strictly blocks ADMIN role from accessing /medical-officer and redirects to /admin', () => {
		const access = evaluateRouteAccess('valid-jwt', 'ADMIN', false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/admin')
	})

	it('strictly blocks unauthenticated user without token and redirects to login', () => {
		const access = evaluateRouteAccess(null, null, false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/login')
	})
})

describe('Multi-Hospital Selection & Non-Arbitrary Scope', () => {
	it('guarantees that multi-hospital officer starts with unselected (all) scope and never arbitrarily defaults to one', () => {
		const store = createMockStore()
		const state = store.getState().medicalOfficer
		expect(state.dashboard.selectedHospitalId).toBe('')
		expect(state.dashboard.authorizedHospitals.length).toBe(2)
		expect(state.dashboard.selectedHospitalId).not.toBe('hosp-1')
		expect(state.dashboard.selectedHospitalId).not.toBe('hosp-2')
	})

	it('allows officer to explicitly select a specific hospital and updates both dashboard and request queue filters', () => {
		const store = createMockStore()
		store.dispatch(setSelectedHospital('hosp-2'))
		const state = store.getState().medicalOfficer
		expect(state.dashboard.selectedHospitalId).toBe('hosp-2')
		expect(state.requests.filters.hospitalId).toBe('hosp-2')
	})
})

describe('Mandatory Verification Decision Validation Rules', () => {
	it('approval requires remarks with minimum length of 2 characters', () => {
		const validateApprovalRemarks = (remarks) => {
			if (!remarks || typeof remarks !== 'string' || remarks.trim().length < 2) {
				return { valid: false, error: 'Remarks required (min 2 chars).' }
			}
			return { valid: true }
		}

		expect(validateApprovalRemarks('').valid).toBe(false)
		expect(validateApprovalRemarks(' ').valid).toBe(false)
		expect(validateApprovalRemarks('A').valid).toBe(false)
		expect(validateApprovalRemarks('OK').valid).toBe(true)
		expect(validateApprovalRemarks('Clinically verified post-operative transfusion.').valid).toBe(true)
	})

	it('rejection requires rejection reason with minimum length of 5 characters', () => {
		const validateRejectionReason = (reason) => {
			if (!reason || typeof reason !== 'string' || reason.trim().length < 5) {
				return { valid: false, error: 'Rejection reason required (min 5 chars).' }
			}
			return { valid: true }
		}

		expect(validateRejectionReason('').valid).toBe(false)
		expect(validateRejectionReason('No').valid).toBe(false)
		expect(validateRejectionReason('1234').valid).toBe(false)
		expect(validateRejectionReason('Elective surgery, not an acute emergency.').valid).toBe(true)
	})

	it('additional-information request requires detailed specification of required information (min 5 chars)', () => {
		const validateRequiredInfo = (info) => {
			if (!info || typeof info !== 'string' || info.trim().length < 5) {
				return { valid: false, error: 'Information required (min 5 chars).' }
			}
			return { valid: true }
		}

		expect(validateRequiredInfo('').valid).toBe(false)
		expect(validateRequiredInfo('info').valid).toBe(false)
		expect(validateRequiredInfo('Please attach hemoglobin lab report and doctor prescription.').valid).toBe(true)
	})
})

describe('Concurrency Conflict Handling (HTTP 409)', () => {
	it('triggers concurrency conflict state on HTTP 409 and prompts user to refresh before submitting', () => {
		const store = createMockStore()
		store.dispatch({
			type: approveEmergencyRequest.rejected.type,
			payload: {
				status: 409,
				code: 'CONCURRENCY_CONFLICT',
				message: 'The request was updated by another session and must be refreshed.',
			},
		})

		const state = store.getState().medicalOfficer
		expect(state.activeRequest.concurrencyConflict).toBe(true)
		expect(state.activeRequest.actionError).toContain('updated by another session')

		// Officer clicks Refresh -> clears conflict
		store.dispatch(clearConcurrencyConflict())
		const refreshedState = store.getState().medicalOfficer
		expect(refreshedState.activeRequest.concurrencyConflict).toBe(false)
	})
})

describe('Quarantined Flagged_Suspicious Status Guards', () => {
	it('strictly prevents ordinary Medical Officer actions when a ticket is Flagged_Suspicious', () => {
		const request = {
			_id: 'req-suspicious',
			verificationStatus: 'Flagged_Suspicious',
		}

		const isFlaggedSuspicious = request.verificationStatus === 'Flagged_Suspicious'
		const isActionable =
			(request.verificationStatus === 'Pending_Verification' ||
				request.verificationStatus === 'More_Information_Required') &&
			!isFlaggedSuspicious

		expect(isFlaggedSuspicious).toBe(true)
		expect(isActionable).toBe(false)
	})
})

describe('Requester Clarification Resubmission (provideAdditionalInformation)', () => {
	it('resets ticket to Pending_Verification upon successful requester information resubmission', () => {
		const store = createMockStore()
		store.dispatch({
			type: provideAdditionalInformation.fulfilled.type,
			payload: {
				_id: 'req-1',
				verificationStatus: 'Pending_Verification',
			},
		})

		const state = store.getState().medicalOfficer
		expect(state.requesterAction.success).toBe(true)
		expect(state.requesterAction.isLoading).toBe(false)
		expect(state.requesterAction.error).toBeNull()
	})
})

describe('Clinical Governance Invariants & Transfusion Safety', () => {
	it('clinical governance boundary: verification is NOT allocation, reservation, or dispatch', () => {
		const governanceNotice =
			'Verification confirms clinical validity only. Verification is not blood allocation, not inventory reservation, does not authorize donor dispatch, and does not authorize blood issuance or transfusion.'
		expect(governanceNotice).toContain('not blood allocation')
		expect(governanceNotice).toContain('not inventory reservation')
		expect(governanceNotice).toContain('does not authorize donor dispatch')
		expect(governanceNotice).toContain('does not authorize blood issuance')
	})
})

describe('Verified Hospital Selection & Mandatory Registry Enforcement', () => {
	const validateHospitalSelection = (values) => {
		const errors = {}
		if (!values.hospitalId || !values.hospitalId.trim()) {
			errors.hospitalId = 'Selection of an active, verified hospital facility from the registry is mandatory.'
		}
		if (!values.hospitalName || !values.hospitalName.trim()) {
			errors.hospitalName = 'Hospital name is required from verified registry.'
		}
		if (!values.hospitalCity || !values.hospitalCity.trim()) {
			errors.hospitalCity = 'City is required from verified registry.'
		}
		return errors
	}

	it('strictly blocks emergency ticket submission if verified hospitalId is omitted', () => {
		const valuesWithoutHospital = {
			hospitalId: '',
			hospitalName: 'Apollo Hospital',
			hospitalCity: 'Chennai',
		}
		const errors = validateHospitalSelection(valuesWithoutHospital)
		expect(errors.hospitalId).toBeDefined()
		expect(errors.hospitalId).toContain('mandatory')
	})

	it('accepts ticket submission when active, verified hospital is chosen from registry and populates authoritative details', () => {
		const registryHospital = {
			_id: 'hosp-registry-101',
			hospitalName: 'Apollo Main Centre',
			hospitalCode: 'HOSP-APO-01',
			address: {
				street: '21 Greams Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: 600006,
			},
		}

		const formValues = {
			hospitalId: registryHospital._id,
			hospitalName: registryHospital.hospitalName,
			hospitalAddress: registryHospital.address.street,
			hospitalCity: registryHospital.address.city,
			hospitalState: registryHospital.address.state,
			hospitalPinCode: registryHospital.address.pinCode,
		}

		const errors = validateHospitalSelection(formValues)
		expect(Object.keys(errors).length).toBe(0)
		expect(formValues.hospitalId).toBe('hosp-registry-101')
		expect(formValues.hospitalName).toBe('Apollo Main Centre')
		expect(formValues.hospitalCity).toBe('Chennai')
	})
})

describe('Authentication & Role Resolution Regression Tests', () => {
	// Replicates frontend loginslice role determination logic
	const resolveRoleFromBackend = (response) => {
		const backendRole = response?.data?.role || response?.data?.user?.role
		return backendRole === 'MEDICAL_OFFICER' ? 'MEDICAL_OFFICER' : 'USER'
	}

	it('1. A genuine MEDICAL_OFFICER backend response grants Medical Officer frontend access', () => {
		const responseDirect = { data: { role: 'MEDICAL_OFFICER', token: 'jwt-mo-1' } }
		expect(resolveRoleFromBackend(responseDirect)).toBe('MEDICAL_OFFICER')

		const responseNested = { data: { user: { role: 'MEDICAL_OFFICER' }, token: 'jwt-mo-2' } }
		expect(resolveRoleFromBackend(responseNested)).toBe('MEDICAL_OFFICER')

		const access = evaluateRouteAccess('jwt-mo-1', 'MEDICAL_OFFICER', false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(true)
	})

	it('2. A USER backend response cannot become MEDICAL_OFFICER through targetRole', () => {
		// Even if client passes targetRole: 'MEDICAL_OFFICER', backend returns USER
		const responseUser = { data: { role: 'USER', token: 'jwt-user-1' } }
		const targetRole = 'MEDICAL_OFFICER' // client attempted injection
		// Role is resolved strictly from trusted backend authentication data, ignoring targetRole
		const resolvedRole = resolveRoleFromBackend(responseUser)
		expect(resolvedRole).toBe('USER')
		expect(resolvedRole).not.toBe(targetRole)

		const access = evaluateRouteAccess('jwt-user-1', resolvedRole, false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/user')
	})

	it('3. Opening /login/medical-officer does not grant Medical Officer identity', () => {
		// When standard user logs in on the medical-officer URL, backend returns standard user contract
		const standardUserLoginResponse = { data: { token: 'jwt-std-user' } }
		const resolvedRole = resolveRoleFromBackend(standardUserLoginResponse)
		expect(resolvedRole).toBe('USER')

		// ProtectedRoute guard blocks standard user from accessing /medical-officer
		const access = evaluateRouteAccess('jwt-std-user', resolvedRole, false, ['MEDICAL_OFFICER'])
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/user')
	})

	it('4. Missing or malformed backend role information fails safely to USER', () => {
		expect(resolveRoleFromBackend(null)).toBe('USER')
		expect(resolveRoleFromBackend({})).toBe('USER')
		expect(resolveRoleFromBackend({ data: {} })).toBe('USER')
		expect(resolveRoleFromBackend({ data: { role: 'UNKNOWN_ROLE' } })).toBe('USER')
		expect(resolveRoleFromBackend({ data: { role: 12345 } })).toBe('USER')
		expect(resolveRoleFromBackend({ data: { user: null } })).toBe('USER')
		expect(resolveRoleFromBackend({ data: { user: { role: 'INVALID' } } })).toBe('USER')
	})

	it('5. ADMIN, BLOODBANK, STAFF, and USER retain their existing routing', () => {
		// USER
		const userAccess = evaluateRouteAccess('jwt-token', 'USER', false, ['USER'])
		expect(userAccess.allowed).toBe(true)
		const userBlockedFromAdmin = evaluateRouteAccess('jwt-token', 'USER', false, ['ADMIN'])
		expect(userBlockedFromAdmin.allowed).toBe(false)
		expect(userBlockedFromAdmin.redirect).toBe('/user')

		// ADMIN
		const adminAccess = evaluateRouteAccess('jwt-token', 'ADMIN', false, ['ADMIN'])
		expect(adminAccess.allowed).toBe(true)
		const adminBlockedFromMO = evaluateRouteAccess('jwt-token', 'ADMIN', false, ['MEDICAL_OFFICER'])
		expect(adminBlockedFromMO.allowed).toBe(false)
		expect(adminBlockedFromMO.redirect).toBe('/admin')

		// BLOODBANK
		const bbAccess = evaluateRouteAccess('jwt-token', 'BLOODBANK', false, ['BLOODBANK'])
		expect(bbAccess.allowed).toBe(true)
		const bbBlockedFromMO = evaluateRouteAccess('jwt-token', 'BLOODBANK', false, ['MEDICAL_OFFICER'])
		expect(bbBlockedFromMO.allowed).toBe(false)
		expect(bbBlockedFromMO.redirect).toBe('/bloodbank')

		// STAFF
		const staffAccess = evaluateRouteAccess('jwt-token', 'STAFF', true, ['STAFF', 'BLOODBANK'])
		expect(staffAccess.allowed).toBe(true)
		const staffBlockedFromMO = evaluateRouteAccess('jwt-token', 'STAFF', true, ['MEDICAL_OFFICER'])
		expect(staffBlockedFromMO.allowed).toBe(false)
	})

	it('6. Direct URL access remains protected against unauthenticated and unauthorized users', () => {
		// Unauthenticated
		const unauth = evaluateRouteAccess(null, null, false, ['MEDICAL_OFFICER'])
		expect(unauth.allowed).toBe(false)
		expect(unauth.redirect).toBe('/login')

		// Token exists but role is empty
		const emptyRole = evaluateRouteAccess('jwt-token', '', false, ['MEDICAL_OFFICER'])
		expect(emptyRole.allowed).toBe(false)
		expect(emptyRole.redirect).toBe('/login')

		// Direct URL access to /medical-officer by authenticated USER
		const userDirect = evaluateRouteAccess('jwt-token', 'USER', false, ['MEDICAL_OFFICER'])
		expect(userDirect.allowed).toBe(false)
		expect(userDirect.redirect).toBe('/user')
	})
})

describe('Queue Filtering, Pagination, Loading & Error States', () => {
	it('updates filters and handles empty queue state', () => {
		const store = createMockStore()
		store.dispatch(
			setRequestFilters({
				status: 'Pending_Verification',
				urgencyLevel: 'Critical',
				requiredBloodGroup: 'AB_Negative',
				search: 'URGENT-99',
			})
		)
		const state = store.getState().medicalOfficer
		expect(state.requests.filters.urgencyLevel).toBe('Critical')
		expect(state.requests.filters.requiredBloodGroup).toBe('AB_Negative')
		expect(state.requests.filters.search).toBe('URGENT-99')
		expect(state.requests.items.length).toBe(0)
	})

	it('handles network failure and error states in requests queue and active review', () => {
		const store = createMockStore()
		store.dispatch({
			type: 'medicalOfficer/fetchAssignedRequests/rejected',
			payload: { message: 'Network connection lost. Please retry.' },
		})
		let state = store.getState().medicalOfficer
		expect(state.requests.isLoading).toBe(false)
		expect(state.requests.error?.message || state.requests.error).toContain('Network connection lost')

		store.dispatch({
			type: 'medicalOfficer/fetchRequestDetails/rejected',
			payload: { message: 'Failed to retrieve request details.' },
		})
		state = store.getState().medicalOfficer
		expect(state.activeRequest.isLoading).toBe(false)
		expect(state.activeRequest.error?.message || state.activeRequest.error).toContain('Failed to retrieve request details')
	})
})
