import { Body, Controller, Get, Post, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { z } from 'zod';
import { Public, Roles, Utilisateur } from '../common/auth';
import { Role, UtilisateurCourant } from '../common/roles';
import { Valider } from '../common/validation';
import { DbService } from '../db/db.service';

const TOUS: Role[] = [
  'admin_national', 'admin_regional', 'agent_fiscal', 'controleur', 'collectivite', 'service_foncier',
  'urbanisme', 'notaire', 'promoteur', 'proprietaire', 'auditeur', 'admin_technique',
];

const connexion = z.object({ login: z.string().min(1), mot_de_passe: z.string().min(1) });

@Controller('auth')
export class AuthController {
  constructor(private readonly db: DbService, private readonly jwt: JwtService) {}

  // NB : en production l'authentification (MFA comprise) est déléguée à l'IAM institutionnel
  // (Keycloak / OIDC) ; cet endpoint sert au prototype.
  @Public()
  @Post('connexion')
  async connexion(@Body(new Valider(connexion)) body: z.infer<typeof connexion>) {
    const u = await this.db.one(
      'SELECT id, login, nom, role, territoire_code, proprietaire_id, mot_de_passe FROM snifi.utilisateurs WHERE login = $1 AND actif',
      [body.login],
    );
    if (!u || !(await bcrypt.compare(body.mot_de_passe, u.mot_de_passe))) {
      throw new UnauthorizedException('Identifiants invalides');
    }
    await this.db.tx({ utilisateur: `${u.login} (${u.role})`, motif: 'Connexion', source: 'AUTH' }, (c) =>
      c.query('UPDATE snifi.utilisateurs SET derniere_connexion = now() WHERE id = $1', [u.id]),
    );
    const { mot_de_passe: _, ...profil } = u;
    return { jeton: this.jwt.sign(profil as UtilisateurCourant), utilisateur: profil };
  }

  @Roles(...TOUS)
  @Get('moi')
  moi(@Utilisateur() u: UtilisateurCourant) {
    return u;
  }
}
