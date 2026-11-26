/**
 * The UK contract-form catalogue: which published forms exist, in which edition.
 *
 * Seeded from the Contracts Studio handoff (`form-catalogue.csv`, 25 November
 * 2026): the JCT 2024 families and the 2021 homeowner forms, the NEC4 (January
 * 2023 revision) and NEC3 (April 2013) suites, FIDIC works and consultancy books
 * with their legacy editions, IChemE, the ACA partnering forms, and the other UK
 * market families.
 *
 * **Metadata only.** A row is a fact about a publication — its publisher, edition,
 * code and title — never its text. The publishers own the words; this platform
 * holds no clause wording of any form, and nothing here is a licence to use one.
 *
 * Three kinds of row, kept apart because confusing them is how a contract ends
 * up on the wrong edition:
 *
 * - `CURRENT` — the edition in publication.
 * - `LEGACY` — a named earlier edition, still met on live projects. Drafting on
 *   one is allowed; it is never offered as a recommendation.
 * - `VERIFY_ISSUE` — a family, a regional adaptation or an "earlier editions"
 *   import route whose exact issue is not pinned. It can be browsed, never drafted
 *   on: a placeholder must not resolve to some current edition by default. The
 *   exact issue is onboarded first.
 */

export type CatalogueStatus = 'CURRENT' | 'LEGACY' | 'VERIFY_ISSUE';

export type ContractFormEntry = {
  /** Stable: publisher, edition and code, slugged. */
  key: string;
  publisher: string;
  edition: string;
  code: string;
  title: string;
  /** works, subcontract, consultancy, services, supply, warranty, related, consumer… */
  type: string;
  status: CatalogueStatus;
  /** Where the publisher lists it — a public catalogue page, not the text. */
  source: string;
};

type Row = [string, string, string, string, string, string, CatalogueStatus, string];

const ROWS: Row[] = [
  ["jct:2024:db", "JCT", "2024", "DB", "Design and Build", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbc-q", "JCT", "2024", "SBC/Q", "Standard Building with Quantities", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbc-xq", "JCT", "2024", "SBC/XQ", "Standard Building without Quantities", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbc-aq", "JCT", "2024", "SBC/AQ", "Standard Building with Approximate Quantities", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:ic", "JCT", "2024", "IC", "Intermediate Building", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icd", "JCT", "2024", "ICD", "Intermediate Building with Contractor Design", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mw", "JCT", "2024", "MW", "Minor Works", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mwd", "JCT", "2024", "MWD", "Minor Works with Contractor Design", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:tcc", "JCT", "2024", "TCC", "Target Cost", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mp", "JCT", "2024", "MP", "Major Project Construction", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:pcc", "JCT", "2024", "PCC", "Prime Cost Building", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mtc", "JCT", "2024", "MTC", "Measured Term", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:rm", "JCT", "2024", "RM", "Repair and Maintenance", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:ce", "JCT", "2024", "CE", "Constructing Excellence", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mc", "JCT", "2024", "MC", "Management Building", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cm-tc", "JCT", "2024", "CM/TC", "Construction Management Trade Contract", "works", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:dbsub-a", "JCT", "2024", "DBSub/A", "Design and Build Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:dbsub-c", "JCT", "2024", "DBSub/C", "Design and Build Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbcsub-a", "JCT", "2024", "SBCSub/A", "Standard Building Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbcsub-c", "JCT", "2024", "SBCSub/C", "Standard Building Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbcsub-d-a", "JCT", "2024", "SBCSub/D/A", "Standard Building Design Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:sbcsub-d-c", "JCT", "2024", "SBCSub/D/C", "Standard Building Design Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-a", "JCT", "2024", "ICSub/A", "Intermediate Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-c", "JCT", "2024", "ICSub/C", "Intermediate Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-d-a", "JCT", "2024", "ICSub/D/A", "Intermediate Design Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-d-c", "JCT", "2024", "ICSub/D/C", "Intermediate Design Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-nam", "JCT", "2024", "ICSub/NAM", "Intermediate Named Subcontract Tender and Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-nam-c", "JCT", "2024", "ICSub/NAM/C", "Intermediate Named Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:icsub-nam-e", "JCT", "2024", "ICSub/NAM/E", "Intermediate Named Subcontractor Employer Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mwsub-d", "JCT", "2024", "MWSub/D", "Minor Works Design Subcontract", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:tccsub-a", "JCT", "2024", "TCCSub/A", "Target Cost Subcontract Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:tccsub-c", "JCT", "2024", "TCCSub/C", "Target Cost Subcontract Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mpsub", "JCT", "2024", "MPSub", "Major Project Subcontract", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mcwc-a", "JCT", "2024", "MCWC/A", "Management Works Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mcwc-c", "JCT", "2024", "MCWC/C", "Management Works Conditions", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mcwc-e", "JCT", "2024", "MCWC/E", "Management Works Contractor Employer Agreement", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:shortsub", "JCT", "2024", "ShortSub", "Short Form of Subcontract", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:subsub", "JCT", "2024", "SubSub", "Sub-subcontract", "subcontract", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:ca", "JCT", "2024", "CA", "Public Sector Consultancy Agreement", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:pcsa", "JCT", "2024", "PCSA", "General Contractor Preconstruction Services", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:pcsa-sp", "JCT", "2024", "PCSA/SP", "Specialist Preconstruction Services", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:fa", "JCT", "2024", "FA", "Framework Agreement", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cm-a", "JCT", "2024", "CM/A", "Construction Management Appointment", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:ce-p", "JCT", "2024", "CE/P", "Constructing Excellence Project Team Agreement", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:adj", "JCT", "2024", "Adj", "Adjudication Agreement", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:adj-n", "JCT", "2024", "Adj/N", "Named Adjudicator Agreement", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:dab", "JCT", "2024", "DAB", "Dispute Adjudication Board Documentation", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:pba", "JCT", "2024", "PBA", "Project Bank Account Documentation", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:pc-n", "JCT", "2024", "PC/N", "Non-binding Partnering Charter", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:jct-cimar", "JCT", "2024", "JCT/CIMAR", "Model Arbitration Rules", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:fr", "JCT", "2024", "FR", "Formula Rules", "related", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cwa-f", "JCT", "2024", "CWa/F", "Contractor Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cwa-p-t", "JCT", "2024", "CWa/P&T", "Contractor Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:scwa-f", "JCT", "2024", "SCWa/F", "Subcontractor Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:scwa-p-t", "JCT", "2024", "SCWa/P&T", "Subcontractor Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cmwa-f", "JCT", "2024", "CMWa/F", "Construction Manager Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:cmwa-p-t", "JCT", "2024", "CMWa/P&T", "Construction Manager Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:tcwa-f", "JCT", "2024", "TCWa/F", "Trade Contractor Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:tcwa-p-t", "JCT", "2024", "TCWa/P&T", "Trade Contractor Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mcwa-f", "JCT", "2024", "MCWa/F", "Management Contractor Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:mcwa-p-t", "JCT", "2024", "MCWa/P&T", "Management Contractor Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:wcwa-f", "JCT", "2024", "WCWa/F", "Works Contractor Warranty for Funder", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:wcwa-p-t", "JCT", "2024", "WCWa/P&T", "Works Contractor Warranty for Purchaser or Tenant", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2024:scwa-e", "JCT", "2024", "SCWa/E", "Subcontractor Warranty for Employer", "warranty", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2021:ho-b", "JCT", "2021", "HO/B", "Home Owner Building Contract without Consultant", "consumer", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2021:ho-c", "JCT", "2021", "HO/C", "Home Owner Building Contract with Consultant", "consumer", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:2021:ho-ca", "JCT", "2021", "HO/CA", "Home Owner Consultancy Agreement", "consumer", "CURRENT", "https://www.jctltd.co.uk/"],
  ["jct:verify-issue:ho-rm", "JCT", "verify issue", "HO/RM", "Home Repair and Maintenance", "consumer", "VERIFY_ISSUE", "https://www.jctltd.co.uk/"],
  ["jct:legacy:legacy", "JCT", "legacy", "LEGACY", "2016, 2011, 2005 and earlier project-used forms", "edition import", "VERIFY_ISSUE", "https://www.jctltd.co.uk/"],
  ["jct:regional:sbcc", "JCT", "regional", "SBCC", "Scottish Building Contract Committee forms and editions", "edition import", "VERIFY_ISSUE", "https://www.jctltd.co.uk/"],
  ["jct:regional:rsua", "JCT", "regional", "RSUA", "Northern Ireland adaptation schedules", "edition import", "VERIFY_ISSUE", "https://www.jctltd.co.uk/"],
  ["nec:nec4-jan-2023-revision:ecc", "NEC", "NEC4: Jan 2023 revision", "ECC", "Engineering and Construction Contract", "works", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:ecs", "NEC", "NEC4: Jan 2023 revision", "ECS", "Engineering and Construction Subcontract", "works", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:ecsc", "NEC", "NEC4: Jan 2023 revision", "ECSC", "Engineering and Construction Short Contract", "works", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:ecss", "NEC", "NEC4: Jan 2023 revision", "ECSS", "Engineering and Construction Short Subcontract", "works", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:psc", "NEC", "NEC4: Jan 2023 revision", "PSC", "Professional Service Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:pssc", "NEC", "NEC4: Jan 2023 revision", "PSSC", "Professional Service Short Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:tsc", "NEC", "NEC4: Jan 2023 revision", "TSC", "Term Service Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:tssc", "NEC", "NEC4: Jan 2023 revision", "TSSC", "Term Service Short Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:sc", "NEC", "NEC4: Jan 2023 revision", "SC", "Supply Contract", "supply", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:ssc", "NEC", "NEC4: Jan 2023 revision", "SSC", "Supply Short Contract", "supply", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:fc", "NEC", "NEC4: Jan 2023 revision", "FC", "Framework Contract", "framework", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ecc", "NEC", "NEC3: April 2013 suite", "ECC", "Engineering and Construction Contract", "works", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ecs", "NEC", "NEC3: April 2013 suite", "ECS", "Engineering and Construction Subcontract", "works", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ecsc", "NEC", "NEC3: April 2013 suite", "ECSC", "Engineering and Construction Short Contract", "works", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ecss", "NEC", "NEC3: April 2013 suite", "ECSS", "Engineering and Construction Short Subcontract", "works", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:psc", "NEC", "NEC3: April 2013 suite", "PSC", "Professional Service Contract", "services", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:pssc", "NEC", "NEC3: April 2013 suite", "PSSC", "Professional Service Short Contract", "services", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:tsc", "NEC", "NEC3: April 2013 suite", "TSC", "Term Service Contract", "services", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:tssc", "NEC", "NEC3: April 2013 suite", "TSSC", "Term Service Short Contract", "services", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:sc", "NEC", "NEC3: April 2013 suite", "SC", "Supply Contract", "supply", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ssc", "NEC", "NEC3: April 2013 suite", "SSC", "Supply Short Contract", "supply", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:fc", "NEC", "NEC3: April 2013 suite", "FC", "Framework Contract", "framework", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:pss", "NEC", "NEC4: Jan 2023 revision", "PSS", "Professional Service Subcontract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:tss", "NEC", "NEC4: Jan 2023 revision", "TSS", "Term Service Subcontract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:fmc", "NEC", "NEC4: Jan 2023 revision", "FMC", "Facilities Management Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:fmsc", "NEC", "NEC4: Jan 2023 revision", "FMSC", "Facilities Management Short Contract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:fms", "NEC", "NEC4: Jan 2023 revision", "FMS", "Facilities Management Subcontract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:fmss", "NEC", "NEC4: Jan 2023 revision", "FMSS", "Facilities Management Short Subcontract", "services", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:dboc", "NEC", "NEC4: Jan 2023 revision", "DBOC", "Design Build and Operate", "specialist", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:alc", "NEC", "NEC4: Jan 2023 revision", "ALC", "Alliance Contract", "specialist", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec4-jan-2023-revision:drsc", "NEC", "NEC4: Jan 2023 revision", "DRSC", "Dispute Resolution Service Contract", "specialist", "CURRENT", "https://www.neccontract.com/products/contracts"],
  ["nec:nec3-april-2013-suite:ac", "NEC", "NEC3: April 2013 suite", "AC", "Adjudicator Contract", "dispute", "LEGACY", "https://www.neccontract.com/products/contracts"],
  ["nec:legacy:legacy", "NEC", "legacy", "LEGACY", "Earlier NEC editions and pre-2023 NEC4 revisions", "edition import", "VERIFY_ISSUE", "https://www.neccontract.com/products/contracts"],
  ["fidic:2017-2022-reprint:red", "FIDIC", "2017: 2022 reprint", "RED", "Construction", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-2022-reprint:yellow", "FIDIC", "2017: 2022 reprint", "YELLOW", "Plant and Design-Build", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-2022-reprint:silver", "FIDIC", "2017: 2022 reprint", "SILVER", "EPC and Turnkey", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-original:red", "FIDIC", "2017: original", "RED", "Construction", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-original:yellow", "FIDIC", "2017: original", "YELLOW", "Plant and Design-Build", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-original:silver", "FIDIC", "2017: original", "SILVER", "EPC and Turnkey", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:1999-first-edition:red", "FIDIC", "1999: first edition", "RED", "Construction", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:1999-first-edition:yellow", "FIDIC", "1999: first edition", "YELLOW", "Plant and Design-Build", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:1999-first-edition:silver", "FIDIC", "1999: first edition", "SILVER", "EPC and Turnkey", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2021-second-edition:green", "FIDIC", "2021: second edition", "GREEN", "Short Form", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:1999-first-edition:green", "FIDIC", "1999: first edition", "GREEN", "Short Form", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2019-2023-reprint:emerald", "FIDIC", "2019: 2023 reprint", "EMERALD", "Underground Works", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2019-original:emerald", "FIDIC", "2019: original", "EMERALD", "Underground Works", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2008-first-edition:gold", "FIDIC", "2008: first edition", "GOLD", "Design Build Operate", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2016-second-edition:blue-green", "FIDIC", "2016: second edition", "BLUE-GREEN", "Dredging and Reclamation", "works", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2006-first-edition:blue-green", "FIDIC", "2006: first edition", "BLUE-GREEN", "Dredging and Reclamation", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2010-version-3:pink", "FIDIC", "2010: version 3", "PINK", "MDB Harmonised Construction", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2005-2006-versions:pink", "FIDIC", "2005/2006 versions", "PINK", "Earlier MDB Harmonised Construction", "works", "VERIFY_ISSUE", "https://fidic.org/book-category/all-documents"],
  ["fidic:1995-first-edition:orange", "FIDIC", "1995: first edition", "ORANGE", "Design-Build and Turnkey", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:1987-fourth-edition:red", "FIDIC", "1987: fourth edition", "RED", "Works of Civil Engineering Construction", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:1987-third-edition:yellow", "FIDIC", "1987: third edition", "YELLOW", "Electrical and Mechanical Works", "works", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2011-first-edition:red-sub", "FIDIC", "2011: first edition", "RED-SUB", "Construction Subcontract for Red Book 1999", "subcontract", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2019-first-edition:yellow-sub", "FIDIC", "2019: first edition", "YELLOW-SUB", "Plant and Design-Build Subcontract for Yellow Book 1999", "subcontract", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:1994-first-edition:civil-sub", "FIDIC", "1994: first edition", "CIVIL-SUB", "Civil Engineering Construction Subcontract for Red Book fourth edition", "subcontract", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-fifth-edition:white", "FIDIC", "2017: fifth edition", "WHITE", "Client Consultant Model Services Agreement", "consultancy", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2006-fourth-edition:white", "FIDIC", "2006: fourth edition", "WHITE", "Client Consultant Model Services Agreement", "consultancy", "LEGACY", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-second-edition:jv", "FIDIC", "2017: second edition", "JV", "Model Joint Venture Agreement", "consultancy", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2017-second-edition:subconsult", "FIDIC", "2017: second edition", "SUBCONSULT", "Sub-Consultancy Agreement", "consultancy", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:2013-first-edition:rep", "FIDIC", "2013: first edition", "REP", "Model Representative Agreement", "related", "CURRENT", "https://fidic.org/book-category/all-documents"],
  ["fidic:parent-edition:dab", "FIDIC", "parent edition", "DAB", "Dispute Adjudication Board Agreement", "related", "VERIFY_ISSUE", "https://fidic.org/book-category/all-documents"],
  ["fidic:parent-edition:daab", "FIDIC", "parent edition", "DAAB", "Dispute Avoidance and Adjudication Board Agreement", "related", "VERIFY_ISSUE", "https://fidic.org/book-category/all-documents"],
  ["fidic:project-specific:mdb", "FIDIC", "project-specific", "MDB", "Institution-specific licensed FIDIC procurement variants", "edition import", "VERIFY_ISSUE", "https://fidic.org/book-category/all-documents"],
  ["fidic:project-specific:legacy", "FIDIC", "project-specific", "LEGACY", "Earlier works and consultancy editions and reprints", "edition import", "VERIFY_ISSUE", "https://fidic.org/book-category/all-documents"],
  ["icheme:uk-edition:red", "IChemE", "UK edition", "RED", "Lump Sum", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:green", "IChemE", "UK edition", "GREEN", "Reimbursable", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:burgundy", "IChemE", "UK edition", "BURGUNDY", "Target Cost", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:yellow", "IChemE", "UK edition", "YELLOW", "Subcontract", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:brown", "IChemE", "UK edition", "BROWN", "Civil Engineering Subcontract", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:orange", "IChemE", "UK edition", "ORANGE", "Minor Works", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:silver", "IChemE", "UK edition", "SILVER", "Professional Services", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:blue", "IChemE", "UK edition", "BLUE", "EPCM", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:grey", "IChemE", "UK edition", "GREY", "Adjudication Rules", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:white", "IChemE", "UK edition", "WHITE", "Expert Determination Rules", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["icheme:uk-edition:pink", "IChemE", "UK edition", "PINK", "Arbitration Rules", "specialist", "CURRENT", "https://www.icheme.org/knowledge-networks/communities/special-interest-groups/forms-of-contract/"],
  ["aca:verify-issue:ppc2000", "ACA", "verify issue", "PPC2000", "Project Partnering", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["aca:verify-issue:spc2000", "ACA", "verify issue", "SPC2000", "Specialist Project Partnering", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["aca:verify-issue:tpc2005", "ACA", "verify issue", "TPC2005", "Term Partnering", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["aca:verify-issue:fac-1", "ACA", "verify issue", "FAC-1", "Framework Alliance", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["aca:verify-issue:tac-1", "ACA", "verify issue", "TAC-1", "Term Alliance", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["aca:verify-issue:ppc-int", "ACA", "verify issue", "PPC-INT", "International Project Partnering", "partnering", "VERIFY_ISSUE", "https://ppc2000.co.uk/"],
  ["uk:verify-issue:icc", "UK", "verify issue", "ICC", "Infrastructure Conditions: Measurement, Design and Construct, Target Cost, Term, Minor Works and other published forms", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:ice", "UK", "verify issue", "ICE", "Legacy ICE Conditions and associated forms", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:ace", "UK", "verify issue", "ACE", "Professional Services Agreements", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:ceca", "UK", "verify issue", "CECA", "Civil engineering subcontracts", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:mf-1", "UK", "verify issue", "MF/1", "IET and IMechE electrical and mechanical plant model form", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:riba", "UK", "verify issue", "RIBA", "Professional Services and building contracts", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:rics", "UK", "verify issue", "RICS", "Consultant appointments", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:fmb", "UK", "verify issue", "FMB", "Domestic and commercial building forms", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:scape", "UK", "verify issue", "SCAPE", "Framework and call-off documentation", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:public", "UK", "verify issue", "PUBLIC", "Authority-specific public works and call-off terms", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:d-b-epc", "UK", "verify issue", "D&B-EPC", "Employer bespoke EPC, EPCM and plant supply forms", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:highways", "UK", "verify issue", "HIGHWAYS", "Highways agreements including section 38 and section 278", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:rail", "UK", "verify issue", "RAIL", "Rail infrastructure access and asset protection agreements", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
  ["uk:verify-issue:water", "UK", "verify issue", "WATER", "Water sector adoption and connection agreements", "market extension", "VERIFY_ISSUE", "https://www.rics.org/content/dam/ricsglobal/documents/standards/Appropriate-contract-selection-2nd-edition.pdf"],
];

export const CATALOGUE: readonly ContractFormEntry[] = ROWS.map(([key, publisher, edition, code, title, type, status, source]) => ({ key, publisher, edition, code, title, type, status, source }));

const BY_KEY = new Map(CATALOGUE.map((entry) => [entry.key, entry]));

export const formByKey = (key: string): ContractFormEntry | undefined => BY_KEY.get(key);

/** How a form is named to a person: publisher, code, title and the exact edition. */
export const formLabel = (entry: ContractFormEntry): string => `${entry.publisher} ${entry.code} ${entry.title} (${entry.edition})`;

/** Whether a contract can be drafted on this entry: a pinned edition, not a family or import route. */
export const draftable = (entry: ContractFormEntry): boolean => entry.status !== 'VERIFY_ISSUE';
