// Option lists matching the real Elementor lead form's exact wording (see CLAUDE.md
// "Relationship to Connected Home Hub" in choProject, and config/leadToConsultationMapping.js
// which maps these to consultation-form equivalents by exact string match). Keeping
// manual lead entry on the same vocabulary means both paths stay compatible with that
// mapping — a manually-entered "Existing Home" pre-fills a later consultation exactly
// like a real webhook-sourced one would.
module.exports = {
  homeTypes: ['New Construction', 'Existing Home', 'Moving Soon'],
  homeSizes: ['Under 2,000 sq ft', '2,000–3,500 sq ft', '3,500+ sq ft', 'Not Sure'],
  budgets: ['Under $1,000', '$1,000–$3,000', '$3,000–$6,000', '$6,000+'],
  timelines: ['ASAP', 'Within 30 Days', '1–3 Months', 'Just Researching'],
};
