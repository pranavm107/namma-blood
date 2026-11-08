import React, { useEffect } from 'react'
import {
	Box,
	Button,
	Card,
	CardActions,
	CardContent,
	Chip,
	Container,
	Divider,
	Grid,
	Paper,
	Stack,
	Typography,
} from '@mui/material'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import VolunteerActivismIcon from '@mui/icons-material/VolunteerActivism'
import BloodtypeIcon from '@mui/icons-material/Bloodtype'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ExploreIcon from '@mui/icons-material/Explore'
import HubIcon from '@mui/icons-material/Hub'
import ShieldIcon from '@mui/icons-material/Shield'
import { getUserDonateStates } from '../../store/donateStatesSlice'
import { getUserRequestsStates } from '../../store/receiveStatesSlice'

const UserHome = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()
	const donatestates = useSelector((state) => state?.donatestates)
	const receivestates = useSelector((state) => state?.receivestates)

	useEffect(() => {
		dispatch(getUserDonateStates())
		dispatch(getUserRequestsStates())
	}, [dispatch])

	const renderStatBox = (title, count, color, bg) => (
		<Box
			sx={{
				p: 2,
				borderRadius: 2,
				backgroundColor: bg,
				display: 'flex',
				flexDirection: 'column',
				alignItems: 'center',
				justifyContent: 'center',
			}}
		>
			<Typography variant='caption' sx={{ color: '#475569', fontWeight: 600, textAlign: 'center' }}>
				{title}
			</Typography>
			<Typography variant='h5' sx={{ color: color, fontWeight: 800, mt: 0.5 }}>
				{count || 0}
			</Typography>
		</Box>
	)

	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			<Paper
				elevation={0}
				sx={{
					p: { xs: 2.5, md: 3.5 },
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff8f8 100%)',
					border: '1px solid #ffebee',
				}}
			>
				<Chip
					label='DONOR & RECIPIENT PORTAL'
					sx={{
						backgroundColor: '#ffebee',
						color: '#c62828',
						fontWeight: 700,
						fontSize: '0.75rem',
						letterSpacing: '0.08em',
						mb: 1.5,
					}}
				/>
				<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
					My Activity Dashboard
				</Typography>
				<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
					Track your active donation appointments and emergency blood requests in one place.
				</Typography>

				<Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} sx={{ mt: 1 }}>
					<Button
						variant='contained'
						startIcon={<VolunteerActivismIcon />}
						onClick={() => navigate('/user/wanttodonate')}
						sx={{
							backgroundColor: '#c62828',
							color: '#ffffff',
							fontWeight: 700,
							textTransform: 'none',
							px: 2.5,
							borderRadius: 2,
							boxShadow: '0 4px 12px rgba(198, 40, 40, 0.3)',
							'&:hover': { backgroundColor: '#b71c1c' },
						}}
					>
						Schedule a Blood Donation
					</Button>
					<Button
						variant='outlined'
						startIcon={<BloodtypeIcon />}
						onClick={() => navigate('/user/lookingfor')}
						sx={{
							borderColor: '#c62828',
							color: '#c62828',
							fontWeight: 700,
							textTransform: 'none',
							px: 2.5,
							borderRadius: 2,
							'&:hover': {
								borderColor: '#b71c1c',
								backgroundColor: '#ffebee',
							},
						}}
					>
						Find Blood Stock
					</Button>
				</Stack>
			</Paper>

			{/* Emergency Blood Response & Matching Section */}
			<Paper
				elevation={0}
				sx={{
					p: { xs: 2.5, md: 3 },
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #fff5f5 0%, #ffffff 100%)',
					border: '1.5px solid #ef5350',
					boxShadow: '0 4px 20px rgba(211, 47, 47, 0.08)',
				}}
			>
				<Stack direction={{ xs: 'column', md: 'row' }} justifyContent='space-between' alignItems={{ xs: 'flex-start', md: 'center' }} spacing={2}>
					<Box>
						<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
							<Chip
								icon={<WarningAmberIcon sx={{ color: '#d32f2f !important' }} />}
								label='CRITICAL EMERGENCY RESPONSE'
								size='small'
								sx={{
									backgroundColor: '#ffebee',
									color: '#c62828',
									fontWeight: 800,
									fontSize: '0.72rem',
									letterSpacing: '0.05em',
									border: '1px solid #ffcdd2',
								}}
							/>
							<Chip
								icon={<ShieldIcon sx={{ color: '#2e7d32 !important' }} />}
								label='Tier 3 Discovery Active'
								size='small'
								sx={{
									backgroundColor: '#e8f5e9',
									color: '#2e7d32',
									fontWeight: 700,
									fontSize: '0.72rem',
								}}
							/>
						</Box>
						<Typography variant='h5' sx={{ fontWeight: 800, color: '#991b1b', mb: 0.5 }}>
							Emergency Blood Connection & Matching
						</Typography>
						<Typography variant='body2' sx={{ color: '#475569', maxWidth: 720 }}>
							Initiate urgent emergency blood tickets, run real-time dual-stream donor discovery, and query verified blood bank facility stocks. Matching results require clinical confirmation prior to dispatch.
						</Typography>
					</Box>
					<Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ width: { xs: '100%', md: 'auto' }, flexShrink: 0 }}>
						<Button
							variant='contained'
							startIcon={<WarningAmberIcon />}
							onClick={() => navigate('/user/emergency-request')}
							sx={{
								backgroundColor: '#d32f2f',
								color: '#ffffff',
								fontWeight: 700,
								textTransform: 'none',
								px: 2.5,
								py: 1,
								borderRadius: 2,
								boxShadow: '0 4px 14px rgba(211, 47, 47, 0.35)',
								'&:hover': { backgroundColor: '#b71c1c' },
							}}
						>
							Emergency Request
						</Button>
						<Button
							variant='outlined'
							startIcon={<ExploreIcon />}
							onClick={() => navigate('/user/emergency-discovery')}
							sx={{
								borderColor: '#d32f2f',
								color: '#d32f2f',
								fontWeight: 700,
								textTransform: 'none',
								px: 2.5,
								py: 1,
								borderRadius: 2,
								'&:hover': {
									borderColor: '#b71c1c',
									backgroundColor: '#ffebee',
								},
							}}
						>
							Emergency Discovery
						</Button>
						<Button
							variant='text'
							startIcon={<HubIcon />}
							onClick={() => navigate('/user/emergency-matches')}
							sx={{
								color: '#7f1d1d',
								fontWeight: 700,
								textTransform: 'none',
								px: 2,
								py: 1,
								borderRadius: 2,
								'&:hover': { backgroundColor: 'rgba(211, 47, 47, 0.08)' },
							}}
						>
							Ticket Matches
						</Button>
					</Stack>
				</Stack>
			</Paper>

			<Grid container spacing={3}>
				{/* My Donations */}
				<Grid item xs={12} md={6}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							backgroundColor: '#ffffff',
							boxShadow: '0 4px 16px rgba(0,0,0,0.02)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
								<Box
									sx={{
										width: 44,
										height: 44,
										borderRadius: 2,
										backgroundColor: '#ffebee',
										color: '#c62828',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<VolunteerActivismIcon />
								</Box>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
										My Donation Requests
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Status of appointments sent to blood banks
									</Typography>
								</Box>
							</Box>

							<Grid container spacing={2}>
								<Grid item xs={6}>
									{renderStatBox('Pending', donatestates?.Pending, '#d97706', '#fef3c7')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Accepted', donatestates?.Accepted, '#0284c7', '#e0f2fe')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Fulfilled', donatestates?.Fulfilled, '#16a34a', '#ecfdf5')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Rejected', donatestates?.Rejected, '#dc2626', '#ffe4e6')}
								</Grid>
							</Grid>
						</CardContent>

						<Divider />
						<CardActions sx={{ p: 2 }}>
							<Button
								fullWidth
								variant='text'
								endIcon={<ArrowForwardIcon />}
								onClick={() => navigate('/user/donaterequestsstates')}
								sx={{
									color: '#c62828',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#fff5f5' },
								}}
							>
								View Donation Status
							</Button>
						</CardActions>
					</Card>
				</Grid>

				{/* My Blood Requests */}
				<Grid item xs={12} md={6}>
					<Card
						elevation={0}
						sx={{
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							backgroundColor: '#ffffff',
							boxShadow: '0 4px 16px rgba(0,0,0,0.02)',
							height: '100%',
							display: 'flex',
							flexDirection: 'column',
							justifyContent: 'space-between',
						}}
					>
						<CardContent sx={{ p: 3 }}>
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 3 }}>
								<Box
									sx={{
										width: 44,
										height: 44,
										borderRadius: 2,
										backgroundColor: '#e0f2fe',
										color: '#0284c7',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<BloodtypeIcon />
								</Box>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
										My Blood Requests
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Status of blood units requested for patients
									</Typography>
								</Box>
							</Box>

							<Grid container spacing={2}>
								<Grid item xs={6}>
									{renderStatBox('Pending', receivestates?.Pending, '#d97706', '#fef3c7')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Accepted', receivestates?.Accepted, '#0284c7', '#e0f2fe')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Fulfilled', receivestates?.Fulfilled, '#16a34a', '#ecfdf5')}
								</Grid>
								<Grid item xs={6}>
									{renderStatBox('Rejected', receivestates?.Rejected, '#dc2626', '#ffe4e6')}
								</Grid>
							</Grid>
						</CardContent>

						<Divider />
						<CardActions sx={{ p: 2 }}>
							<Button
								fullWidth
								variant='text'
								endIcon={<ArrowForwardIcon />}
								onClick={() => navigate('/user/receiverequestsstates')}
								sx={{
									color: '#0284c7',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#f0f9ff' },
								}}
							>
								View Request Status
							</Button>
						</CardActions>
					</Card>
				</Grid>
			</Grid>
		</Container>
	)
}

export default UserHome
