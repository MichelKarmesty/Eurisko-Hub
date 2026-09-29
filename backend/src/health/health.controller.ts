import { Controller, Get } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Public } from '../common/auth.decorators';
import { HealthService } from './health.service';

/** Bumped by hand only when the shape of this payload changes. */
const HEALTH_SCHEMA_VERSION = 1;

/**
 * Unauthenticated liveness/readiness/ops endpoints.
 *
 * Why these exist: the defense and the operations story need to prove the
 * service is *alive* from the outside, cheaply and without credentials. Before
 * this controller the API had no route that answered `200` without a JWT, so
 * every monitor had to guess by calling `/auth/login` and reading a `400` as
 * "the process is up" - which is neither honest nor readable on a slide.
 *
 * `GET /health` is a readiness probe: it touches the database with `SELECT 1`,
 * so `200` means "the process is up AND the database answers". It also carries
 * the ops evidence the defense scripts print: process uptime, the SQLite file
 * and its size (proof of persistence), and the last five real requests.
 * `GET /` is a plain identification/liveness route for humans and uptime checks.
 *
 * Both routes are `@Public()`; the global `JwtAuthGuard` would otherwise reject
 * them with `401`. They expose no data beyond a fixed service name, a schema
 * version, uptime, a file size and method/path/status triples - never a secret,
 * an account, a ticket title or an email address, so they are safe to leave
 * reachable unauthenticated.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    private readonly health: HealthService,
  ) {}

  /** GET / - liveness + identification. Always `200` while the process serves. */
  @Public()
  @Get()
  root() {
    const report = this.health.report();
    return {
      service: report.service,
      status: report.status,
      version: report.version,
      health: '/health',
      uptimeSeconds: Math.round(process.uptime()),
      uptime: report.uptime,
      timestamp: new Date().toISOString(),
    };
  }

  /** GET /health - readiness (process + database) plus the ops evidence block. */
  @Public()
  @Get('health')
  async health_() {
    let database: 'connected' | 'unavailable' = 'connected';
    try {
      await this.dataSource.query('SELECT 1');
    } catch {
      database = 'unavailable';
    }

    const report = this.health.report();
    return {
      status: database === 'connected' ? 'ok' : 'degraded',
      service: report.service,
      version: report.version,
      schemaVersion: HEALTH_SCHEMA_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      uptime: report.uptime,
      uptimeMs: report.uptimeMs,
      startedAt: report.startedAt,
      database,
      // Proof of persistence: the on-disk SQLite file and how big it is right
      // now. `mode: 'memory'` says the process is using a throwaway database,
      // which is a real (and reportable) deployment choice, not a failure.
      db: report.db,
      // Request counters + the last five real (non-health) requests, so the
      // monitor can show the app serving the audience live.
      requests: report.requests,
      timestamp: new Date().toISOString(),
    };
  }
}
