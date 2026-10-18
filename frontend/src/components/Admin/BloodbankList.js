import {
	Box,
	Button,
	SvgIcon,
	Table,
	TableBody,
	TableCell,
	TableContainer,
	TableHead,
	TableRow,
	Typography,
} from '@mui/material'
import React, { useEffect } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import PlusIcon from '@heroicons/react/24/solid/PlusIcon'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import { getBloodbanks } from '../../store/bloodbankSlice'

const BloodbankList = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()
	const { bloodbanks } = useSelector((state) => state?.bloodbanks)

	useEffect(() => {
		dispatch(getBloodbanks(''))
	}, [dispatch])

	return (
		<>
			<Box sx={{ mb: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
				<Box>
					<Typography variant='h5' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Partner Blood Banks
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Accredited blood banks registered on Namma Blood
					</Typography>
				</Box>
				<Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap' }}>
					<Button
						startIcon={<UploadFileIcon />}
						variant='outlined'
						onClick={() => navigate('/admin/bulk-import')}
						sx={{
							borderColor: '#cbd5e1',
							color: '#334155',
							fontWeight: 700,
							textTransform: 'none',
							py: 1,
							px: 2,
							borderRadius: 2,
							'&:hover': {
								borderColor: '#94a3b8',
								backgroundColor: '#f8fafc',
							},
						}}
					>
						Bulk Import CSV
					</Button>
					<Button
						startIcon={
							<SvgIcon fontSize='small'>
								<PlusIcon />
							</SvgIcon>
						}
						variant='contained'
						onClick={() => navigate('/admin/addbloodbank')}
						sx={{
							backgroundColor: '#c62828',
							fontWeight: 700,
							textTransform: 'none',
							py: 1,
							px: 2.5,
							borderRadius: 2,
							boxShadow: '0 4px 12px rgba(198, 40, 40, 0.3)',
							'&:hover': {
								backgroundColor: '#b71c1c',
							},
						}}
					>
						Add Blood Bank
					</Button>
				</Box>
			</Box>

			<Box
				sx={{
					borderRadius: 3,
					overflow: 'hidden',
					border: '1px solid #e2e8f0',
					boxShadow: '0 4px 16px rgba(0,0,0,0.02)',
					backgroundColor: '#ffffff',
				}}
			>
				<TableContainer>
					<Table sx={{ minWidth: 700 }} aria-label='customized table'>
						<TableHead>
							<TableRow
								selected={true}
								style={{ backgroundColor: '#fff5f5' }}
							>
								<TableCell>S.No</TableCell>
								{/* <TableCell>Status</TableCell> */}
								<TableCell>Blood Bank</TableCell>
								<TableCell>Contact Person</TableCell>
								<TableCell>Category</TableCell>
								<TableCell>Address</TableCell>
								<TableCell>State</TableCell>
								<TableCell>City</TableCell>
								<TableCell>Pin Code</TableCell>
								<TableCell>Email</TableCell>
								<TableCell>Phone</TableCell>
							</TableRow>
						</TableHead>
						<TableBody>
							{bloodbanks &&
								bloodbanks?.map((bloodbank, index) => {
									return (
										<React.Fragment key={bloodbank?._id}>
											<TableRow
												style={{
													backgroundColor: '##ffffff',
												}}
											>
												<TableCell>
													{index + 1}
												</TableCell>
												{/* <TableCell>
													{bloodbank?.status
														? 'Active'
														: 'Inactive'}
												</TableCell> */}
												<TableCell>
													{bloodbank?.bloodbankName}
												</TableCell>
												<TableCell>
													{bloodbank?.contactPerson}
												</TableCell>
												<TableCell>
													{bloodbank?.category}
												</TableCell>
												<TableCell>
													{bloodbank?.address1 +
														', ' +
														bloodbank?.address2}
												</TableCell>
												<TableCell>
													{bloodbank?.state}
												</TableCell>
												<TableCell>
													{bloodbank?.city}
												</TableCell>
												<TableCell>
													{bloodbank?.pinCode}
												</TableCell>
												<TableCell>
													{bloodbank?.email}
												</TableCell>
												<TableCell>
													{bloodbank?.phoneNo1},{' '}
													{bloodbank?.phoneNo2}
												</TableCell>
											</TableRow>
										</React.Fragment>
									)
								})}
							{bloodbanks?.length === 0 && (
								<TableRow>
									<TableCell colSpan={11} align='center'>
										<h2>There is no data Available</h2>
									</TableCell>
								</TableRow>
							)}
						</TableBody>
					</Table>
				</TableContainer>
			</Box>
		</>
	)
}

export default BloodbankList
