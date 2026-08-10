// Rough phone-number -> local time-of-day derivation, used only to give the
// model a general sense of "morning/afternoon/evening/night" for greeting
// purposes — NOT precise timekeeping, and never used to originate a
// greeting on its own (the customer leads; this only helps the model
// understand what time it plausibly is if that becomes relevant).
//
// COUNTRY CODE LIMITATION: a country calling code maps to exactly one
// timezone only for single-timezone countries (Nigeria +234, UK +44,
// Germany +49, etc). Multi-timezone countries (+1 US/Canada, +61
// Australia, +7 Russia, +86 China isn't actually multi-zone but is huge,
// +91 India spans a wide area on one official zone, etc) get a single
// "most common" fallback zone below — this will be wrong for a real
// fraction of numbers in those countries. That's a known, accepted
// imprecision, not a bug: this is for a soft "likely evening" prompt hint,
// not for scheduling or anything that needs to be correct.
//
// Add more entries as your actual customer base grows into new countries.
const COUNTRY_CODE_TIMEZONES = {
  '234': 'Africa/Lagos',        // Nigeria — single zone, reliable
  '233': 'Africa/Accra',        // Ghana
  '254': 'Africa/Nairobi',      // Kenya
  '27': 'Africa/Johannesburg',  // South Africa
  '256': 'Africa/Kampala',      // Uganda
  '20': 'Africa/Cairo',         // Egypt
  '44': 'Europe/London',        // UK — single zone
  '353': 'Europe/Dublin',       // Ireland
  '49': 'Europe/Berlin',        // Germany
  '33': 'Europe/Paris',         // France
  '91': 'Asia/Kolkata',         // India — one official zone despite size
  '971': 'Asia/Dubai',          // UAE
  '65': 'Asia/Singapore',       // Singapore
  '81': 'Asia/Tokyo',           // Japan
  '86': 'Asia/Shanghai',        // China — one official zone
  '61': 'Australia/Sydney',     // Australia — MULTI-ZONE, this picks the
                                  // most populous (eastern) zone; will be
                                  // wrong for Perth/WA and other regions
  '1': 'America/New_York',      // US/Canada — MULTI-ZONE (6+ zones), this
                                  // picks US Eastern as the most common
                                  // guess; genuinely imprecise for this
                                  // country code specifically
};

/**
 * Given a phone number like "+2349043557520", returns a rough label like
 * "morning" / "afternoon" / "evening" / "night" for the customer's likely
 * local time, or null if the country code isn't in our map or the number
 * is missing/malformed. Never throws.
 */
function getCustomerTimeOfDay(phoneNumber) {
  if (!phoneNumber) return null;

  const digits = phoneNumber.replace(/[^\d]/g, '');
  if (!digits) return null;

  // Try longest-prefix match first (e.g. "971" before "97", "1" last
  // since it's a single digit and would otherwise match too eagerly).
  const codes = Object.keys(COUNTRY_CODE_TIMEZONES).sort((a, b) => b.length - a.length);
  const matchedCode = codes.find(code => digits.startsWith(code));
  if (!matchedCode) return null;

  const timezone = COUNTRY_CODE_TIMEZONES[matchedCode];

  try {
    const hour = parseInt(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: timezone }).format(new Date()),
      10
    );

    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 21) return 'evening';
    return 'night';
  } catch (e) {
    console.error(`Failed to compute time of day for timezone ${timezone}:`, e.message);
    return null;
  }
}

module.exports = { getCustomerTimeOfDay };
