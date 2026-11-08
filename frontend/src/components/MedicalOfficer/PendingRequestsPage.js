/**
 * Medical Officer Pending Requests Page
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Displays filterable, paginated emergency blood requests in Pending_Verification
 * and More_Information_Required statuses for authorized hospital facilities.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Chip,
	Grid,
	Paper,
	TextField,
	Typography,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Pagination,
	FormControl,
	InputLabel,
	Select,
	MenuItem,
	CircularProgress,
	Alert,
	ToggleButtonGroup,
	ToggleButton,
	InputAdornment,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import FilterListIcon from '@mui/icons-material/FilterList'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { fetchAssignedRequests, setRequestFilters } from '../../store/medicalOfficerSlice'

const BLOOD_GROUPS = [
	'A_Positive',
	'A_Negative',
	'B_Positive',
	'B_Negative',
	'AB_Positive',
	'AB_Negative',
	'O_Positive',
	'O_Negative',
]

const URGENCY_CONFIG = {
	Critical: { label: 'CRITICAL (<2h)', color: 'error', bg: '#fee2e2', text: '#991b1b' },
	Urgent: { label: 'URGENT (2-6h)', color: 'warning', bg: '#fef3c7', text: '#92400e' },
	High_Priority: { label: 'HIGH (6-24h)', color: 'info', bg: '#e0f2fe', text: '#0369a1' },
}

const PendingRequestsPage = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { requests, dashboard } = useSelector((state) => state?.medicalOfficer || {})
	const { items, pagination, filters, isLoading, error } = requests
	const { selectedHospitalId } = dashboard

	const [statusTab, setStatusTab] = useState(filters.status || 'Pending_Verification')
	const [urgencyFilter, setUrgencyFilter] = useState(filters.urgencyLevel || '')
	const [bloodGroupFilter, setBloodGroupFilter] = useState(filters.requiredBloodGroup || '')
	const [searchQuery, setSearchQuery] = useState(filters.search || '')
	const [page, setPage] = useState(pagination.page || 1)

	const loadRequests = useCallback(
		(currentPage = page, status = statusTab) => {
			dispatch(
				fetchAssignedRequests({
					page: currentPage,
					limit: 15,
					status,
					urgencyLevel: urgencyFilter,
					requiredBloodGroup: bloodGroupFilter,
					search: searchQuery,
					hospitalId: selectedHospitalId || '',
				})
			)
		},
		[dispatch, page, statusTab, urgencyFilter, bloodGroupFilter, searchQuery, selectedHospitalId]
	)

	useEffect(() => {
		loadRequests(page, statusTab)
	}, [loadRequests, page, statusTab])

	const handleStatusChange = (_, newStatus) => {
		if (newStatus) {
			setStatusTab(newStatus)
			setPage(1)
			dispatch(setRequestFilters({ status: newStatus }))
		}
	}

	const handleFilterSubmit = (e) => {
		e.preventDefault()
		setPage(1)
		loadRequests(1, statusTab)
	}

	const handlePageChange = (_, newPage) => {
		setPage(newPage)
		loadRequests(newPage, statusTab)
	}

	return (
		<Box>
			{/* Sub-header & Status Toggle */}
			<Box
				sx={{
					display: 'flex',
					justifyContent: 'space-between',
					alignItems: 'center',
					flexWrap: 'wrap',
					gap: 2,
					mb: 3,
				}}
			>
				<Box>
					<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a' }}>
						Verification Review Queue
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Showing requests requiring Medical Officer clinical attention
					</Typography>
				</Box>

				<ToggleButtonGroup
					value={statusTab}
					exclusive
					onChange={handleStatusChange}
					size='small'
					sx={{ bgcolor: '#ffffff', borderRadius: 2 }}
				>
					<ToggleButton
						value='Pending_Verification'
						sx={{
							textTransform: 'none',
							fontWeight: 700,
							px: 2,
							'&.Mui-selected': { bgcolor: '#fffbeb', color: '#92400e' },
						}}
					>
						<HourglassEmptyIcon sx={{ fontSize: 18, mr: 0.75, color: '#d97706' }} />
						Pending Initial Review
					</ToggleButton>
					<ToggleButton
						value='More_Information_Required'
						sx={{
							textTransform: 'none',
							fontWeight: 700,
							px: 2,
							'&.Mui-selected': { bgcolor: '#f0f9ff', color: '#075985' },
						}}
					>
						<HelpOutlineIcon sx={{ fontSize: 18, mr: 0.75, color: '#0284c7' }} />
						Awaiting Clarification
					</ToggleButton>
				</ToggleButtonGroup>
			</Box>

			{/* Filter Toolbar */}
			<Paper
				component='form'
				onSubmit={handleFilterSubmit}
				elevation={0}
				sx={{ p: 2.5, mb: 3, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}
			>
				<Grid container spacing={2} alignItems='center'>
					<Grid item xs={12} sm={4}>
						<TextField
							fullWidth
							size='small'
							placeholder='Search by Request # or Patient Name'
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							InputProps={{
								startAdornment: (
									<InputAdornment position='start'>
										<SearchIcon sx={{ color: '#94a3b8' }} />
									</InputAdornment>
								),
							}}
							sx={{ bgcolor: '#ffffff' }}
						/>
					</Grid>
					<Grid item xs={6} sm={3}>
						<FormControl fullWidth size='small'>
							<InputLabel>Urgency Level</InputLabel>
							<Select
								value={urgencyFilter}
								label='Urgency Level'
								onChange={(e) => setUrgencyFilter(e.target.value)}
								sx={{ bgcolor: '#ffffff' }}
							>
								<MenuItem value=''>All Urgencies</MenuItem>
								<MenuItem value='Critical'>Critical (&lt; 2 hrs)</MenuItem>
								<MenuItem value='Urgent'>Urgent (2 - 6 hrs)</MenuItem>
								<MenuItem value='High_Priority'>High Priority (6 - 24 hrs)</MenuItem>
							</Select>
						</FormControl>
					</Grid>
					<Grid item xs={6} sm={3}>
						<FormControl fullWidth size='small'>
							<InputLabel>Blood Group</InputLabel>
							<Select
								value={bloodGroupFilter}
								label='Blood Group'
								onChange={(e) => setBloodGroupFilter(e.target.value)}
								sx={{ bgcolor: '#ffffff' }}
							>
								<MenuItem value=''>All Blood Groups</MenuItem>
								{BLOOD_GROUPS.map((bg) => (
									<MenuItem key={bg} value={bg}>
										{bg.replace('_', ' ')}
									</MenuItem>
								))}
							</Select>
						</FormControl>
					</Grid>
					<Grid item xs={12} sm={2}>
						<Button
							type='submit'
							fullWidth
							variant='contained'
							color='primary'
							startIcon={<FilterListIcon />}
							sx={{ height: 40, fontWeight: 700, textTransform: 'none', borderRadius: 2 }}
						>
							Filter
						</Button>
					</Grid>
				</Grid>
			</Paper>

			{/* Main Content Area */}
			{isLoading ? (
				<Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
					<CircularProgress size={40} color='primary' />
				</Box>
			) : error ? (
				<Alert severity='error' sx={{ borderRadius: 2, mb: 3 }}>
					{error}
				</Alert>
			) : items.length === 0 ? (
				<Paper
					elevation={0}
					sx={{
						p: 6,
						borderRadius: 3,
						border: '1px dashed #cbd5e1',
						bgcolor: '#f8fafc',
						textAlign: 'center',
					}}
				>
					<HourglassEmptyIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1.5 }} />
					<Typography variant='h6' sx={{ fontWeight: 700, color: '#334155', mb: 0.5 }}>
						No Requests in Queue
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						There are currently no emergency blood requests matching your filters in this status queue.
					</Typography>
				</Paper>
			) : (
				<>
					<TableContainer
						component={Paper}
						elevation={0}
						sx={{ borderRadius: 3, border: '1px solid #e2e8f0', mb: 3 }}
					>
						<Table>
							<TableHead sx={{ bgcolor: '#f1f5f9' }}>
								<TableRow>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Reference ID</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Patient Demographics</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Blood & Units</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Hospital Facility</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Urgency Level</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Created Date</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Status</TableCell>
									<TableCell align='right' sx={{ fontWeight: 800, color: '#475569' }}>
										Action
									</TableCell>
								</TableRow>
							</TableHead>
							<TableBody>
								{items.map((req) => {
									const urgency = URGENCY_CONFIG[req.urgencyLevel] || {
										label: req.urgencyLevel,
										bg: '#f1f5f9',
										text: '#334155',
									}

									return (
										<TableRow key={req._id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
											<TableCell>
												<Typography
													variant='body2'
													sx={{ fontWeight: 800, color: '#0f172a', fontFamily: 'monospace' }}
												>
													{req.requestNumber || req._id}
												</Typography>
											</TableCell>
											<TableCell>
												<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
													{req.patientName}
												</Typography>
												<Typography variant='caption' sx={{ color: '#64748b' }}>
													{req.patientAge} yrs • {req.patientGender}
												</Typography>
											</TableCell>
											<TableCell>
												<Chip
													label={req.requiredBloodGroup?.replace('_', ' ')}
													size='small'
													color='error'
													sx={{ fontWeight: 800, mr: 1 }}
												/>
												<Typography variant='caption' sx={{ fontWeight: 700, color: '#1e293b' }}>
													{req.unitsRequested} Unit(s)
												</Typography>
												<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
													{req.requiredComponent?.replace(/_/g, ' ')}
												</Typography>
											</TableCell>
											<TableCell>
												<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
													{req.hospitalId?.hospitalName || req.hospitalName || '—'}
												</Typography>
												<Typography variant='caption' sx={{ color: '#64748b' }}>
													{req.hospitalId?.address?.city || req.hospitalCity || ''}
												</Typography>
											</TableCell>
											<TableCell>
												<Chip
													label={urgency.label}
													size='small'
													sx={{
														fontWeight: 800,
														fontSize: '0.7rem',
														bgcolor: urgency.bg,
														color: urgency.text,
													}}
												/>
											</TableCell>
											<TableCell>
												<Typography variant='body2' sx={{ color: '#475569' }}>
													{new Date(req.createdAt).toLocaleDateString('en-IN', {
														day: 'numeric',
														month: 'short',
														hour: '2-digit',
														minute: '2-digit',
													})}
												</Typography>
											</TableCell>
											<TableCell>
												<Chip
													label={
														req.verificationStatus === 'Pending_Verification'
															? 'PENDING'
															: 'MORE INFO'
													}
													size='small'
													sx={{
														fontWeight: 800,
														fontSize: '0.7rem',
														bgcolor:
															req.verificationStatus === 'Pending_Verification'
																? '#fef3c7'
																: '#e0f2fe',
														color:
															req.verificationStatus === 'Pending_Verification'
																? '#92400e'
																: '#0369a1',
													}}
												/>
											</TableCell>
											<TableCell align='right'>
												<Button
													variant='contained'
													size='small'
													color='primary'
													endIcon={<ArrowForwardIcon fontSize='small' />}
													onClick={() => navigate(`/medical-officer/requests/${req._id}`)}
													sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}
												>
													Review
												</Button>
											</TableCell>
										</TableRow>
									)
								})}
							</TableBody>
						</Table>
					</TableContainer>

					{/* Pagination */}
					{pagination.totalPages > 1 && (
						<Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
							<Pagination
								count={pagination.totalPages}
								page={page}
								onChange={handlePageChange}
								color='primary'
								shape='rounded'
							/>
						</Box>
					)}
				</>
			)}
		</Box>
	)
}

export default PendingRequestsPage
