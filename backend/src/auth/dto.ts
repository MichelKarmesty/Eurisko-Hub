import { IsEmail, IsString } from 'class-validator';

/**
 * POST /auth/login — the only public auth request contract. There is no
 * registration DTO because there is no public registration (ADR-004): account
 * creation is `POST /users`, which is Admin-only.
 */
export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  password: string;
}
