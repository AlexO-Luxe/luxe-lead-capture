// sample-data.js - example payload that generates the static mockup.
// Run: node src/preview.js   (writes templates/lead-qualified.generated.html)

module.exports = {
  guestName:      'Eleanor Whitmore',
  contactPhone:   '+44 7700 900 812',
  contactEmail:   'eleanor.whitmore@example.com',

  createdAt:      '2026-06-24T09:14:00Z',
  qualifiedAt:    '2026-06-26T14:32:00Z',
  qualifiedBy:    'Sofia Marchetti',
  assignedTo:     'James Okafor',
  assignedToRole: 'Reservations',

  source:         'Google Ads · PPC',
  campaign:       'London · Marylebone · Sept',

  nights:         91,
  weeklyRate:     1200,
  budgetNote:     'flex to £1,400',
  guests:         2,

  checkIn:        '2026-09-01',
  checkOut:       '2026-12-01',
  location:       'Marylebone, London W1',

  teamAvgCooking: '3d 14h',

  // Leads board "visited paths" column, in order
  visitedPaths: [
    '/luxury-apartments-london',
    '/marylebone',
    '/our-reviews',
    '/marylebone',
    'hero form'
  ],

  notes: [
    { author: 'Sofia Marchetti', at: '24 Jun, 09:32', kind: 'open',
      text: 'Called within 20 min, very warm. Relocating for a 3-month consultancy contract, start date firm.' },
    { author: 'Sofia Marchetti', at: '24 Jun, 14:10', kind: 'mid',
      text: 'Sent three Marylebone 1-bed options with virtual tour links. Strong reaction to the Devonshire St apartment.' },
    { author: 'James Okafor', at: '25 Jun, 11:05', kind: 'mid',
      text: 'Viewing booked for Friday. Budget flexible to £1,400/wk for the right place. Decision-maker on the call.' },
    { author: 'James Okafor', at: '26 Jun, 14:30', kind: 'qualified',
      text: 'Confirmed strong intent and viewing went well. Marking qualified, moving to proposal stage.' }
  ],

  nextAction:    'Send formal proposal for Devonshire St and secure holding deposit.',
  nextActionDue: '27 Jun',

  mondayUrl:     'https://student-luxe.monday.com/boards/2171015719',
  whatsappUrl:   'https://wa.me/447700900812'
};
