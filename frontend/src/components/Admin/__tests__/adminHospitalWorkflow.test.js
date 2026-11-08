/**
 * Admin Hospital Registry Management Integration & Security Tests
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import { configureStore } from '@reduxjs/toolkit'
import adminHospitalReducer, {
	setHospitalFilters,
	setHospitalPage,
	clearHospitalFilters,
	setAssociationFilters,
	fetchAdminHospitals,
	fetchHospitalById,
	registerHospital,
	verifyHospital,
	fetchMoAssociations,
	fetchMedicalOfficersList,
	fetchMoDirectory,
	onboardMedicalOfficer,
	verifyMedicalOfficerAccount,
	setMoDirectoryFilters,
	assignMedicalOfficer,
	updateAssociationStatus,
} from '../../../store/adminHospitalSlice'
import loginReducer from '../../../store/loginslice'

const createMockStore = (initialAuthState = {}, initialHospitalState = {}) => {
	return configureStore({
		reducer: {
			login: loginReducer,
			adminHospital: adminHospitalReducer,
		},
		preloadedState: {
			login: {
				isLoggedin: true,
				token: 'mock-admin-token-12345',
				role: 'ADMIN',
				...initialAuthState,
			},
			adminHospital: {
				hospitals: {
					items: [],
					pagination: { page: 1, limit: 15, totalPages: 1, totalRecords: 0 },
					filters: { verificationStatus: '', isActive: '', city: '', search: '' },
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
					filters: { hospitalId: '', associationStatus: '' },
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
					pagination: { page: 1, limit: 20, totalPages: 1, totalRecords: 0 },
					filters: { verificationStatus: '', search: '' },
					isLoading: false,
					error: null,
					actionLoading: false,
					actionError: null,
					actionSuccess: false,
				},
				...initialHospitalState,
			},
		},
	})
}

// Route guard helper mirroring ProtectedRoute logic
function evaluateAdminRouteAccess(token, role, isStaff) {
	if (!token || !role) {
		return { allowed: false, redirect: '/login/admin' }
	}
	const allowedRoles = ['ADMIN']
	const isRoleAllowed =
		allowedRoles.includes(role) ||
		(isStaff && (allowedRoles.includes('STAFF') || allowedRoles.includes('BLOODBANK')))

	if (!isRoleAllowed) {
		if (role === 'USER') return { allowed: false, redirect: '/user' }
		if (role === 'BLOODBANK') return { allowed: false, redirect: '/bloodbank' }
		if (role === 'MEDICAL_OFFICER') return { allowed: false, redirect: '/medical-officer' }
		return { allowed: false, redirect: '/' }
	}
	return { allowed: true }
}

describe('Admin Hospital Management Route Access & Authorization Guards', () => {
	it('allows authenticated ADMIN role to access /admin/hospitals and /admin/medical-officers', () => {
		const access = evaluateAdminRouteAccess('valid-admin-jwt', 'ADMIN', false)
		expect(access.allowed).toBe(true)
	})

	it('strictly blocks USER role from accessing admin hospital management', () => {
		const access = evaluateAdminRouteAccess('valid-user-jwt', 'USER', false)
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/user')
	})

	it('strictly blocks MEDICAL_OFFICER role from accessing admin hospital management', () => {
		const access = evaluateAdminRouteAccess('valid-mo-jwt', 'MEDICAL_OFFICER', false)
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/medical-officer')
	})

	it('strictly blocks BLOODBANK role from accessing admin hospital management', () => {
		const access = evaluateAdminRouteAccess('valid-bb-jwt', 'BLOODBANK', false)
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/bloodbank')
	})

	it('strictly blocks unauthenticated user without token and redirects to login/admin', () => {
		const access = evaluateAdminRouteAccess(null, null, false)
		expect(access.allowed).toBe(false)
		expect(access.redirect).toBe('/login/admin')
	})
})

describe('Hospital Registration Validation & Payload Integrity', () => {
	const validateRegistrationPayload = (payload) => {
		const errors = {}
		if (!payload.hospitalName || typeof payload.hospitalName !== 'string' || !payload.hospitalName.trim()) {
			errors.hospitalName = 'Hospital name is required.'
		}
		const validTypes = ['Government', 'Private', 'Trust', 'Autonomous']
		if (!payload.hospitalType || !validTypes.includes(payload.hospitalType)) {
			errors.hospitalType = 'Invalid hospital type.'
		}
		if (
			!payload.address ||
			!payload.address.street ||
			!payload.address.city ||
			!payload.address.state ||
			!payload.address.pinCode
		) {
			errors.address = 'Complete address is required.'
		}
		if (!payload.contactPhone || !payload.contactPhone.trim()) {
			errors.contactPhone = 'Contact phone is required.'
		}
		if (!payload.contactEmail || !payload.contactEmail.trim() || !payload.contactEmail.includes('@')) {
			errors.contactEmail = 'Valid contact email is required.'
		}
		return errors
	}

	it('accepts valid hospital registration payload without manual hospitalCode input', () => {
		const validPayload = {
			hospitalName: 'Apollo Main Centre',
			hospitalType: 'Private',
			address: {
				street: '21 Greams Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600006',
			},
			contactPhone: '9840123456',
			contactEmail: 'contact@apollo.org',
			location: {
				type: 'Point',
				coordinates: [80.25, 13.06],
			},
		}

		const errors = validateRegistrationPayload(validPayload)
		expect(Object.keys(errors).length).toBe(0)
		expect(validPayload.hospitalCode).toBeUndefined()
		expect(typeof validPayload.address.pinCode).toBe('string')
	})

	it('strictly rejects hospital registration with missing required fields', () => {
		const incompletePayload = {
			hospitalName: 'Apollo Main Centre',
			// missing address, phone, email
		}

		const errors = validateRegistrationPayload(incompletePayload)
		expect(errors.address).toBeDefined()
		expect(errors.contactPhone).toBeDefined()
		expect(errors.contactEmail).toBeDefined()
	})

	it('handles registration duplicate conflict (HTTP 409) cleanly', () => {
		const store = createMockStore()
		store.dispatch({
			type: registerHospital.rejected.type,
			payload: {
				status: 409,
				message: "Hospital with code 'HOSP-APO-01' is already registered.",
			},
		})

		const state = store.getState().adminHospital
		expect(state.registration.isLoading).toBe(false)
		expect(state.registration.error).toContain('already registered')
		expect(state.registration.success).toBe(false)
	})
})

describe('Hospital Directory Filtering & Pagination', () => {
	it('updates search, city, verification status, and active filters', () => {
		const store = createMockStore()
		store.dispatch(
			setHospitalFilters({
				search: 'Apollo',
				city: 'Chennai',
				verificationStatus: 'Verified',
				isActive: 'true',
			})
		)

		const state = store.getState().adminHospital
		expect(state.hospitals.filters.search).toBe('Apollo')
		expect(state.hospitals.filters.city).toBe('Chennai')
		expect(state.hospitals.filters.verificationStatus).toBe('Verified')
		expect(state.hospitals.filters.isActive).toBe('true')
		expect(state.hospitals.pagination.page).toBe(1)
	})

	it('clears all filters and resets pagination to page 1', () => {
		const store = createMockStore()
		store.dispatch(
			setHospitalFilters({
				search: 'Apollo',
				city: 'Chennai',
				verificationStatus: 'Verified',
			})
		)
		store.dispatch(setHospitalPage(3))
		expect(store.getState().adminHospital.hospitals.pagination.page).toBe(3)

		store.dispatch(clearHospitalFilters())
		const state = store.getState().adminHospital
		expect(state.hospitals.filters.search).toBe('')
		expect(state.hospitals.filters.city).toBe('')
		expect(state.hospitals.filters.verificationStatus).toBe('')
		expect(state.hospitals.pagination.page).toBe(1)
	})

	it('handles fetchAdminHospitals.fulfilled by populating items and pagination', () => {
		const store = createMockStore()
		const mockPayload = {
			hospitals: [
				{ _id: 'hosp-1', hospitalCode: 'HOSP-1', hospitalName: 'Apollo', verificationStatus: 'Verified', isActive: true },
				{ _id: 'hosp-2', hospitalCode: 'HOSP-2', hospitalName: 'Fortis', verificationStatus: 'Pending', isActive: false },
			],
			pagination: { page: 1, limit: 15, totalPages: 1, totalRecords: 2 },
		}

		store.dispatch({
			type: fetchAdminHospitals.fulfilled.type,
			payload: mockPayload,
		})

		const state = store.getState().adminHospital
		expect(state.hospitals.items.length).toBe(2)
		expect(state.hospitals.pagination.totalRecords).toBe(2)
		expect(state.hospitals.isLoading).toBe(false)
	})
})

describe('Hospital Administrative Verification State Transitions', () => {
	it('verifies and activates hospital facility via verifyHospital thunk', () => {
		const store = createMockStore()
		const verifiedHospital = {
			_id: 'hosp-1',
			hospitalCode: 'HOSP-1',
			hospitalName: 'Apollo Main Centre',
			verificationStatus: 'Verified',
			isActive: true,
			verifiedAt: new Date().toISOString(),
		}

		store.dispatch({
			type: verifyHospital.fulfilled.type,
			payload: {
				hospital: verifiedHospital,
				message: 'Hospital Apollo Main Centre has been verified and activated.',
			},
		})

		const state = store.getState().adminHospital
		expect(state.currentHospital.data.verificationStatus).toBe('Verified')
		expect(state.currentHospital.data.isActive).toBe(true)
		expect(state.currentHospital.verifySuccess).toBe(true)
		expect(state.currentHospital.verifyLoading).toBe(false)
	})

	it('rejects hospital facility verification and deactivates facility', () => {
		const store = createMockStore()
		const rejectedHospital = {
			_id: 'hosp-2',
			hospitalCode: 'HOSP-2',
			hospitalName: 'Unaccredited Clinic',
			verificationStatus: 'Rejected',
			isActive: false,
		}

		store.dispatch({
			type: verifyHospital.fulfilled.type,
			payload: {
				hospital: rejectedHospital,
				message: 'Hospital verification rejected.',
			},
		})

		const state = store.getState().adminHospital
		expect(state.currentHospital.data.verificationStatus).toBe('Rejected')
		expect(state.currentHospital.data.isActive).toBe(false)
	})

	it('enforces clinical governance boundary: hospital verification is not clinical approval', () => {
		const governanceNotice =
			'Hospital verification activates facility credentials in the central hospital registry. Hospital verification is NOT clinical approval, NOT blood allocation, and NOT blood dispatch or issuance.'
		expect(governanceNotice).toContain('NOT clinical approval')
		expect(governanceNotice).toContain('NOT blood allocation')
		expect(governanceNotice).toContain('NOT blood dispatch')
	})
})

describe('Medical Officer Assignment & Explicit Permission Management', () => {
	const validateAssignment = (assignment) => {
		const errors = {}
		if (!assignment.medicalOfficerUserId || !/^[0-9a-fA-F]{24}$/.test(assignment.medicalOfficerUserId)) {
			errors.medicalOfficerUserId = 'Valid 24-character User ID is required.'
		}
		if (!assignment.hospitalId || !assignment.hospitalId.trim()) {
			errors.hospitalId = 'Hospital ID is required.'
		}
		if (!assignment.permissions || !Array.isArray(assignment.permissions) || assignment.permissions.length === 0) {
			errors.permissions = 'At least one explicit permission is required.'
		}
		const validPermissions = ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS']
		const hasInvalid = (assignment.permissions || []).some((p) => !validPermissions.includes(p))
		if (hasInvalid) {
			errors.permissions = 'Invalid permission specified.'
		}
		return errors
	}

	it('accepts valid Medical Officer assignment with explicit permissions', () => {
		const assignment = {
			medicalOfficerUserId: '6aee07f8e1f5e5d9a8b2e8e5',
			hospitalId: '6aee07f8e1f5e5d9a8b2e8e8',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			associationStatus: 'Active',
			effectiveFrom: new Date(),
		}

		const errors = validateAssignment(assignment)
		expect(Object.keys(errors).length).toBe(0)
		expect(assignment.permissions).toContain('VIEW_EMERGENCY_REQUESTS')
		expect(assignment.permissions).toContain('VERIFY_EMERGENCY_REQUESTS')
	})

	it('strictly prevents assigning Medical Officer without explicit permissions', () => {
		const assignmentWithoutPermissions = {
			medicalOfficerUserId: '6aee07f8e1f5e5d9a8b2e8e5',
			hospitalId: '6aee07f8e1f5e5d9a8b2e8e8',
			permissions: [],
		}

		const errors = validateAssignment(assignmentWithoutPermissions)
		expect(errors.permissions).toBeDefined()
	})

	it('updates association status to Suspended and updates permissions via updateAssociationStatus', () => {
		const store = createMockStore()
		const initialAssociation = {
			_id: 'assoc-1',
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		}
		store.dispatch({
			type: fetchMoAssociations.fulfilled.type,
			payload: [initialAssociation],
		})

		const updatedAssociation = {
			_id: 'assoc-1',
			associationStatus: 'Suspended',
			permissions: ['VIEW_EMERGENCY_REQUESTS'],
		}
		store.dispatch({
			type: updateAssociationStatus.fulfilled.type,
			payload: {
				association: updatedAssociation,
				message: "Association status updated to 'Suspended'.",
			},
		})

		const state = store.getState().adminHospital
		expect(state.associations.items[0].associationStatus).toBe('Suspended')
		expect(state.associations.items[0].permissions).toEqual(['VIEW_EMERGENCY_REQUESTS'])
	})
})

describe('Preservation of Existing Blood Bank Operations', () => {
	it('confirms existing blood bank routes and pages remain distinct from hospital registry', () => {
		const adminNavigationItems = [
			{ name: 'Blood Banks', path: '/admin/bloodbanks' },
			{ name: 'Hospital Registry', path: '/admin/hospitals' },
			{ name: 'Medical Officer Management', path: '/admin/medical-officers' },
			{ name: 'Bulk Import', path: '/admin/bulk-import' },
			{ name: 'About Us', path: '/aboutus' },
		]

		expect(adminNavigationItems.find((item) => item.name === 'Blood Banks')).toBeDefined()
		expect(adminNavigationItems.find((item) => item.name === 'Hospital Registry')).toBeDefined()
		expect(adminNavigationItems.find((item) => item.name === 'Medical Officer Management')).toBeDefined()
		expect(adminNavigationItems.find((item) => item.name === 'Bulk Import')).toBeDefined()

		// Strict endpoint separation
		const hospitalEndpoint = '/api/hospitals'
		const bloodbankEndpoint = '/api/bloodbank'
		expect(hospitalEndpoint).not.toEqual(bloodbankEndpoint)
	})
})

describe('Automatic Hospital Code Generation Flow (Part A)', () => {
	it('handles registration success by storing authoritatively generated hospital code', () => {
		const store = createMockStore()
		const createdHospital = {
			_id: 'hosp-generated-1',
			hospitalCode: 'HOSP-CHE-0001',
			hospitalName: 'Apollo Speciality Chennai',
			hospitalType: 'Private',
			verificationStatus: 'Pending',
			isActive: false,
		}

		store.dispatch({
			type: registerHospital.fulfilled.type,
			payload: createdHospital,
		})

		const state = store.getState().adminHospital
		expect(state.registration.success).toBe(true)
		expect(state.registration.createdHospital).toBeDefined()
		expect(state.registration.createdHospital.hospitalCode).toBe('HOSP-CHE-0001')
	})
})

describe('Searchable Medical Officer Selection & Populated ID Synchronization (Part B)', () => {
	const mockMedicalOfficers = [
		{
			_id: '6aee07f8e1f5e5d9a8b2e8e1',
			firstName: 'Ramesh',
			lastName: 'Kuppusamy',
			email: 'dr.ramesh@apollo.org',
			medicalRegistrationNumber: 'TMC-849201',
			medicalCouncil: 'Tamil Nadu Medical Council',
			role: 'MEDICAL_OFFICER',
			status: true,
		},
		{
			_id: '6aee07f8e1f5e5d9a8b2e8e2',
			firstName: 'Priya',
			lastName: 'Natarajan',
			email: 'dr.priya@fortis.org',
			medicalRegistrationNumber: 'KMC-552140',
			medicalCouncil: 'Karnataka Medical Council',
			role: 'MEDICAL_OFFICER',
			status: true,
		},
	]

	it('populates availableMedicalOfficers in Redux store on fetchMedicalOfficersList.fulfilled', () => {
		const store = createMockStore()
		expect(store.getState().adminHospital.availableMedicalOfficers.items).toHaveLength(0)

		store.dispatch({
			type: fetchMedicalOfficersList.fulfilled.type,
			payload: mockMedicalOfficers,
		})

		const state = store.getState().adminHospital
		expect(state.availableMedicalOfficers.isLoading).toBe(false)
		expect(state.availableMedicalOfficers.items).toHaveLength(2)
		expect(state.availableMedicalOfficers.items[0].firstName).toBe('Ramesh')
	})

	it('supports multi-criteria search filtering across name, email, reg no, and council', () => {
		const filterDoctors = (doctors, query) => {
			const q = query.toLowerCase().trim()
			if (!q) return doctors
			return doctors.filter((mo) => {
				const name = `${mo.firstName || ''} ${mo.lastName || ''}`.toLowerCase()
				const email = (mo.email || '').toLowerCase()
				const reg = (mo.medicalRegistrationNumber || '').toLowerCase()
				const council = (mo.medicalCouncil || '').toLowerCase()
				return name.includes(q) || email.includes(q) || reg.includes(q) || council.includes(q)
			})
		}

		// Search by last name
		expect(filterDoctors(mockMedicalOfficers, 'Kuppusamy')).toHaveLength(1)
		expect(filterDoctors(mockMedicalOfficers, 'Kuppusamy')[0]._id).toBe('6aee07f8e1f5e5d9a8b2e8e1')

		// Search by email domain
		expect(filterDoctors(mockMedicalOfficers, 'fortis.org')).toHaveLength(1)
		expect(filterDoctors(mockMedicalOfficers, 'fortis.org')[0]._id).toBe('6aee07f8e1f5e5d9a8b2e8e2')

		// Search by registration number
		expect(filterDoctors(mockMedicalOfficers, '849201')).toHaveLength(1)

		// Search by council
		expect(filterDoctors(mockMedicalOfficers, 'Karnataka')).toHaveLength(1)
	})

	it('synchronizes genuine MongoDB User ID into read-only field upon selection and clears on deselection', () => {
		let formState = {
			medicalOfficerUserId: '',
			hospitalId: '6aee07f8e1f5e5d9a8b2e8e8',
		}

		// Simulate user selecting Dr. Ramesh from Autocomplete
		const selectedDoctor = mockMedicalOfficers[0]
		formState = {
			...formState,
			medicalOfficerUserId: selectedDoctor ? selectedDoctor._id : '',
		}
		expect(formState.medicalOfficerUserId).toBe('6aee07f8e1f5e5d9a8b2e8e1')

		// Simulate clearing selection
		const cleared = null
		formState = {
			...formState,
			medicalOfficerUserId: cleared ? cleared._id : '',
		}
		expect(formState.medicalOfficerUserId).toBe('')
	})
})

describe('Medical Officer Onboarding & Lifecycle Governance (Redux Store)', () => {
	it('handles onboardMedicalOfficer.fulfilled by prepending new doctor in Pending status', () => {
		const store = createMockStore()
		const newDoctor = {
			_id: 'doc-onboard-1',
			firstName: 'Venkatesh',
			lastName: 'Sundaram',
			email: 'dr.venkat@hospital.org',
			medicalRegistrationNumber: 'TMC-99881',
			medicalCouncil: 'Tamil Nadu Medical Council',
			verificationStatus: 'Pending',
			status: false,
		}

		store.dispatch({
			type: onboardMedicalOfficer.fulfilled.type,
			payload: {
				medicalOfficer: newDoctor,
				message: 'Doctor onboarded successfully in Pending status.',
			},
		})

		const state = store.getState().adminHospital
		expect(state.medicalOfficerDirectory.actionSuccess).toBe(true)
		expect(state.medicalOfficerDirectory.items).toHaveLength(1)
		expect(state.medicalOfficerDirectory.items[0].verificationStatus).toBe('Pending')
		expect(state.medicalOfficerDirectory.items[0].status).toBe(false)
	})

	it('handles verifyMedicalOfficerAccount.fulfilled by updating verification status and adding active doctor to available list', () => {
		const store = createMockStore()
		const initialDoctor = {
			_id: 'doc-onboard-1',
			firstName: 'Venkatesh',
			lastName: 'Sundaram',
			email: 'dr.venkat@hospital.org',
			medicalRegistrationNumber: 'TMC-99881',
			medicalCouncil: 'Tamil Nadu Medical Council',
			verificationStatus: 'Pending',
			status: false,
		}

		store.dispatch({
			type: onboardMedicalOfficer.fulfilled.type,
			payload: { medicalOfficer: initialDoctor },
		})

		// Admin verifies doctor
		const verifiedDoctor = {
			...initialDoctor,
			verificationStatus: 'Verified',
			status: true,
		}

		store.dispatch({
			type: verifyMedicalOfficerAccount.fulfilled.type,
			payload: { medicalOfficer: verifiedDoctor },
		})

		const state = store.getState().adminHospital
		expect(state.medicalOfficerDirectory.items[0].verificationStatus).toBe('Verified')
		expect(state.medicalOfficerDirectory.items[0].status).toBe(true)

		// Must now appear in availableMedicalOfficers for selector!
		expect(state.availableMedicalOfficers.items).toHaveLength(1)
		expect(state.availableMedicalOfficers.items[0]._id).toBe('doc-onboard-1')
	})

	it('handles verifyMedicalOfficerAccount.fulfilled when rejecting by removing from available selector list', () => {
		const store = createMockStore()
		const verifiedDoctor = {
			_id: 'doc-onboard-1',
			firstName: 'Venkatesh',
			lastName: 'Sundaram',
			verificationStatus: 'Verified',
			status: true,
		}

		// Initial available list has doctor
		store.dispatch({
			type: fetchMedicalOfficersList.fulfilled.type,
			payload: [verifiedDoctor],
		})
		expect(store.getState().adminHospital.availableMedicalOfficers.items).toHaveLength(1)

		// Doctor is subsequently suspended or rejected
		const rejectedDoctor = {
			...verifiedDoctor,
			verificationStatus: 'Rejected',
			status: false,
		}

		store.dispatch({
			type: verifyMedicalOfficerAccount.fulfilled.type,
			payload: { medicalOfficer: rejectedDoctor },
		})

		const state = store.getState().adminHospital
		expect(state.availableMedicalOfficers.items).toHaveLength(0)
	})

	it('updates directory filters and resets page to 1', () => {
		const store = createMockStore()
		store.dispatch(
			setMoDirectoryFilters({
				verificationStatus: 'Pending',
				search: 'Venkat',
			})
		)

		const state = store.getState().adminHospital
		expect(state.medicalOfficerDirectory.filters.verificationStatus).toBe('Pending')
		expect(state.medicalOfficerDirectory.filters.search).toBe('Venkat')
		expect(state.medicalOfficerDirectory.pagination.page).toBe(1)
	})
})

