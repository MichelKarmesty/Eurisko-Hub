import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/auth.decorators';
import {
  demoSeedingEnabled,
  publicDemoAccounts,
} from '../common/demo-accounts';

/**
 * Dev-only discovery endpoint (see common/demo-accounts.ts).
 *
 * The login card, `scripts/verify-slice.mjs` and the E2E harnesses all read
 * the demo accounts from here, so the list lives in exactly one place. When
 * demo seeding is disabled (production, or `SEED_DEMO_DATA=false`) it returns
 * an empty list rather than leaking anything.
 */
@Controller('demo')
export class DemoController {
  @Public()
  @Get('accounts')
  accounts() {
    return { accounts: demoSeedingEnabled() ? publicDemoAccounts() : [] };
  }
}
