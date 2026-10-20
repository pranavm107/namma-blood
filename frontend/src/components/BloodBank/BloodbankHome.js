import React, { useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
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
	Typography,
} from '@mui/material'
import { useNavigate } from 'react-router-dom'
import VolunteerActivismIcon from '@mui/icons-material/VolunteerActivism'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import ArrowForwardIcon from '@mui/icons-material/ArrowForward'
import BiotechIcon from '@mui/icons-material/Biotech'
import SecurityIcon from '@mui/icons-material/Security'
import { getBloodbankDonateStates } from '../../store/donateStatesSlice'
import { getBloodbankReceiveStates } from '../../store/receiveStatesSlice'

const BloodbankHome = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()
	const donatestates = useSelector((state) => state?.donatestates)
	const receivestates = useSelector((state) => state?.receivestates)

	useEffect(() => {
		dispatch(getBloodbankDonateStates())
		dispatch(getBloodbankReceiveStates())
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
					label='PARTNER BLOOD BANK CONSOLE'
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
					Blood Bank Overview
				</Typography>
				<Typography variant='body2' sx={{ color: '#64748b' }}>
					Manage voluntary blood donations and patient blood unit distribution across your center.
				</Typography>
			</Paper>

			<Grid container spacing={3}>
				{/* Donor Requests */}
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
										Donation Requests
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Voluntary donors offering to donate blood
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
								onClick={() => navigate('/bloodbank/donaterequestsstates')}
								sx={{
									color: '#c62828',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#fff5f5' },
								}}
							>
								View All Donation Requests
							</Button>
						</CardActions>
					</Card>
				</Grid>

				{/* Blood Requests */}
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
									<LocalHospitalIcon />
								</Box>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
										Patient Blood Requests
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Inquiries from patients and hospitals in need
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
								onClick={() => navigate('/bloodbank/receiverequestsstates')}
								sx={{
									color: '#0284c7',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#f0f9ff' },
								}}
							>
								View All Patient Requests
							</Button>
						</CardActions>
					</Card>
				</Grid>

				{/* Traceable Blood Inventory */}
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
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
								<Box
									sx={{
										width: 44,
										height: 44,
										borderRadius: 2,
										backgroundColor: '#ecfdf5',
										color: '#16a34a',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<BiotechIcon />
								</Box>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
										Traceable Blood Units & Screening
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										DIN tracking, TTI testing, Medical Officer clearance & discard
									</Typography>
								</Box>
							</Box>
							<Typography variant='body2' sx={{ color: '#475569', mb: 2 }}>
								Full clinical lifecycle controls for traceable barcoded units: mandatory 5-panel TTI screening, verified MO clearance, crossmatch compatibility, and auditable biohazard discard.
							</Typography>
						</CardContent>

						<Divider />
						<CardActions sx={{ p: 2 }}>
							<Button
								fullWidth
								variant='text'
								endIcon={<ArrowForwardIcon />}
								onClick={() => navigate('/bloodbank/inventory')}
								sx={{
									color: '#16a34a',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#f0fdf4' },
								}}
							>
								Open Traceable Inventory
							</Button>
						</CardActions>
					</Card>
				</Grid>

				{/* Legacy Reconciliation Console */}
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
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
								<Box
									sx={{
										width: 44,
										height: 44,
										borderRadius: 2,
										backgroundColor: '#fffbeb',
										color: '#b45309',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									<SecurityIcon />
								</Box>
								<Box>
									<Typography variant='h6' sx={{ fontWeight: 800, color: '#1e293b' }}>
										Reconciliation & Safe Migration
									</Typography>
									<Typography variant='caption' sx={{ color: '#64748b' }}>
										Dry-run audit, discrepancy detection & atomic migration
									</Typography>
								</Box>
							</Box>
							<Typography variant='body2' sx={{ color: '#475569', mb: 2 }}>
								Safely audit unverified aggregate stock against barcoded inventory. Simulate dry-runs and execute transactional conversions into quarantined traceable units.
							</Typography>
						</CardContent>

						<Divider />
						<CardActions sx={{ p: 2 }}>
							<Button
								fullWidth
								variant='text'
								endIcon={<ArrowForwardIcon />}
								onClick={() => navigate('/bloodbank/reconciliation')}
								sx={{
									color: '#b45309',
									fontWeight: 700,
									textTransform: 'none',
									'&:hover': { backgroundColor: '#fefce8' },
								}}
							>
								Open Reconciliation Console
							</Button>
						</CardActions>
					</Card>
				</Grid>
			</Grid>
		</Container>
	)
}

export default BloodbankHome
