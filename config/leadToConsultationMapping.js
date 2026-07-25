// Best-effort translation from a lead's Elementor-form answers to consultation form
// pre-fill values. The two forms use different option wording (the lead form is
// coarser — e.g. "Smart Locks / Doorbells" as one option vs. the consultation's
// separate "Smart Locks"/"Smart Doorbell"), so this only maps what translates
// unambiguously. Anything not mapped here is still shown to staff verbatim via the
// "What they told us initially" reference panel — see views/admin/consultation-form.ejs
// — so nothing from the lead is ever silently lost, just not force-fit into a
// possibly-wrong consultation option.

const HOME_TYPE_MAP = {
  'New Construction': 'New Construction',
  'Existing Home': 'Existing Home',
  'Moving Soon': 'Moving into New Home',
};

const HOME_SIZE_MAP = {
  'Under 2,000 sq ft': 'Under 2,000 sq ft',
  '2,000–3,500 sq ft': '2,000 - 3,500 sq ft',
  '3,500+ sq ft': '3,500 - 5,000 sq ft', // approximate — consultation splits further at 5,000+
};

const BUDGET_MAP = {
  'Under $1,000': 'Under $1,000',
  '$1,000–$3,000': '$1,000–$3,000',
  '$3,000–$6,000': '$3,000–$6,000',
  // lead's "$6,000+" is ambiguous between the consultation's $6-10k/$10k+ split — left unmapped
};

const TIMELINE_MAP = {
  'ASAP': 'ASAP',
  'Within 30 Days': 'Within 30 Days',
  '1–3 Months': 'Within 90 Days', // approximate
  'Just Researching': 'Just Researching',
};

const INTERESTS_MAP = {
  'Whole-home Wi-Fi': ['Whole Home WiFi'],
  'Security Cameras': ['Security Cameras'],
  'Smart Lighting': ['Smart Lighting'],
  'Smart Locks / Doorbells': ['Smart Locks', 'Smart Doorbell'],
  'Full Home Automation': ['Home Automation'],
  'TV Mounting': ['TV Mounting'],
  'Not Sure Yet': ['Not Sure Yet'],
};

function mapLeadToConsultation(lead) {
  if (!lead) return {};

  const servicesInterested = new Set();
  for (const interest of lead.interests || []) {
    for (const mapped of INTERESTS_MAP[interest] || []) servicesInterested.add(mapped);
  }

  return {
    home_type: HOME_TYPE_MAP[lead.home_type] || null,
    square_footage: HOME_SIZE_MAP[lead.home_size] || null,
    budget_range: BUDGET_MAP[lead.budget] || null,
    desired_timeline: TIMELINE_MAP[lead.timeline] || null,
    services_interested: [...servicesInterested],
    biggest_frustration: lead.additional_details || null,
  };
}

module.exports = { mapLeadToConsultation };
