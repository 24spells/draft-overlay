// The 24spells website the overlay talks to: hosted card stats, coach files, pairing and uploads, and
// the links it opens (review, sealed pool, your games). One place, so a new address is a one-line change.
// OVERLAY_SITE points a test run at a local copy of the site (e.g. http://localhost:5173).
export const SITE = process.env.OVERLAY_SITE ?? 'https://23spells.pages.dev';
