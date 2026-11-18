// Kinds of company for "What does your company do?", asked right after the
// company name, before the owner account exists (ONBOARD-COMPANYTYPE-01).
// Same ids and labels as the backend's COMPANY_KINDS
// (packages/backend/src/services/department-groups.ts); a test keeps them equal.

export const COMPANY_KIND_CHOICES = Object.freeze([
  ['healthcare rehabilitation and medical services', 'Healthcare'],
  ['tourism and hospitality', 'Tourism and hospitality'],
  ['food culinary services and food safety', 'Food and catering'],
  ['construction building services and trades', 'Construction and trades'],
  ['real estate architecture and spatial design', 'Real estate and architecture'],
  ['manufacturing production and maintenance', 'Manufacturing'],
  ['industrial engineering materials and vehicle services', 'Engineering and vehicles'],
  ['transport and mobility', 'Transport and mobility'],
  ['energy utilities and environmental technology', 'Energy and utilities'],
  ['telecommunications electrical systems and measurement', 'Telecom and electrical'],
  ['agriculture environment and sustainability', 'Agriculture and environment'],
  ['forestry horticulture animals and veterinary services', 'Animals, forestry and gardens'],
  ['fashion textiles crafts and publishing production', 'Fashion, crafts and printing'],
  ['cleaning beauty and personal services', 'Cleaning and beauty'],
  ['events', 'Events'],
  ['care family and community support', 'Care and family support'],
  ['community services and nonprofit organisations', 'Nonprofit and community'],
  ['public services emergency and community safety', 'Public and emergency services'],
].map(([id, label]) => Object.freeze({ id, label })));

const CUSTOM_TEXT = /^[\p{L}\p{N} _-]{1,64}$/u;

/** A saved answer: '' (general office and online work), a known kind id, or `custom:<text>`. */
export function validCompanyKind(value) {
  if (value === '') return true;
  if (typeof value !== 'string') return false;
  if (value.startsWith('custom:')) { const text = value.slice(7); return text === text.trim() && CUSTOM_TEXT.test(text); }
  return COMPANY_KIND_CHOICES.some(k => k.id === value);
}
