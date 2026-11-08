/**
 * Dual-Stream Emergency Candidate Matching Dashboard
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import React, { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
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
	Pagination,
	Paper,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
} from '@mui/material'
import PersonSearchIcon from '@mui/icons-material/PersonSearch'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import VerifiedIcon from '@mui/icons-material/Verified'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import HelpOutlineIcon from '@mui/icons-material/HelpOutline'
import SearchIcon from '@mui/icons-material/Search'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import HourglassEmptyIcon from '@mui/icons-material/HourglassEmpty'
import ShieldIcon from '@mui/icons-material/Shield'
import SendIcon from '@mui/icons-material/Send'
import { toast } from 'react-toastify'
import { getEmergencyRequestMatches, clearMatchingData } from '../../../store/emergencySlice'
import { provideAdditionalInformation } from '../../../store/medicalOfficerSlice'

const EmergencyMatchingDashboard = () => {
	const { id } = useParams()
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { matching, creation } = useSelector((state) => state?.emergency || {})
	const { requesterAction } = useSelector((state) => state?.medicalOfficer || {})

	const [ticketInput, setTicketInput] = useState(id || '')
	const [donorPage, setDonorPage] = useState(1)
	const [bankPage, setBankPage] = useState(1)
	const [infoResponse, setInfoResponse] = useState('')
	const [infoResponseError, setInfoResponseError] = useState('')
	const [resubmittedSuccess, setResubmittedSuccess] = useState(false)

	const activeRequestId = id || ticketInput

	// Detect if this ticket was just created in this session and is awaiting clinical verification
	const justCreated = creation?.createdTicket
	const isJustCreatedPending =
		justCreated &&
		(justCreated._id === activeRequestId || justCreated.requestNumber === activeRequestId) &&
		justCreated.verificationStatus === 'Pending_Verification'

	const errorMessage = typeof matching.error === 'string' ? matching.error.toLowerCase() : ''

	const isMoreInfoRequired =
		!resubmittedSuccess &&
		(errorMessage.includes('additional clinical information') ||
			matching.errorCode === 'REQUEST_MORE_INFORMATION_REQUIRED')

	const isPendingVerification =
		resubmittedSuccess ||
		isJustCreatedPending ||
		errorMessage.includes('pending medical verification') ||
		matching.errorCode === 'REQUEST_PENDING_VERIFICATION'

	const isFlaggedSuspicious =
		errorMessage.includes('flagged as suspicious') ||
		matching.errorCode === 'REQUEST_FLAGGED_SUSPICIOUS'

	const isRejected =
		errorMessage.includes('verification was rejected') ||
		matching.errorCode === 'REQUEST_VERIFICATION_REJECTED'

	const displayRequestNumber = matching.requestNumber || (isJustCreatedPending ? justCreated.requestNumber : null)
	const displayBloodGroup =
		matching.matchingSummary?.preferredGroup ||
		matching.requestDetails?.requiredBloodGroup ||
		(isJustCreatedPending ? justCreated.requiredBloodGroup : null)
	const displayUnits =
		matching.unmetUnits !== null && matching.unmetUnits !== undefined
			? matching.unmetUnits
			: (isJustCreatedPending ? justCreated.unitsRequested : null)

	const handleProvideInfoSubmit = async (e) => {
		e.preventDefault()
		if (!infoResponse.trim() || infoResponse.trim().length < 5) {
			setInfoResponseError('Please provide clinical clarification (minimum 5 characters).')
			return
		}
		setInfoResponseError('')

		const resultAction = await dispatch(
			provideAdditionalInformation({
				requestId: activeRequestId.trim(),
				informationProvided: infoResponse.trim(),
			})
		)

		if (provideAdditionalInformation.fulfilled.match(resultAction)) {
			toast.success('Clarification submitted successfully. Status updated to Pending Verification.')
			setResubmittedSuccess(true)
			setInfoResponse('')
		} else {
			toast.error(resultAction.payload?.message || 'Failed to submit additional information.')
		}
	}

	const fetchMatches = useCallback(
		(dPage = 1, bPage = 1) => {
			if (!activeRequestId) return
			// Avoid triggering a doomed 400 network call when ticket is already known to be pending verification
			if (isJustCreatedPending) return
			dispatch(
				getEmergencyRequestMatches({
					requestId: activeRequestId.trim(),
					donorPage: dPage,
					donorLimit: 6,
					bankPage: bPage,
					bankLimit: 6,
					radiusKm: 15,
				})
			)
		},
		[dispatch, activeRequestId, isJustCreatedPending]
	)

	useEffect(() => {
		if (id) {
			setTicketInput(id)
			setDonorPage(1)
			setBankPage(1)
			fetchMatches(1, 1)
		}
		return () => {
			dispatch(clearMatchingData())
		}
	}, [id, fetchMatches, dispatch])

	const handleSearchSubmit = (e) => {
		e.preventDefault()
		if (!ticketInput.trim()) return
		navigate(`/user/emergency-requests/${encodeURIComponent(ticketInput.trim())}/matches`)
	}

	const handleDonorPageChange = (_, newPage) => {
		setDonorPage(newPage)
		fetchMatches(newPage, bankPage)
	}

	const handleBankPageChange = (_, newPage) => {
		setBankPage(newPage)
		fetchMatches(donorPage, newPage)
	}

	return (
		<Container maxWidth='xl' sx={{ py: 4 }}>
			{/* Top Navigation & Lookup Bar */}
			<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2, mb: 3 }}>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
					<Button
						variant='text'
						startIcon={<ArrowBackIcon />}
						onClick={() => navigate('/user')}
						sx={{ color: '#64748b', textTransform: 'none', fontWeight: 600 }}
					>
						Back to Dashboard
					</Button>
					<Typography variant='h5' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Emergency Candidate Matching
					</Typography>
				</Box>

				<Box component='form' onSubmit={handleSearchSubmit} sx={{ display: 'flex', gap: 1 }}>
					<TextField
						size='small'
						placeholder='Ticket ID or EMG Number'
						value={ticketInput}
						onChange={(e) => setTicketInput(e.target.value)}
						sx={{ width: 280, bgcolor: '#ffffff' }}
					/>
					<Button type='submit' variant='contained' color='primary' startIcon={<SearchIcon />} sx={{ fontWeight: 700 }}>
						Match
					</Button>
				</Box>
			</Box>

			{/* Persistent Mandatory Clinical Governance Warning Banner */}
			<Alert severity='warning' sx={{ mb: 4, borderRadius: 3, border: '1px solid #fed7aa' }}>
				<AlertTitle sx={{ fontWeight: 800 }}>Clinical Governance & Transfusion Safety Notice</AlertTitle>
				Matching results are informational and do not constitute clinical clearance, donation authorization, blood reservation, issuance, dispatch, or transfusion approval. All blood units require appropriate Medical Officer clearance, verified screening records, and mandatory laboratory pre-transfusion crossmatching.
			</Alert>

			{/* Request Overview Card (If matching data is loaded or freshly created) */}
			{displayRequestNumber && (
				<Paper elevation={0} sx={{ p: 3, mb: 4, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
					<Grid container spacing={3} alignItems='center'>
						<Grid item xs={12} sm={3}>
							<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600, display: 'block' }}>
								REQUEST IDENTIFIER
							</Typography>
							<Typography variant='subtitle1' sx={{ fontWeight: 800, color: '#1e293b', fontFamily: 'monospace' }}>
								{displayRequestNumber}
							</Typography>
						</Grid>
						<Grid item xs={6} sm={3}>
							<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600, display: 'block' }}>
								REQUIRED BLOOD GROUP
							</Typography>
							<Chip
								label={displayBloodGroup ? displayBloodGroup.replace('_', ' ') : 'Blood Group'}
								color='error'
								size='small'
								sx={{ fontWeight: 800, mt: 0.5 }}
							/>
						</Grid>
						<Grid item xs={6} sm={3}>
							<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600, display: 'block' }}>
								UNMET SHORTFALL
							</Typography>
							<Typography variant='subtitle1' sx={{ fontWeight: 800, color: '#c62828' }}>
								{displayUnits !== null ? `${displayUnits} Units Needed` : 'Pending calculation'}
							</Typography>
						</Grid>
						<Grid item xs={12} sm={3}>
							<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600, display: 'block' }}>
								SEARCH RADIUS
							</Typography>
							<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
								{matching.matchingSummary?.searchRadiusKm || 15} km Radius
							</Typography>
						</Grid>
					</Grid>
				</Paper>
			)}

			{/* Clinical Status: More Information Required (Interactive Clarification Form) */}
			{isMoreInfoRequired ? (
				<Paper
					elevation={0}
					sx={{
						p: 3.5,
						mb: 4,
						borderRadius: 3,
						border: '1px solid #bae6fd',
						bgcolor: '#f0f9ff',
					}}
				>
					<Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
						<HelpOutlineIcon sx={{ color: '#0284c7', fontSize: 36, mt: 0.5 }} />
						<Box sx={{ flex: 1 }}>
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
								<Typography variant='h6' sx={{ fontWeight: 800, color: '#075985' }}>
									Additional Clinical Information Required
								</Typography>
								<Chip
									label='CLARIFICATION NEEDED'
									size='small'
									sx={{
										bgcolor: '#e0f2fe',
										color: '#0369a1',
										fontWeight: 800,
										fontSize: '0.75rem',
									}}
								/>
							</Box>
							<Typography variant='body1' sx={{ color: '#0c4a6e', mb: 2, lineHeight: 1.6 }}>
								The reviewing Medical Officer requires additional clinical details or documentation before verification can proceed. Please provide the requested clarification below to transition the ticket back to <strong>Pending Verification</strong>.
							</Typography>

							<Box component='form' onSubmit={handleProvideInfoSubmit} sx={{ mt: 2 }}>
								<TextField
									multiline
									rows={3}
									fullWidth
									label='Clarification / Document Details *'
									placeholder='Enter attending physician notes, laboratory confirmation, or emergency justification...'
									value={infoResponse}
									onChange={(e) => setInfoResponse(e.target.value)}
									error={Boolean(infoResponseError)}
									helperText={infoResponseError || 'Minimum 5 characters required'}
									sx={{ bgcolor: '#ffffff', mb: 2, borderRadius: 2 }}
								/>
								<Button
									type='submit'
									variant='contained'
									color='primary'
									startIcon={requesterAction.isLoading ? <CircularProgress size={16} color='inherit' /> : <SendIcon />}
									disabled={requesterAction.isLoading}
									sx={{ fontWeight: 800, px: 3, borderRadius: 2, textTransform: 'none' }}
								>
									Submit Clarification to Medical Officer
								</Button>
							</Box>
						</Box>
					</Box>
				</Paper>
			) : isFlaggedSuspicious ? (
				<Alert
					severity='error'
					icon={<ShieldIcon />}
					sx={{ mb: 4, borderRadius: 3, border: '1px solid #fecaca', bgcolor: '#fef2f2' }}
				>
					<AlertTitle sx={{ fontWeight: 800 }}>Clinical Security Notice: Quarantined Request</AlertTitle>
					Emergency blood request <strong>#{ticketInput || id}</strong> has been flagged as suspicious and quarantined. In strict compliance with healthcare safety standards, matching and donor dispatch are suspended pending administrative review.
				</Alert>
			) : isRejected ? (
				<Alert
					severity='error'
					sx={{ mb: 4, borderRadius: 3, border: '1px solid #fecaca', bgcolor: '#fef2f2' }}
				>
					<AlertTitle sx={{ fontWeight: 800 }}>Emergency Request Verification Rejected</AlertTitle>
					This emergency blood request was rejected during Medical Officer verification. Matching and blood allocation cannot be performed on rejected requests.
				</Alert>
			) : isPendingVerification ? (
				<Paper
					elevation={0}
					sx={{
						p: 3.5,
						mb: 4,
						borderRadius: 3,
						border: '1px solid #fed7aa',
						bgcolor: '#fffbf5',
					}}
				>
					<Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2 }}>
						<HourglassEmptyIcon sx={{ color: '#d97706', fontSize: 36, mt: 0.5 }} />
						<Box sx={{ flex: 1 }}>
							<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
								<Typography variant='h6' sx={{ fontWeight: 800, color: '#92400e' }}>
									Request Registered — Pending Medical Verification
								</Typography>
								<Chip
									label='PENDING CLINICAL VERIFICATION'
									size='small'
									sx={{
										bgcolor: '#fef3c7',
										color: '#b45309',
										fontWeight: 800,
										fontSize: '0.75rem',
										letterSpacing: '0.05em',
									}}
								/>
							</Box>
							<Typography variant='body1' sx={{ color: '#78350f', mb: 1.5, lineHeight: 1.6 }}>
								Emergency Blood Request <strong>#{ticketInput || id}</strong> has been successfully registered. In strict compliance with healthcare safety standards, automated candidate matching and donor dispatch are activated immediately once an authorized Medical Officer confirms clinical verification.
							</Typography>
							<Divider sx={{ my: 1.5, borderColor: '#fde68a' }} />
							<Grid container spacing={2} sx={{ mt: 0.5 }}>
								<Grid item xs={12} sm={4}>
									<Typography variant='caption' sx={{ color: '#92400e', fontWeight: 700, display: 'block' }}>
										CLINICAL PROTOCOL
									</Typography>
									<Typography variant='body2' sx={{ color: '#78350f' }}>
										Attending doctor / Medical Officer evaluates patient condition and confirms transfusion urgency.
									</Typography>
								</Grid>
								<Grid item xs={12} sm={4}>
									<Typography variant='caption' sx={{ color: '#92400e', fontWeight: 700, display: 'block' }}>
										AUTOMATIC DISPATCH
									</Typography>
									<Typography variant='body2' sx={{ color: '#78350f' }}>
										Once verified, compatible nearby donors and verified blood bank stock within 15 km will populate below.
									</Typography>
								</Grid>
								<Grid item xs={12} sm={4}>
									<Typography variant='caption' sx={{ color: '#92400e', fontWeight: 700, display: 'block' }}>
										VERIFIED DEMO REQUEST
									</Typography>
									<Typography variant='body2' sx={{ color: '#78350f' }}>
										To view dual-stream candidate matching in action, explore QA verified request{' '}
										<Button
											size='small'
											onClick={() => {
												setTicketInput('6aed932b2debf35b705967bd')
												navigate('/user/emergency-requests/6aed932b2debf35b705967bd/matches')
											}}
											sx={{ p: 0, minWidth: 0, textTransform: 'none', fontWeight: 800, textDecoration: 'underline' }}
										>
											6aed932b2debf35b705967bd
										</Button>
									</Typography>
								</Grid>
							</Grid>
						</Box>
					</Box>
				</Paper>
			) : matching.error ? (
				<Alert severity='error' sx={{ mb: 4, borderRadius: 2 }}>
					<AlertTitle sx={{ fontWeight: 700 }}>Unable to Retrieve Matching Candidates</AlertTitle>
					{matching.error}
				</Alert>
			) : null}

			{/* Dual-Stream Candidate View */}
			{matching.isLoading ? (
				<Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
					<CircularProgress color='primary' size={48} />
				</Box>
			) : (
				<Grid container spacing={4}>
					{/* ========================================================= */}
					{/* STREAM A: DONOR CANDIDATE STREAM (INDEPENDENT)           */}
					{/* ========================================================= */}
					<Grid item xs={12} md={6}>
						<Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', minHeight: 480 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
								<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
									<PersonSearchIcon sx={{ color: '#c62828' }} />
									<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Donor Candidates
									</Typography>
								</Box>
								<Chip
									label={`${matching.donorStream.pagination?.totalCount ?? 0} Discovered`}
									size='small'
									sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}
								/>
							</Box>

							<Divider sx={{ mb: 2.5 }} />

							{matching.donorStream.candidates?.length > 0 ? (
								<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
									{matching.donorStream.candidates.map((donor, idx) => {
										const ref = donor.candidateRef || donor.pseudonymousDonorId || `DNR-${idx}`
										const isProspective =
											donor.classification === 'Pending_Clinical_Evaluation' ||
											donor.clinicalEligibilityStatus === 'Pending_Clinical_Evaluation'
										const dist = donor.approxDistanceKm ?? donor.distanceKm ?? null
										return (
											<Card key={ref} elevation={0} sx={{ borderRadius: 2, border: '1px solid #e2e8f0' }}>
												<CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
													<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
														<Typography variant='body2' sx={{ fontFamily: 'monospace', fontWeight: 700, color: '#334155' }}>
															{ref}
														</Typography>
														<Chip
															label={donor.bloodGroup?.replace('_', ' ')}
															size='small'
															color='error'
															sx={{ fontWeight: 800 }}
														/>
													</Box>

													<Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 1, flexWrap: 'wrap' }}>
														{isProspective ? (
															<Chip
																icon={<HelpOutlineIcon />}
																label='Tier 3: Prospective Donor'
																size='small'
																sx={{ bgcolor: '#fef3c7', color: '#92400e', fontWeight: 700 }}
															/>
														) : (
															<Chip
																icon={<VerifiedIcon />}
																label='Tier 2: Potential Donor Match'
																color='success'
																size='small'
																sx={{ fontWeight: 700 }}
															/>
														)}
														<Typography variant='caption' sx={{ color: '#64748b', fontWeight: 600 }}>
															{donor.matchQuality?.replace('_', ' ')} Match
														</Typography>
														{dist !== null && (
															<Typography variant='caption' sx={{ color: '#64748b' }}>
																• ~{dist} km
															</Typography>
														)}
													</Box>

													<Typography variant='caption' sx={{ color: '#64748b', display: 'block', fontStyle: 'italic' }}>
														{donor.clinicalNotice ||
															'Self-reported intent only. Mandatory on-site clinical evaluation & crossmatching are required.'}
													</Typography>
												</CardContent>
											</Card>
										)
									})}
								</Box>
							) : (
								<Box sx={{ textAlign: 'center', py: 6 }}>
									<Typography variant='body2' sx={{ color: '#94a3b8' }}>
										{isPendingVerification
											? 'Candidate discovery paused awaiting medical verification.'
											: 'No matching volunteer donors found for this emergency ticket.'}
									</Typography>
								</Box>
							)}

							{/* Independent Donor Pagination */}
							{matching.donorStream.pagination?.totalPages > 1 && (
								<Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
									<Pagination
										count={matching.donorStream.pagination.totalPages}
										page={donorPage}
										onChange={handleDonorPageChange}
										color='primary'
										size='small'
									/>
								</Box>
							)}
						</Paper>
					</Grid>

					{/* ========================================================= */}
					{/* STREAM B: BLOOD BANK INVENTORY STREAM (INDEPENDENT)      */}
					{/* ========================================================= */}
					<Grid item xs={12} md={6}>
						<Paper elevation={0} sx={{ p: 3, borderRadius: 3, border: '1px solid #e2e8f0', minHeight: 480 }}>
							<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
								<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
									<LocalHospitalIcon sx={{ color: '#0284c7' }} />
									<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
										Blood Bank Facilities
									</Typography>
								</Box>
								<Chip
									label={`${matching.bankStream.pagination?.totalCount ?? 0} Facilities`}
									size='small'
									sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}
								/>
							</Box>

							<Divider sx={{ mb: 2.5 }} />

							{matching.bankStream.candidates?.length > 0 ? (
								<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
									{matching.bankStream.candidates.map((bank, bIdx) => {
										const ref = bank.facilityRef || bank.pseudonymousFacilityRef || bank.bloodBankId || bank._id || `BB-${bIdx}`
										const trust = bank.inventoryTrustStatus || bank.inventoryStatus || bank.inventoryState
										const isVerified = trust === 'Verified_Bloodbank_Stock_Match'
										const isNoStock = trust === 'No_Matching_Stock'
										const dist = bank.approxDistanceKm ?? bank.distanceKm ?? null

										return (
											<Card key={ref} elevation={0} sx={{ borderRadius: 2, border: '1px solid #e2e8f0' }}>
												<CardContent sx={{ p: 2, '&:last-child': { pb: 2 } }}>
													<Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
														<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
															{bank.name || bank.bloodBankName || 'Regional Blood Centre'}
														</Typography>
														{isVerified ? (
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
																label='0 Units Available'
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

													<Typography variant='caption' sx={{ color: '#64748b', display: 'block', mb: 0.5 }}>
														{bank.city}, {bank.state} {dist !== null ? `(~${dist} km)` : ''}
													</Typography>

													<Typography variant='caption' sx={{ color: '#64748b', display: 'block', fontStyle: 'italic' }}>
														{bank.inventoryNotice ||
															(isVerified
																? 'Verified issue-eligible inventory meeting all mandatory clinical safety standards.'
																: isNoStock
																? 'Inventory records verified. No matching units found for the requested group.'
																: 'Inventory status could not be verified on platform.')}
													</Typography>
												</CardContent>
											</Card>
										)
									})}
								</Box>
							) : (
								<Box sx={{ textAlign: 'center', py: 6 }}>
									<Typography variant='body2' sx={{ color: '#94a3b8' }}>
										{isPendingVerification
											? 'Blood bank inventory matching paused awaiting medical verification.'
											: 'No matching blood bank inventory found for this emergency ticket.'}
									</Typography>
								</Box>
							)}

							{/* Independent Blood Bank Pagination */}
							{matching.bankStream.pagination?.totalPages > 1 && (
								<Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
									<Pagination
										count={matching.bankStream.pagination.totalPages}
										page={bankPage}
										onChange={handleBankPageChange}
										color='primary'
										size='small'
									/>
								</Box>
							)}
						</Paper>
					</Grid>
				</Grid>
			)}
		</Container>
	)
}

export default EmergencyMatchingDashboard
