import './env'; // must stay first: loads backend/.env before any module reads it
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';

/** Fail fast in production when critical env vars are absent. */
function assertProductionEnv() {
  if (process.env.NODE_ENV !== 'production') return;
  const missing: string[] = [];
  if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!process.env.APP_BASE_URL) missing.push('APP_BASE_URL');
  if (missing.length) {
    console.error(
      `[startup] Missing required production environment variable(s): ${missing.join(', ')}.\n` +
        '         The server will not start. Set them and restart.',
    );
    process.exit(1);
  }

  // Production defaults to synchronize=false and this project ships no
  // migrations, so the tables have to exist already. Say so once, loudly,
  // instead of letting the first query fail with "no such table".
  if (process.env.TYPEORM_SYNCHRONIZE !== 'true') {
    console.warn(
      '[startup] NODE_ENV=production with TypeORM synchronize disabled — the ' +
        'database schema must already exist (this repo ships no migrations). ' +
        'Set TYPEORM_SYNCHRONIZE=true to let TypeORM create it.',
    );
  }
}

async function bootstrap() {
  assertProductionEnv();

  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Eurisko Hub API listening on http://localhost:${port}`);
}
bootstrap();
