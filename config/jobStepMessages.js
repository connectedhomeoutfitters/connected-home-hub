// Per-job-type customer communication sent when a step (job) is closed out. Each step of
// the workflow gets its own message so the customer is kept informed as the project moves
// consultation → estimate → install → done. Job types not listed here (e.g. the internal
// estimate_followup task) still close out — stamping closed_at — but send no customer email.
//
//   label            — heading on the job page's close-out card
//   button           — the close-out button text
//   subject/template — the customer email (templates live in views/emails/)
//
// SUBJECTS MUST NOT NAME A COMPANY. These strings are static and shared by every tenant,
// so a company name baked in here reaches *other* contractors' customers. It would also
// be redundant: services/mailer.js already sets the From display name to the sending
// org's company name, so the customer sees who it's from before opening it.
//   staffDescription — one-line note telling staff what the customer will receive
//   includeWarranties— load + pass the customer's active warranties to the template (install)

module.exports = {
  consultation: {
    label: 'Complete consultation',
    button: 'Complete & notify customer',
    subject: 'Your consultation is complete',
    template: 'job-consultation-complete',
    staffDescription: "emails the customer that the consultation is done and you're now preparing their estimate",
  },
  install: {
    label: 'Close out project',
    button: 'Close out project',
    subject: 'Your project is complete',
    template: 'warranty-summary',
    staffDescription: 'emails the customer a "project complete" note with their warranty documentation',
    includeWarranties: true,
  },
};
