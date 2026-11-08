/**
 * Hospital Directory — Admin Hospital Registry Management
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import React, { useEffect, useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
	Box,
	Button,
	Card,
	Chip,
	Container,
	Grid,
	IconButton,
	InputAdornment,
	MenuItem,
	Pagination,
	Paper,
	Select,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	TextField,
	Typography,
	Alert,
	CircularProgress,
	Tooltip,
} from '@mui/material'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import AddCircleOutlineIcon from '@mui/icons-material/AddCircleOutline'
import SearchIcon from '@mui/icons-material/Search'
import ClearIcon from '@mui/icons-material/Clear'
import VisibilityIcon from '@mui/icons-material/Visibility'
import PersonAddAlt1Icon from '@mui/icons-material/PersonAddAlt1'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import HighlightOffIcon from '@mui/icons-material/HighlightOff'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import RefreshIcon from '@mui/icons-material/Refresh'
import {
	fetchAdminHospitals,
	setHospitalFilters,
	setHospitalPage,
	clearHospitalFilters,
} from '../../store/adminHospitalSlice'

const HospitalDirectory = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { items, pagination, filters, isLoading, error } = useSelector(
		(state) => state.adminHospital?.hospitals || {}
	)

	const [searchTerm, setSearchTerm] = useState(filters?.search || '')
	const [cityTerm, setCityTerm] = useState(filters?.city || '')

	useEffect(() => {
		dispatch(
			fetchAdminHospitals({
				page: pagination?.page || 1,
				limit: pagination?.limit || 15,
				verificationStatus: filters?.verificationStatus || '',
				isActive: filters?.isActive !== undefined ? filters?.isActive : '',
				city: filters?.city || '',
				search: filters?.search || '',
			})
		)
	}, [dispatch, pagination?.page, pagination?.limit, filters])

	const handleSearchSubmit = (e) => {
		if (e) e.preventDefault()
		dispatch(
			setHospitalFilters({
				search: searchTerm.trim(),
				city: cityTerm.trim(),
			})
		)
	}

	const handleClearFilters = () => {
		setSearchTerm('')
		setCityTerm('')
		dispatch(clearHospitalFilters())
	}

	const handlePageChange = (event, value) => {
		dispatch(setHospitalPage(value))
	}

	const getStatusChip = (status) => {
		switch (status) {
			case 'Verified':
				return (
					<Chip
						size='small'
						icon={<CheckCircleOutlineIcon />}
						label='Verified'
						color='success'
						sx={{ fontWeight: 600 }}
					/>
				)
			case 'Rejected':
				return (
					<Chip
						size='small'
						icon={<HighlightOffIcon />}
						label='Rejected'
						color='error'
						sx={{ fontWeight: 600 }}
					/>
				)
			case 'Pending':
			default:
				return (
					<Chip
						size='small'
						icon={<HourglassEmptyIcon />}
						label='Pending'
						color='warning'
						sx={{ fontWeight: 600 }}
					/>
				)
		}
	}

	return (
		<Container maxWidth='xl' sx={{ pb: 8, pt: 2 }}>
			{/* Header */}
			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
					border: '1px solid #bbf7d0',
					display: 'flex',
					flexDirection: { xs: 'column', md: 'row' },
					alignItems: { xs: 'flex-start', md: 'center' },
					justifyContent: 'space-between',
					gap: 2,
				}}
			>
				<Box>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 0.5 }}>
						<LocalHospitalIcon sx={{ color: '#16a34a', fontSize: 32 }} />
						<Typography variant='h5' sx={{ fontWeight: 800, color: '#1e293b' }}>
							Hospital Registry Directory
						</Typography>
					</Box>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Manage accredited hospital facilities, oversee credential verification, and link accredited Medical Officers.
					</Typography>
				</Box>
				<Button
					variant='contained'
					startIcon={<AddCircleOutlineIcon />}
					onClick={() => navigate('/admin/hospitals/register')}
					sx={{
						backgroundColor: '#16a34a',
						fontWeight: 700,
						textTransform: 'none',
						px: 3,
						py: 1,
						borderRadius: 2,
						boxShadow: '0 4px 12px rgba(22, 163, 74, 0.25)',
						'&:hover': { backgroundColor: '#15803d' },
					}}
				>
					Register New Hospital
				</Button>
			</Paper>

			{/* Search & Filters Card */}
			<Card
				elevation={0}
				sx={{
					p: 2.5,
					mb: 3,
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					backgroundColor: '#ffffff',
				}}
			>
				<form onSubmit={handleSearchSubmit}>
					<Grid container spacing={2} alignItems='center'>
						<Grid item xs={12} sm={4} md={3}>
							<TextField
								fullWidth
								size='small'
								placeholder='Search Name or Code...'
								value={searchTerm}
								onChange={(e) => setSearchTerm(e.target.value)}
								InputProps={{
									startAdornment: (
										<InputAdornment position='start'>
											<SearchIcon fontSize='small' sx={{ color: '#94a3b8' }} />
										</InputAdornment>
									),
								}}
							/>
						</Grid>

						<Grid item xs={12} sm={4} md={2}>
							<TextField
								fullWidth
								size='small'
								placeholder='Filter City...'
								value={cityTerm}
								onChange={(e) => setCityTerm(e.target.value)}
							/>
						</Grid>

						<Grid item xs={6} sm={4} md={2}>
							<Select
								fullWidth
								size='small'
								displayEmpty
								value={filters?.verificationStatus || ''}
								onChange={(e) => dispatch(setHospitalFilters({ verificationStatus: e.target.value }))}
								sx={{ bgcolor: '#ffffff' }}
							>
								<MenuItem value=''>
									<em>All Verification Statuses</em>
								</MenuItem>
								<MenuItem value='Pending'>Pending</MenuItem>
								<MenuItem value='Verified'>Verified</MenuItem>
								<MenuItem value='Rejected'>Rejected</MenuItem>
							</Select>
						</Grid>

						<Grid item xs={6} sm={4} md={2}>
							<Select
								fullWidth
								size='small'
								displayEmpty
								value={filters?.isActive !== undefined ? String(filters.isActive) : ''}
								onChange={(e) => dispatch(setHospitalFilters({ isActive: e.target.value }))}
								sx={{ bgcolor: '#ffffff' }}
							>
								<MenuItem value=''>
									<em>All Active States</em>
								</MenuItem>
								<MenuItem value='true'>Active Facilities</MenuItem>
								<MenuItem value='false'>Inactive Facilities</MenuItem>
							</Select>
						</Grid>

						<Grid item xs={12} sm={4} md={3} sx={{ display: 'flex', gap: 1 }}>
							<Button
								type='submit'
								variant='contained'
								sx={{
									flex: 1,
									backgroundColor: '#1e293b',
									textTransform: 'none',
									fontWeight: 700,
									'&:hover': { backgroundColor: '#0f172a' },
								}}
							>
								Apply Filters
							</Button>
							<Tooltip title='Clear All Filters'>
								<IconButton
									onClick={handleClearFilters}
									sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}
								>
									<ClearIcon fontSize='small' />
								</IconButton>
							</Tooltip>
							<Tooltip title='Refresh'>
								<IconButton
									onClick={() =>
										dispatch(
											fetchAdminHospitals({
												page: pagination?.page || 1,
												limit: pagination?.limit || 15,
												...filters,
											})
										)
									}
									sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}
								>
									<RefreshIcon fontSize='small' />
								</IconButton>
							</Tooltip>
						</Grid>
					</Grid>
				</form>
			</Card>

			{/* Error State */}
			{error && (
				<Alert
					severity='error'
					sx={{ mb: 3, borderRadius: 2 }}
					action={
						<Button color='inherit' size='small' onClick={() => dispatch(fetchAdminHospitals(filters))}>
							Retry
						</Button>
					}
				>
					{error}
				</Alert>
			)}

			{/* Table Card */}
			<Card
				elevation={0}
				sx={{
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					backgroundColor: '#ffffff',
					overflow: 'hidden',
				}}
			>
				{isLoading ? (
					<Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', py: 8 }}>
						<CircularProgress size={36} sx={{ color: '#16a34a' }} />
					</Box>
				) : items?.length === 0 ? (
					<Box sx={{ textAlign: 'center', py: 8, px: 2 }}>
						<LocalHospitalIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
						<Typography variant='h6' sx={{ color: '#1e293b', fontWeight: 700 }}>
							No Hospitals Found
						</Typography>
						<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
							No registered facilities match the selected criteria.
						</Typography>
						<Button
							variant='outlined'
							startIcon={<AddCircleOutlineIcon />}
							onClick={() => navigate('/admin/hospitals/register')}
							sx={{ textTransform: 'none', fontWeight: 600 }}
						>
							Register a Hospital
						</Button>
					</Box>
				) : (
					<>
						<TableContainer>
							<Table sx={{ minWidth: 800 }}>
								<TableHead sx={{ backgroundColor: '#f8fafc' }}>
									<TableRow>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Hospital Code</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Hospital Name</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Type</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>City, State</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>PIN Code</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Verification</TableCell>
										<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Active</TableCell>
										<TableCell align='right' sx={{ fontWeight: 700, color: '#475569' }}>
											Actions
										</TableCell>
									</TableRow>
								</TableHead>
								<TableBody>
									{items.map((hospital) => (
										<TableRow key={hospital._id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
											<TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#1e293b' }}>
												{hospital.hospitalCode}
											</TableCell>
											<TableCell sx={{ fontWeight: 600, color: '#0f172a' }}>
												{hospital.hospitalName}
											</TableCell>
											<TableCell>
												<Chip
													label={hospital.hospitalType || 'Private'}
													size='small'
													sx={{
														backgroundColor: '#f1f5f9',
														color: '#334155',
														fontWeight: 600,
														fontSize: '0.75rem',
													}}
												/>
											</TableCell>
											<TableCell sx={{ color: '#334155' }}>
												{hospital.address?.city}, {hospital.address?.state}
											</TableCell>
											<TableCell sx={{ fontFamily: 'monospace', color: '#64748b' }}>
												{hospital.address?.pinCode}
											</TableCell>
											<TableCell>{getStatusChip(hospital.verificationStatus)}</TableCell>
											<TableCell>
												{hospital.isActive ? (
													<Chip
														size='small'
														label='Active'
														sx={{
															backgroundColor: '#dcfce7',
															color: '#15803d',
															fontWeight: 600,
														}}
													/>
												) : (
													<Chip
														size='small'
														label='Inactive'
														sx={{
															backgroundColor: '#f1f5f9',
															color: '#64748b',
															fontWeight: 600,
														}}
													/>
												)}
											</TableCell>
											<TableCell align='right'>
												<Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
													<Tooltip title='View Facility Details & Verify'>
														<Button
															variant='outlined'
															size='small'
															startIcon={<VisibilityIcon fontSize='small' />}
															onClick={() => navigate(`/admin/hospitals/${hospital._id}`)}
															sx={{
																textTransform: 'none',
																fontWeight: 600,
																borderColor: '#cbd5e1',
																color: '#1e293b',
															}}
														>
															Details
														</Button>
													</Tooltip>
													<Tooltip title='Assign Medical Officer'>
														<IconButton
															size='small'
															onClick={() => navigate(`/admin/medical-officers?hospitalId=${hospital._id}`)}
															sx={{
																color: '#16a34a',
																border: '1px solid #bbf7d0',
																borderRadius: 1.5,
															}}
														>
															<PersonAddAlt1Icon fontSize='small' />
														</IconButton>
													</Tooltip>
												</Box>
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</TableContainer>

						{/* Pagination Footer */}
						{pagination && pagination.totalPages > 1 && (
							<Box sx={{ p: 2, display: 'flex', justifyContent: 'center' }}>
								<Pagination
									count={pagination.totalPages}
									page={pagination.page}
									onChange={handlePageChange}
									color='primary'
									shape='rounded'
								/>
							</Box>
						)}
					</>
				)}
			</Card>
		</Container>
	)
}

export default HospitalDirectory
