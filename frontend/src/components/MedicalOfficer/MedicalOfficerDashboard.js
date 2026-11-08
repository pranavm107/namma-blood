/**
 * Medical Officer Dashboard Overview
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Displays metrics for pending, more information required, verified, and rejected
 * emergency requests, along with facility-level breakdown for multi-hospital officers.
 */

import React, { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Grid,
	Paper,
	Typography,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	CircularProgress,
	Alert,
} from '@mui/material'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import CancelIcon from '@mui/icons-material/Cancel'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import { fetchMedicalOfficerDashboard, setRequestFilters } from '../../store/medicalOfficerSlice'

const MedicalOfficerDashboard = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { dashboard } = useSelector((state) => state?.medicalOfficer || {})
	const { metrics, hospitalBreakdown, isLoading, error, selectedHospitalId } = dashboard

	useEffect(() => {
		dispatch(fetchMedicalOfficerDashboard(selectedHospitalId))
	}, [dispatch, selectedHospitalId])

	const navigateToQueue = (status) => {
		dispatch(setRequestFilters({ status, page: 1 }))
		if (status === 'Verified') {
			navigate('/medical-officer/verified')
		} else if (status === 'Rejected') {
			navigate('/medical-officer/rejected')
		} else {
			navigate('/medical-officer/pending')
		}
	}

	if (isLoading) {
		return (
			<Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
				<CircularProgress size={44} color='primary' />
			</Box>
		)
	}

	if (error) {
		return (
			<Alert severity='error' sx={{ borderRadius: 2 }}>
				{error}
			</Alert>
		)
	}

	return (
		<Box>
			{/* Metric KPI Cards */}
			<Grid container spacing={3} sx={{ mb: 4 }}>
				{/* 1. Pending Verification */}
				<Grid item xs={12} sm={6} md={3}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #fde68a',
							bgcolor: '#fffbeb',
							cursor: 'pointer',
							transition: 'transform 0.15s ease-in-out',
							'&:hover': { transform: 'translateY(-2px)' },
						}}
						onClick={() => navigateToQueue('Pending_Verification')}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
								<Typography variant='caption' sx={{ color: '#b45309', fontWeight: 800 }}>
									PENDING REVIEW
								</Typography>
								<HourglassEmptyIcon sx={{ color: '#d97706', fontSize: 28 }} />
							</Box>
							<Typography variant='h3' sx={{ fontWeight: 900, color: '#92400e' }}>
								{metrics?.pendingCount || 0}
							</Typography>
							<Typography variant='body2' sx={{ color: '#78350f', mt: 1 }}>
								Awaiting Medical Officer clinical verification
							</Typography>
						</CardContent>
					</Card>
				</Grid>

				{/* 2. More Information Requested */}
				<Grid item xs={12} sm={6} md={3}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #bae6fd',
							bgcolor: '#f0f9ff',
							cursor: 'pointer',
							transition: 'transform 0.15s ease-in-out',
							'&:hover': { transform: 'translateY(-2px)' },
						}}
						onClick={() => navigateToQueue('More_Information_Required')}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
								<Typography variant='caption' sx={{ color: '#0369a1', fontWeight: 800 }}>
									INFO REQUESTED
								</Typography>
								<HelpOutlineIcon sx={{ color: '#0284c7', fontSize: 28 }} />
							</Box>
							<Typography variant='h3' sx={{ fontWeight: 900, color: '#075985' }}>
								{metrics?.moreInfoCount || 0}
							</Typography>
							<Typography variant='body2' sx={{ color: '#0c4a6e', mt: 1 }}>
								Awaiting requester clinical clarification
							</Typography>
						</CardContent>
					</Card>
				</Grid>

				{/* 3. Verified Requests */}
				<Grid item xs={12} sm={6} md={3}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #bbf7d0',
							bgcolor: '#f0fdf4',
							cursor: 'pointer',
							transition: 'transform 0.15s ease-in-out',
							'&:hover': { transform: 'translateY(-2px)' },
						}}
						onClick={() => navigateToQueue('Verified')}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
								<Typography variant='caption' sx={{ color: '#15803d', fontWeight: 800 }}>
									VERIFIED
								</Typography>
								<CheckCircleIcon sx={{ color: '#16a34a', fontSize: 28 }} />
							</Box>
							<Typography variant='h3' sx={{ fontWeight: 900, color: '#166534' }}>
								{metrics?.verifiedCount || 0}
							</Typography>
							<Typography variant='body2' sx={{ color: '#14532d', mt: 1 }}>
								Clinically verified and unlocked for matching
							</Typography>
						</CardContent>
					</Card>
				</Grid>

				{/* 4. Rejected Requests */}
				<Grid item xs={12} sm={6} md={3}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #fecaca',
							bgcolor: '#fef2f2',
							cursor: 'pointer',
							transition: 'transform 0.15s ease-in-out',
							'&:hover': { transform: 'translateY(-2px)' },
						}}
						onClick={() => navigateToQueue('Rejected')}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
								<Typography variant='caption' sx={{ color: '#b91c1c', fontWeight: 800 }}>
									REJECTED
								</Typography>
								<CancelIcon sx={{ color: '#dc2626', fontSize: 28 }} />
							</Box>
							<Typography variant='h3' sx={{ fontWeight: 900, color: '#991b1b' }}>
								{metrics?.rejectedCount || 0}
							</Typography>
							<Typography variant='body2' sx={{ color: '#7f1d1d', mt: 1 }}>
								Rejected due to clinical protocol or invalidity
							</Typography>
						</CardContent>
					</Card>
				</Grid>
			</Grid>

			{/* Facility Breakdown (for Multi-Hospital Associations) */}
			{hospitalBreakdown && hospitalBreakdown.length > 0 && (
				<Paper elevation={0} sx={{ p: 3, mb: 4, borderRadius: 3, border: '1px solid #e2e8f0' }}>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
						<LocalHospitalIcon sx={{ color: '#059669' }} />
						<Typography variant='h6' sx={{ fontWeight: 800, color: '#0f172a' }}>
							Hospital-Wise Request Breakdown
						</Typography>
					</Box>
					<TableContainer>
						<Table size='small'>
							<TableHead sx={{ bgcolor: '#f8fafc' }}>
								<TableRow>
									<TableCell sx={{ fontWeight: 700, color: '#475569' }}>Hospital Facility</TableCell>
									<TableCell sx={{ fontWeight: 700, color: '#475569' }}>City</TableCell>
									<TableCell align='center' sx={{ fontWeight: 700, color: '#b45309' }}>
										Pending
									</TableCell>
									<TableCell align='center' sx={{ fontWeight: 700, color: '#0284c7' }}>
										Info Requested
									</TableCell>
									<TableCell align='center' sx={{ fontWeight: 700, color: '#16a34a' }}>
										Verified
									</TableCell>
									<TableCell align='center' sx={{ fontWeight: 700, color: '#dc2626' }}>
										Rejected
									</TableCell>
									<TableCell align='right' sx={{ fontWeight: 700, color: '#475569' }}>
										Action
									</TableCell>
								</TableRow>
							</TableHead>
							<TableBody>
								{hospitalBreakdown.map((row) => (
									<TableRow key={row.hospitalId} hover>
										<TableCell>
											<Typography variant='body2' sx={{ fontWeight: 700, color: '#1e293b' }}>
												{row.hospitalName}
											</Typography>
											<Typography variant='caption' sx={{ color: '#64748b', fontFamily: 'monospace' }}>
												{row.hospitalCode}
											</Typography>
										</TableCell>
										<TableCell>{row.city || '—'}</TableCell>
										<TableCell align='center'>
											<Chip
												label={row.counts?.pending || 0}
												size='small'
												sx={{ bgcolor: '#fef3c7', color: '#b45309', fontWeight: 800 }}
											/>
										</TableCell>
										<TableCell align='center'>
											<Chip
												label={row.counts?.moreInfo || 0}
												size='small'
												sx={{ bgcolor: '#e0f2fe', color: '#0369a1', fontWeight: 800 }}
											/>
										</TableCell>
										<TableCell align='center'>
											<Chip
												label={row.counts?.verified || 0}
												size='small'
												sx={{ bgcolor: '#dcfce7', color: '#15803d', fontWeight: 800 }}
											/>
										</TableCell>
										<TableCell align='center'>
											<Chip
												label={row.counts?.rejected || 0}
												size='small'
												sx={{ bgcolor: '#fee2e2', color: '#b91c1c', fontWeight: 800 }}
											/>
										</TableCell>
										<TableCell align='right'>
											<Button
												size='small'
												variant='text'
												endIcon={<ArrowForwardIcon fontSize='small' />}
												onClick={() => {
													dispatch(setRequestFilters({ hospitalId: row.hospitalId, page: 1 }))
													navigate('/medical-officer/pending')
												}}
												sx={{ textTransform: 'none', fontWeight: 700 }}
											>
												View Queue
											</Button>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</TableContainer>
				</Paper>
			)}

			{/* Quick Action Navigation Buttons */}
			<Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
				<Typography variant='subtitle1' sx={{ fontWeight: 800, color: '#0f172a', mb: 2 }}>
					Quick Clinical Actions
				</Typography>
				<Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
					<Button
						variant='contained'
						color='warning'
						startIcon={<HourglassEmptyIcon />}
						onClick={() => navigateToQueue('Pending_Verification')}
						sx={{ fontWeight: 700, textTransform: 'none', borderRadius: 2 }}
					>
						Review Pending Requests ({metrics?.pendingCount || 0})
					</Button>
					<Button
						variant='outlined'
						color='primary'
						startIcon={<HelpOutlineIcon />}
						onClick={() => navigateToQueue('More_Information_Required')}
						sx={{ fontWeight: 700, textTransform: 'none', borderRadius: 2 }}
					>
						Follow-Up Information Queue ({metrics?.moreInfoCount || 0})
					</Button>
					<Button
						variant='outlined'
						color='success'
						startIcon={<CheckCircleIcon />}
						onClick={() => navigateToQueue('Verified')}
						sx={{ fontWeight: 700, textTransform: 'none', borderRadius: 2 }}
					>
						Audit Verified Requests ({metrics?.verifiedCount || 0})
					</Button>
					<Button
						variant='outlined'
						color='error'
						startIcon={<CancelIcon />}
						onClick={() => navigateToQueue('Rejected')}
						sx={{ fontWeight: 700, textTransform: 'none', borderRadius: 2 }}
					>
						Inspect Rejected Requests ({metrics?.rejectedCount || 0})
					</Button>
				</Box>
			</Paper>
		</Box>
	)
}

export default MedicalOfficerDashboard
