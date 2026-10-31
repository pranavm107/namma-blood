/**
 * Immunohematology Blood Component Compatibility Engine
 * Namma Blood — Emergency Blood Connection (Milestone 4.2)
 *
 * ==============================================================================
 * CLINICAL GOVERNANCE & STATUTORY CITATIONS:
 * ==============================================================================
 * 1. National Blood Transfusion Council (NBTC) & National AIDS Control Organisation (NACO),
 *    Ministry of Health and Family Welfare, Government of India:
 *    - "Standards for Blood Banks & Blood Transfusion Services" (2007 Edition).
 *    - Section G: "Compatibility Testing and Selection of Blood and Blood Components":
 *        • Section G-1.0: "Compatibility Testing" (p. 38)
 *        • Section G-1.1: "Whole Blood" — Whole blood must strictly be ABO and Rh(D) identical (p. 38)
 *        • Section G-1.2: "Red Blood Cells" — Must be ABO and Rh(D) compatible with recipient serum (p. 38)
 *        • Section G-2.0 & G-2.1: "Fresh Frozen Plasma" — Donor plasma must be ABO compatible with recipient red cells (p. 39)
 *        • Section G-3.0, G-3.1 & G-3.2: "Platelet Concentrate" — ABO identical preferred; Rh-negative females of
 *          childbearing potential (< 50 yrs) should receive Rh-negative platelets or anti-D prophylaxis (pp. 39–40)
 *        • Section G-4.0 & G-4.1: "Cryoprecipitate" — Preferably ABO-compatible, especially in neonates and infants (p. 40)
 *    - Official Publication / Ministry Reference:
 *        https://naco.gov.in/guidelines-standards
 *        https://mohfw.gov.in/
 *
 * 2. Directorate General of Health Services (DGHS), Ministry of Health and Family Welfare, Govt. of India:
 *    - "Technical Manual on Blood Transfusion Services" (2003 / 2007).
 *    - Chapters 8 & 9: Component therapy, immunohematology crossmatching, and anti-D prophylaxis protocols.
 *
 * 3. The Drugs and Cosmetics Act, 1940 and Drugs and Cosmetics Rules, 1945:
 *    - Part XII-B and Schedule F, Part XII-B: "Requirements for the Collection, Storage,
 *      Processing and Distribution of Blood and its Components by Blood Banks".
 *    - Central Drugs Standard Control Organisation (CDSCO), Ministry of Health and Family Welfare:
 *      https://cdsco.gov.in/
 *
 * ==============================================================================
 * CLINICAL SAFETY BOUNDARIES & GOVERNANCE RESTRICTIONS:
 * ==============================================================================
 * - PRESUMPTIVE ASSESSMENT ONLY: This engine provides a preliminary immunohematological selection
 *   to identify potential compatible inventory groups. It is strictly marked as a DEVELOPMENT /
 *   PRESUMPTIVE tool and is NOT an authoritative clinical decision.
 * - CANNOT AUTHORIZE DISPATCH: This engine CANNOT independently authorize blood reservation,
 *   issuance, or dispatch.
 * - LABORATORY CROSSMATCH MANDATORY: Under NBTC Section G-1.0 and DGHS standards, a serological /
 *   laboratory pre-transfusion crossmatch remains strictly mandatory prior to physical blood unit issuance.
 * - MEDICAL OFFICER AUTHORIZATION: Any non-identical allocation (e.g. alternative platelet units,
 *   non-identical cryoprecipitate, or Rh-mismatched platelets) strictly requires formal institutional
 *   Medical Officer review and written approval.
 * - EMERGENCY UNCROSSMATCHED BLOOD: Emergency uncrossmatched transfusion (e.g., O-Negative PRBCs
 *   issued in extremis) is an exceptional clinical protocol requiring verified Medical Officer
 *   emergency authorization under Phase 3 protocols; it is NEVER an ordinary compatibility default.
 */

const {
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
	MANDATORY_TTI_TESTS,
} = require('../BloodUnit/bloodUnitModel')

const COMPATIBILITY_SPEC_VERSION = '1.0.0-NBTC-DGHS'
const CLINICAL_AUTHORITY =
	'National Blood Transfusion Council (NBTC) & DGHS, Ministry of Health and Family Welfare, Govt. of India'

/**
 * Standard ABO Blood Group Dissection
 */
const BLOOD_GROUP_PARSER = {
	A_Positive: { abo: 'A', rh: 'Positive', formatted: 'A+' },
	A_Negative: { abo: 'A', rh: 'Negative', formatted: 'A-' },
	B_Positive: { abo: 'B', rh: 'Positive', formatted: 'B+' },
	B_Negative: { abo: 'B', rh: 'Negative', formatted: 'B-' },
	AB_Positive: { abo: 'AB', rh: 'Positive', formatted: 'AB+' },
	AB_Negative: { abo: 'AB', rh: 'Negative', formatted: 'AB-' },
	O_Positive: { abo: 'O', rh: 'Positive', formatted: 'O+' },
	O_Negative: { abo: 'O', rh: 'Negative', formatted: 'O-' },
}

/**
 * Packed Red Blood Cells (PRBCs) Compatibility Matrix
 *
 * Transfusion Immunology Principle (NBTC Standards Sec. G-1.2, p. 38):
 * Donor red cells must lack the ABO antigens against which the recipient possesses
 * naturally occurring reciprocal antibodies (anti-A, anti-B).
 * Rh(D)-Negative patients must receive Rh(D)-Negative red cells to prevent anti-D alloimmunization.
 */
const PRBC_COMPATIBILITY_RULES = {
	O_Negative: {
		preferred: 'O_Negative',
		compatible: ['O_Negative'],
		rationale:
			'Recipient serum contains both anti-A and anti-B antibodies; patient lacks Rh(D) antigen. Only O-Negative donor red cells are immunologically compatible (NBTC Sec. G-1.2).',
	},
	O_Positive: {
		preferred: 'O_Positive',
		compatible: ['O_Positive', 'O_Negative'],
		rationale:
			'Recipient serum contains anti-A and anti-B antibodies; patient possesses Rh(D) antigen. O-Positive is identical; O-Negative is compatible alternative (NBTC Sec. G-1.2).',
	},
	A_Negative: {
		preferred: 'A_Negative',
		compatible: ['A_Negative', 'O_Negative'],
		rationale:
			'Recipient serum contains anti-B antibodies; patient lacks Rh(D). A-Negative is identical; O-Negative red cells lack A, B, and D antigens (NBTC Sec. G-1.2).',
	},
	A_Positive: {
		preferred: 'A_Positive',
		compatible: ['A_Positive', 'A_Negative', 'O_Positive', 'O_Negative'],
		rationale:
			'Recipient serum contains anti-B antibodies; patient is Rh(D) positive. A-Positive is identical; A-Negative, O-Positive, and O-Negative are compatible alternatives (NBTC Sec. G-1.2).',
	},
	B_Negative: {
		preferred: 'B_Negative',
		compatible: ['B_Negative', 'O_Negative'],
		rationale:
			'Recipient serum contains anti-A antibodies; patient lacks Rh(D). B-Negative is identical; O-Negative is compatible alternative (NBTC Sec. G-1.2).',
	},
	B_Positive: {
		preferred: 'B_Positive',
		compatible: ['B_Positive', 'B_Negative', 'O_Positive', 'O_Negative'],
		rationale:
			'Recipient serum contains anti-A antibodies; patient is Rh(D) positive. B-Positive is identical; B-Negative, O-Positive, and O-Negative are compatible alternatives (NBTC Sec. G-1.2).',
	},
	AB_Negative: {
		preferred: 'AB_Negative',
		compatible: ['AB_Negative', 'A_Negative', 'B_Negative', 'O_Negative'],
		rationale:
			'Recipient serum contains neither anti-A nor anti-B; patient lacks Rh(D). AB-Negative is identical; all Rh-Negative donor red cells are compatible (NBTC Sec. G-1.2).',
	},
	AB_Positive: {
		preferred: 'AB_Positive',
		compatible: [
			'AB_Positive',
			'AB_Negative',
			'A_Positive',
			'A_Negative',
			'B_Positive',
			'B_Negative',
			'O_Positive',
			'O_Negative',
		],
		rationale:
			'Universal Red Cell Recipient: Recipient serum has no anti-A or anti-B antibodies; patient is Rh(D) positive. All 8 blood groups are compatible for PRBCs (NBTC Sec. G-1.2).',
	},
}

/**
 * Whole Blood Compatibility Matrix
 *
 * Transfusion Immunology Principle (NBTC Standards Sec. G-1.1, p. 38):
 * Whole blood contains both donor red cells and plasma antibodies.
 * Therefore, Whole Blood MUST strictly be ABO and Rh(D) identical to recipient blood.
 * Alternate blood groups are NOT clinically permitted for whole blood transfusion.
 */
const WHOLE_BLOOD_COMPATIBILITY_RULES = {
	O_Negative: {
		preferred: 'O_Negative',
		compatible: ['O_Negative'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group to avoid donor plasma and red cell incompatibility (NBTC Sec. G-1.1).',
	},
	O_Positive: {
		preferred: 'O_Positive',
		compatible: ['O_Positive'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	A_Negative: {
		preferred: 'A_Negative',
		compatible: ['A_Negative'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	A_Positive: {
		preferred: 'A_Positive',
		compatible: ['A_Positive'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	B_Negative: {
		preferred: 'B_Negative',
		compatible: ['B_Negative'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	B_Positive: {
		preferred: 'B_Positive',
		compatible: ['B_Positive'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	AB_Negative: {
		preferred: 'AB_Negative',
		compatible: ['AB_Negative'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
	AB_Positive: {
		preferred: 'AB_Positive',
		compatible: ['AB_Positive'],
		rationale:
			'Whole Blood requires strictly identical ABO and Rh(D) group (NBTC Sec. G-1.1).',
	},
}

/**
 * Fresh Frozen Plasma (FFP) Compatibility Matrix
 *
 * Transfusion Immunology Principle (NBTC Standards Sec. G-2.1, p. 39):
 * Donor plasma contains antibodies that can lyse recipient red cells.
 * Donor plasma must NOT contain antibodies directed against recipient red cells.
 * (This is the INVERSE of the red cell compatibility matrix).
 * Rh(D) matching is not clinically required for FFP because plasma is acellular (no intact RBCs).
 */
const FFP_COMPATIBILITY_RULES = {
	AB_Positive: {
		preferred: 'AB_Positive',
		compatible: ['AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient has both A and B antigens on red cells; donor plasma must have neither anti-A nor anti-B. Only AB plasma is compatible (NBTC Sec. G-2.1).',
	},
	AB_Negative: {
		preferred: 'AB_Negative',
		compatible: ['AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient has A and B red cell antigens. Donor plasma must have neither anti-A nor anti-B (AB plasma). Rh factor is acellular in plasma (NBTC Sec. G-2.1).',
	},
	A_Positive: {
		preferred: 'A_Positive',
		compatible: ['A_Positive', 'A_Negative', 'AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient red cells possess A antigen. Donor plasma must not contain anti-A antibodies. Group A and AB plasma are compatible (NBTC Sec. G-2.1).',
	},
	A_Negative: {
		preferred: 'A_Negative',
		compatible: ['A_Positive', 'A_Negative', 'AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient red cells possess A antigen. Group A and AB plasma are compatible (NBTC Sec. G-2.1).',
	},
	B_Positive: {
		preferred: 'B_Positive',
		compatible: ['B_Positive', 'B_Negative', 'AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient red cells possess B antigen. Donor plasma must not contain anti-B antibodies. Group B and AB plasma are compatible (NBTC Sec. G-2.1).',
	},
	B_Negative: {
		preferred: 'B_Negative',
		compatible: ['B_Positive', 'B_Negative', 'AB_Positive', 'AB_Negative'],
		rationale:
			'Recipient red cells possess B antigen. Group B and AB plasma are compatible (NBTC Sec. G-2.1).',
	},
	O_Positive: {
		preferred: 'O_Positive',
		compatible: [
			'O_Positive',
			'O_Negative',
			'A_Positive',
			'A_Negative',
			'B_Positive',
			'B_Negative',
			'AB_Positive',
			'AB_Negative',
		],
		rationale:
			'Universal Plasma Recipient: Recipient red cells lack A and B antigens. Donor plasma cannot cause ABO-mediated red cell hemolysis. All plasma groups are compatible (NBTC Sec. G-2.1).',
	},
	O_Negative: {
		preferred: 'O_Negative',
		compatible: [
			'O_Positive',
			'O_Negative',
			'A_Positive',
			'A_Negative',
			'B_Positive',
			'B_Negative',
			'AB_Positive',
			'AB_Negative',
		],
		rationale:
			'Universal Plasma Recipient: Recipient red cells lack A and B antigens. All plasma groups are compatible (NBTC Sec. G-2.1).',
	},
}

/**
 * Platelet Concentrate Compatibility Rules
 *
 * Transfusion Immunology Principle (NBTC Standards Sec. G-3.1 & G-3.2, pp. 39–40; DGHS Technical Manual):
 * - Platelets express ABO antigens on their membrane and are suspended in donor plasma (~50 mL per RDP, ~200-300 mL per SDP).
 * - ABO-identical transfusion is strongly preferred to optimize post-transfusion platelet recovery and avoid isohemagglutinin-mediated hemolysis.
 * - Platelets DO NOT express Rh(D) antigens, but platelet units contain residual red blood cells (up to 0.5 mL in RDP pools).
 * - Transfusion of Rh(D)-positive platelets to an Rh-negative recipient (especially females of childbearing potential, age < 50)
 *   carries substantial risk of anti-D alloimmunization.
 * - When Rh-positive platelets are transfused to an Rh-negative female of childbearing age, anti-D immunoglobulin
 *   prophylaxis is strongly recommended (NBTC Sec. G-3.2).
 * - Out-of-group platelet transfusions (e.g. Group O platelets with high-titer anti-A to Group A recipient) require
 *   Medical Officer authorization and consideration of donor antibody titer or volume reduction.
 */
function getPlateletCompatibility(recipientGroup) {
	const info = BLOOD_GROUP_PARSER[recipientGroup]
	if (!info) return null

	const preferred = recipientGroup
	const isRhNegative = info.rh === 'Negative'

	// Clinically accepted platelet donor groups by ABO recipient:
	// Identical group is primary.
	// Plasma-compatible groups (lacking antibodies against recipient RBCs) are secondary.
	// Out-of-group alternatives with anti-A/anti-B require MO approval.
	let compatible = []

	if (info.abo === 'O') {
		// O recipient red cells lack A/B antigens. Plasma from A, B, AB does not hemolyze O red cells.
		compatible = isRhNegative
			? ['O_Negative', 'O_Positive', 'A_Negative', 'B_Negative', 'AB_Negative', 'A_Positive', 'B_Positive', 'AB_Positive']
			: ['O_Positive', 'O_Negative', 'A_Positive', 'B_Positive', 'AB_Positive', 'A_Negative', 'B_Negative', 'AB_Negative']
	} else if (info.abo === 'A') {
		// A recipient has A antigen. AB plasma has no antibodies. Group B and O plasma contain anti-A.
		compatible = isRhNegative
			? ['A_Negative', 'A_Positive', 'AB_Negative', 'AB_Positive', 'O_Negative', 'B_Negative', 'O_Positive', 'B_Positive']
			: ['A_Positive', 'A_Negative', 'AB_Positive', 'AB_Negative', 'O_Positive', 'B_Positive', 'O_Negative', 'B_Negative']
	} else if (info.abo === 'B') {
		// B recipient has B antigen. AB plasma has no antibodies. Group A and O plasma contain anti-B.
		compatible = isRhNegative
			? ['B_Negative', 'B_Positive', 'AB_Negative', 'AB_Positive', 'O_Negative', 'A_Negative', 'O_Positive', 'A_Positive']
			: ['B_Positive', 'B_Negative', 'AB_Positive', 'AB_Negative', 'O_Positive', 'A_Positive', 'O_Negative', 'A_Negative']
	} else if (info.abo === 'AB') {
		// AB recipient red cells have A & B antigens. Only AB plasma has neither.
		compatible = isRhNegative
			? ['AB_Negative', 'AB_Positive', 'A_Negative', 'B_Negative', 'O_Negative', 'A_Positive', 'B_Positive', 'O_Positive']
			: ['AB_Positive', 'AB_Negative', 'A_Positive', 'B_Positive', 'O_Positive', 'A_Negative', 'B_Negative', 'O_Negative']
	}

	return {
		preferred,
		compatible,
		rationale:
			'Platelets: ABO-identical is clinically preferred for optimal platelet count increment. Out-of-group platelets contain donor plasma isohemagglutinins and require Medical Officer sign-off. Platelet units contain trace RBCs; Rh-positive platelets transfused to Rh-negative recipients carry anti-D alloimmunization risk (NBTC Sec. G-3.1, G-3.2).',
		requiresMedicalOfficerApprovalForAlternatives: true,
	}
}

/**
 * Cryoprecipitate Compatibility Rules
 *
 * CLINICAL NUANCE & EVIDENCE HIERARCHY (NBTC Standards Sec. G-4.1, p. 40):
 * - Published National Guideline Recommendation:
 *   NBTC Section G-4.1 states: "Cryoprecipitated Antihaemophilic Factor should preferably be
 *   ABO compatible with recipient's red blood cells, especially when transfused to neonates and infants."
 *   The national guideline specifies a clinical preference ("should preferably be"), not an explicit
 *   statutory or mandatory requirement.
 * - Stricter Institutional Safety Policy:
 *   Because neonates and infants possess small blood volumes, many hospital transfusion committees
 *   adopt a stricter local safety policy requiring ABO compatibility for pediatric transfusions.
 * - Unresolved Adult vs. Paediatric Decisions:
 *   In adult emergency resuscitation (e.g. massive trauma or obstetric hemorrhage), out-of-group
 *   cryoprecipitate is widely utilized for urgent fibrinogen replenishment without isohemagglutinin titer checks,
 *   as each unit contributes only ~10-15 mL of plasma.
 * - Medical Officer Approval Requirement & Conservative Safeguards:
 *   Because the national guideline establishes a recommendation rather than an automated dispensing matrix,
 *   the engine designates ABO-identical as preferred and strictly enforces that ANY non-identical
 *   cryoprecipitate allocation requires Medical Officer evaluation (requiresMedicalOfficerApproval: true)
 *   and cannot be treated as an authoritative automated clinical decision.
 */
function getCryoprecipitateCompatibility(recipientGroup) {
	const info = BLOOD_GROUP_PARSER[recipientGroup]
	if (!info) return null

	const preferred = recipientGroup

	// For Cryoprecipitate, identical is preferred.
	// Plasma ABO compatible groups are listed as secondary alternatives, but ALL non-identical
	// allocations are flagged as requiring Medical Officer evaluation.
	let compatible = []

	if (info.abo === 'O') {
		compatible = [
			'O_Positive',
			'O_Negative',
			'A_Positive',
			'A_Negative',
			'B_Positive',
			'B_Negative',
			'AB_Positive',
			'AB_Negative',
		]
	} else if (info.abo === 'A') {
		compatible = [
			'A_Positive',
			'A_Negative',
			'AB_Positive',
			'AB_Negative',
			'O_Positive',
			'O_Negative',
			'B_Positive',
			'B_Negative',
		]
	} else if (info.abo === 'B') {
		compatible = [
			'B_Positive',
			'B_Negative',
			'AB_Positive',
			'AB_Negative',
			'O_Positive',
			'O_Negative',
			'A_Positive',
			'A_Negative',
		]
	} else if (info.abo === 'AB') {
		compatible = [
			'AB_Positive',
			'AB_Negative',
			'A_Positive',
			'A_Negative',
			'B_Positive',
			'B_Negative',
			'O_Positive',
			'O_Negative',
		]
	}

	return {
		preferred,
		compatible,
		rationale:
			'Cryoprecipitate: Prepared from plasma but contains low volume (~10-15 mL/unit). ABO-identical is clinically preferred. Non-identical Cryoprecipitate requires Medical Officer approval per NBTC Sec. G-4.1 recommendation to evaluate pediatric vulnerability and isohemagglutinin load.',
		requiresMedicalOfficerApprovalForAlternatives: true,
		unresolvedInstitutionalDecision:
			'Institutional transfusion committee policy must establish whether ABO-incompatible cryoprecipitate is acceptable in adult massive transfusion without isohemagglutinin titer checks, and whether a stricter ABO-compatibility mandate applies to pediatric recipients (NBTC Sec. G-4.1 recommendation).',
	}
}

/**
 * Parses and validates an input blood group string against authorized enum definitions.
 *
 * @param {string} bloodGroupStr
 * @returns {Object} { abo: string, rh: string, formatted: string, raw: string }
 */
function parseBloodGroup(bloodGroupStr) {
	if (!bloodGroupStr || typeof bloodGroupStr !== 'string') {
		const err = new Error('Blood group is missing or not a valid string.')
		err.code = 'INVALID_BLOOD_GROUP'
		err.statusCode = 400
		throw err
	}

	const trimmed = bloodGroupStr.trim()
	const parsed = BLOOD_GROUP_PARSER[trimmed]

	if (!parsed) {
		const err = new Error(
			`Invalid blood group '${trimmed}'. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}`
		)
		err.code = 'UNRECOGNIZED_BLOOD_GROUP'
		err.statusCode = 400
		throw err
	}

	return {
		...parsed,
		raw: trimmed,
	}
}

/**
 * Retrieves the clinically compatible donor blood groups for a specified recipient group and component.
 *
 * @param {Object} params
 * @param {string} params.recipientGroup - Authorized blood group of recipient
 * @param {string} params.componentType - Supported component type
 * @returns {Object} Structured compatibility descriptor
 */
function getCompatibleDonorGroups({ recipientGroup, componentType = 'Packed_Red_Blood_Cells' }) {
	const parsedGroup = parseBloodGroup(recipientGroup)

	if (!VALID_COMPONENT_TYPES.includes(componentType)) {
		const err = new Error(
			`Unsupported component type '${componentType}'. Supported components: ${VALID_COMPONENT_TYPES.join(', ')}`
		)
		err.code = 'UNSUPPORTED_COMPONENT_TYPE'
		err.statusCode = 400
		throw err
	}

	let ruleData = null

	switch (componentType) {
		case 'Packed_Red_Blood_Cells':
			ruleData = PRBC_COMPATIBILITY_RULES[parsedGroup.raw]
			break
		case 'Whole_Blood':
			ruleData = WHOLE_BLOOD_COMPATIBILITY_RULES[parsedGroup.raw]
			break
		case 'Fresh_Frozen_Plasma':
			ruleData = FFP_COMPATIBILITY_RULES[parsedGroup.raw]
			break
		case 'Platelet_Concentrate':
			ruleData = getPlateletCompatibility(parsedGroup.raw)
			break
		case 'Cryoprecipitate':
			ruleData = getCryoprecipitateCompatibility(parsedGroup.raw)
			break
		default:
			break
	}

	if (!ruleData) {
		const err = new Error(
			`Clinical compatibility rules are undefined for component '${componentType}' and group '${recipientGroup}'.`
		)
		err.code = 'COMPATIBILITY_RULE_UNDEFINED'
		err.statusCode = 500
		throw err
	}

	const compatibleGroups = ruleData.compatible
	const preferredGroup = ruleData.preferred
	const alternateGroups = compatibleGroups.filter((g) => g !== preferredGroup)

	return {
		recipientGroup: parsedGroup.raw,
		recipientFormatted: parsedGroup.formatted,
		componentType,
		preferredGroup,
		compatibleGroups,
		alternateGroups,
		clinicalRationale: ruleData.rationale,
		unresolvedInstitutionalDecision: ruleData.unresolvedInstitutionalDecision || null,
		governance: {
			ruleVersion: COMPATIBILITY_SPEC_VERSION,
			clinicalAuthority: CLINICAL_AUTHORITY,
			requiresLaboratoryCrossmatch: true,
			isAuthoritativeClinicalDecision: false,
			isPresumptiveImmunohematologyCheck: true,
			cannotAuthorizeDispatch: true,
			requiresMedicalOfficerApprovalForAlternatives: Boolean(
				ruleData.requiresMedicalOfficerApprovalForAlternatives
			),
			disclaimer:
				'ABO/Rh selection identifies eligible blood groups in principle. A serological crossmatch and Medical Officer authorization are mandatory prior to blood issuance.',
		},
	}
}

/**
 * Evaluates immunological compatibility between a specific recipient and donor blood group.
 *
 * @param {Object} params
 * @param {string} params.recipientGroup - Recipient blood group
 * @param {string} params.donorGroup - Donor blood group
 * @param {string} params.componentType - Supported component type
 * @returns {Object} Comprehensive explainable compatibility evaluation
 */
function evaluateCompatibility({
	recipientGroup,
	donorGroup,
	componentType = 'Packed_Red_Blood_Cells',
}) {
	const parsedRecipient = parseBloodGroup(recipientGroup)
	const parsedDonor = parseBloodGroup(donorGroup)

	const compatRules = getCompatibleDonorGroups({
		recipientGroup: parsedRecipient.raw,
		componentType,
	})

	const isCompatible = compatRules.compatibleGroups.includes(parsedDonor.raw)
	const isIdentical = parsedRecipient.raw === parsedDonor.raw

	let matchQuality = 'Incompatible'
	if (isIdentical) {
		matchQuality = 'Identical'
	} else if (isCompatible) {
		matchQuality = 'Compatible_Alternative'
	}

	// Rh-mismatch risk assessment
	const isRhNegativeRecipient = parsedRecipient.rh === 'Negative'
	const isRhPositiveDonor = parsedDonor.rh === 'Positive'
	const hasRhMismatch = isRhNegativeRecipient && isRhPositiveDonor

	let rhRiskDescription = 'Rh(D) antigens are concordant or safe.'
	let rhImmuneGlobulinRecommended = false

	if (hasRhMismatch) {
		if (componentType === 'Packed_Red_Blood_Cells' || componentType === 'Whole_Blood') {
			rhRiskDescription =
				'SEVERE RISK: Transfusing Rh(D)-positive red cells into an Rh(D)-negative recipient causes anti-D alloimmunization and potential hemolytic transfusion reaction (NBTC Sec. G-1.2).'
		} else if (componentType === 'Platelet_Concentrate') {
			rhRiskDescription =
				'HIGH CAUTION: Platelet concentrates contain residual red blood cells. Transfusing Rh-positive platelets to an Rh-negative recipient (especially females of childbearing potential < 50 yrs) carries anti-D alloimmunization risk. Rh immune globulin (anti-D prophylaxis) is strongly recommended (NBTC Sec. G-3.2).'
			rhImmuneGlobulinRecommended = true
		} else if (componentType === 'Fresh_Frozen_Plasma' || componentType === 'Cryoprecipitate') {
			rhRiskDescription =
				'ACCEPTABLE: Plasma and cryoprecipitate are acellular and contain no intact RBCs; Rh(D) mismatch does not cause anti-D immunization (NBTC Sec. G-2.1, G-4.1).'
		}
	}

	// Clinical approval requirements
	let requiresMedicalOfficerApproval = false
	let approvalRationale = null

	if (componentType === 'Cryoprecipitate' && !isIdentical) {
		requiresMedicalOfficerApproval = true
		approvalRationale =
			'Transfusing non-identical Cryoprecipitate requires institutional Medical Officer approval to evaluate pediatric risk and isohemagglutinin load (NBTC Sec. G-4.1 recommendation).'
	} else if (componentType === 'Platelet_Concentrate') {
		if (hasRhMismatch) {
			requiresMedicalOfficerApproval = true
			approvalRationale =
				'Transfusing Rh-positive platelets to an Rh-negative recipient requires Medical Officer approval and anti-D prophylaxis evaluation (NBTC Sec. G-3.2).'
		} else if (!isIdentical) {
			requiresMedicalOfficerApproval = true
			approvalRationale =
				'Out-of-group platelet transfusion contains donor plasma antibodies and requires Medical Officer sign-off (NBTC Sec. G-3.1).'
		}
	}

	let clinicalExplanation = ''
	if (matchQuality === 'Identical') {
		clinicalExplanation = `Donor group (${parsedDonor.formatted}) is exact identical match to recipient group (${parsedRecipient.formatted}) for ${componentType}.`
	} else if (matchQuality === 'Compatible_Alternative') {
		clinicalExplanation = `Donor group (${parsedDonor.formatted}) is a recognized compatible alternative for recipient (${parsedRecipient.formatted}) for ${componentType}. ${compatRules.clinicalRationale}`
	} else {
		clinicalExplanation = `INCOMPATIBLE: Donor group (${parsedDonor.formatted}) is clinically contraindicated for recipient group (${parsedRecipient.formatted}) for ${componentType}. Incompatible blood causes acute hemolytic transfusion reactions.`
	}

	return {
		isCompatible,
		matchQuality,
		recipientGroup: parsedRecipient.raw,
		recipientFormatted: parsedRecipient.formatted,
		donorGroup: parsedDonor.raw,
		donorFormatted: parsedDonor.formatted,
		componentType,
		clinicalExplanation,
		requiresMedicalOfficerApproval,
		rhRiskAssessment: {
			hasRhMismatch,
			riskDescription: rhRiskDescription,
			rhImmuneGlobulinRecommended,
			clinicalAdvisory:
				'CLINICAL ADVISORY ONLY: Not an automated treatment instruction or prescription order. Transfusion medicine specialist or attending physician must clinically evaluate recipient (gender, childbearing potential, prior sensitization) and determine indication for anti-D immunoglobulin per institutional protocol.',
		},
		governance: {
			ruleVersion: COMPATIBILITY_SPEC_VERSION,
			clinicalAuthority: CLINICAL_AUTHORITY,
			requiresLaboratoryCrossmatch: true,
			isPresumptiveImmunohematologyCheck: true,
			isAuthoritativeClinicalDecision: false,
			cannotAuthorizeDispatch: true,
			cannotIssuePrescriptionOrOrder: true,
			requiresMedicalOfficerApproval,
			approvalRationale,
			clinicalGovernance: requiresMedicalOfficerApproval
				? 'Pending_Medical_Officer_Approval'
				: 'Presumptive_Check_Completed',
		},
	}
}

/**
 * Validates whether a specific traceable BloodUnit document from inventory
 * satisfies both immunological compatibility and all Phase 3 clinical safety invariants.
 *
 * PHASE 3 CLINICAL SAFEGUARD GATES:
 * 1. Immunological ABO/Rh compatibility for component.
 * 2. status === 'Available' (non-quarantined, non-discarded).
 * 3. clearance.isVerified === true (authorized Medical Officer quality sign-off).
 * 4. expiryDate > now (non-expired shelf life).
 * 5. All 5 mandatory TTI screening tests === 'Non_Reactive' (hiv, hbv, hcv, syphilis, malaria).
 * 6. reservation.receiveRequestId === null (unreserved; not held by another patient).
 *
 * FAIL-SAFE GUARANTEES:
 * - Missing or malformed unit fields (null bloodGroup, invalid componentType, missing clearance,
 *   missing testing, invalid expiry) fail closed safely without crashing and are recorded in failedSafetyGates.
 *
 * @param {Object} params
 * @param {string} params.recipientGroup - Recipient blood group
 * @param {Object} params.bloodUnit - Traceable BloodUnit document (Phase 3 model)
 * @param {string} [params.componentType] - Optional override, defaults to unit's componentType
 * @param {Date} [params.now] - Current timestamp for expiry checks
 * @returns {Object} Comprehensive unit validation report
 */
function validateUnitCompatibility({
	recipientGroup,
	bloodUnit,
	componentType = null,
	now = new Date(),
}) {
	if (!bloodUnit || typeof bloodUnit !== 'object') {
		const err = new Error('BloodUnit object is required for unit compatibility validation.')
		err.code = 'INVALID_BLOOD_UNIT'
		err.statusCode = 400
		throw err
	}

	// 1. Safely parse recipient blood group
	let parsedRecipient = null
	try {
		parsedRecipient = parseBloodGroup(recipientGroup)
	} catch (err) {
		const parseErr = new Error(`Recipient blood group is invalid or missing: ${err.message}`)
		parseErr.code = err.code || 'INVALID_BLOOD_GROUP'
		parseErr.statusCode = 400
		throw parseErr
	}

	const failedSafetyGates = []
	const unitComponent = componentType || bloodUnit.componentType || 'Packed_Red_Blood_Cells'
	const unitGroup = bloodUnit.bloodGroup

	// 2. Validate unit blood group safely
	let parsedDonor = null
	let isUnitGroupValid = false

	if (!unitGroup || typeof unitGroup !== 'string' || !VALID_BLOOD_GROUPS.includes(unitGroup.trim())) {
		failedSafetyGates.push(
			`Blood unit possesses an invalid or unrecognized blood group: '${unitGroup}'.`
		)
	} else {
		try {
			parsedDonor = parseBloodGroup(unitGroup)
			isUnitGroupValid = true
		} catch {
			failedSafetyGates.push(
				`Blood unit blood group '${unitGroup}' could not be parsed.`
			)
		}
	}

	// 3. Validate component type safely
	const isComponentSupported = VALID_COMPONENT_TYPES.includes(unitComponent)
	if (!isComponentSupported) {
		failedSafetyGates.push(
			`Blood unit possesses an unsupported component type: '${unitComponent}'.`
		)
	}

	// 4. Evaluate immunological compatibility if blood group and component are valid
	let compatResult = null
	let isImmunoCompatible = false
	let matchQuality = 'Incompatible'

	if (isUnitGroupValid && isComponentSupported) {
		compatResult = evaluateCompatibility({
			recipientGroup: parsedRecipient.raw,
			donorGroup: parsedDonor.raw,
			componentType: unitComponent,
		})
		isImmunoCompatible = compatResult.isCompatible
		matchQuality = compatResult.matchQuality

		if (!isImmunoCompatible) {
			failedSafetyGates.push(
				`Immunologically incompatible: donor group '${parsedDonor.formatted}' is contraindicated for recipient '${parsedRecipient.formatted}' for ${unitComponent}.`
			)
		}
	} else {
		isImmunoCompatible = false
		matchQuality = 'Incompatible'
	}

	// 5. Clinical Status Gate
	if (!bloodUnit.status || bloodUnit.status !== 'Available') {
		failedSafetyGates.push(
			`Unit status is '${bloodUnit.status || 'missing'}'. Only 'Available' inventory is issue-eligible.`
		)
	}

	// 6. Medical Officer Quality Clearance Gate
	if (!bloodUnit.clearance || bloodUnit.clearance.isVerified !== true) {
		failedSafetyGates.push(
			'Medical Officer quality verification is missing. Unit lacks explicit clinical sign-off.'
		)
	}

	// 7. Clinical Shelf-Life Expiry Gate
	const parsedExpiry = bloodUnit.expiryDate ? new Date(bloodUnit.expiryDate) : null
	const isExpiryValid = parsedExpiry && !isNaN(parsedExpiry.getTime())

	if (!isExpiryValid || parsedExpiry <= now) {
		const expiryDisplay = isExpiryValid
			? parsedExpiry.toISOString()
			: (bloodUnit.expiryDate ? String(bloodUnit.expiryDate) : 'missing')
		failedSafetyGates.push(
			`Unit is expired or expiry date is invalid (Expiry date: ${expiryDisplay}).`
		)
	}

	// 8. 5-Panel TTI Screening Gate
	if (!bloodUnit.testing || typeof bloodUnit.testing !== 'object') {
		failedSafetyGates.push('TTI infectious screening panel is missing on unit.')
	} else {
		for (const test of MANDATORY_TTI_TESTS) {
			const result = bloodUnit.testing[test]
			if (result !== 'Non_Reactive') {
				failedSafetyGates.push(
					`Mandatory screening test '${test}' is '${result || 'missing'}'. Must be 'Non_Reactive'.`
				)
			}
		}
	}

	// 9. Reservation Lock Gate
	if (
		bloodUnit.reservation &&
		bloodUnit.reservation.receiveRequestId &&
		bloodUnit.reservation.reservedExpiresAt &&
		!isNaN(new Date(bloodUnit.reservation.reservedExpiresAt).getTime()) &&
		new Date(bloodUnit.reservation.reservedExpiresAt) > now
	) {
		failedSafetyGates.push(
			`Unit is currently reserved under an active hold for request '${bloodUnit.reservation.receiveRequestId}'.`
		)
	}

	const hasPassedAllSafetyGates = failedSafetyGates.length === 0
	const isEligibleForAllocation = isImmunoCompatible && hasPassedAllSafetyGates

	// Determine if Medical Officer approval is mandatory for this specific unit allocation
	const requiresMedicalOfficerApproval =
		Boolean(compatResult?.governance?.requiresMedicalOfficerApproval) ||
		(unitComponent === 'Cryoprecipitate' && matchQuality !== 'Identical') ||
		Boolean(compatResult?.rhRiskAssessment?.hasRhMismatch)

	return {
		isEligibleForAllocation,
		isImmunoCompatible,
		hasPassedAllSafetyGates,
		matchQuality,
		unitNumber: bloodUnit.unitNumber || null,
		unitGroup: unitGroup || null,
		recipientGroup: parsedRecipient.raw,
		componentType: unitComponent,
		requiresMedicalOfficerApproval,
		failedSafetyGates,
		compatResult,
		governance: {
			ruleVersion: COMPATIBILITY_SPEC_VERSION,
			clinicalAuthority: CLINICAL_AUTHORITY,
			isAuthoritativeClinicalDecision: false,
			isPresumptiveImmunohematologyCheck: true,
			cannotAuthorizeDispatch: true,
			cannotIssuePrescriptionOrOrder: true,
			requiresLaboratoryCrossmatch: true,
			requiresMedicalOfficerApproval,
			clinicalGovernance: requiresMedicalOfficerApproval
				? 'Pending_Medical_Officer_Approval'
				: 'Presumptive_Check_Completed',
		},
	}
}

module.exports = {
	COMPATIBILITY_SPEC_VERSION,
	CLINICAL_AUTHORITY,
	BLOOD_GROUP_PARSER,
	PRBC_COMPATIBILITY_RULES,
	WHOLE_BLOOD_COMPATIBILITY_RULES,
	FFP_COMPATIBILITY_RULES,
	parseBloodGroup,
	getCompatibleDonorGroups,
	evaluateCompatibility,
	validateUnitCompatibility,
}

