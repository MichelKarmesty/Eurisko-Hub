import { IsEmail, IsString, MinLength } from 'class-validator';

/**
 * Password handling. An account's email is validated with `@IsEmail()` and
 * **nothing else**: any real, deliverable address is accepted — a personal
 * provider (`someone@gmail.com`, `someone@hotmail.com`, `someone@outlook.com`,
 * `someone@yahoo.com`…) or a company domain. The application never restricts
 * accounts to one domain, so the same rules apply to login, account creation
 * and password recovery.
 */

/** POST /auth/login — the only public auth request contract for signing in. */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}

/**
 * POST /auth/forgot-password — public. Always answers the same generic message
 * (registered or not), so it cannot be used to enumerate accounts.
 */
export class ForgotPasswordDto {
  @IsEmail()
  email: string;
}

/**
 * POST /auth/reset-password — public. The one-time `token` comes from the reset
 * link/email; `token` is a 64-char hex string, so the 20-char floor rejects
 * obviously malformed input before it reaches the service.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(20)
  token: string;

  @IsString()
  @MinLength(8)
  password: string;
}

/**
 * POST /auth/change-password — authenticated. Changing a password while signed
 * in still requires the current one, so a stolen/borrowed token alone cannot
 * take over the account.
 */
export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
