import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AnomaliesController } from './anomalies/anomalies.controller';
import { AuditController } from './audit/audit.controller';
import { AuthController } from './auth/auth.controller';
import { BatimentsController } from './batiments/batiments.controller';
import { CartographieController } from './cartographie/cartographie.controller';
import { AuthGuard, Public } from './common/auth';
import { ErreursFilter } from './common/erreurs.filter';
import { config } from './config';
import { DbModule } from './db/db.module';
import { DbService } from './db/db.service';
import { EspaceProprietaireController } from './espace-proprietaire/espace-proprietaire.controller';
import { FiscaliteController } from './fiscalite/fiscalite.controller';
import { ParcellesController } from './parcelles/parcelles.controller';
import { ProprietairesController } from './proprietaires/proprietaires.controller';
import { TableauDeBordController } from './tableau-de-bord/tableau-de-bord.controller';
import { TransactionsController } from './transactions/transactions.controller';

@Controller('sante')
class SanteController {
  constructor(private readonly db: DbService) {}

  @Public()
  @Get()
  async sante() {
    await this.db.query('SELECT 1');
    return { statut: 'ok', service: 'snifi-api', version: '0.1.0' };
  }
}

@Module({
  imports: [DbModule, JwtModule.register({ secret: config.jwtSecret, signOptions: { expiresIn: config.jwtTtl as any } })],
  controllers: [
    SanteController, AuthController, ProprietairesController, ParcellesController, BatimentsController,
    CartographieController, FiscaliteController, TransactionsController, AnomaliesController, AuditController,
    TableauDeBordController, EspaceProprietaireController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ErreursFilter },
  ],
})
export class AppModule {}
