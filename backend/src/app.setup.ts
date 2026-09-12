import {
  ClassSerializerInterceptor,
  INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/**
 * The single, shared HTTP pipeline for the API.
 *
 * `main.ts` (real server) and the automated API tests both call this, so the
 * validation/serialization boundary exercised by the tests is byte-for-byte
 * the boundary users hit in production:
 *
 *  - ValidationPipe: whitelist + forbidNonWhitelisted + transform, so unknown
 *    fields and invalid enum values are rejected with 400 before they reach a
 *    controller (the explicit request contract).
 *  - ClassSerializerInterceptor: applies @Exclude (e.g. User.passwordHash) to
 *    every response, so secrets can never leak through the contract.
 */
export function configureApp(app: INestApplication): void {
  // Routes match ADR-001 exactly (e.g. PATCH /tickets/:id/claim), so no prefix.
  app.enableCors(); // web client runs on a different origin in dev
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown DTO properties (client can't be trusted)
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));
}
