/**
 * Role-Based Route Guard for React Router 6
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import React from 'react'
import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { useSelector } from 'react-redux'

export const ProtectedRoute = ({ allowedRoles = [], children }) => {
	const location = useLocation()
	const { token, role, isStaff } = useSelector((state) => state?.login || {})

	// 1. Unauthenticated Guard: Redirect to role-appropriate login route
	if (!token || !role) {
		const segment = location.pathname.split('/')[1]
		const targetRole =
			segment === 'admin'
				? 'admin'
				: segment === 'bloodbank'
				? 'bloodbank'
				: segment === 'medical-officer'
				? 'medical-officer'
				: 'user'
		return <Navigate to={`/login/${targetRole}`} state={{ from: location }} replace />
	}

	// 2. Role Authorization Guard
	const isRoleAllowed =
		allowedRoles.length === 0 ||
		allowedRoles.includes(role) ||
		(isStaff && (allowedRoles.includes('STAFF') || allowedRoles.includes('BLOODBANK')))

	if (!isRoleAllowed) {
		// Redirect authenticated user to their home portal instead of 404
		if (role === 'USER') return <Navigate to='/user' replace />
		if (role === 'BLOODBANK') return <Navigate to='/bloodbank' replace />
		if (role === 'ADMIN') return <Navigate to='/admin' replace />
		if (role === 'MEDICAL_OFFICER') return <Navigate to='/medical-officer' replace />
		return <Navigate to='/' replace />
	}

	return children ? children : <Outlet />
}

export default ProtectedRoute

