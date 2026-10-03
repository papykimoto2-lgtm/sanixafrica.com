import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config';

export async function creerApplication() {
  const app = await NestFactory.create(AppModule, { logger: process.env.JEST_WORKER_ID ? ['error'] : ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigin.split(','), allowedHeaders: ['Authorization', 'Content-Type', 'X-Snifi-Motif'] });
  return app;
}

if (require.main === module) {
  creerApplication().then(async (app) => {
    await app.listen(config.port);
    console.log(`SNIFI API — http://localhost:${config.port}/api/v1`);
  });
}
