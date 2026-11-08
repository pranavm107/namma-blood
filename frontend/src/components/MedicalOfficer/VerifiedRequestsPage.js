/**
 * Medical Officer Verified Requests Page
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Displays emergency blood requests that have been clinically verified by authorized
 * Medical Officers, displaying verification timestamps and audit history.
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Chip,
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
	CircularProgress,
	Alert,
	InputAdornment,
} from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { fetchAssignedRequests } from '../../store/medicalOfficerSlice'

const VerifiedRequestsPage = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { requests, dashboard } = useSelector((state) => state?.medicalOfficer || {})
	const { items, pagination, isLoading, error } = requests
	const { selectedHospitalId } = dashboard

	const [searchQuery, setSearchQuery] = useState('')
	const [page, setPage] = useState(1)

	const loadRequests = useCallback(
		(currentPage = page) => {
			dispatch(
				fetchAssignedRequests({
					page: currentPage,
					limit: 15,
					status: 'Verified',
					search: searchQuery,
					hospitalId: selectedHospitalId || '',
				})
			)
		},
		[dispatch, page, searchQuery, selectedHospitalId]
	)

	useEffect(() => {
		loadRequests(page)
	}, [loadRequests, page])

	const handleSearchSubmit = (e) => {
		e.preventDefault()
		setPage(1)
		loadRequests(1)
	}

	return (
		<Box>
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
						Verified Emergency Requests
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Emergency tickets successfully verified for candidate matching and blood connection
					</Typography>
				</Box>

				<Box component='form' onSubmit={handleSearchSubmit} sx={{ display: 'flex', gap: 1 }}>
					<TextField
						size='small'
						placeholder='Search verified tickets...'
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						InputProps={{
							startAdornment: (
								<InputAdornment position='start'>
									<SearchIcon sx={{ color: '#94a3b8' }} />
								</InputAdornment>
							),
						}}
						sx={{ width: 280, bgcolor: '#ffffff' }}
					/>
					<Button type='submit' variant='contained' color='primary' sx={{ fontWeight: 700 }}>
						Search
					</Button>
				</Box>
			</Box>

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
					<CheckCircleIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1.5 }} />
					<Typography variant='h6' sx={{ fontWeight: 700, color: '#334155', mb: 0.5 }}>
						No Verified Requests Found
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						There are currently no emergency blood requests in Verified status for the selected scope.
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
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Patient</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Blood & Units</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Hospital Facility</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Verified Timestamp</TableCell>
									<TableCell sx={{ fontWeight: 800, color: '#475569' }}>Status</TableCell>
									<TableCell align='right' sx={{ fontWeight: 800, color: '#475569' }}>
										Action
									</TableCell>
								</TableRow>
							</TableHead>
							<TableBody>
								{items.map((req) => (
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
										</TableCell>
										<TableCell>
											<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b' }}>
												{req.hospitalId?.hospitalName || req.hospitalName}
											</Typography>
											<Typography variant='caption' sx={{ color: '#64748b' }}>
												{req.hospitalId?.address?.city || req.hospitalCity}
											</Typography>
										</TableCell>
										<TableCell>
											<Typography variant='body2' sx={{ color: '#166534', fontWeight: 600 }}>
												{req.verifiedAt
													? new Date(req.verifiedAt).toLocaleString('en-IN', {
															dateStyle: 'medium',
															timeStyle: 'short',
													  })
													: new Date(req.updatedAt).toLocaleString('en-IN', {
															dateStyle: 'medium',
															timeStyle: 'short',
													  })}
											</Typography>
										</TableCell>
										<TableCell>
											<Chip
												icon={<CheckCircleIcon fontSize='small' />}
												label='VERIFIED'
												size='small'
												color='success'
												sx={{ fontWeight: 800, fontSize: '0.72rem' }}
											/>
										</TableCell>
										<TableCell align='right'>
											<Button
												variant='outlined'
												size='small'
												color='primary'
												endIcon={<ArrowForwardIcon fontSize='small' />}
												onClick={() => navigate(`/medical-officer/requests/${req._id}`)}
												sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}
											>
												Details
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>

					{pagination.totalPages > 1 && (
						<Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
							<Pagination
								count={pagination.totalPages}
								page={page}
								onChange={(_, newPage) => setPage(newPage)}
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

export default VerifiedRequestsPage
