import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * Liveness/readiness/ops routes (`GET /` and `GET /health`).
 *
 * It injects the globally registered `DataSource` from
 * `TypeOrmModule.forRoot` for the readiness probe, so it adds no database
 * coupling of its own. `HealthService` is exported because the request-logging
 * middleware is installed from `configureApp()` (app.setup.ts), which resolves
 * it from the application container.
 */
@Module({
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
