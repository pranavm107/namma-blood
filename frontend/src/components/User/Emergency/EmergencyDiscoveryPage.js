/**
 * Emergency Discovery Interface (Donors & Blood Banks)
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import {
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Container,
	Divider,
	Grid,
	MenuItem,
	Pagination,
	Paper,
	Slider,
	Tab,
	Tabs,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
} from '@mui/material'
import TravelExploreIcon from '@mui/icons-material/TravelExplore'
import PersonSearchIcon from '@mui/icons-material/PersonSearch'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import VerifiedIcon from '@mui/icons-material/Verified'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import useGeolocation from '../../../hooks/useGeolocation'
import {
	discoverEmergencyDonors,
	discoverEmergencyBloodbanks,
	setEmergencyFilters,
} from '../../../store/emergencySlice'

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

const COMPONENTS = [
	{ label: 'Packed Red Blood Cells (PRBC)', value: 'Packed_Red_Blood_Cells' },
	{ label: 'Whole Blood', value: 'Whole_Blood' },
	{ label: 'Fresh Frozen Plasma (FFP)', value: 'Fresh_Frozen_Plasma' },
	{ label: 'Platelet Concentrate', value: 'Platelet_Concentrate' },
	{ label: 'Cryoprecipitate', value: 'Cryoprecipitate' },
]

const EmergencyDiscoveryPage = () => {
	const dispatch = useDispatch()
	const { donorDiscovery, bloodbankDiscovery, filters } = useSelector((state) => state?.emergency || {})
	const [activeTab, setActiveTab] = useState(0) // 0 = Donors, 1 = Blood Banks
	const [donorPage, setDonorPage] = useState(1)
	const [bankPage, setBankPage] = useState(1)

	const {
		coordinates,
		isLoading: geoLoading,
		error: geoError,
		requestLocation,
	} = useGeolocation()

	// Execute discovery queries based on active filters
	const fetchDonors = useCallback(
		(page = 1) => {
			dispatch(
				discoverEmergencyDonors({
					bloodGroup: filters.bloodGroup,
					componentType: filters.componentType,
					radiusKm: filters.radiusKm,
					latitude: coordinates ? coordinates[1] : undefined,
					longitude: coordinates ? coordinates[0] : undefined,
					city: !coordinates ? filters.city : undefined,
					state: !coordinates ? filters.state : undefined,
					page,
					limit: 6,
				})
			)
		},
		[dispatch, filters, coordinates]
	)

	const fetchBloodbanks = useCallback(
		(page = 1) => {
			dispatch(
				discoverEmergencyBloodbanks({
					bloodGroup: filters.bloodGroup,
					componentType: filters.componentType,
					radiusKm: filters.radiusKm,
					latitude: coordinates ? coordinates[1] : undefined,
					longitude: coordinates ? coordinates[0] : undefined,
					city: !coordinates ? filters.city : undefined,
					state: !coordinates ? filters.state : undefined,
					page,
					limit: 6,
				})
			)
		},
		[dispatch, filters, coordinates]
	)

	useEffect(() => {
		if (activeTab === 0) {
			fetchDonors(donorPage)
		} else {
			fetchBloodbanks(bankPage)
		}
	}, [activeTab, donorPage, bankPage, fetchDonors, fetchBloodbanks])

	const handleGpsClick = async () => {
		const res = await requestLocation()
		if (res.success && res.coordinates) {
			dispatch(
				setEmergencyFilters({
					latitude: res.coordinates[1],
					longitude: res.coordinates[0],
					useGps: true,
				})
			)
		}
	}

	return (
		<Container maxWidth='lg' sx={{ py: 4 }}>
			{/* Page Header */}
			<Box sx={{ mb: 4 }}>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
					<TravelExploreIcon sx={{ color: '#c62828', fontSize: 36 }} />
					<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Emergency Discovery
					</Typography>
				</Box>
				<Typography variant='body1' sx={{ color: '#64748b' }}>
					Geospatial search for ready volunteer donors and verified institutional blood bank inventories within your response radius.
				</Typography>
			</Box>

			{/* Filter Control Bar */}
			<Paper elevation={0} sx={{ p: 3, mb: 4, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#ffffff' }}>
				<Grid container spacing={3} alignItems='center'>
					<Grid item xs={12} sm={3}>
						<TextField
							select
							fullWidth
							size='small'
							label='Required Blood Group'
							value={filters.bloodGroup}
							onChange={(e) => dispatch(setEmergencyFilters({ bloodGroup: e.target.value }))}
						>
							{BLOOD_GROUPS.map((grp) => (
								<MenuItem key={grp} value={grp}>
									{grp.replace('_', ' ')}
								</MenuItem>
							))}
						</TextField>
					</Grid>

					<Grid item xs={12} sm={4}>
						<TextField
							select
							fullWidth
							size='small'
							label='Component Type'
							value={filters.componentType}
							onChange={(e) => dispatch(setEmergencyFilters({ componentType: e.target.value }))}
						>
							{COMPONENTS.map((c) => (
								<MenuItem key={c.value} value={c.value}>
									{c.label}
								</MenuItem>
							))}
						</TextField>
					</Grid>

					<Grid item xs={12} sm={5}>
						<Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
							<Button
								variant={coordinates ? 'contained' : 'outlined'}
								color='primary'
								size='small'
								startIcon={geoLoading ? <CircularProgress size={14} sx={{ color: 'inherit' }} /> : <MyLocationIcon />}
								onClick={handleGpsClick}
								disabled={geoLoading}
								sx={{ textTransform: 'none', minWidth: 140 }}
							>
								{coordinates ? 'GPS Active ✓' : 'Use Current GPS'}
							</Button>
							{!coordinates && (
								<TextField
									size='small'
									placeholder='City fallback (e.g. Chennai)'
									value={filters.city}
									onChange={(e) => dispatch(setEmergencyFilters({ city: e.target.value }))}
									sx={{ flex: 1 }}
								/>
							)}
						</Box>
					</Grid>

					<Grid item xs={12} sm={8}>
						<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
							Search Radius: {filters.radiusKm} km
						</Typography>
						<Slider
							value={filters.radiusKm}
							min={1}
							max={50}
							step={1}
							onChange={(_, val) => dispatch(setEmergencyFilters({ radiusKm: val }))}
							sx={{ color: '#c62828' }}
						/>
					</Grid>

					<Grid item xs={12} sm={4} sx={{ textAlign: 'right' }}>
						<Button
							variant='contained'
							color='primary'
							onClick={() => {
								if (activeTab === 0) fetchDonors(1)
								else fetchBloodbanks(1)
							}}
							sx={{ px: 3, fontWeight: 700 }}
						>
							Apply Filters
						</Button>
					</Grid>
				</Grid>

				{geoError && (
					<Alert severity='info' sx={{ mt: 2, py: 0.5 }}>
						{geoError.message || 'GPS location not available; fallback to City/State active.'}
					</Alert>
				)}
			</Paper>

			{/* Stream Switcher Tabs */}
			<Box sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}>
				<Tabs value={activeTab} onChange={(_, val) => setActiveTab(val)}>
					<Tab
						icon={<PersonSearchIcon />}
						iconPosition='start'
						label={`Nearby Donors (${donorDiscovery.pagination?.totalCount ?? 0})`}
						sx={{ fontWeight: 700, textTransform: 'none' }}
					/>
					<Tab
						icon={<LocalHospitalIcon />}
						iconPosition='start'
						label={`Blood Banks (${bloodbankDiscovery.pagination?.totalCount ?? 0})`}
						sx={{ fontWeight: 700, textTransform: 'none' }}
					/>
				</Tabs>
			</Box>

			{/* TAB 0: DONOR DISCOVERY STREAM */}
			{activeTab === 0 && (
				<Box>
					{donorDiscovery.clinicalNotice && (
						<Alert severity='warning' sx={{ mb: 3, borderRadius: 2 }}>
							<AlertTitle sx={{ fontWeight: 700 }}>Mandatory Clinical Screening Notice</AlertTitle>
							{donorDiscovery.clinicalNotice}
						</Alert>
					)}

					{donorDiscovery.isLoading ? (
						<Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
							<CircularProgress color='primary' />
						</Box>
					) : donorDiscovery.data?.length > 0 ? (
						<Grid container spacing={3}>
							{donorDiscovery.data.map((donor, idx) => {
								const ref = donor.candidateRef || donor.pseudonymousDonorId || `DNR-${idx}`
								const isProspective =
									donor.classification === 'Pending_Clinical_Evaluation' ||
									donor.clinicalEligibilityStatus === 'Pending_Clinical_Evaluation'
								const dist = donor.approxDistanceKm ?? donor.distanceKm ?? null
								return (
									<Grid item xs={12} sm={6} md={4} key={ref}>
										<Card elevation={0} sx={{ borderRadius: 3, border: '1px solid #e2e8f0', height: '100%' }}>
											<CardContent>
												<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1.5 }}>
													<Typography variant='caption' sx={{ fontFamily: 'monospace', color: '#64748b', fontWeight: 700 }}>
														{ref}
													</Typography>
													<Chip
														label={donor.bloodGroup?.replace('_', ' ')}
														size='small'
														color='primary'
														sx={{ fontWeight: 800 }}
													/>
												</Box>

												<Box sx={{ mb: 2 }}>
													{isProspective ? (
														<Chip
															icon={<HelpOutlineIcon />}
															label='Prospective Donor'
															color='default'
															size='small'
															sx={{ bgcolor: '#fef3c7', color: '#92400e', fontWeight: 700, mb: 1 }}
														/>
													) : (
														<Chip
															icon={<VerifiedIcon />}
															label='Clinically Cleared'
															color='success'
															size='small'
															sx={{ fontWeight: 700, mb: 1 }}
														/>
													)}
													<Typography variant='body2' sx={{ color: '#1e293b', fontWeight: 600 }}>
														Match: {donor.matchQuality?.replace('_', ' ') || 'Compatible'}
													</Typography>
													{donor.approxDistanceKm !== null && (
														<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
															Distance: ~{donor.approxDistanceKm} km
														</Typography>
													)}
												</Box>

												<Divider sx={{ my: 1.5 }} />

												<Typography variant='caption' sx={{ color: '#64748b', display: 'block', fontStyle: 'italic' }}>
													{isProspective
														? 'Donor availability is self-reported. Prospective match only — required clinical screening must precede blood collection.'
														: 'Historical Medical Officer clearance on record. Mandatory pre-donation screening & crossmatching remain compulsory.'}
												</Typography>
											</CardContent>
										</Card>
									</Grid>
								)
							})}
						</Grid>
					) : (
						<Paper elevation={0} sx={{ p: 6, textAlign: 'center', borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
							<PersonSearchIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
							<Typography variant='h6' sx={{ color: '#475569', fontWeight: 700 }}>
								No Compatible Donors in Selected Radius
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mt: 0.5 }}>
								Try expanding your search radius (up to 50 km) or selecting a different blood component filter.
							</Typography>
						</Paper>
					)}

					{/* Independent Donor Pagination */}
					{donorDiscovery.pagination?.totalPages > 1 && (
						<Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
							<Pagination
								count={donorDiscovery.pagination.totalPages}
								page={donorPage}
								onChange={(_, p) => {
									setDonorPage(p)
									fetchDonors(p)
								}}
								color='primary'
							/>
						</Box>
					)}
				</Box>
			)}

			{/* TAB 1: BLOOD BANK DISCOVERY STREAM */}
			{activeTab === 1 && (
				<Box>
					{bloodbankDiscovery.governanceNotice && (
						<Alert severity='info' sx={{ mb: 3, borderRadius: 2 }}>
							<AlertTitle sx={{ fontWeight: 700 }}>Clinical Governance Notice</AlertTitle>
							{bloodbankDiscovery.governanceNotice}
						</Alert>
					)}

					{bloodbankDiscovery.isLoading ? (
						<Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
							<CircularProgress color='primary' />
						</Box>
					) : bloodbankDiscovery.data?.length > 0 ? (
						<Grid container spacing={3}>
							{bloodbankDiscovery.data.map((bank, bIdx) => {
								const ref = bank.facilityRef || bank.pseudonymousFacilityRef || bank.bloodBankId || bank._id || `BB-${bIdx}`
								const trust = bank.inventoryTrustStatus || bank.inventoryStatus || bank.inventoryState
								const isVerifiedMatch = trust === 'Verified_Bloodbank_Stock_Match'
								const isNoStock = trust === 'No_Matching_Stock'
								const name = bank.name || bank.bloodBankName || 'Regional Blood Centre'
								const dist = bank.approxDistanceKm ?? bank.distanceKm ?? null

								return (
									<Grid item xs={12} sm={6} md={4} key={ref}>
										<Card elevation={0} sx={{ borderRadius: 3, border: '1px solid #e2e8f0', height: '100%' }}>
											<CardContent>
												<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
													<Typography variant='caption' sx={{ fontFamily: 'monospace', color: '#64748b' }}>
														{ref}
													</Typography>
													{isVerifiedMatch ? (
														<Chip
															icon={<VerifiedIcon />}
															label={`${bank.verifiedUnitsAvailable} Units Verified`}
															color='success'
															size='small'
															sx={{ fontWeight: 700 }}
														/>
													) : isNoStock ? (
														<Chip
															icon={<WarningAmberIcon />}
															label='0 Units Matching'
															color='warning'
															size='small'
															sx={{ fontWeight: 700 }}
														/>
													) : (
														<Chip
															icon={<HelpOutlineIcon />}
															label='Inventory Unverified'
															size='small'
															sx={{ bgcolor: '#e2e8f0', color: '#475569', fontWeight: 700 }}
														/>
													)}
												</Box>

												<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 0.5 }}>
													{name}
												</Typography>
												<Typography variant='body2' sx={{ color: '#64748b', mb: 1 }}>
													{bank.city}, {bank.state}
												</Typography>

												{dist !== null && (
													<Typography variant='caption' sx={{ color: '#64748b', display: 'block', mb: 1.5 }}>
														Distance: ~{dist} km
													</Typography>
												)}

												<Divider sx={{ my: 1.5 }} />

												<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
													{isVerifiedMatch
														? 'Issue-eligible traceable units available meeting all clinical clearance & non-reactive TTI mandates.'
														: isNoStock
														? 'Inventory records verified. No matching units available for this blood group and component.'
														: 'Inventory status could not be verified on platform. Presence in discovery does not imply stock availability.'}
												</Typography>
											</CardContent>
										</Card>
									</Grid>
								)
							})}
						</Grid>
					) : (
						<Paper elevation={0} sx={{ p: 6, textAlign: 'center', borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
							<LocalHospitalIcon sx={{ fontSize: 48, color: '#94a3b8', mb: 1 }} />
							<Typography variant='h6' sx={{ color: '#475569', fontWeight: 700 }}>
								No Registered Blood Banks in Selected Radius
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mt: 0.5 }}>
								Try expanding your search radius or searching by City/State.
							</Typography>
						</Paper>
					)}

					{/* Independent Blood Bank Pagination */}
					{bloodbankDiscovery.pagination?.totalPages > 1 && (
						<Box sx={{ display: 'flex', justifyContent: 'center', mt: 4 }}>
							<Pagination
								count={bloodbankDiscovery.pagination.totalPages}
								page={bankPage}
								onChange={(_, p) => {
									setBankPage(p)
									fetchBloodbanks(p)
								}}
								color='primary'
							/>
						</Box>
					)}
				</Box>
			)}
		</Container>
	)
}

export default EmergencyDiscoveryPage
