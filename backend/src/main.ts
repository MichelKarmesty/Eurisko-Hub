import { NestFactory, Reflector } from '@nestjs/core';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Routes match ADR-001 exactly (e.g. PATCH /tickets/:id/claim), so no prefix.
  app.enableCors(); // web client will run on a different origin in dev
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // strip unknown DTO properties (client can't be trusted)
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  // Applies @Exclude (e.g. User.passwordHash) to every response.
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  console.log(`Eurisko Hub API listening on http://localhost:${port}`);
}
bootstrap();
