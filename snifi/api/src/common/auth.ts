import {
  CanActivate, createParamDecorator, ExecutionContext, Injectable, SetMetadata, UnauthorizedException, ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuditContext } from '../db/db.service';
import { Role, UtilisateurCourant } from './roles';

const ROLES_KEY = 'snifi:roles';
const PUBLIC_KEY = 'snifi:public';

/** Restreint une route aux rôles indiqués. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * Garde globale : JWT obligatoire (sauf @Public) puis contrôle RBAC.
 * Une route sans @Roles n'est accessible qu'à l'administrateur national (refus par défaut).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest();
    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException('Authentification requise');
    try {
      req.user = this.jwt.verify<UtilisateurCourant>(token);
    } catch {
      throw new UnauthorizedException('Jeton invalide ou expiré');
    }
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, targets) ?? ['admin_national'];
    if (!roles.includes(req.user.role)) throw new ForbiddenException('Droits insuffisants pour cette opération');
    return true;
  }
}

export const Utilisateur = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): UtilisateurCourant => ctx.switchToHttp().getRequest().user,
);

/** Contexte d'audit : utilisateur + motif (corps « motif » ou en-tête X-Snifi-Motif encodé URI). */
export const Audit = createParamDecorator((_: unknown, ctx: ExecutionContext): AuditContext => {
  const req = ctx.switchToHttp().getRequest();
  const header = req.headers['x-snifi-motif'];
  const motif = (req.body && typeof req.body.motif === 'string' && req.body.motif) ||
    (typeof header === 'string' ? decodeURIComponent(header) : undefined);
  return { utilisateur: `${req.user.login} (${req.user.role})`, motif, source: req.headers['x-snifi-source'] ?? 'API' };
});
