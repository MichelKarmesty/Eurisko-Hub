/**
 * A fresh clone has no `backend/.data` folder: it is gitignored, and sql.js
 * cannot create a file inside a folder that does not exist. The app therefore
 * used to log "Unable to connect to the database. Retrying..." until someone
 * ran `mkdir .data` by hand -- the one step that broke a clean checkout.
 *
 * This pins the fix in `AppModule`: pointing `DB_FILE` at a path inside a
 * missing folder creates that folder and boots anyway. It runs against a real
 * temporary directory rather than a mocked filesystem, because the thing being
 * tested *is* the filesystem call.
 */
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppModule } from '../src/app.module';

describe('DB_FILE — a fresh clone needs no manual mkdir', () => {
  const root = mkdtempSync(join(tmpdir(), 'eurisko-db-folder-'));
  // Two levels of missing folder, so a shallow mkdir would not be enough.
  const dbFile = join(root, 'data', 'nested', 'hub.sqlite');
  let app: INestApplication | undefined;

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
    delete process.env.DB_FILE;
  });

  it('creates the folder that DB_FILE points into, then boots', async () => {
    expect(existsSync(dirname(dbFile))).toBe(false);

    process.env.DB_FILE = dbFile;
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    expect(existsSync(dirname(dbFile))).toBe(true);
  });
});
