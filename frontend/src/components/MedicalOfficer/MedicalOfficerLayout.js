/**
 * Medical Officer Portal Layout
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Provides shared portal navigation, explicit multi-hospital selection,
 * and mandatory clinical safety warning banners.
 */

import React, { useEffect } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Container,
	Tabs,
	Tab,
	Paper,
	Typography,
	FormControl,
	InputLabel,
	Select,
	MenuItem,
	Alert,
	AlertTitle,
	Chip,
} from '@mui/material'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser'
import PendingActionsIcon from '@mui/icons-material/PendingActions'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import HighlightOffIcon from '@mui/icons-material/HighlightOff'
import DashboardIcon from '@mui/icons-material/Dashboard'
import {
	fetchMedicalOfficerDashboard,
	setSelectedHospital,
} from '../../store/medicalOfficerSlice'

const MedicalOfficerLayout = () => {
	const navigate = useNavigate()
	const location = useLocation()
	const dispatch = useDispatch()

	const { dashboard } = useSelector((state) => state?.medicalOfficer || {})
	const { authorizedHospitals = [], selectedHospitalId = '' } = dashboard

	useEffect(() => {
		dispatch(fetchMedicalOfficerDashboard(selectedHospitalId))
	}, [dispatch, selectedHospitalId])

	// Determine active tab from current URL
	const currentPath = location.pathname
	let activeTab = 0
	if (currentPath === '/medical-officer' || currentPath === '/medical-officer/') {
		activeTab = 0
	} else if (currentPath.includes('/pending')) {
		activeTab = 1
	} else if (currentPath.includes('/verified')) {
		activeTab = 2
	} else if (currentPath.includes('/rejected')) {
		activeTab = 3
	}

	const handleTabChange = (_, newValue) => {
		switch (newValue) {
			case 0:
				navigate('/medical-officer')
				break
			case 1:
				navigate('/medical-officer/pending')
				break
			case 2:
				navigate('/medical-officer/verified')
				break
			case 3:
				navigate('/medical-officer/rejected')
				break
			default:
				navigate('/medical-officer')
		}
	}

	const handleHospitalChange = (e) => {
		const newHospitalId = e.target.value
		dispatch(setSelectedHospital(newHospitalId))
		dispatch(fetchMedicalOfficerDashboard(newHospitalId))
	}

	return (
		<Container maxWidth='xl' sx={{ py: 3 }}>
			{/* Top Bar: Title & Hospital Selection */}
			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					background: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 100%)',
				}}
			>
				<Box
					sx={{
						display: 'flex',
						justifyContent: 'space-between',
						alignItems: 'center',
						flexWrap: 'wrap',
						gap: 2,
					}}
				>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
						<LocalHospitalIcon sx={{ color: '#059669', fontSize: 38 }} />
						<Box>
							<Typography variant='h5' component='h1' sx={{ fontWeight: 800, color: '#0f172a' }}>
								Medical Officer Verification Portal
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b' }}>
								Clinical verification and medical oversight for hospital emergency blood requests
							</Typography>
						</Box>
					</Box>

					{/* Explicit Multi-Hospital Selector (Never silently defaults to arbitrary hospital) */}
					{authorizedHospitals.length > 0 && (
						<Box sx={{ minWidth: 280 }}>
							<FormControl fullWidth size='small'>
								<InputLabel id='mo-hospital-select-label' sx={{ fontWeight: 600 }}>
									Hospital Facility Scope
								</InputLabel>
								<Select
									labelId='mo-hospital-select-label'
									value={selectedHospitalId}
									label='Hospital Facility Scope'
									onChange={handleHospitalChange}
									sx={{ bgcolor: '#ffffff', borderRadius: 2 }}
								>
									<MenuItem value=''>
										<em>All Authorized Facilities ({authorizedHospitals.length})</em>
									</MenuItem>
									{authorizedHospitals.map((h) => (
										<MenuItem key={h._id} value={h._id}>
											{h.hospitalName} ({h.hospitalCode}) — {h.address?.city || ''}
										</MenuItem>
									))}
								</Select>
							</FormControl>
						</Box>
					)}
				</Box>
			</Paper>

			{/* Mandatory Clinical Safety & Governance Banner */}
			<Alert
				severity='info'
				icon={<VerifiedUserIcon />}
				sx={{
					mb: 3,
					borderRadius: 2.5,
					border: '1px solid #bae6fd',
					bgcolor: '#f0f9ff',
					'& .MuiAlert-icon': { color: '#0284c7' },
				}}
			>
				<AlertTitle sx={{ fontWeight: 800, color: '#0369a1' }}>
					Clinical Governance & Safety Boundaries
				</AlertTitle>
				<Typography variant='body2' sx={{ color: '#0c4a6e', lineHeight: 1.5 }}>
					Verification confirms the <strong>clinical validity of the emergency blood requirement</strong>.
					Verification <strong>is not</strong> blood allocation, <strong>not</strong> inventory reservation,
					does <strong>not</strong> authorize donor dispatch, and does <strong>not</strong> authorize blood issuance or transfusion.
					Laboratory crossmatching and standard clinical transfusion safeguards remain mandatory.
				</Typography>
			</Alert>

			{/* Navigation Tabs */}
			<Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
				<Tabs
					value={activeTab}
					onChange={handleTabChange}
					variant='scrollable'
					scrollButtons='auto'
					textColor='primary'
					indicatorColor='primary'
					sx={{
						'& .MuiTab-root': {
							textTransform: 'none',
							fontWeight: 700,
							fontSize: '0.95rem',
							minHeight: 48,
						},
					}}
				>
					<Tab icon={<DashboardIcon />} iconPosition='start' label='Dashboard Overview' />
					<Tab
						icon={<PendingActionsIcon />}
						iconPosition='start'
						label={
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
								<span>Pending Requests</span>
								{dashboard.metrics?.pendingCount > 0 && (
									<Chip
										label={dashboard.metrics.pendingCount}
										size='small'
										color='warning'
										sx={{ height: 20, fontSize: '0.75rem', fontWeight: 800 }}
									/>
								)}
							</Box>
						}
					/>
					<Tab
						icon={<CheckCircleOutlineIcon />}
						iconPosition='start'
						label={
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
								<span>Verified Requests</span>
								{dashboard.metrics?.verifiedCount > 0 && (
									<Chip
										label={dashboard.metrics.verifiedCount}
										size='small'
										color='success'
										sx={{ height: 20, fontSize: '0.75rem', fontWeight: 800 }}
									/>
								)}
							</Box>
						}
					/>
					<Tab
						icon={<HighlightOffIcon />}
						iconPosition='start'
						label={
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
								<span>Rejected Requests</span>
								{dashboard.metrics?.rejectedCount > 0 && (
									<Chip
										label={dashboard.metrics.rejectedCount}
										size='small'
										color='error'
										sx={{ height: 20, fontSize: '0.75rem', fontWeight: 800 }}
									/>
								)}
							</Box>
						}
					/>
				</Tabs>
			</Box>

			{/* Render Child Pages */}
			<Outlet />
		</Container>
	)
}

export default MedicalOfficerLayout

