import React from 'react'
import { useNavigate } from 'react-router-dom'
import ListItemButton from '@mui/material/ListItemButton'
import ListItemIcon from '@mui/material/ListItemIcon'
import ListItemText from '@mui/material/ListItemText'
import AccountCircleIcon from '@mui/icons-material/AccountCircle'
import BloodtypeIcon from '@mui/icons-material/Bloodtype'
import InfoIcon from '@mui/icons-material/Info'
import ContactsIcon from '@mui/icons-material/Contacts'
import HomeIcon from '@mui/icons-material/Home'
import Inventory2Icon from '@mui/icons-material/Inventory2'
import UploadFileIcon from '@mui/icons-material/UploadFile'
import BiotechIcon from '@mui/icons-material/Biotech'
import SecurityIcon from '@mui/icons-material/Security'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import WarningAmberIcon from '@mui/icons-material/WarningAmber'
import ExploreIcon from '@mui/icons-material/Explore'
import HubIcon from '@mui/icons-material/Hub'
import { useDispatch, useSelector } from 'react-redux'
import { useLocation } from 'react-router-dom'
import LogoutIcon from '@mui/icons-material/Logout'
import { logout } from '../../store/loginslice'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

const MainListItems = () => {
	const dispatch = useDispatch()
	const location = useLocation()
	const navigate = useNavigate()
	const { role, isLoggedin } = useSelector((state) => state?.login)
	const url = location.pathname.split('/')

	const homeHandler = () => {
		if (role === 'USER') navigate('/user')
		else if (role === 'BLOODBANK') navigate('/bloodbank')
		else if (role === 'ADMIN') navigate('/admin')
		else if (role === 'MEDICAL_OFFICER') navigate('/medical-officer')
		else navigate('/')
	}

	const medicalOfficerDashboardHandler = () => {
		navigate('/medical-officer')
	}

	const medicalOfficerPendingHandler = () => {
		navigate('/medical-officer/pending')
	}

	const medicalOfficerVerifiedHandler = () => {
		navigate('/medical-officer/verified')
	}

	const medicalOfficerRejectedHandler = () => {
		navigate('/medical-officer/rejected')
	}

	const adminHandler = () => {
		navigate('/login/admin')
	}

	const userHandler = () => {
		navigate('/login/user')
	}

	const bloodbankHandler = () => {
		navigate('/login/bloodbank')
	}

	const staffHandler = () => {
		navigate('/login/staff')
	}

	const wantToDonateHandler = () => {
		navigate('/user/wanttodonate')
	}

	const lookingForBloodHandler = () => {
		navigate('/user/lookingfor')
	}

	const emergencyRequestHandler = () => {
		navigate('/user/emergency-request')
	}

	const emergencyDiscoveryHandler = () => {
		navigate('/user/emergency-discovery')
	}

	const emergencyMatchesHandler = () => {
		navigate('/user/emergency-matches')
	}

	const donorrequestsForBloodHandler = () => {
		navigate('/bloodbank/donorrequests')
	}

	const receiverequestsForBloodHandler = () => {
		navigate('/bloodbank/receiverequests')
	}

	const stockHandler = () => {
		navigate('/bloodbank/stock')
	}

	const inventoryHandler = () => {
		navigate('/bloodbank/inventory')
	}

	const reconciliationHandler = () => {
		navigate('/bloodbank/reconciliation')
	}

	const aboutusHandler = () => {
		if (role === 'USER') navigate('/user/aboutus')
		else if (role === 'BLOODBANK') navigate('/bloodbank/aboutus')
		else if (role === 'ADMIN') navigate('/admin/aboutus')
		else navigate('/aboutus')
	}

	const contactusHandler = () => {
		// if (role === 'USER') navigate('/user/contactus')
		// else if (role === 'BLOODBANK') navigate('/bloodbank/contactus')
		// else if (role === 'ADMIN') navigate('/admin/contactus')
		navigate('/contactus')
	}

	const bloodbankListHandler = () => {
		navigate('/admin/bloodbanks')
	}

	const bulkImportHandler = () => {
		navigate('/admin/bulk-import')
	}

	const adminHospitalsHandler = () => {
		navigate('/admin/hospitals')
	}

	const adminMedicalOfficersHandler = () => {
		navigate('/admin/medical-officers')
	}

	const logoutHandler = async () => {
		dispatch(logout())
		toast.success('Logout successfully.')
		navigate('/')
	}

	return (
		<>
			{!isLoggedin && (
				<>
					<ListItemButton
						onClick={homeHandler}
						selected={url?.length === 2 && url[1] === ''}   
					>
						<ListItemIcon>
							<HomeIcon />
						</ListItemIcon>
						<ListItemText primary='Dashboard' />
					</ListItemButton>
					<ListItemButton
						onClick={userHandler}
						selected={url[1] === 'user' && url[2] === 'login'}
					>
						<ListItemIcon>
							<AccountCircleIcon />
						</ListItemIcon>
						<ListItemText primary='User Login' />
					</ListItemButton>
					<ListItemButton
						onClick={bloodbankHandler}
						selected={url[1] === 'bloodbank' && url[2] === 'login'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Bloodbank Login' />
					</ListItemButton>

					<ListItemButton
						onClick={staffHandler}
						selected={url[1] === 'staff' && url[2] === 'login'}
					>
						<ListItemIcon>
							<LocalHospitalIcon />
						</ListItemIcon>
						<ListItemText primary='Staff Portal' />
					</ListItemButton>

					<ListItemButton
						onClick={adminHandler}
						selected={url[1] === 'admin' && url[2] === 'login'}
					>
						<ListItemIcon>
							<AccountCircleIcon />
						</ListItemIcon>
						<ListItemText primary='Admin Login' />
					</ListItemButton>

					<ListItemButton
						onClick={contactusHandler}
						selected={url[1] === 'contactus'}
					>
						<ListItemIcon>
							<ContactsIcon />
						</ListItemIcon>
						<ListItemText primary='Contact us' />
					</ListItemButton>
					<ListItemButton
						onClick={aboutusHandler}
						selected={url[1] === 'aboutus'}
					>
						<ListItemIcon>
							<InfoIcon />
						</ListItemIcon>
						<ListItemText primary='About us' />
					</ListItemButton>
				</>
			)}

			{isLoggedin && role === 'USER' && (
				<>
					<ListItemButton
						onClick={homeHandler}
						selected={url[1] === 'user' && url?.length === 2}
					>
						<ListItemIcon>
							<HomeIcon />
						</ListItemIcon>
						<ListItemText primary='Dashboard' />
					</ListItemButton>
					<ListItemButton
						onClick={wantToDonateHandler}
						selected={url[2] === 'wanttodonate'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Want to donate' />
					</ListItemButton>
					<ListItemButton
						onClick={lookingForBloodHandler}
						selected={url[2] === 'lookingfor'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Looking for blood' />
					</ListItemButton>
					<ListItemButton
						onClick={emergencyRequestHandler}
						selected={url[2] === 'emergency-request'}
						sx={{
							borderRadius: 1,
							mx: 0.5,
							'&.Mui-selected': { backgroundColor: 'rgba(211, 47, 47, 0.08)' },
							'&.Mui-selected:hover': { backgroundColor: 'rgba(211, 47, 47, 0.14)' },
						}}
					>
						<ListItemIcon sx={{ color: '#d32f2f' }}>
							<WarningAmberIcon />
						</ListItemIcon>
						<ListItemText
							primary='Emergency Request'
							primaryTypographyProps={{ sx: { fontWeight: 600, color: '#c62828' } }}
						/>
					</ListItemButton>
					<ListItemButton
						onClick={emergencyDiscoveryHandler}
						selected={url[2] === 'emergency-discovery'}
						sx={{ borderRadius: 1, mx: 0.5 }}
					>
						<ListItemIcon>
							<ExploreIcon />
						</ListItemIcon>
						<ListItemText primary='Emergency Discovery' />
					</ListItemButton>
					<ListItemButton
						onClick={emergencyMatchesHandler}
						selected={url[2] === 'emergency-matches' || url[2] === 'emergency-requests'}
						sx={{ borderRadius: 1, mx: 0.5 }}
					>
						<ListItemIcon>
							<HubIcon />
						</ListItemIcon>
						<ListItemText primary='Emergency Matching' />
					</ListItemButton>
					{/* <ListItemButton
						onClick={contactusHandler}
						selected={url[2] === 'contactus'}
					>
						<ListItemIcon>
							<ContactsIcon />
						</ListItemIcon>
						<ListItemText primary='Contact us' />
					</ListItemButton> */}
					<ListItemButton
						onClick={aboutusHandler}
						selected={url[2] === 'aboutus'}
					>
						<ListItemIcon>
							<InfoIcon />
						</ListItemIcon>
						<ListItemText primary='About us' />
					</ListItemButton>
					<ListItemButton onClick={logoutHandler}>
						<ListItemIcon>
							<LogoutIcon />
						</ListItemIcon>
						<ListItemText primary='Logout' />
					</ListItemButton>
				</>
			)}

			{isLoggedin && role === 'BLOODBANK' && (
				<>
					<ListItemButton
						onClick={homeHandler}
						selected={url[1] === 'bloodbank' && url?.length === 2}
					>
						<ListItemIcon>
							<HomeIcon />
						</ListItemIcon>
						<ListItemText primary='Home' />
					</ListItemButton>
					<ListItemButton
						onClick={donorrequestsForBloodHandler}
						selected={url[2] === 'donorrequests'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Donor requests' />
					</ListItemButton>
					<ListItemButton
						onClick={receiverequestsForBloodHandler}
						selected={url[2] === 'receiverequests'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Receive requests' />
					</ListItemButton>
					<ListItemButton
						onClick={inventoryHandler}
						selected={url[2] === 'inventory'}
					>
						<ListItemIcon>
							<BiotechIcon />
						</ListItemIcon>
						<ListItemText primary='Traceable Inventory' />
					</ListItemButton>
					<ListItemButton
						onClick={reconciliationHandler}
						selected={url[2] === 'reconciliation'}
					>
						<ListItemIcon>
							<SecurityIcon />
						</ListItemIcon>
						<ListItemText primary='Reconciliation' />
					</ListItemButton>
					<ListItemButton
						onClick={stockHandler}
						selected={url[2] === 'stock'}
					>
						<ListItemIcon>
							<Inventory2Icon />
						</ListItemIcon>
						<ListItemText primary='Legacy Stock' />
					</ListItemButton>
					{/* <ListItemButton
						onClick={contactusHandler}
						selected={url[2] === 'contactus'}
					>
						<ListItemIcon>
							<ContactsIcon />
						</ListItemIcon>
						<ListItemText primary='Contact us' />
					</ListItemButton> */}
					<ListItemButton
						onClick={aboutusHandler}
						selected={url[2] === 'aboutus'}
					>
						<ListItemIcon>
							<InfoIcon />
						</ListItemIcon>
						<ListItemText primary='About us' />
					</ListItemButton>
					<ListItemButton onClick={logoutHandler}>
						<ListItemIcon>
							<LogoutIcon />
						</ListItemIcon>
						<ListItemText primary='Logout' />
					</ListItemButton>
				</>
			)}

			{isLoggedin && role === 'ADMIN' && (
				<>
					<ListItemButton
						onClick={homeHandler}
						selected={url[1] === 'admin' && url?.length === 2}
					>
						<ListItemIcon>
							<HomeIcon />
						</ListItemIcon>
						<ListItemText primary='Dashboard' />
					</ListItemButton>
					<ListItemButton
						onClick={bloodbankListHandler}
						selected={url[1] === 'admin' && url[2] === 'bloodbanks'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Blood Banks' />
					</ListItemButton>
					<ListItemButton
						onClick={adminHospitalsHandler}
						selected={url[1] === 'admin' && url[2] === 'hospitals'}
					>
						<ListItemIcon>
							<LocalHospitalIcon />
						</ListItemIcon>
						<ListItemText primary='Hospital Registry' />
					</ListItemButton>
					<ListItemButton
						onClick={adminMedicalOfficersHandler}
						selected={url[1] === 'admin' && url[2] === 'medical-officers'}
					>
						<ListItemIcon>
							<SecurityIcon />
						</ListItemIcon>
						<ListItemText primary='Medical Officer Management' />
					</ListItemButton>
					<ListItemButton
						onClick={bulkImportHandler}
						selected={url[1] === 'admin' && url[2] === 'bulk-import'}
					>
						<ListItemIcon>
							<UploadFileIcon />
						</ListItemIcon>
						<ListItemText primary='Bulk Import' />
					</ListItemButton>
					<ListItemButton
						onClick={aboutusHandler}
						selected={url[2] === 'aboutus'}
					>
						<ListItemIcon>
							<InfoIcon />
						</ListItemIcon>
						<ListItemText primary='About us' />
					</ListItemButton>
					<ListItemButton onClick={logoutHandler}>
						<ListItemIcon>
							<LogoutIcon />
						</ListItemIcon>
						<ListItemText primary='Logout' />
					</ListItemButton>
				</>
			)}

			{isLoggedin && role === 'MEDICAL_OFFICER' && (
				<>
					<ListItemButton
						onClick={medicalOfficerDashboardHandler}
						selected={url[1] === 'medical-officer' && (url.length === 2 || url[2] === '')}
					>
						<ListItemIcon>
							<HomeIcon />
						</ListItemIcon>
						<ListItemText primary='MO Dashboard' />
					</ListItemButton>
					<ListItemButton
						onClick={medicalOfficerPendingHandler}
						selected={url[1] === 'medical-officer' && url[2] === 'pending'}
					>
						<ListItemIcon>
							<WarningAmberIcon />
						</ListItemIcon>
						<ListItemText primary='Pending Requests' />
					</ListItemButton>
					<ListItemButton
						onClick={medicalOfficerVerifiedHandler}
						selected={url[1] === 'medical-officer' && url[2] === 'verified'}
					>
						<ListItemIcon>
							<LocalHospitalIcon />
						</ListItemIcon>
						<ListItemText primary='Verified Requests' />
					</ListItemButton>
					<ListItemButton
						onClick={medicalOfficerRejectedHandler}
						selected={url[1] === 'medical-officer' && url[2] === 'rejected'}
					>
						<ListItemIcon>
							<BloodtypeIcon />
						</ListItemIcon>
						<ListItemText primary='Rejected Requests' />
					</ListItemButton>
					<ListItemButton onClick={logoutHandler}>
						<ListItemIcon>
							<LogoutIcon />
						</ListItemIcon>
						<ListItemText primary='Logout' />
					</ListItemButton>
				</>
			)}
		</>
	)
}

export default MainListItems
