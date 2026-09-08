#!/usr/bin/env node
/**
 * Eurisko Hub — "Assigned agent resolves a ticket" browser E2E.
 *
 * Drives the REAL React app (http://localhost:5173) with no direct API calls:
 *
 *   1. Alice (Requester) opens an IT ticket.
 *   2. Bob (IT Agent) sees it in his queue and claims it (-> In Progress).
 *   3. Bob submits an EMPTY resolution note -> the backend 400 is surfaced
 *      in the form (DoD: reject bad input).
 *   4. Bob types a note and clicks "Mark Resolved".
 *   5. The ticket visibly moves to the "Resolved by me" section with the
 *      note (DoD: UI reflects the state change immediately).
 *   6. Alice's "My tickets" shows the ticket as Resolved with the note.
 *
 * Screenshots land in artifacts/e2e/.
 *
 * Prereqs: backend on :3000 (DB_FILE persistent), `npm run dev` on :5173,
 * demo accounts provisioned (run ../scripts/verify-slice.mjs full once).
 *
 * Run:  node scripts/resolve-slice.e2e.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
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

async function loginAs(page, chipText) {
  // Header logout if a session is active, then fill & submit the auth form.
  const logout = page.getByRole('button', { name: 'Switch account' });
  if (await logout.isVisible().catch(() => false)) await logout.click();
  await page.locator('.chip', { hasText: chipText }).first().click();
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.locator('.topbar').waitFor({ state: 'visible' });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const defaultChrome = path.join(ROOT, 'e2e', '.browsers', 'chrome-headless-shell-linux64', 'chrome-headless-shell');
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? defaultChrome,
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1360, height: 950 } });
  page.setDefaultTimeout(20000);

  console.log(`E2E against ${BASE}`);
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });

  // --- 1. Alice opens a ticket --------------------------------------------
  const title = `UI E2E ${Date.now()} - docking station flickers`;
  await loginAs(page, 'alice@corp.com');
  await page.getByLabel('Title').fill(title);
  await page.getByLabel('Description').fill('Docking station output flickers on the external monitor.');
  await page.getByLabel('Category').selectOption('IT');
  await page.getByLabel('Priority').selectOption('High');
  await page.getByRole('button', { name: 'Open ticket' }).click();

  const openedNotice = await page.locator('.notice-success').first().innerText();
  const m = openedNotice.match(/Ticket #(\d+) opened/);
  if (!m) fail('Requester opens a ticket via the UI', `notice: ${openedNotice}`);
  const id = Number(m[1]);
  ok(`Requester (Alice) opens ticket #${id} from the UI`);

  // Row appears under "My tickets" as Open (React result on create).
  const myRow = page.locator('table.tickets tr', { hasText: title });
  await myRow.waitFor({ state: 'visible' });
  if (!(await myRow.innerText()).includes('Open')) {
    fail('New ticket shows as Open in Alice list', await myRow.innerText());
  }
  ok(`Alice list shows the ticket as Open`);

  // --- 2. Bob claims it from the IT queue ---------------------------------
  await loginAs(page, 'bob@corp.com');
  const queueRow = page.locator('table.tickets tr', { hasText: title });
  await queueRow.waitFor({ state: 'visible' });
  await queueRow.getByRole('button', { name: 'Claim' }).click();

  const workCard = page.locator('.work-item', { hasText: `#${id} —` });
  await workCard.waitFor({ state: 'visible' });
  if (!(await workCard.innerText()).includes('In Progress')) {
    fail('Claimed ticket is In Progress in My work', await workCard.innerText());
  }
  ok(`Agent (Bob) claims the ticket from the queue -> In Progress`);
  await page.screenshot({ path: path.join(SHOTS, '1-agent-in-progress.png'), fullPage: false });

  // --- 3. Empty note -> backend 400 shown in the form ----------------------
  await workCard.getByRole('button', { name: 'Mark Resolved' }).click();
  const formError = workCard.locator('.form-error');
  await formError.waitFor({ state: 'visible' });
  const errText = (await formError.innerText()).trim();
  if (!/resolution note is required/i.test(errText)) {
    fail('Empty resolution note is rejected (400 surfaced in UI)', errText);
  }
  ok(`Empty resolution note rejected -> UI shows: "${errText}"`);
  await page.screenshot({ path: path.join(SHOTS, '2-empty-note-400.png'), fullPage: false });

  // --- 4. Bob resolves with a note ----------------------------------------
  await workCard.getByLabel('Resolution note').fill(NOTE);
  await workCard.getByRole('button', { name: 'Mark Resolved' }).click();

  await page.locator('.notice-success', { hasText: `Ticket #${id} resolved` }).waitFor({ state: 'visible' });
  await sleep(250); // let React re-render the sections

  // --- 5. Ticket moved to the Resolved section with the note --------------
  const inProgressEmpty = await page
    .locator('section', { hasText: 'My work · In Progress (0)' })
    .isVisible();
  if (!inProgressEmpty) fail('In Progress section emptied', 'ticket still listed as In Progress');

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
  await loginAs(page, 'alice@corp.com');
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
