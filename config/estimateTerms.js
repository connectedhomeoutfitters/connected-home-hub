// Real Terms & Conditions (provided by the business owner, 2026-07-23) — replaces the
// earlier non-legal placeholder text. Authored as HTML, not markdown: rendered
// unescaped (`<%- terms %>`) into a scrollable box in views/portal/estimate.ejs, which
// is safe because this content is fully author-controlled, never user input.
//
// Now a function of the company name (from company_settings, see services/companySettings.js)
// so the legal contracting party matches the configured business; falls back to the legal
// name if unset. `co` is interpolated wherever the company name appears below.
module.exports = function estimateTerms(companyName) {
  const co = (companyName && String(companyName).trim()) || 'Connected Home Outfitters LLC';
  return `
<h5>${co}</h5>
<h6 class="mt-3">Estimate Terms &amp; Conditions</h6>
<p>By accepting this estimate electronically or by signing below, the Customer agrees to the following Terms and Conditions.</p>

<h6 class="mt-3">1. Scope of Work</h6>
<p>${co} ("Contractor") agrees to provide the products and services described in this estimate. Any work requested outside the scope of this estimate may require a written change order and additional charges.</p>

<h6 class="mt-3">2. Estimate Validity</h6>
<p>This estimate is valid for thirty (30) calendar days from the date issued. Pricing may be adjusted after this period due to changes in material costs, product availability, or labor rates.</p>

<h6 class="mt-3">3. Deposit</h6>
<p>A deposit equal to <strong>50% of the total estimate</strong> is required before scheduling work or ordering equipment.</p>
<p>The deposit covers project planning, equipment procurement, and scheduling.</p>
<p>Projects requiring custom, special-order, or non-returnable equipment may require additional upfront payment.</p>

<h6 class="mt-3">4. Final Payment</h6>
<p>The remaining balance is due immediately upon substantial completion of the installation and prior to final project handoff unless otherwise agreed to in writing.</p>
<p>Accepted payment methods include credit card, ACH, check, or other approved payment methods.</p>

<h6 class="mt-3">5. Equipment Availability</h6>
<p>Quoted equipment is subject to manufacturer availability. If a specified product becomes unavailable, Contractor may recommend an equivalent product of similar quality and functionality after customer approval.</p>

<h6 class="mt-3">6. Scheduling</h6>
<p>Installation dates are scheduled after receipt of the required deposit.</p>
<p>While every effort is made to meet requested dates, scheduling may be affected by weather, supplier delays, customer availability, or unforeseen circumstances.</p>

<h6 class="mt-3">7. Customer Responsibilities</h6>
<p>Customer agrees to:</p>
<ul>
  <li>Provide reasonable access to all work areas.</li>
  <li>Ensure utilities and internet service are available during installation.</li>
  <li>Remove personal belongings from work areas when practical.</li>
  <li>Obtain HOA approval when required.</li>
  <li>Disclose any known wiring, structural, or access limitations.</li>
</ul>

<h6 class="mt-3">8. Existing Conditions</h6>
<p>Contractor is not responsible for existing wiring defects, undocumented modifications, damaged equipment, inadequate internet service, electrical deficiencies, or other pre-existing conditions discovered during installation.</p>
<p>Additional work required to correct such conditions will be quoted separately.</p>

<h6 class="mt-3">9. Change Orders</h6>
<p>Changes requested after acceptance of this estimate may affect pricing, equipment, labor, and project completion dates.</p>
<p>All change orders must be approved before additional work is performed.</p>

<h6 class="mt-3">10. Limited Warranty</h6>
<p>${co} warrants its installation workmanship for one (1) year from the date of project completion.</p>
<p>Manufacturer warranties apply separately to purchased equipment and remain subject to each manufacturer's terms and conditions.</p>
<p>Warranty coverage does not include:</p>
<ul>
  <li>Customer misuse</li>
  <li>Power surges</li>
  <li>Internet service interruptions</li>
  <li>Software updates from third-party manufacturers</li>
  <li>Acts of nature</li>
  <li>Physical damage caused after installation</li>
</ul>

<h6 class="mt-3">11. Customer-Supplied Equipment</h6>
<p>Contractor may install customer-supplied equipment when agreed upon.</p>
<p>${co} cannot guarantee compatibility, performance, or manufacturer warranty coverage for equipment not purchased through Contractor.</p>
<p>Additional labor charges may apply for troubleshooting customer-supplied devices.</p>

<h6 class="mt-3">12. Property Protection</h6>
<p>Reasonable care will be taken to protect the property during installation.</p>
<p>Customer acknowledges that low-voltage installations may require drilling, cutting drywall, attic access, fishing wire through walls, or other minor modifications necessary to complete the work professionally.</p>

<h6 class="mt-3">13. Cancellations</h6>
<p>Orders canceled after equipment has been purchased may be subject to restocking fees and reimbursement for any non-refundable materials or services already incurred.</p>
<p>Deposits may be partially or fully non-refundable once materials have been ordered specifically for the project.</p>

<h6 class="mt-3">14. Limitation of Liability</h6>
<p>Contractor's total liability arising from this project shall not exceed the amount paid by the Customer for the specific services provided.</p>
<p>Contractor shall not be liable for indirect, incidental, special, or consequential damages, including loss of internet service, data loss, business interruption, or lost profits.</p>

<h6 class="mt-3">15. Photography</h6>
<p>Contractor may photograph completed installations for documentation, warranty records, and marketing purposes.</p>
<p>No identifying personal information or customer addresses will be published without permission.</p>
<p>Customer may opt out by notifying Contractor in writing before project completion.</p>

<h6 class="mt-3">16. Electronic Acceptance</h6>
<p>The Customer agrees that electronic signatures, online estimate acceptance, and electronic payment constitute acceptance of this agreement and are legally binding to the fullest extent permitted by applicable law.</p>

<h6 class="mt-3">17. Governing Law</h6>
<p>This agreement shall be governed by the laws of the State of Texas.</p>
<p>Any disputes shall be resolved in the appropriate state or federal courts located within the State of Texas unless otherwise required by law.</p>

<hr class="my-3">

<h6>Customer Acknowledgment</h6>
<p>By clicking <strong>"Accept Estimate"</strong>, signing electronically, or submitting the required deposit, Customer acknowledges that they:</p>
<ul>
  <li>Have reviewed this estimate.</li>
  <li>Understand the scope of work.</li>
  <li>Agree to these Terms &amp; Conditions.</li>
  <li>Authorize ${co} to perform the described work.</li>
  <li>Agree to pay the required 50% deposit prior to scheduling and the remaining balance upon project completion.</li>
</ul>
`.trim();
};
