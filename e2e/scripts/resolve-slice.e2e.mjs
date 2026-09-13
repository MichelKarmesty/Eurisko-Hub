#!/usr/bin/env node
/**
 * Eurisko Hub — "Assigned agent resolves a ticket" browser E2E.
 *
 * Drives the REAL React app (http://localhost:5173) with no direct API calls:
 *
 *   1. Rana (Requester) opens an IT ticket.
 *   2. Karim (IT Agent) sees it in his queue and claims it (-> In Progress).
 *   3. Karim submits an EMPTY resolution note -> the backend 400 is surfaced
 *      in the form (DoD: reject bad input).
 *   4. Karim types a note and clicks "Mark Resolved".
 *   5. The ticket visibly moves to the "Resolved by me" section with the
 *      note (DoD: UI reflects the state change immediately).
 *   6. Rana's "My tickets" shows the ticket as Resolved with the note.
 *
 * Screenshots land in artifacts/e2e/.
 *
 * Prereqs: backend on :3000 (DB_FILE persistent) with the test fixtures
 * provisioned (node scripts/verify-slice.mjs full), `npm run dev` on :5173.
 * The self-contained runner scripts/run-browser-e2e.mjs does all of this.
 *
 * Run:  node scripts/resolve-slice.e2e.mjs
 */
import { chromium } from 'playwright';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHOTS = path.join(ROOT, 'artifacts', 'e2e');
const BASE = process.env.APP_URL ?? 'http://localhost:5173';

const NOTE = 'Replaced the docking cable and reseated the dock (UI run).';
const results = [];
const ok = (name) => {
  results.push(name);
  console.log(`PASS  ${name}`);
};
const fail = (name, detail) => {
  throw new Error(`${name}\n     -> ${detail}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Sign in with the test-fixture credentials. The app seeds only the Admin and
 * has no public registration (ADR-004), so the runner provisions these
 * fixtures via the Admin API before this script executes.
 */
async function loginAs(page, email, password) {
  const logout = page.getByRole('button', { name: 'Switch account' });
  if (await logout.isVisible().catch(() => false)) await logout.click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.locator('.topbar').waitFor({ state: 'visible' });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  // Prefer an explicit CHROME_PATH, then a repo-local chrome-headless-shell,
  // then Playwright's own installed browser (the runner installs it if needed).
  // PLAYWRIGHT_BUNDLED=1 tells us the runner already probed and chose Playwright's.
  const repoChrome = path.join(ROOT, 'e2e', '.browsers', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const executablePath = process.env.CHROME_PATH
    ? process.env.CHROME_PATH
    : process.env.PLAYWRIGHT_BUNDLED === '1'
      ? undefined
      : existsSync(repoChrome)
        ? repoChrome
        : undefined;
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  page.setDefaultTimeout(20000);

  console.log(`E2E against ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // --- 1. Rana opens a ticket --------------------------------------------
  const title = `UI E2E ${Date.now()} - docking station flickers`;
  await loginAs(page, 'rana.khoury@eurisko.com', 'password123');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill('Docking station output flickers on the external monitor.');
  await page.getByLabel('Category').selectOption('IT');
  await page.getByLabel('Priority').selectOption('High');
  await page.getByRole('button', { name: 'Open ticket' }).click();

  const openedNotice = await page.locator('.notice-success').first().innerText();
  const m = openedNotice.match(/Ticket #(\d+) opened/);
  if (!m) fail('Requester opens a ticket via the UI', `notice: ${openedNotice}`);
  const id = Number(m[1]);
  ok(`Requester (Rana) opens ticket #${id} from the UI`);

  // Row appears under "My tickets" as Open (React result on create).
  const myRow = page.locator('table.tickets tr', { hasText: title });
  await myRow.waitFor({ state: 'visible' });
  if (!(await myRow.innerText()).includes('Open')) {
    fail('New ticket shows as Open in Rana list', await myRow.innerText());
  }
  ok(`Rana list shows the ticket as Open`);

  // --- 2. Karim claims it from the IT queue ---------------------------------
  await loginAs(page, 'karim.haddad@eurisko.com', 'password123');
  const queueRow = page.locator('table.tickets tr', { hasText: title });
  await queueRow.waitFor({ state: 'visible' });
  await queueRow.getByRole('button', { name: 'Claim' }).click();

  const workCard = page.locator('.work-item', { hasText: `#${id} —` });
  await workCard.waitFor({ state: 'visible' });
  if (!(await workCard.innerText()).includes('In Progress')) {
    fail('Claimed ticket is In Progress in My work', await workCard.innerText());
  }
  ok(`Agent (Karim) claims the ticket from the queue -> In Progress`);
  await page.screenshot({ path: path.join(SHOTS, '1-agent-in-progress.png'), fullPage: false });

  // --- 3. Empty note -> backend 400 shown in the form ----------------------
  await workCard.getByRole('button', { name: 'Mark Resolved' }).click();
  const formError = workCard.locator('.form-error');
  await formError.waitFor({ state: 'visible' });
  const errText = (await formError.innerText()).trim();
  // Empty string is rejected by the DTO; a whitespace-only note would be
  // rejected by the service rule. Either way the 400 surfaces here.
  if (!/resolution/i.test(errText)) {
    fail('Empty resolution note is rejected (400 surfaced in UI)', errText);
  }
  ok(`Empty resolution note rejected -> UI shows: "${errText}"`);
  await page.screenshot({ path: path.join(SHOTS, '2-empty-note-400.png'), fullPage: false });

  // --- 4. Karim resolves with a note ----------------------------------------
  await workCard.getByLabel('Resolution note').fill(NOTE);
  await workCard.getByRole('button', { name: 'Mark Resolved' }).click();

  await page.locator('.notice-success', { hasText: `Ticket #${id} resolved` }).waitFor({ state: 'visible' });
  await sleep(250); // let React re-render the sections

  // --- 5. This ticket left "My work · In Progress" ------------------------
  // Other tickets may legitimately be in progress (the fixture provisioner
  // leaves one assigned to this agent), so assert on *this* ticket, not on the
  // section being empty.
  const inProgressSection = page.locator('section', { hasText: 'My work · In Progress' });
  if ((await inProgressSection.locator('tr, .work-item', { hasText: title }).count()) > 0) {
    fail('Ticket left the In Progress section', 'the ticket is still listed as In Progress');
  }

  const resolvedTable = page.locator('section', { hasText: 'Resolved by me' });
  const resolvedRow = resolvedTable.locator('table.tickets tr', { hasText: title });
  await resolvedRow.waitFor({ state: 'visible' });
  const rowText = await resolvedRow.innerText();
  if (!rowText.includes('Resolved') || !rowText.includes(NOTE)) {
    fail('Resolved section shows status + note', rowText);
  }
  ok('Ticket moved to "Resolved by me" section, note visible (agent view)');
  await page.screenshot({ path: path.join(SHOTS, '3-bob-resolved-view.png'), fullPage: false });
  // --- 6. Requester sees Resolved + the note -------------------------------
  await loginAs(page, 'rana.khoury@eurisko.com', 'password123');
  const aliceRow = page.locator('table.tickets tr', { hasText: title });
  await aliceRow.waitFor({ state: 'visible' });
  const aliceText = await aliceRow.innerText();
  if (!aliceText.includes('Resolved') || !aliceText.includes(NOTE)) {
    fail('Requester sees Resolved + note', aliceText);
  }
  ok('Requester "My tickets" reflects Resolved status + resolution note');
  await page.screenshot({ path: path.join(SHOTS, '4-requester-resolved-view.png'), fullPage: false });

  await browser.close();
  console.log(`\n${results.length} UI checks passed. Screenshots: ${SHOTS}`);
}

main().catch((err) => {
  console.error(`\nE2E FAILED: ${err.message}`);
  process.exitCode = 1;
});
