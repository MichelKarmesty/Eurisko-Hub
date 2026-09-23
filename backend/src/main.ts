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
