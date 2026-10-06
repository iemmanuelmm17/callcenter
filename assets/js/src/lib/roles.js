/* Which roles may read / change the domain thresholds (QA-5).
 *
 * The same rule is enforced server-side: api/settings.php answers 403 to any
 * other role for both GET and POST, and api/report.php ships the effective
 * thresholds with the dashboard payload so non-privileged screens still colour
 * their KPIs with the domain's numbers.
 *
 * Why not the report's response flag alone: the nav button and the Save button
 * render before any request resolves, and a UI that flickers a control in and
 * out is worse than one that never shows it. Single source here, asserted in
 * tests/php/endpoints.mjs (server) and tests/js/smoke.mjs (client).
 */

const ROLES_READING_SETTINGS = ['office_manager', 'supervisor'];

const CAN_READ_SETTINGS = role => ROLES_READING_SETTINGS.includes(role);

const CAN_WRITE_SETTINGS = role => role === 'office_manager';

export { CAN_READ_SETTINGS, CAN_WRITE_SETTINGS, ROLES_READING_SETTINGS };
