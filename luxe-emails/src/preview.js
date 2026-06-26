// preview.js - render the sample payload to a static HTML file for browser preview.
const fs = require('fs');
const path = require('path');
const { renderLeadQualified } = require('./render-lead-qualified');
const sample = require('./sample-data');

const { subject, html } = renderLeadQualified(sample);
const out = path.join(__dirname, '..', 'templates', 'lead-qualified.generated.html');
fs.writeFileSync(out, html);
console.log('Subject:', subject);
console.log('Wrote:  ', out, `(${html.length} bytes)`);
